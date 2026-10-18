import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { nativeManifestId } from '../services/agent-runtime/native-capabilities.mjs';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';

// Engineering fixtures only: fresh PGlite, loopback HTTP and real native work in
// test-owned temporary directories. No employee deliverable or model acceptance.
// Backdating last_seen exercises the actual 15-second SQL boundary without
// changing timeouts. PGlite does not reproduce independent PostgreSQL row locks.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
const { LocalExecutor, exportFiles, revision } = createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
let pool: pg.Pool, directory: string, traceRoot: string, server: http.Server, url: string;
let LocalOperationService: typeof import('../apps/api/src/local-execution.ts').LocalOperationService;
let assertRunAuthorization: typeof import('../apps/api/src/execution-policy.ts').assertRunAuthorization;
const departmentId = 'heartbeat-fixture-department', modelId = 'heartbeat-unused-model';
const employee = { id: 'reviewer', name: '隔离复审', title: '经理', role: 'manager', modelId,
  tools: ['artifact_write', 'terminal_test'], instructions: 'Only temporary engineering fixture files' };
const command = 'node --test fixture.test.mjs';
const script = "import test from 'node:test'; import assert from 'node:assert/strict'; import {appendFile} from 'node:fs/promises';\n" +
  "test('isolated native command runs once',async()=>{await appendFile(new URL('./executions.txt',import.meta.url),'once\\n');assert.equal(1,1);});\n";
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
type Fixture = { device: any; runId: string; projectId: string; owner: string; workspace: string; executor: any;
  service: InstanceType<typeof import('../apps/api/src/local-execution.ts').LocalOperationService> };

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'local-operation-heartbeat-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: '隔离心跳测试', agents: [employee] }]);
  const local = await import('../apps/api/src/local-execution.ts'); LocalOperationService = local.LocalOperationService;
  ({ assertRunAuthorization } = await import('../apps/api/src/execution-policy.ts'));
  const app = express(); app.use(express.json({ limit: '32mb' })); app.use('/api', local.localDeviceRouter(traceRoot));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error.status ?? 500).json({ code: error.code, message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});
