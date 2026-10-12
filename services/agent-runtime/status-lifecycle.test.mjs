import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EmployeeHostFactory } from './employee-hosts.mjs';
import { ProductDshRuntime } from './product-runtime.mjs';
import { readRun } from './trace-store.mjs';
import { listArtifacts } from './sandbox.mjs';
import { workspaceRevision } from './handoff.mjs';

// Real native Host/AgentTeams lifecycle with synthetic loopback replies and a
// disposable fixture workspace. No original API/DB/model/employee files.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixturePath = 'fixture.test.mjs', command = 'node --test ' + fixturePath;
const fixtureSource = "import test from 'node:test'; import assert from 'node:assert/strict'; test('local fixture', () => assert.equal(1, 1));\n";
const employee = (id, role, tools) => ({ id, employeeId: id, role, modelId: id,
  rolePrompt: 'Execute only this synthetic lifecycle fixture.', tools });
const contract = (id, assignee, dependencies, extra = {}) => ({ id, subject: id, assignee, assigneeId: assignee,
  kind: 'work', objective: 'Inspect or deliver this synthetic fixture.', dependencies,
  acceptanceCriteria: ['fixture task complete'], inputs: [], outputs: [], verify: [], maxOutputTokens: 512, maxModelCalls: 12, ...extra });

