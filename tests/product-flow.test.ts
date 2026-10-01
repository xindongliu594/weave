import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { RunSandbox, listArtifacts, artifactFile } from '../services/agent-runtime/sandbox.mjs';
import { HandoffGate } from '../services/agent-runtime/handoff.mjs';

// The API, queue, billing and DSH host are real. Only the model and Docker
// boundary are test doubles; the fixed executor never runs model-supplied code.
const base = process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const schema = 'flow_' + Date.now();
const admin = new pg.Pool({ connectionString: base });
const expected = JSON.parse(readFileSync(new URL('./fixtures/offline-handoff/expected/report.json', import.meta.url), 'utf8'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let app: any, server: http.Server, gateway: http.Server, pool: pg.Pool, directory: string, url: string;
let modelId: string, mode = 'pass', commands = 0;
const steps = new Map<string, number>(), assignments: string[] = [], evidence: any[] = [];

before(async () => {
  await admin.query('CREATE SCHEMA ' + schema);
  const dbURL = new URL(base); dbURL.searchParams.set('options', '-c search_path=' + schema);
  process.env.DATABASE_URL = dbURL.toString();
  directory = await mkdtemp(join(tmpdir(), 'product-flow-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs');
  // Replace the readiness boundary directly on every OS. No shell shim or
  // PATH mutation; accidental real container operations must fail loudly.
  mock.method(RunSandbox, 'assertReady', async (signal?: AbortSignal) => { signal?.throwIfAborted(); });
  for (const name of ['start', 'file', 'sync'] as const) {
    mock.method(RunSandbox.prototype as any, name, async () => { throw Error('TEST_DOCKER_EXECUTION_FORBIDDEN'); });
  }
  mock.method(RunSandbox.prototype, 'close', async function () {});
  mock.method(RunSandbox.prototype, 'execute', async function (this: any, name: string, args: any, signal?: AbortSignal) {
    signal?.throwIfAborted(); mkdirSync(this.root, { recursive: true });
    if (args.expectedWorkspaceRevision) assert.equal(args.expectedWorkspaceRevision, this.revision());
    assert.ok(['result.json', 'review.json'].includes(args.path) || name === 'terminal_test');
    let result: any;
    if (name === 'artifact_write') {
      const file = join(this.root, args.path), current = existsSync(file) ? hash(readFileSync(file)) : undefined;
      if (current !== args.expectedSha256) throw Error('FILE_VERSION_CONFLICT');
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, args.content);
      result = { path: args.path, sha256: hash(args.content) };
    } else if (name === 'filesystem') {
      const content = readFileSync(artifactFile(this.root, args.path), 'utf8');
      result = { path: args.path, content, sha256: hash(content) };
    } else {
      assert.equal(name, 'terminal_test'); assert.equal(args.command, 'check-fixed-result'); commands++;
      const actual = JSON.parse(readFileSync(artifactFile(this.root, 'result.json'), 'utf8'));
      assert.deepEqual(actual, expected); result = { exitCode: 0, output: 'fixed JSON oracle passed' };
    }
    return { ...result, artifacts: listArtifacts(this.root), workspaceRevision: this.revision() };
  });
  const commit = HandoffGate.prototype.commit;
  mock.method(HandoffGate.prototype, 'commit', function (this: any, record: any) {
    commit.call(this, record);
    if (mode === 'stale' && record.taskId === 'produce') writeFileSync(join(this.sandbox.root, 'result.json'), '{}');
  });
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  const { createApp } = await import('../apps/api/src/app.ts'); app = createApp();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  gateway = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), messages = body.messages ?? [];
    assert.equal(req.headers.authorization, 'Bearer simulated-key');
    let message: any = { content: 'fixture done' };
    if (body.tools?.[0]?.function?.name === 'capability_probe') {
      message = tool('capability_probe', { nonce: body.tools[0].function.parameters.properties.nonce.enum[0] }, 'probe');
    } else if (messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'probe')) {
      message = { content: JSON.parse(messages.find((m: any) => m.tool_call_id === 'probe').content).result };
    } else {
      const assignment = messages.filter((m: any) => m.role === 'user' && typeof m.content === 'string').reverse().find((m: any) => m.content.includes('AgentTeams automatic task assignment'))?.content ?? '';
      const match = /Task: (t\d+).*?\[flow:(\w+)\]/.exec(assignment), attempt = /Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
      if (match) {
        const [, id, label] = match, key = id + ':' + attempt, step = steps.get(key) ?? 0;
        steps.set(key, step + 1); assignments.push(label);
        const update = (status: string, more: any = {}) => ['agent_teams_update_task', { task_id: id, attempt_id: attempt, status, ...more }];
        const actions: any[] = [['agent_teams_claim_task', { task_id: id }], update('in_progress')];
        if (label === 'produce') {
          if (mode !== 'missing') actions.push(['artifact_write', { path: 'result.json', content: JSON.stringify(expected) }]);
          if (!['missing', 'forged'].includes(mode)) actions.push(['terminal_test', { command: 'check-fixed-result' }]);
          actions.push(update('completed', { output: 'fixed report', changedPaths: ['result.json'], acceptanceResults: [{ criterion: 'result correct', status: 'passed', evidence: 'fixed fixture' }], commandsRun: [{ command: 'check-fixed-result', status: 'passed', exitCode: 0, evidence: 'model claim' }] }));
        } else {
          actions.push(['filesystem', { path: 'result.json' }], ['artifact_write', { path: 'review.json', content: '{"accepted":true}' }], update('completed', { output: 'independent review', verdict: 'pass' }));
        }
        if (step < actions.length) message = tool(actions[step][0], actions[step][1], key + ':' + step);
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  }).listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayId = (await call('/gateways', 'POST', { name: 'Simulated gateway', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1', apiKey: 'simulated-key' }, 201)).id;
  modelId = (await call('/models', 'POST', { gatewayId, model: 'fixture', name: 'Fixture model', inputRate: 1, outputRate: 2 }, 201)).id;
  await call('/models/' + modelId + '/test', 'POST', {});
  await call('/models/' + modelId + '/test-tools', 'POST', {});
});

after(async () => {
  await app?.locals.shutdown();
  for (const instance of [server, gateway]) if (instance) await new Promise<void>(resolve => instance.close(() => resolve()));
  mock.restoreAll();
  await pool?.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  if (process.env.E2E_EVIDENCE_PATH) writeFileSync(process.env.E2E_EVIDENCE_PATH, JSON.stringify({ executor: 'bounded test double', model: 'simulated HTTP gateway', scenarios: evidence }, null, 2) + '\n');
  if (directory) await rm(directory, { recursive: true, force: true });
});

function tool(name: string, args: any, id: string) { return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function call(path: string, method = 'GET', body?: any, status = 200) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(data)); return data;
}
async function waitFor(read: () => Promise<any>, accept: (value: any) => boolean, label: string) {
  const deadline = Date.now() + 20000; let value: any;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(label + ': ' + JSON.stringify(value));
}
async function launch(nextMode: string) {
  mode = nextMode; commands = 0; assignments.length = 0; steps.clear();
  const agents = [
    { id: 'manager', role: 'manager', name: '经理', tools: [] },
    { id: 'producer', role: 'member', name: '产出者', tools: ['artifact_write', 'terminal_test'] },
    { id: 'reviewer', role: 'member', name: '审查者', tools: ['filesystem', 'artifact_write'] },
  ].map(a => ({ ...a, title: a.name, instructions: 'Execute only the approved fixture tasks', modelId }));
  const department = await call('/departments', 'POST', { name: 'Flow ' + mode, description: 'Integration fixture', agents }, 201);
  const project = await call('/projects', 'POST', { departmentId: department.id, requirement: '生成固定测试报告并由另一位员工独立审查，核对文件版本和审批。', policy: { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 60 } }, 201);
  const original = (await call('/projects')).find((p: any) => p.id === project.id);
  const common = { estimatedInputTokens: 1000, estimatedOutputTokens: 512, maxModelCalls: 15, maxBudget: .2 };
  const plan = { rationale: 'An approved producer and an independent reviewer exchange a versioned file', agents: original.plan.agents, tasks: [
    { ...common, id: 'produce', subject: '[flow:produce]', objective: 'Write the fixed report', assigneeId: 'producer', dependencies: [], acceptanceCriteria: ['result correct'], kind: 'implementation', inScope: ['result.json'], verify: ['check-fixed-result'], outputs: [{ path: 'result.json', format: 'json', requiredKeys: ['orderCount', 'totalCents'], expectedValues: expected }] },
    { ...common, id: 'review', subject: '[flow:review]', objective: 'Read and independently review the fixed report', assigneeId: 'reviewer', dependencies: ['produce'], acceptanceCriteria: ['independent approval'], kind: 'review', reviewedTaskId: 'produce', inputs: [{ path: 'result.json', producerTaskId: 'produce' }], outputs: [{ path: 'review.json', format: 'json', expectedValues: { accepted: true } }] },
  ] };
  await call('/projects/' + project.id + '/plan', 'PUT', { version: 1, plan });
  const saved = (await call('/projects')).find((p: any) => p.id === project.id); assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation));
  return (await call('/projects/' + project.id + '/approve', 'POST', { version: 2 }, 202)).id;
}
const approvals = (id: string) => call('/approvals?runId=' + id);
const run = (id: string) => call('/runs/' + id);
async function pendingApproval(id: string) { return (await waitFor(() => approvals(id), list => list.some((a: any) => a.status === 'pending'), 'pending approval')).find((a: any) => a.status === 'pending'); }
async function stopped(id: string) {
  const result = await waitFor(() => run(id), r => ['completed', 'failed', 'cancelled'].includes(r.status), 'stopped run');
  assert.equal(result.integrity, 'ok', 'every stopped run must have a complete archive'); return result;
}

