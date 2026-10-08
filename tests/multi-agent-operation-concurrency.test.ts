import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';

// Actual product HTTP and native file execution in independent temporary data.
// PGlite serializes one backend: competing HTTP clients are tested, independent
// PostgreSQL row-lock/interleaving and multiple OS helper processes are not.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
const { LocalExecutor } = createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
let pool: pg.Pool, directory: string, traceRoot: string, server: http.Server, gateway: http.Server, url: string;
let LocalOperationService: typeof import('../apps/api/src/local-execution.ts').LocalOperationService;
let providerRequests = 0;
const departmentId = 'operation-concurrency-department', modelId = 'operation-concurrency-model';
const employees = [
  { id: 'first', name: '隔离员工甲', title: '经理', role: 'manager', modelId, tools: ['artifact_write'], instructions: 'Only isolated fixture files' },
  { id: 'second', name: '隔离员工乙', title: '开发', role: 'member', modelId, tools: ['artifact_write'], instructions: 'Only isolated fixture files' },
];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const close = (instance?: http.Server) => instance ? new Promise<void>(done => { instance.closeAllConnections(); instance.close(() => done()); }) : Promise.resolve();
const evidence = (scenario: string, details: Record<string, unknown>) => console.log('COMPETITION ' + JSON.stringify({ scenario, ...details, providerRequests }));
type Fixture = {
  device: { id: string; token: string; grant: { id: string; root: string; allowCommands: boolean } };
  runId: string; owner: string; workspace: string; executor: any;
  service: InstanceType<typeof import('../apps/api/src/local-execution.ts').LocalOperationService>;
};

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'multi-agent-operation-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer((_request, response) => { providerRequests++; response.writeHead(500); response.end('INFERENCE_FORBIDDEN'); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', ['operation-concurrency-gateway', { name: 'Never-called sentinel', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1' }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES($1,$2,'available')", [modelId, { id: modelId, name: 'Never-called model', model: 'unused', gatewayId: 'operation-concurrency-gateway', inputRate: 2, outputRate: 10 }]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: '并发隔离部门', agents: employees }]);
  const local = await import('../apps/api/src/local-execution.ts'); LocalOperationService = local.LocalOperationService;
  const app = express(); app.use(express.json({ limit: '32mb' })); app.use('/api', local.localDeviceRouter(traceRoot));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).json({ code: error.code, message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,request_keys,tool_approvals CASCADE');
  providerRequests = 0;
});
afterEach(async () => {
  if (!isolated) return;
  assert.equal(providerRequests, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations')).rows[0].n, 0);
  const limits = (await pool.query("SELECT policy->>'maxBudget' AS cap FROM projects")).rows;
  assert.ok(limits.length > 0 && limits.every(row => Number(row.cap) === 1), 'the fixture cap remains one USD; protocol tests do not raise it');
});
after(async () => {
  if (!isolated) return;
  await close(server); await close(gateway); await pool?.end();
  if (directory) {
    const within = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(within.startsWith('multi-agent-operation-') && !within.startsWith('..') && !isAbsolute(within), 'remove only this test-owned temporary root');
    await rm(directory, { recursive: true, force: true });
  }
});

async function request(f: Fixture, path: string, body: unknown) {
  const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Local-Device-Key': f.device.token }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const poll = (f: Fixture, body: unknown = {}) => request(f, '/local-devices/' + f.device.id + '/poll', body);
const protocol = (f: Fixture, id: string, name: string, body: unknown) => request(f, '/local-devices/' + f.device.id + '/operations/' + id + '/' + name, body);
const row = async (id: string) => (await pool.query('SELECT * FROM local_operations WHERE id=$1', [id])).rows[0];
async function fixture(): Promise<Fixture> {
  const root = join(directory, 'device-' + randomUUID()); await mkdir(root);
  const device = { id: randomUUID(), token: randomBytes(32).toString('hex'), grant: { id: randomUUID(), root, allowCommands: false } };
  const runId = randomUUID(), projectId = randomUUID(), owner = randomUUID();
  const policy = { maxBudget: 1, maxAgents: 2, maxConcurrentAgents: 2, maxModelCalls: 10, maxTaskModelCalls: 5, deadlineSeconds: 180,
    executionTarget: { kind: 'local', deviceId: device.id, grantId: device.grant.id } };
  const executionTarget = { ...policy.executionTarget, name: '并发测试设备', platform: process.platform, label: 'isolated', allowCommands: false };
  const tasks = employees.map((employee, i) => ({ id: 'task-' + i, subject: employee.name + '测试文件', assigneeId: employee.id, assignee: employee.id,
    dependencies: [], objective: 'Write only bounded temporary fixture text', taskPrompt: 'Write only bounded temporary fixture text', acceptanceCriteria: ['fixture version verified'], estimatedInputTokens: 10, estimatedOutputTokens: 10 }));
  const snapshot = { projectId, planVersion: 1, templateVersion: 'operation-concurrency-fixture', requirement: 'Isolated local-operation concurrency checks',
    policy, departmentId, agents: employees.map(employee => ({ ...employee, roleVersion: 1, rolePrompt: employee.instructions, model: 'unused' })), tasks, executionTarget };
  const service = new LocalOperationService(traceRoot, owner), executor = new LocalExecutor(device.grant);
  const f: Fixture = { device, runId, owner, workspace: join(root, runId), service, executor };
  const registration = await request(f, '/local-devices/register', { id: device.id, token: device.token, name: '并发测试设备', platform: process.platform,
    grant: { id: device.grant.id, label: 'isolated', allowCommands: false } });
  assert.equal(registration.status, 200, JSON.stringify(registration.data));
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [projectId, departmentId, '并发隔离部门', snapshot.requirement, policy, { rationale: 'Explicit isolated native file tasks', agents: employees, tasks }, 'manual']);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '3 minutes',now())", [runId, projectId, snapshot, owner]);
  createRunArchive(traceRoot, snapshot, { id: runId });
  const prepareId = await service.enqueue(runId, 'prepare', {}, {}, []);
  const offered = await poll(f); assert.equal(offered.status, 200); assert.equal(offered.data.job.id, prepareId);
  const start = await protocol(f, prepareId, 'start', { claimToken: offered.data.job.claimToken }); assert.equal(start.status, 200);
  const result = await executor.execute(offered.data.job, new AbortController().signal);
  assert.equal((await protocol(f, prepareId, 'result', { claimToken: offered.data.job.claimToken, ok: true, result })).status, 200);
  await service.wait(prepareId);
  return f;
}
const enqueue = (f: Fixture, content: string, employeeId = 'first', expectedSha256?: string) =>
  f.service.enqueue(f.runId, 'artifact_write', { path: 'shared.txt', content, ...(expectedSha256 ? { expectedSha256 } : {}) },
    { agentId: employeeId, callId: randomUUID(), sessionId: randomUUID() });
async function oneClaim(f: Fixture, id: string) {
  const response = await poll(f); assert.equal(response.status, 200); assert.equal(response.data.job?.id, id); return response.data.job;
}
async function executeStarted(f: Fixture, job: any) {
  const response = await protocol(f, job.id, 'start', { claimToken: job.claimToken }); assert.equal(response.status, 200, JSON.stringify(response.data));
  return { claimToken: job.claimToken, ok: true, result: await f.executor.execute(job, new AbortController().signal) };
}
async function finish(f: Fixture, job: any, body: any) {
  const response = await protocol(f, job.id, 'result', body); assert.equal(response.status, 200, JSON.stringify(response.data));
  return f.service.wait(job.id);
}

test('16 clients competing for a claim and start obtain one token and one actual native write', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), id = await enqueue(f, 'single native fixture write');
  const responses = await Promise.all(Array.from({ length: 16 }, () => poll(f))); responses.forEach(r => assert.equal(r.status, 200));
  const jobs = responses.map(r => r.data.job).filter(Boolean); assert.ok(jobs.length >= 1);
  assert.deepEqual([...new Set(jobs.map(job => job.id))], [id]); assert.equal(new Set(jobs.map(job => job.claimToken)).size, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE device_id=$1 AND status IN ('claimed','started')", [f.device.id])).rows[0].n, 1);
  const recovered = await oneClaim(f, id); assert.equal(recovered.claimToken, jobs[0].claimToken, 'a lost poll reply reoffers the same unstarted claim');
  let executions = 0;
  const starts = await Promise.all(Array.from({ length: 16 }, async () => {
    const response = await protocol(f, id, 'start', { claimToken: recovered.claimToken });
    if (response.status !== 200) return { status: response.status, code: response.data.code };
    executions++; return { status: 200, body: { claimToken: recovered.claimToken, ok: true, result: await f.executor.execute(recovered, new AbortController().signal) } };
  }));
  assert.equal(starts.filter(s => s.status === 200).length, 1); assert.equal(executions, 1);
  assert.ok(starts.filter(s => s.status !== 200).every(s => s.status === 409 && s.code === 'LOCAL_START_DENIED'));
  const running = await poll(f); assert.equal(running.data.job, undefined); assert.equal(running.data.orphan.id, id); assert.equal(running.data.orphan.started, true);
  const body = starts.find(s => s.status === 200)!.body; const result = await finish(f, recovered, body);
  assert.equal(result.sha256, hash('single native fixture write')); assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'single native fixture write');
  assert.equal((await row(id)).status, 'completed'); assert.equal(providerRequests, 0);
  evidence('same-operation-claim/start', { clients: 16, offers: jobs.length, uniqueTokens: 1, start200: 1, start409: 15, nativeWrites: executions, fileSha256: result.sha256 });
});