async function lifecycle(t, { resumeDelayMs = 0, cancelOnResume = false, deadlineDuringResume = false, deadlineSeconds = 45, qaOutcome } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'status-lifecycle-')), id = randomUUID();
  const snapshot = { mode: 'product', projectId: randomUUID(), planVersion: 8, requirement: 'Disposable engineering lifecycle fixture',
    executionBudget: 1, approval: { kind: 'project', projectVersion: 8 },
    policy: { maxBudget: 1, maxConcurrentAgents: 2, deadlineSeconds, contextManagement: 'prune', contextBytes: 192000,
      maxModelCalls: 100, maxTaskModelCalls: 20, allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] },
    agents: [employee('manager', 'manager', ['filesystem', 'artifact_write']), employee('dev', 'member', ['artifact_write', 'terminal_test']), employee('qa', 'member', ['filesystem', 'terminal_test'])],
    tasks: [
      contract('dev', 'dev', [], { kind: 'implementation', outputs: [{ path: fixturePath, format: 'text' }], inScope: [fixturePath], verify: [command] }),
      contract('qa_verify', 'qa', ['dev'], { kind: 'verification', inputs: [{ path: fixturePath, producerTaskId: 'dev' }], verify: [command] }),
      contract('qa_review', 'qa', ['dev', 'qa_verify'], { kind: 'review', reviewedTaskId: 'dev', inputs: [{ path: fixturePath, producerTaskId: 'dev' }], verify: [command] }),
      contract('manager_accept', 'manager', ['dev', 'qa_review'], { inputs: [{ path: fixturePath, producerTaskId: 'dev' }], outputs: [{ path: 'report.txt', format: 'text' }], inScope: ['report.txt'] }),
    ] };
  const receipts = [], wires = [], usage = [], steps = new Map(), resumed = Promise.withResolvers();
  const realResume = EmployeeHostFactory.prototype.resume;
  let releaseResume, resumeCount = 0, resumeTimer;
  const resumeGate = new Promise(resolve => { releaseResume = resolve; });
  t.mock.method(EmployeeHostFactory.prototype, 'resume', function (owner, options) {
    resumeCount++;
    const setup = options.setup;
    return realResume.call(this, owner, { ...options, async setup(ctx, agent) {
      const prepared = await setup?.(ctx, agent);
      if (agent.options.model === 'qa') {
        resumed.resolve({ sessionId: agent.id });
        if (cancelOnResume || deadlineDuringResume) await resumeGate;
        else if (resumeDelayMs) await new Promise(resolve => { resumeTimer = setTimeout(resolve, resumeDelayMs); });
      }
      return prepared;
    } });
  });
  const server = http.createServer(async (request, result) => {
    let text = ''; for await (const part of request) text += part;
    const body = JSON.parse(text), receipt = receipts.find(row => !row.claimed && row.modelId === body.model);
    assert.ok(receipt, 'every local model reply has an admitted request'); receipt.claimed = true;
    wires.push({ modelId: body.model, taskId: receipt.taskId, sessionId: receipt.sessionId });
    const key = receipt.taskId + ':' + receipt.attemptId, step = steps.get(key) ?? 0; steps.set(key, step + 1);
    const update = extra => ['agent_teams_update_task', { task_id: receipt.runtimeTaskId, attempt_id: receipt.attemptId, status: 'completed', output: 'Synthetic fixture outcome',
      acceptanceResults: [{ criterion: 'fixture task complete', status: 'passed', evidence: 'local fixture only' }], commandsRun: [{ command, status: 'passed', exitCode: 0, evidence: 'host must verify its own receipt' }], ...extra }];
    const actions = [['agent_teams_claim_task', { task_id: receipt.runtimeTaskId }],
      ['agent_teams_update_task', { task_id: receipt.runtimeTaskId, attempt_id: receipt.attemptId, status: 'in_progress' }]];
    if (receipt.taskId === 'dev') actions.push(['artifact_write', { path: fixturePath, content: fixtureSource }], ['terminal_test', { command }], update({ changedPaths: [fixturePath] }));
    if (receipt.taskId === 'qa_verify') actions.push(['filesystem', { path: fixturePath }], ['terminal_test', { command }], update(), ['agent_teams_send_message', { to: 'captain', content: 'Synthetic QA verification complete; scheduler owns the next assignment.' }]);
    if (receipt.taskId === 'qa_review') actions.push(['filesystem', { path: fixturePath }], ['terminal_test', { command }], update({ verdict: 'pass' }));
    if (receipt.taskId === 'manager_accept') actions.push(['filesystem', { path: fixturePath }], ['artifact_write', { path: 'report.txt', content: 'Synthetic lifecycle complete' }], update({ changedPaths: ['report.txt'], commandsRun: [] }));
    let action = receipt.taskId ? actions[step] : undefined;
    if(receipt.taskId==='qa_review'&&qaOutcome==='missing'&&step>=2)action=undefined;
    if(receipt.taskId==='qa_review'&&qaOutcome==='reject'&&step===4)
      action=['agent_teams_update_task',{task_id:receipt.runtimeTaskId,attempt_id:receipt.attemptId,status:'failed',
        output:'Synthetic independent review rejected this fixture.',verdict:'reject',
        findings:[{id:'fixture-rejection',severity:'high',problem:'Synthetic acceptance mismatch',requiredFix:'Correct the fixture'}]}];
    result.setHeader('content-type', 'application/json');
    result.end(JSON.stringify({ choices: [{ message: action ? { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { content: 'Synthetic turn complete.' }, finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const runtime = new ProductDshRuntime({ traceRoot: root, beforeRequest: async (_id, row) => receipts.push({ ...row }), onUsage: async (_id, row) => usage.push(row), requestApproval: async () => randomUUID(),
    createExecutor: archive => {
      const files = join(archive.dir, 'artifacts'); mkdirSync(files, { recursive: true });
      return { root: files, revision: () => workspaceRevision(files), prepare: async () => {}, close: async () => {}, async execute(name, args, _signal, context) {
        if (name === 'artifact_write') { writeFileSync(join(files, args.path), args.content); return { artifacts: listArtifacts(files) }; }
        if (name === 'terminal_test') {
          assert.equal(args.command, command); const operationId = randomUUID();
          archive.append('local/operation-queued', { operationId, name, ...context });
          const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixturePath], { cwd: files, encoding: 'utf8', timeout: 5000,
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() } });
          assert.equal(result.error, undefined); assert.equal(result.status, 0);
          archive.append('local/operation-finished', { operationId, name, ...context, localWorkspace: files });
          return { exitCode: result.status, output: result.stdout + result.stderr, artifacts: listArtifacts(files), workspaceRevision: workspaceRevision(files) };
        }
        assert.equal(name, 'filesystem'); const bytes = readFileSync(join(files, args.path));
        return { path: args.path, content: bytes.toString(), sha256: hash(bytes), artifacts: listArtifacts(files) };
      } };
    } });
  try {
    const start = await runtime.start({ runId: id, approvedSnapshot: snapshot, routes: snapshot.agents.map(agent => ({ id: agent.modelId, wireModel: agent.modelId, name: agent.modelId,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, inputRate: 1, outputRate: 2, maxOutputTokens: 512 })) });
    if (cancelOnResume) { await Promise.race([resumed.promise, start.completion.then(result => { throw Error('Fixture stopped before native resume: ' + result.message); })]); const cancellation = runtime.cancel(id); releaseResume(); await cancellation; }
    if (deadlineDuringResume) {
      await Promise.race([resumed.promise, start.completion.then(result => { throw Error('Fixture stopped before native resume: ' + result.message); })]);
      // The production deadline closes Hosts and cancels unpublished setup.
      // Release only the test-owned gate after its durable deadline event.
      while (!readRun(root, id).events.some(e => e.type === 'run/deadline-exceeded')) await new Promise(resolve => setTimeout(resolve, 10));
      releaseResume();
    }
    const outcome = await start.completion, archive = readRun(root, id);
    return { outcome, archive, wires, usage, resumeCount };
  } finally {
    clearTimeout(resumeTimer); releaseResume(); await runtime.cancel(id); t.mock.restoreAll();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
}

test('native same-QA verification then review survives a cold resume longer than the old status deadline', { timeout: 45000 }, async t => {
  const { outcome, archive, wires, usage, resumeCount } = await lifecycle(t, { resumeDelayMs: 16000 });
  assert.equal(outcome.status, 'completed', outcome.message); assert.equal(archive.integrity, 'ok'); assert.ok(resumeCount >= 1);
  assert.deepEqual(archive.events.filter(e => e.type === 'handoff/accepted').map(e => e.data.taskId), ['dev', 'qa_verify', 'qa_review', 'manager_accept']);
  const qaTurns = archive.events.filter(e => e.type === 'runtime/created' && e.data.employeeId === 'qa');
  assert.equal(qaTurns.length, 2); assert.equal(qaTurns[0].data.sessionId, qaTurns[1].data.sessionId); assert.equal(qaTurns[1].data.resumed, true);
  const statusEnds = archive.events.filter(e => e.type === 'tool/result' && e.data.name === 'agent_teams_status');
  assert.ok(statusEnds.some(end => { const start = archive.events.find(e => e.type === 'tool/start' && e.callId === end.callId); return Date.parse(end.at) - Date.parse(start.at) >= 15000; }));
  assert.ok(statusEnds.every(e => !e.data.result.isError));
  assert.ok(wires.some(row => row.taskId === 'qa_review')); assert.ok(wires.some(row => row.taskId === 'manager_accept'));
  assert.equal(usage.length, wires.length); assert.ok(!archive.events.some(e => e.type === 'billing/unconfirmed'));
});

test('user cancellation still aborts native cold resume without executing a later task', { timeout: 15000 }, async t => {
  const { outcome, archive, wires } = await lifecycle(t, { cancelOnResume: true });
  assert.equal(outcome.status, 'cancelled'); assert.equal(archive.integrity, 'ok');
  assert.ok(!wires.some(row => row.taskId === 'qa_review' || row.taskId === 'manager_accept'));
  assert.ok(archive.events.some(e => e.type === 'handoff/accepted' && e.data.taskId === 'qa_verify'));
  assert.ok(!archive.events.some(e=>e.type==='handoff/reminder'));
  assert.equal(archive.events.at(-1).type, 'run/finished');
});

test('missing formal QA handoff stops product admission before a coordinator or manager can take over', {timeout:20000},async t=>{
  const {outcome,archive,wires,usage}=await lifecycle(t,{qaOutcome:'missing'});
  assert.equal(outcome.status,'failed');assert.match(outcome.message,/HANDOFF_NOT_SUBMITTED/);
  assert.equal(archive.integrity,'ok');
  assert.equal(archive.events.filter(e=>e.type==='handoff/reminder').length,1);
  assert.equal(archive.events.filter(e=>e.type==='handoff/missing').length,1);
  assert.deepEqual(archive.events.filter(e=>e.type==='handoff/accepted').map(e=>e.data.taskId),['dev','qa_verify']);
  assert.equal(wires.filter(row=>row.taskId==='qa_review').length,4);
  assert.ok(!wires.some(row=>row.taskId==='manager_accept'));
  const stopped=archive.events.find(e=>e.type==='handoff/missing').seq;
  assert.ok(!archive.events.some(e=>e.type==='model/wire-request'&&e.seq>stopped),'failure closes every new model admission');
  assert.equal(usage.length,wires.length,'every already dispatched fixture request settles');
});

test('a formal negative QA verdict remains a failed review and never unlocks manager acceptance', {timeout:20000},async t=>{
  const {outcome,archive,wires}=await lifecycle(t,{qaOutcome:'reject'});
  assert.equal(outcome.status,'failed');
  assert.ok(archive.events.some(e=>e.type==='quality/review-submitted'&&e.data.taskId==='qa_review'&&e.data.verdict==='reject'));
  assert.deepEqual(archive.events.filter(e=>e.type==='handoff/accepted').map(e=>e.data.taskId),['dev','qa_verify']);
  assert.ok(!wires.some(row=>row.taskId==='manager_accept'));
  assert.ok(!archive.events.some(e=>e.type==='handoff/reminder'));
});

test('the approved run deadline still aborts native cold resume and preserves accepted predecessors', { timeout: 25000 }, async t => {
  const { outcome, archive, wires } = await lifecycle(t, { deadlineDuringResume: true, deadlineSeconds: 15 });
  assert.equal(outcome.status, 'failed'); assert.equal(archive.integrity, 'ok');
  assert.ok(archive.events.some(e => e.type === 'run/deadline-exceeded' && e.data.deadlineSeconds === 15));
  assert.equal(archive.events.at(-1).data.code, 'RUN_DEADLINE_EXCEEDED');
  assert.ok(!wires.some(row => row.taskId === 'qa_review' || row.taskId === 'manager_accept'));
  assert.deepEqual(archive.events.filter(e => e.type === 'handoff/accepted').map(e => e.data.taskId), ['dev', 'qa_verify']);
});