test('approved API flow waits for command approval, hands off verified files and settles usage', { timeout: 30000 }, async () => {
  const id = await launch('pass'), approval = await pendingApproval(id);
  assert.equal(commands, 0); assert.ok(!assignments.includes('review')); assert.equal(approval.tool, 'terminal_test');
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' });
  const result = await stopped(id); assert.equal(result.status, 'completed', JSON.stringify(result.events.slice(-8))); assert.equal(commands, 1);
  assert.equal(result.integrity, 'ok', 'approval and runtime writers must preserve one complete event journal');
  const seals = result.events.filter((e: any) => e.type === 'handoff/accepted'); assert.equal(seals.length, 2);
  assert.equal(seals[1].data.inputs[0].sha256, seals[0].data.outputs[0].sha256);
  const artifact = await fetch(url + '/runs/' + id + '/artifact?path=result.json'); assert.equal(artifact.status, 200); assert.deepEqual(await artifact.json(), expected);
  assert.deepEqual((await call('/runs/' + id + '/artifacts')).map((f: any) => f.path).sort(), ['result.json', 'review.json']);
  const exported = await call('/runs/' + id + '/export'); assert.equal(exported.integrity, 'ok'); assert.ok(!JSON.stringify(exported).includes('simulated-key'));
  const usage = (await call('/usage')).filter((u: any) => u.runId === id);
  const producer = usage.find((u: any) => u.employeeId === 'producer'), reviewer = usage.find((u: any) => u.employeeId === 'reviewer');
  assert.ok(producer?.sessionId && reviewer?.sessionId); assert.notEqual(producer.sessionId, reviewer.sessionId);
  assert.equal(result.snapshot.runtimeArchitecture, 'employee-host-v1');
  const hosts = result.events.filter((e: any) => e.type === 'runtime/created');
  for (const receipt of [producer, reviewer]) {
    assert.ok(hosts.some((e: any) => e.sessionId === receipt.sessionId && e.data.agentId === receipt.agentId && e.data.employeeId === receipt.employeeId), 'Host identity must match the billed session and employee');
  }
  assert.equal(new Set(hosts.map((e: any) => e.data.hostId)).size, hosts.length, 'every residency has its own Host');
  const disposed = result.events.filter((e: any) => e.type === 'runtime/disposed');
  assert.deepEqual(disposed.map((e: any) => e.data.hostId).sort(), hosts.map((e: any) => e.data.hostId).sort(), 'completed runs release every employee Host');
  for (const host of hosts) {
    assert.ok(disposed.some((e: any) => e.data.hostId === host.data.hostId && e.sessionId === host.sessionId && e.data.agentId === host.data.agentId && e.data.employeeId === host.data.employeeId));
  }
  const receipts = (await pool.query('SELECT id,status FROM model_reservations WHERE run_id=$1', [id])).rows;
  assert.ok(usage.length > 0); assert.ok(usage.every((u: any) => receipts.some(r => r.id === u.id && r.status === 'settled')));
  assert.ok(receipts.every(r => r.status !== 'pending'));
  evidence.push({ scenario: 'approval-handoff-billing', status: result.status, seals: seals.length, commands, usageRows: usage.length, separateWorkerSessions: true, report: expected });
});