test('two employees share one device without overlapping claims, and a stale writer cannot overwrite the first file', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), first = await enqueue(f, 'employee A'), second = await enqueue(f, 'employee B', 'second');
  const claims = await Promise.all(Array.from({ length: 12 }, () => poll(f))); const offered = claims.map(r => r.data.job).filter(Boolean);
  assert.deepEqual([...new Set(offered.map(job => job.id))], [first]);
  const a = await oneClaim(f, first), body = await executeStarted(f, a);
  const whileRunning = await Promise.all(Array.from({ length: 12 }, () => poll(f)));
  assert.ok(whileRunning.every(r => r.status === 200 && !r.data.job && r.data.orphan?.id === first));
  assert.equal((await row(second)).status, 'queued'); await finish(f, a, body);
  const b = await oneClaim(f, second); assert.notEqual(b.claimToken, a.claimToken);
  assert.equal((await protocol(f, second, 'start', { claimToken: b.claimToken })).status, 200);
  let rejected: any;
  try { await f.executor.execute(b, new AbortController().signal); } catch (error) { rejected = error; }
  assert.equal(rejected?.code, 'FILE_VERSION_CONFLICT'); assert.equal(rejected?.notExecuted, true);
  assert.equal((await protocol(f, second, 'result', { claimToken: b.claimToken, ok: false,
    error: { code: rejected.code, message: rejected.message, notExecuted: true } })).status, 200);
  await assert.rejects(f.service.wait(second), { code: 'FILE_VERSION_CONFLICT', notExecuted: true });
  assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'employee A'); assert.equal((await row(second)).status, 'failed');
  const fresh = await enqueue(f, 'employee B with current SHA', 'second', hash('employee A'));
  const current = await oneClaim(f, fresh); const accepted = await finish(f, current, await executeStarted(f, current));
  assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'employee B with current SHA');
  assert.equal(accepted.sha256, hash('employee B with current SHA')); assert.equal(providerRequests, 0);
  evidence('two-employees/stale-file', { clients: 12, maxActiveClaims: 1, secondStayedQueued: true, staleCode: rejected.code, originalPreserved: true, freshShaAccepted: true });
});