beforeEach(async () => {
  if (isolated) await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,request_keys,tool_approvals CASCADE');
});
afterEach(async () => {
  if (!isolated) return;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations')).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE policy->>'maxBudget'<>'1'")).rows[0].n, 0);
});
after(async () => {
  if (!isolated) return;
  if (server) await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
  await pool?.end();
  if (directory) {
    const within = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(within.startsWith('local-operation-heartbeat-') && !within.startsWith('..') && !isAbsolute(within));
    await rm(directory, { recursive: true, force: true });
  }
});
async function request(f: Fixture, endpoint: string, body: unknown) {
  const response = await fetch(url + '/local-devices/' + endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'X-Local-Device-Key': f.device.token }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const protocol = (f: Fixture, id: string, action: string, body: unknown) => request(f, f.device.id + '/operations/' + id + '/' + action, body);
const row = async (id: string) => (await pool.query('SELECT * FROM local_operations WHERE id=$1', [id])).rows[0];
const ageHeartbeat = (f: Fixture) => pool.query("UPDATE local_devices SET last_seen=clock_timestamp()-interval '20 seconds' WHERE id=$1", [f.device.id]);
async function fixture(): Promise<Fixture> {
  const root = join(directory, 'device-' + randomUUID()); await mkdir(root);
  const device = { id: randomUUID(), token: randomBytes(32).toString('hex'), grant: { id: randomUUID(), root, allowCommands: true } };
  const runId = randomUUID(), projectId = randomUUID(), owner = randomUUID();
  const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, maxModelCalls: 10, maxTaskModelCalls: 5, deadlineSeconds: 180,
    executionTarget: { kind: 'local', deviceId: device.id, grantId: device.grant.id } };
  const executionTarget = { ...policy.executionTarget, name: '隔离心跳设备', platform: process.platform, label: 'isolated', allowCommands: true };
  const tasks = [{ id: 'review', subject: 'Isolated native review', assigneeId: employee.id, assignee: employee.id, dependencies: [],
    objective: 'Verify only isolated fixture execution', taskPrompt: 'Verify only isolated fixture execution',
    acceptanceCriteria: ['native fixture receipt known'], estimatedInputTokens: 10, estimatedOutputTokens: 10 }];
  const snapshot = { projectId, planVersion: 1, templateVersion: 'heartbeat-engineering-fixture', requirement: 'Isolated heartbeat lifecycle',
    policy, departmentId, agents: [{ ...employee, roleVersion: 1, rolePrompt: employee.instructions, model: 'unused' }], tasks, executionTarget };
  const service = new LocalOperationService(traceRoot, owner), executor = new LocalExecutor(device.grant);
  const f: Fixture = { device, runId, projectId, owner, workspace: join(root, runId), service, executor };
  assert.equal((await request(f, 'register', { id: device.id, token: device.token, name: '隔离心跳设备', platform: process.platform,
    grant: { id: device.grant.id, label: 'isolated', allowCommands: true } })).status, 200);
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [projectId, departmentId, '隔离心跳测试', snapshot.requirement, policy, { rationale: 'Independent native fixture', agents: [employee], tasks }, 'manual']);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until,started_at) VALUES($1,$2,1,'running',$3,$4,clock_timestamp()+interval '3 minutes',now())", [runId, projectId, snapshot, owner]);
  createRunArchive(traceRoot, snapshot, { id: runId });
  const id = await service.enqueue(runId, 'prepare', {}, {}, [{ path: 'fixture.test.mjs', content: Buffer.from(script).toString('base64') }]);
  const job = await claim(f, id); const body = await execute(f, job); await submit(f, job, body); await service.wait(id);
  return f;
}
async function claim(f: Fixture, id: string) {
  const response = await request(f, f.device.id + '/poll', {});
  assert.equal(response.status, 200); assert.equal(response.data.job?.id, id); return response.data.job;
}
async function start(f: Fixture, job: any) {
  const response = await protocol(f, job.id, 'start', { claimToken: job.claimToken }); assert.equal(response.status, 200, JSON.stringify(response.data));
}
async function execute(f: Fixture, job: any) {
  await start(f, job); return { claimToken: job.claimToken, ok: true, result: await f.executor.execute(job, new AbortController().signal) };
}
async function submit(f: Fixture, job: any, body: any) {
  const response = await protocol(f, job.id, 'result', body); assert.equal(response.status, 200, JSON.stringify(response.data));
}
async function commandJob(f: Fixture) {
  const args = { command, expectedWorkspaceRevision: revision(exportFiles(f.workspace)) }, approvalId = randomUUID();
  await pool.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments,status) VALUES($1,$2,$3,'terminal_test',$4,'approved')", [approvalId, f.runId, employee.id, args]);
  const id = await f.service.enqueue(f.runId, 'terminal_test', args, { agentId: employee.id, employeeId: employee.id,
    callId: randomUUID(), sessionId: randomUUID(), taskId: 'review', approvalId });
  return { id, args, approvalId };
}
async function writeJob(f: Fixture) {
  const id = await f.service.enqueue(f.runId, 'artifact_write', { path: 'once.txt', content: 'one native write' },
    { agentId: employee.id, callId: randomUUID(), sessionId: randomUUID(), taskId: 'review' });
  const job = await claim(f, id); return { id, job, body: await execute(f, job) };
}