test('missing output and forged verification cannot dispatch the dependent reviewer', { timeout: 30000 }, async () => {
  for (const fault of ['missing', 'forged']) {
    const id = await launch(fault);
    const result = await waitFor(() => run(id), r => r.events?.some((e: any) => e.type === 'handoff/blocked'), fault + ' blocked');
    assert.ok(result.events.some((e: any) => e.type === 'handoff/blocked' && e.data.message.includes(fault === 'missing' ? 'MISSING_FILE' : 'UNVERIFIED_COMMAND')));
    assert.ok(!assignments.includes('review')); assert.equal(commands, 0); assert.equal((await approvals(id)).length, 0);
    assert.equal(result.events.filter((e: any) => e.type === 'handoff/accepted').length, 0);
    await call('/runs/' + id + '/cancel', 'POST', {}, 202); await stopped(id);
    evidence.push({ scenario: fault, downstreamModelCalls: 0, commands, blocked: true });
  }
});

test('a modified accepted input is rejected before the reviewer makes a model request', { timeout: 30000 }, async () => {
  const id = await launch('stale'), approval = await pendingApproval(id);
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' });
  const result = await stopped(id); assert.equal(result.status, 'failed'); assert.ok(!assignments.includes('review'));
  assert.ok(result.events.some((e: any) => e.type === 'handoff/blocked' && e.data.message.includes('VERSION_MISMATCH')));
  evidence.push({ scenario: 'stale-input', status: result.status, downstreamModelCalls: 0, blocked: true });
});

test('cancellation while approval is pending cancels the receipt and never runs the command', { timeout: 30000 }, async () => {
  const id = await launch('cancel'), approval = await pendingApproval(id);
  await call('/runs/' + id + '/cancel', 'POST', {}, 202);
  assert.equal((await stopped(id)).status, 'cancelled'); assert.equal(commands, 0); assert.ok(!assignments.includes('review'));
  assert.equal((await approvals(id)).find((a: any) => a.id === approval.id).status, 'cancelled');
  await call('/approvals/' + approval.id, 'POST', { decision: 'approved' }, 409);
  evidence.push({ scenario: 'cancel-pending-approval', status: 'cancelled', commands, obsoleteApprovalStatus: 409 });
});