test('16 identical competing receipts are idempotent and keep the one real file result', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), id = await enqueue(f, 'immutable receipt'); const job = await oneClaim(f, id); const body = await executeStarted(f, job);
  const receipts = await Promise.all(Array.from({ length: 16 }, () => protocol(f, id, 'result', body)));
  assert.ok(receipts.every(r => r.status === 200)); const stored = await row(id);
  assert.equal(stored.status, 'completed'); assert.deepEqual(stored.result, body); assert.equal(stored.late_result, null);
  assert.equal((await f.service.wait(id)).sha256, hash('immutable receipt')); assert.equal(providerRequests, 0);
  evidence('duplicate-identical-receipts', { clients: 16, result200: 16, durableResultRows: 1, lateResult: false });
});

test('two conflicting competing receipts accept one and cannot replace its persisted result', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), id = await enqueue(f, 'conflicting receipt fixture'); const job = await oneClaim(f, id); const actual = await executeStarted(f, job);
  const bodies = ['client-a', 'client-b'].map(receiptSource => ({ ...actual, result: { ...actual.result, receiptSource } }));
  const responses = await Promise.all(bodies.map(body => protocol(f, id, 'result', body)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); const winner = responses.findIndex(r => r.status === 200);
  assert.deepEqual((await row(id)).result, bodies[winner]); assert.equal((await row(id)).status, 'completed');
  assert.equal((await protocol(f, id, 'result', bodies[1 - winner])).status, 409); assert.deepEqual((await row(id)).result, bodies[winner]);
  assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'conflicting receipt fixture'); assert.equal(providerRequests, 0);
  evidence('conflicting-receipts', { clients: 2, result200: 1, result409: 1, firstResultPreserved: true });
});