test('native plugin dispatch binds the runtime employee alias to its approved file contract', { skip: !isolated, timeout: 30000 }, async () => {
  const f=await fixture(), toolName='plugin__office__write';
  const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
  const code=Buffer.from('unused isolated fixture'), compressed=gzipSync(code), metadata=Buffer.from('{}');
  const manifest={format:'dsh-native-tools-v1',namespace:'office',package:'@company/office',version:'1.0.0',source:{kind:'company',reference:'isolated fixture'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:hash('lock'),
    bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},
    tools:[{name:toolName,originalName:'write',description:'Fixture only',parameters:{type:'object'},files:{read:[],write:['path']}}]};
  const id=nativeManifestId(manifest), root=join(directory,'native-plugins',id);await mkdir(root,{recursive:true});
  await writeFile(join(root,'bundle.gz'),compressed);await writeFile(join(root,'package.json'),metadata);await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
  const {setNativeCapability}=await import('../apps/api/src/native-capabilities.ts');await setNativeCapability(id,true,pool);
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[f.runId])).rows[0].snapshot;
  const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+hash('image'),policySha256:hash('policy'),fingerprint:hash('backend')};
  snapshot.agents[0]={...snapshot.agents[0],id:'employee-2',employeeId:employee.id,sourceAgentId:employee.id,sourceDepartmentId:departmentId,tools:[toolName]};
  snapshot.tasks=[{...snapshot.tasks[0],assignee:'employee-2',assigneeId:employee.id,inputs:[],outputs:[{path:'report.docx'}]}];
  snapshot.nativeCapabilities=[{id,manifest}];snapshot.policy.executionTarget.backend=backend;snapshot.executionTarget.backend=backend;
  await pool.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'隔离心跳测试',agents:[{...employee,tools:[toolName]}]},departmentId]);
  try {
    await pool.query('UPDATE local_devices SET backend=$1 WHERE id=$2',[backend,f.device.id]);
    await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[snapshot,f.runId]);
    const context={agentId:'employee-2',employeeId:employee.id,taskId:'review',callId:randomUUID(),sessionId:randomUUID()};
    const args={toolName,arguments:{path:'report.docx'}};
    const op=await f.service.enqueue(f.runId,'native_plugin',args,context);
    assert.deepEqual((await row(op)).payload.arguments.writePaths,['report.docx']);
    assert.equal((await row(op)).payload.arguments.pluginId,id);
    await assert.rejects(f.service.enqueue(f.runId,'native_plugin',{...args,arguments:{path:'other.docx'}},context),{code:'NATIVE_PATH_DENIED',notExecuted:true});
    snapshot.tasks[0].assignee='employee-3';await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[snapshot,f.runId]);
    await assert.rejects(f.service.enqueue(f.runId,'native_plugin',args,context),{code:'NATIVE_TASK_REQUIRED',notExecuted:true});
  } finally {await pool.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'隔离心跳测试',agents:[employee]},departmentId]);}
});
test('started native command retains its waiting result after the heartbeat exceeds 15 seconds', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), { id } = await commandJob(f), job = await claim(f, id); await start(f, job);
  const controller = new AbortController();
  // The outer node:test runner sets this variable. Let the real approved child
  // run its own test file rather than treating it as recursive test discovery.
  const inheritedTestContext = process.env.NODE_TEST_CONTEXT;
  let execution: Promise<any>;
  try { delete process.env.NODE_TEST_CONTEXT; execution = f.executor.execute(job, controller.signal); }
  finally { if (inheritedTestContext !== undefined) process.env.NODE_TEST_CONTEXT = inheritedTestContext; }
  const observed = f.service.wait(id, controller.signal).then(value => ({ value }), error => ({ error }));
  try {
    await ageHeartbeat(f); await pause(350);
    assert.equal((await row(id)).status, 'started', 'a soft heartbeat expiry cannot cancel an already-started command');
    const actual = await execution; assert.equal(actual.exitCode, 0); assert.match(actual.output, /pass 1/);
    const malformed = await protocol(f, id, 'result', { claimToken: job.claimToken, ok: true, result: { ...actual, exitCode: null } });
    assert.equal(malformed.status, 422); assert.equal((await row(id)).status, 'started');
    assert.equal((await pool.query("SELECT last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices WHERE id=$1", [f.device.id])).rows[0].online, false);
    const body = { claimToken: job.claimToken, ok: true, result: actual }; await submit(f, job, body);
    const outcome = await observed; assert.ok('value' in outcome, JSON.stringify(outcome)); assert.deepEqual(outcome.value, actual);
    assert.equal((await pool.query("SELECT last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices WHERE id=$1", [f.device.id])).rows[0].online, true);
    await assertRunAuthorization((await pool.query('SELECT * FROM project_runs WHERE id=$1', [f.runId])).rows[0]);
    await ageHeartbeat(f);
    assert.deepEqual(await f.service.wait(id), actual, 'completed receipt remains readable with the same stale heartbeat');
    const stored = await row(id); assert.equal(stored.status, 'completed'); assert.equal(stored.late_result, null); assert.deepEqual(stored.result, body);
    assert.equal(readFileSync(join(f.workspace, 'executions.txt'), 'utf8'), 'once\n');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1 AND payload->>'name'='terminal_test'", [f.runId])).rows[0].n, 1);
  } finally { controller.abort(Error('fixture cleanup')); await Promise.allSettled([execution, observed]); }
});

test('stale heartbeat still rejects enqueue, queued waits, claimed waits, start and default run authorization', { skip: !isolated, timeout: 30000 }, async () => {
  for (const state of ['queued', 'claimed']) {
    const f = await fixture(), { id, args, approvalId } = await commandJob(f), job = state === 'claimed' ? await claim(f, id) : null;
    await ageHeartbeat(f);
    const run = (await pool.query('SELECT * FROM project_runs WHERE id=$1', [f.runId])).rows[0];
    await assert.rejects(assertRunAuthorization(run), { code: 'LOCAL_DEVICE_OFFLINE' });
    await assert.rejects(f.service.enqueue(f.runId, 'terminal_test', args, { agentId: employee.id, callId: randomUUID(), sessionId: randomUUID(), approvalId }),
      { code: 'LOCAL_DEVICE_OFFLINE', notExecuted: true });
    if (job) {
      const response = await protocol(f, id, 'start', { claimToken: job.claimToken });
      assert.equal(response.status, 422); assert.equal(response.data.code, 'LOCAL_DEVICE_OFFLINE');
    }
    await assert.rejects(f.service.wait(id), { code: 'LOCAL_DEVICE_OFFLINE', notExecuted: true });
    assert.equal((await row(id)).status, 'cancelled'); assert.equal((await row(id)).started, false);
    assert.throws(() => readFileSync(join(f.workspace, 'executions.txt')), { code: 'ENOENT' });
  }
});

