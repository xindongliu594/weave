import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HandoffGate } from './handoff.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { ExecutionBudget } from './budget.mjs';
import { buildCheckpointContext } from './checkpoint-context.mjs';
import { commandEvidence, nodeTestCounts, localOperationEvidence, captureBudgetEvidence, sourceBudgetEvidence, taskRunEvidence, inheritedBudgetEvidence } from './run-evidence.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const summary = '# tests 2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
test('task sandbox command validity compares its accepted work revision while canonical includes unrelated files',()=>{
 const work='a'.repeat(64),canonical='b'.repeat(64),key={runId:'run',taskId:'a',attemptId:'attempt',generation:1};
 const tasks=[{id:'a',dependencies:[]},{id:'b',dependencies:['a']}],snapshot={tasks},record={taskId:'a',attemptId:'attempt',runId:'run',workspaceRevision:canonical,sandboxWorkRevision:work,taskExecution:{profile:'task-attempt-openshell-v1',key},commands:[{command:'check',exitCode:0,workspaceRevision:work,taskExecution:{profile:'task-attempt-openshell-v1',key,afterWorkRevision:work}}]};
 const evidence=taskRunEvidence({snapshot,taskId:'b',state:{tasks:[{id:'a',status:'completed',attemptId:'attempt'}]},taskIds:new Map(),handoff:{tasks:new Map(tasks.map(t=>[t.id,t])),committed:new Map([['a',record]])},runId:'run'});
 assert.equal(evidence.completedAncestors[0].commands[0].validAtAccepted,true);
 record.commands[0].taskExecution.key={...key,generation:2};
 assert.equal(taskRunEvidence({snapshot,taskId:'b',state:{tasks:[{id:'a',status:'completed',attemptId:'attempt'}]},taskIds:new Map(),handoff:{tasks:new Map(tasks.map(t=>[t.id,t])),committed:new Map([['a',record]])},runId:'run'}).completedAncestors[0].commands[0].validAtAccepted,false);
});
test('source checkpoint retains durable admission call provenance while old inherited snapshots keep the wire basis', () => {
  const callsBasis = 'durable-admissions-and-archived-wire-requests';
  const snapshot = { projectId: 'project', planVersion: 8, executionBudget: .7, costCarryover: { recordedCost: .2, reserved: .096526 },
    budgetHistory: { calls: 24, callsBasis } };
  const budget = new ExecutionBudget({ maxBudget: .7, priorSpend: .296526, priorModelCalls: 24 });
  const seal = captureBudgetEvidence(snapshot, budget, 'parent', 'runtime-checkpoint');
  const source = sourceBudgetEvidence(snapshot, [{ seq: 1, type: 'team/checkpoint', data: { budgetEvidence: seal } }], 'parent');
  assert.equal(source.sourceAdmission.callsBasis, callsBasis); assert.equal(source.sourceAdmission.callsUsed, 24);
  assert.equal(source.project.callsUsed, 24); assert.equal(source.sourceAdmission.retainedUnknownReservation, .096526);
  assert.equal(inheritedBudgetEvidence({ ...snapshot, budgetHistory: { calls: 23 } }).callsBasis, 'archived-model-wire-request-count');
});
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'run-evidence-'));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('actual Node test child output yields pass/fail/skip counts and hashes without exposing any terminal body', () => fixture(root => {
  writeFileSync(join(root, 'sample.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('pass',()=>assert.equal(1,1)); test.skip('skip',()=>{}); console.log('TERMINAL_PRIVATE_BODY');");
  const actual = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'sample.test.mjs'], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(actual.status, 0); assert.equal(actual.error, undefined);
  const result = { exitCode: actual.status, output: actual.stdout + actual.stderr };
  const evidence = commandEvidence({ name: 'terminal_test', args: { command: 'node --test sample.test.mjs' }, result });
  assert.equal(evidence.nodeTests.status, 'available', JSON.stringify({ diagnostic: evidence.nodeTests, stdout: actual.stdout, stderr: actual.stderr }));
  assert.deepEqual([evidence.nodeTests.tests, evidence.nodeTests.pass, evidence.nodeTests.fail, evidence.nodeTests.skipped], [2, 1, 0, 1]);
  assert.equal(evidence.output.sha256, sha(result.output)); assert.equal(evidence.output.bytes, Buffer.byteLength(result.output));
  assert.equal(evidence.stdout.status, 'unknown'); assert.equal(evidence.stderr.status, 'unknown');
  assert.ok(!JSON.stringify(evidence).includes('TERMINAL_PRIVATE_BODY'));
  writeFileSync(join(root, 'sample.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fail',()=>assert.equal(1,2));");
  const failed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'sample.test.mjs'], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(failed.status, 1);
  const counts = nodeTestCounts('node --test sample.test.mjs', failed.stdout + failed.stderr);
  assert.equal(counts.status, 'available'); assert.equal(counts.fail, 1); assert.equal(counts.pass, 0);
}));

test('partial, conflicting, multi-command or repeated Node summaries cannot become verified counts', () => {
  assert.equal(nodeTestCounts('node --test sample.test.mjs', summary).status, 'available');
  assert.equal(nodeTestCounts('node --test sample.test.mjs', summary.replaceAll('#', 'ℹ')).format, 'spec');
  for (const [command, output, complete] of [
    ['node --test a.mjs; node --test b.mjs', summary, true], ['npm test', summary, true],
    ['node --test a.mjs', summary.repeat(2), true], ['node --test a.mjs', summary.replace('# fail 0\n', ''), true],
    ['node --test a.mjs', summary.replace('# tests 2', '# tests 9'), true], ['node --test a.mjs', summary, false],
    ['node --test a.mjs', undefined, true],
  ]) assert.equal(nodeTestCounts(command, output, complete).status, 'unknown');
  const claims = commandEvidence({ name: 'terminal_test', args: { command: 'node --test a.mjs' }, result: { exitCode: 0, testCounts: { tests: 20, pass: 20 }, stdoutSha256: 'a'.repeat(64) } });
  assert.equal(claims.output.status, 'unknown'); assert.equal(claims.nodeTests.status, 'unknown'); assert.equal(claims.stdout.status, 'unknown');
});

test('operation metadata requires one exact completed run/call/attempt/approval chain and never uses a returned claimed ID', () => fixture(root => {
  const archive = createRunArchive(root, { projectId: 'project' });
  const context = { name: 'terminal_test', taskId: 'qa', attemptId: 'attempt', sessionId: 'qa-session', callId: 'call', approvalId: 'approval' };
  const operationId = randomUUID();
  archive.append('local/operation-queued', { ...context, operationId });
  assert.equal(localOperationEvidence(archive, context).status, 'unknown');
  archive.append('local/operation-finished', { ...context, operationId, localWorkspace: 'PRIVATE_LOCAL_PATH' });
  const actual = localOperationEvidence(archive, context);
  assert.equal(actual.status, 'available'); assert.equal(actual.operationId, operationId);
  for (const field of ['taskId', 'attemptId', 'sessionId', 'callId', 'approvalId']) assert.equal(localOperationEvidence(archive, { ...context, [field]: 'stale' }).status, 'unknown');
  const receipt = commandEvidence({ archive, name: context.name, taskId: context.taskId, attemptId: context.attemptId,
    args: { command: 'node --test a.mjs' }, context, result: { output: summary, exitCode: 0, operationId: 'FORGED' } });
  assert.equal(receipt.operation.operationId, operationId); assert.ok(!JSON.stringify(receipt).includes('PRIVATE_LOCAL_PATH'));
  archive.append('local/operation-finished', { ...context, operationId });
  assert.equal(localOperationEvidence(archive, context).status, 'unknown');
}));

test('downstream evidence is limited to committed ancestors and keeps raw private fields and model claims out', () => fixture(root => {
  const snapshot = { projectId: 'project', planVersion: 2, tasks: [
    { id: 'dev', dependencies: [], outputs: [] }, { id: 'qa', dependencies: ['dev'], outputs: [] },
    { id: 'manager', dependencies: ['qa'], outputs: [] }, { id: 'sibling', dependencies: [], outputs: [] },
  ] };
  const archive = createRunArchive(join(root, 'runs'), snapshot), files = join(root, 'files'); mkdirSync(files);
  const gate = new HandoffGate({ snapshot, sandbox: { root: files }, archive });
  const contexts = new Map();
  for (const taskId of ['dev', 'qa', 'sibling']) {
    const attemptId = taskId + '-attempt', context = { sessionId: taskId + '-session', callId: taskId + '-call', approvalId: taskId + '-approval' };
    gate.observe(taskId, attemptId, 'terminal_test', { command: 'node --test a.mjs' }, { exitCode: 0, output: summary + 'PRIVATE_QA_KB_AND_TERMINAL_TEXT' }, [], context);
    const record = gate.prepare(taskId, attemptId, {});
    record.privateKnowledge = 'PRIVATE_QA_KB_AND_TERMINAL_TEXT'; record.commands[0].evidence.output.content = 'PRIVATE_QA_KB_AND_TERMINAL_TEXT';
    gate.commit(record); contexts.set(taskId, context);
  }
  const state = { tasks: ['dev', 'qa', 'manager', 'sibling'].map(name => ({ id: 'native-' + name, status: name === 'manager' ? 'in_progress' : 'completed', attemptId: name + '-attempt', output: 'UNTRUSTED_CLAIM' })) };
  const taskIds = new Map(state.tasks.map(task => [task.id, task.id.slice(7)]));
  const before = JSON.stringify(snapshot), evidence = taskRunEvidence({ snapshot, taskId: 'manager', state, taskIds, handoff: gate, runId: archive.id });
  assert.deepEqual(evidence.completedAncestors.map(node => node.taskId).sort(), ['dev', 'qa']);
  assert.ok(!JSON.stringify(evidence).includes('PRIVATE_QA_KB_AND_TERMINAL_TEXT')); assert.ok(!JSON.stringify(evidence).includes('UNTRUSTED_CLAIM'));
  for (const node of evidence.completedAncestors) {
    assert.equal(node.commands[0].approval.approvalId, contexts.get(node.taskId).approvalId);
    assert.equal(node.commands[0].nodeTests.tests, 2); assert.equal(node.commands[0].validAtAccepted, true);
    assert.ok(node.commands[0].observationSeq > 0);
  }
  const qaRecord = gate.committed.get('qa'); gate.committed.delete('qa'); gate.stage(qaRecord);
  assert.deepEqual(taskRunEvidence({ snapshot, taskId: 'manager', state, taskIds, handoff: gate, runId: archive.id }).completedAncestors.map(node => node.taskId), ['dev'], 'a provisional seal is not a committed receipt');
  gate.commit(qaRecord);
  state.tasks.find(task => task.id === 'native-qa').status = 'in_progress';
  assert.deepEqual(taskRunEvidence({ snapshot, taskId: 'manager', state, taskIds, handoff: gate, runId: archive.id }).completedAncestors.map(node => node.taskId), ['dev']);
  state.tasks.find(task => task.id === 'native-qa').status = 'completed'; state.tasks.find(task => task.id === 'native-qa').attemptId = 'stale';
  assert.equal(taskRunEvidence({ snapshot, taskId: 'manager', state, taskIds, handoff: gate, runId: archive.id }).unavailableAncestors[0].taskId, 'qa');
  assert.equal(JSON.stringify(snapshot), before);
}));

test('recovery seals the actual latest host budget and separates inherited unknown holds from recorded fee; old missing records stay unknown', () => fixture(root => {
  const snapshot = { projectId: 'project', planVersion: 2, tasks: [{ id: 'dev', dependencies: [], outputs: [] }], policy: { maxBudget: 1 },
    executionBudget: .8, costCarryover: { recordedCost: .17, reserved: .03, availableBudget: .8 }, budgetHistory: { calls: 7 } };
  const budget = new ExecutionBudget({ maxBudget: .8, priorSpend: .2, priorModelCalls: 7, maxModelCalls: 50 });
  const archive = createRunArchive(root, snapshot), files = join(archive.dir, 'artifacts'); mkdirSync(files);
  const atNode = captureBudgetEvidence(snapshot, budget, archive.id, 'node-accepted');
  archive.append('handoff/accepted', { taskId: 'dev', budgetEvidence: atNode });
  const ticket = budget.reserve(.02); ticket.settle(.004);
  const atStop = captureBudgetEvidence(snapshot, budget, archive.id); archive.append('team/checkpoint', { tasks: [], budgetEvidence: atStop });
  const events = readRun(root, archive.id).events;
  const recovery = buildCheckpointContext(snapshot, events, new Map(), new Map(), files, archive.id);
  assert.equal(recovery.budgetEvidence.status, 'available'); assert.equal(recovery.budgetEvidence.project.callsUsed, 8);
  assert.ok(Math.abs(recovery.budgetEvidence.project.occupied - .204) < 1e-12);
  assert.equal(recovery.budgetEvidence.sourceAdmission.recordedCost, .17);
  assert.equal(recovery.budgetEvidence.sourceAdmission.retainedUnknownReservation, .03);
  assert.equal(recovery.budgetEvidence.currentAtSourceEnd, true);
  archive.append('model/wire-request', {});
  const stale = sourceBudgetEvidence(snapshot, readRun(root, archive.id).events, archive.id);
  assert.equal(stale.currentAtSourceEnd, false); assert.equal(stale.subsequentAccountingEvents, 1);
  assert.equal(atNode.project.callsUsed, 7); assert.equal(budget.run.calls, 8);
  assert.equal(sourceBudgetEvidence(snapshot, [], archive.id).status, 'unknown');
  assert.equal(sourceBudgetEvidence(snapshot, [{ type: 'team/checkpoint', data: { budgetEvidence: { ...atStop, runId: 'other-run' } } }], archive.id).status, 'unknown');
  const old = captureBudgetEvidence({}, undefined, archive.id);
  assert.equal(old.project.callsUsed, null); assert.equal(old.inherited.recordedCost, null); assert.equal(old.inherited.retainedUnknownReservation, null);
  assert.equal(old.inherited.callsUsed, null);
  const zero = captureBudgetEvidence({ executionBudget: 0, costCarryover: { recordedCost: 0, reserved: 0 }, budgetHistory: { calls: 0 } }, { run: { limit: 0, spent: 0, reserved: 0, calls: 0, maxCalls: 0 } }, archive.id);
  assert.equal(zero.project.callsUsed, 0); assert.equal(zero.inherited.recordedCost, 0);
}));