test('an expired run lease rejects every competing start and forbids new enqueue', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), id = await enqueue(f, 'must not execute'); const job = await oneClaim(f, id);
  await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [f.runId]);
  const starts = await Promise.all(Array.from({ length: 12 }, () => protocol(f, id, 'start', { claimToken: job.claimToken })));
  assert.ok(starts.every(r => r.status === 409 && r.data.code === 'LOCAL_START_DENIED')); assert.equal((await row(id)).started, false);
  const count = (await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1', [f.runId])).rows[0].n;
  await assert.rejects(enqueue(f, 'stale owner cannot enqueue'), { code: 'LOCAL_LEASE_DENIED', notExecuted: true });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1', [f.runId])).rows[0].n, count);
  assert.equal((await poll(f, { active: { id, claimToken: job.claimToken } })).data.cancel, true);
  assert.equal((await row(id)).status, 'cancelled'); assert.equal(providerRequests, 0);
  evidence('expired-lease-before-start', { clients: 12, start200: 0, start409: 12, started: false, newEnqueueDenied: true });
});

test('expired lease, replaced worker and expired operation keep actual late writes for audit without accepting completion', { skip: !isolated, timeout: 30000 }, async () => {
  for (const reason of ['expired-run-lease', 'replaced-worker', 'expired-operation'] as const) {
    const f = await fixture(), id = await enqueue(f, 'late fixture ' + reason); const job = await oneClaim(f, id); const body = await executeStarted(f, job);
    if (reason === 'expired-run-lease') await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [f.runId]);
    else if (reason === 'replaced-worker') await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2', [randomUUID(), f.runId]);
    else await pool.query("UPDATE local_operations SET deadline=clock_timestamp()-interval '1 minute' WHERE id=$1", [id]);
    const receipts = await Promise.all(Array.from({ length: 8 }, () => protocol(f, id, 'result', body)));
    assert.ok(receipts.every(r => r.status === 200)); const stored = await row(id);
    assert.equal(stored.status, 'cancelled'); assert.equal(stored.result, null); assert.deepEqual(stored.late_result, body); assert.equal(stored.started, true);
    await assert.rejects(f.service.wait(id), { code: 'LOCAL_OPERATION_CANCELLED', notExecuted: false });
    const subsequent = await poll(f); assert.equal(subsequent.data.job, null);
    assert.equal(readFileSync(join(f.workspace, 'shared.txt'), 'utf8'), 'late fixture ' + reason);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE id=$1', [id])).rows[0].n, 1); assert.equal(providerRequests, 0);
    evidence(reason + '-after-start', { clients: 8, transport200: 8, completed: false, status: stored.status, confirmedResult: false, lateResult: true, replayed: false });
  }
});

test('a real old operation claim token cannot start or submit the next operation', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), previousId = await enqueue(f, 'prior operation'); const previous = await oneClaim(f, previousId);
  const old = await executeStarted(f, previous); await finish(f, previous, old);
  const currentId = await enqueue(f, 'current operation', 'second', hash('prior operation')); const current = await oneClaim(f, currentId);
  assert.notEqual(current.claimToken, previous.claimToken);
  const starts = await Promise.all(Array.from({ length: 8 }, () => protocol(f, currentId, 'start', { claimToken: previous.claimToken })));
  assert.ok(starts.every(r => r.status === 409)); const body = await executeStarted(f, current);
  const stale = { ...body, claimToken: previous.claimToken };
  const results = await Promise.all(Array.from({ length: 8 }, () => protocol(f, currentId, 'result', stale)));
  assert.ok(results.every(r => r.status === 403)); const uncommitted = await row(currentId);
  assert.equal(uncommitted.status, 'started'); assert.equal(uncommitted.result, null); assert.equal(uncommitted.late_result, null);
  await finish(f, current, body); assert.equal((await row(currentId)).status, 'completed'); assert.equal(providerRequests, 0);
  evidence('old-claim-token', { clients: 8, oldStart409: 8, oldResult403: 8, oldReceiptAdopted: false, validCurrentResultAccepted: true });
});