test('an old heartbeat does not bypass actual withdrawal, cancellation, version, lease or operation deadline checks', { skip: !isolated, timeout: 30000 }, async () => {
  for (const reason of ['disabled-device', 'changed-grant', 'commands-revoked', 'run-cancelled', 'run-finished', 'changed-version', 'expired-lease', 'replaced-worker', 'expired-operation']) {
    const f = await fixture(), { id, job, body } = await writeJob(f); await ageHeartbeat(f);
    if (reason === 'disabled-device') await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1', [f.device.id]);
    else if (reason === 'changed-grant') await pool.query('UPDATE local_devices SET grant_id=$1 WHERE id=$2', [randomUUID(), f.device.id]);
    else if (reason === 'commands-revoked') await pool.query('UPDATE local_devices SET allow_commands=false WHERE id=$1', [f.device.id]);
    else if (reason === 'run-cancelled') await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1', [f.runId]);
    else if (reason === 'run-finished') await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1", [f.runId]);
    else if (reason === 'changed-version') await pool.query('UPDATE projects SET version=version+1 WHERE id=$1', [f.projectId]);
    else if (reason === 'expired-lease') await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.runId]);
    else if (reason === 'replaced-worker') await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2', [randomUUID(), f.runId]);
    else await pool.query("UPDATE local_operations SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const code = reason === 'changed-version' ? 'RUN_REAPPROVAL_REQUIRED' : reason === 'commands-revoked' ? 'LOCAL_COMMAND_DENIED' : 'LOCAL_OPERATION_CANCELLED';
    await assert.rejects(f.service.wait(id), { code });
    const seen = (await pool.query('SELECT last_seen FROM local_devices WHERE id=$1', [f.device.id])).rows[0].last_seen;
    await submit(f, job, body);
    assert.deepEqual((await pool.query('SELECT last_seen FROM local_devices WHERE id=$1', [f.device.id])).rows[0].last_seen, seen, reason + ' late receipt must not refresh heartbeat');
    const stored = await row(id); assert.equal(stored.status, 'cancelled', reason); assert.equal(stored.started, true);
    assert.equal(stored.result, null); assert.deepEqual(stored.late_result, body);
    await assert.rejects(f.service.wait(id), { code: 'LOCAL_OPERATION_CANCELLED', notExecuted: false });
    assert.equal(readFileSync(join(f.workspace, 'once.txt'), 'utf8'), 'one native write');
  }
});

test('started caller cancellation and wrong claim tokens never adopt or replay an old successful receipt', { skip: !isolated, timeout: 30000 }, async () => {
  const f = await fixture(), { id, job, body } = await writeJob(f); await ageHeartbeat(f);
  const seen = (await pool.query('SELECT last_seen FROM local_devices WHERE id=$1', [f.device.id])).rows[0].last_seen;
  const wrong = await protocol(f, id, 'result', { ...body, claimToken: randomUUID() }); assert.equal(wrong.status, 403);
  assert.deepEqual((await pool.query('SELECT last_seen FROM local_devices WHERE id=$1', [f.device.id])).rows[0].last_seen, seen);
  assert.equal((await row(id)).status, 'started'); assert.equal((await row(id)).result, null);
  const controller = new AbortController(); controller.abort(Object.assign(Error('fixture explicit caller stop'), { code: 'FIXTURE_CALLER_ABORT' }));
  await assert.rejects(f.service.wait(id, controller.signal), { code: 'FIXTURE_CALLER_ABORT' });
  await submit(f, job, body); await submit(f, job, body);
  assert.deepEqual((await pool.query('SELECT last_seen FROM local_devices WHERE id=$1', [f.device.id])).rows[0].last_seen, seen);
  const stored = await row(id); assert.equal(stored.status, 'cancelled'); assert.equal(stored.result, null); assert.deepEqual(stored.late_result, body);
  await assert.rejects(f.service.wait(id), { code: 'LOCAL_OPERATION_CANCELLED', notExecuted: false });
  assert.equal(readFileSync(join(f.workspace, 'once.txt'), 'utf8'), 'one native write');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1 AND payload->>'name'='artifact_write'", [f.runId])).rows[0].n, 1);
});
