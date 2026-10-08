import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createTeamHost } from './host.mjs';
import { teamTaskPlan, stageApprovedTeam, workspaceRevision } from './handoff.mjs';
import { buildCheckpointContext } from './checkpoint-context.mjs';
import { listArtifacts } from './sandbox.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { ExecutionBudget } from './budget.mjs';
import { Semaphore } from './limits.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const source = "import test from 'node:test'; import assert from 'node:assert/strict'; test('real local fixture',()=>assert.equal(2+2,4)); test.skip('documented skipped fixture',()=>{}); console.log('PRIVATE_TERMINAL_TEXT');\n";
const command = 'node --test fixture.test.mjs';
const privateText = 'QA_PRIVATE_KNOWLEDGE_BODY';
const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
const initialSnapshot = () => ({ projectId: 'local-evidence-project', planVersion: 2, requirement: 'Local metadata regression only',
  policy: { maxBudget: 1, contextBytes: 192000 }, executionBudget: .8,
  costCarryover: { recordedCost: .17, reserved: .03, availableBudget: .8 }, budgetHistory: { calls: 7, tasks: {} },
  agents: [
    { id: 'manager', employeeId: 'original-manager', role: 'manager', modelId: 'captain', tools: [] },
    { id: 'dev', employeeId: 'original-dev', role: 'member', modelId: 'fixture', tools: ['artifact_write', 'terminal_test'] },
    { id: 'qa', employeeId: 'original-qa', role: 'member', modelId: 'fixture', tools: ['filesystem', 'terminal_test', 'knowledge_read'] },
  ], knowledge: { qa: [{ id: 'qa-private', documentId: 'private-doc', version: 1, content: privateText }] },
  tasks: [
    { id: 'dev', subject: 'Produce fixture', assignee: 'dev', assigneeId: 'original-dev', kind: 'implementation', dependencies: [], objective: 'Create fixture',
      acceptanceCriteria: ['fixture exists'], inputs: [], outputs: [{ path: 'fixture.test.mjs', format: 'text' }], inScope: ['fixture.test.mjs'], verify: [command] },
    { id: 'qa', subject: 'Independent review', assignee: 'qa', assigneeId: 'original-qa', kind: 'review', dependencies: ['dev'], reviewedTaskId: 'dev', objective: 'Review fixture',
      acceptanceCriteria: ['review passed'], inputs: [{ path: 'fixture.test.mjs', producerTaskId: 'dev' }], outputs: [], verify: [command] },
    { id: 'manager_accept', subject: 'Inspect actual receipts', assignee: 'manager', assigneeId: 'original-manager', kind: 'work', dependencies: ['qa'], objective: 'Inspect upstream host evidence',
      acceptanceCriteria: ['receipt metadata exists'], inputs: [], outputs: [] },
  ],
});

async function runPhase(root, snapshot, { pauseAfterDev = false, restoredFile } = {}) {
  const archive = createRunArchive(join(root, 'runs'), snapshot), files = join(archive.dir, 'artifacts'), workspace = join(archive.dir, 'workspace');
  mkdirSync(files); mkdirSync(workspace); if (restoredFile) writeFileSync(join(files, 'fixture.test.mjs'), restoredFile);
  const requests = [], executed = [], steps = new Map(), terminalResults = [];
  const budget = new ExecutionBudget({ maxBudget: snapshot.executionBudget, priorSpend: snapshot.policy.maxBudget - snapshot.executionBudget,
    priorModelCalls: snapshot.budgetHistory.calls, maxModelCalls: 100, tasks: snapshot.tasks, taskUsage: snapshot.budgetHistory.tasks });
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      const section = options.messages.findLast(message => message.source?.sections?.some(section => section.name === 'department:approved-context'))?.source.sections.find(section => section.name === 'department:approved-context');
      const context = section && JSON.parse(section.text); requests.push({ options, context });
      const task = context?.task, employee = snapshot.agents.find(agent => agent.id === task?.assignee);
      const ticket = budget.reserve(.001, task ? { taskId: task.id, employeeId: employee.employeeId } : {}); ticket.settle(.0002);
      if (task && !(pauseAfterDev && task.id !== 'dev')) {
        const key = options.sessionId + ':' + context.attemptId, step = steps.get(key) ?? 0; steps.set(key, step + 1);
        const update = (status, extra = {}) => ['agent_teams_update_task', { task_id: context.runtimeTaskId, attempt_id: context.attemptId, status, ...extra }];
        const actions = [['agent_teams_claim_task', { task_id: context.runtimeTaskId }], update('in_progress')];
        if (task.id === 'dev') actions.push(['artifact_write', { path: 'fixture.test.mjs', content: source }], ['terminal_test', { command }],
          update('completed', { output: 'Developer shared result', changedPaths: ['fixture.test.mjs'], acceptanceResults: [{ criterion: 'fixture exists', status: 'passed', evidence: 'actual fixture' }], commandsRun: [{ command, status: 'passed', exitCode: 0, evidence: 'claim is not the host receipt' }] }));
        if (task.id === 'qa') actions.push(['knowledge_read', { chunkId: 'qa-private' }], ['filesystem', { path: 'fixture.test.mjs' }], ['terminal_test', { command }], update('completed', { verdict: 'pass', output: 'QA shared conclusion without private body' }));
        if (task.id === 'manager_accept') actions.push(update('completed', { output: 'Manager inspected host metadata' }));
        if (step < actions.length) {
          const [name, args] = actions[step];
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'local scripted model fixture' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }();
  adapter.budget = budget;
  const sandbox = { root: files, revision: () => workspaceRevision(files), async execute(name, args, _signal, context) {
    executed.push({ name, taskId: context.taskId });
    if (name === 'artifact_write') { assert.equal(args.path, 'fixture.test.mjs'); writeFileSync(join(files, args.path), args.content); return { artifacts: listArtifacts(files) }; }
    if (name === 'filesystem') { const bytes = readFileSync(join(files, args.path)); return { path: args.path, content: bytes.toString(), sha256: sha(bytes), artifacts: listArtifacts(files) }; }
    assert.equal(name, 'terminal_test'); assert.equal(args.command, command);
    const operationId = randomUUID(); archive.append('local/operation-queued', { operationId, name, ...context });
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'fixture.test.mjs'], { cwd: files, env: childEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0);
    const value = { exitCode: result.status, output: result.stdout + result.stderr, artifacts: listArtifacts(files), workspaceRevision: workspaceRevision(files) };
    terminalResults.push({ taskId: context.taskId, value, operationId, ...context });
    archive.append('local/operation-finished', { operationId, name, ...context, localWorkspace: files }); return value;
  } };
  let host, created, state;
  try {
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(archive.dir, 'sessions'), archive, maxMembers: 3,
      product: { snapshot, sandbox, gate: new Semaphore(2), requestApproval: async () => randomUUID() } });
    const captain = await host.captain({ cwd: workspace, model: 'captain' });
    created = await stageApprovedTeam(host, captain, { name: 'host-evidence-fixture', members: snapshot.agents.map(agent => ({ name: agent.id, provider: 'fixture', model: agent.modelId })),
      tasks: teamTaskPlan(snapshot.tasks, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(snapshot.tasks) }) });
    archive.append('run/task-mapping', { tasks: created.tasks }); host.bindTaskMapping(created.tasks, created.team_id); await host.restoreCheckpoints(created.tasks);
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Isolated local regression only' }); host.lockPlan();
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      state = host.checkpointState();
      if (pauseAfterDev ? readRun(join(root, 'runs'), archive.id).events.some(event => event.type === 'handoff/accepted' && event.data.taskId === 'dev') : state.tasks.every(task => task.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!pauseAfterDev) await host.verifyDeliverable();
  } finally {
    await host?.close(); state = host?.checkpointState(); if (state) archive.append('team/checkpoint', state);
  }
  return { archive, files, requests, executed, terminalResults, budget, created, state, events: readRun(join(root, 'runs'), archive.id).events };
}

function assertManagerEvidence(phase) {
  const managerRequests = phase.requests.filter(request => request.context?.task?.id === 'manager_accept');
  assert.ok(managerRequests.length >= 1);
  for (const request of managerRequests) {
    const evidence = request.context.runEvidence;
    const message = request.options.messages.findLast(item => item.source?.sections?.some(section => section.name === 'department:approved-context'));
    const persisted = phase.events.findLast(event => event.type === 'session/user/message' && event.sessionId === request.options.sessionId && event.data.id === message.id);
    assert.ok(persisted, 'the first complete manager snapshot is durable before model dispatch');
    assert.deepEqual(persisted.data, message);
    assert.deepEqual(evidence.completedAncestors.map(task => task.taskId).sort(), ['dev', 'qa']);
    assert.equal(evidence.unavailableAncestors.length, 0);
    const receipt = evidence.completedAncestors.find(task => task.taskId === 'qa').commands[0], actual = phase.terminalResults.find(result => result.taskId === 'qa');
    assert.equal(receipt.exitCode, 0); assert.equal(receipt.output.sha256, sha(actual.value.output)); assert.equal(receipt.output.bytes, Buffer.byteLength(actual.value.output));
    assert.equal(receipt.operation.operationId, actual.operationId); assert.equal(receipt.approval.approvalId, actual.approvalId);
    assert.deepEqual([receipt.nodeTests.tests, receipt.nodeTests.pass, receipt.nodeTests.fail, receipt.nodeTests.skipped], [2, 1, 0, 1]);
    assert.equal(receipt.validAtAccepted, true); assert.equal(receipt.stdout.status, 'unknown'); assert.equal(receipt.stderr.status, 'unknown');
    assert.ok(!JSON.stringify(request.options).includes(privateText)); assert.ok(!JSON.stringify(evidence).includes('PRIVATE_TERMINAL_TEXT'));
    assert.ok(!request.options.tools.some(tool => ['knowledge_read', 'knowledge_search', 'terminal_test'].includes(tool.name)));
  }
}

test('native developer → QA → manager sees real command hashes/counts with no private knowledge or extra tools', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-evidence-native-'));
  try {
    const phase = await runPhase(root, initialSnapshot()); assertManagerEvidence(phase);
    assert.equal(phase.events.filter(event => event.type === 'handoff/accepted').length, 3);
    assert.deepEqual(phase.terminalResults.map(result => result.taskId), ['dev', 'qa']);
    assert.equal(phase.events.findLast(event => event.type === 'team/checkpoint').data.budgetEvidence.project.callsUsed, phase.budget.run.calls);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native resumed QA/manager inherit source budget and exact developer seal without repeating completed developer execution', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-evidence-resume-'));
  try {
    const snapshot = initialSnapshot(), parent = await runPhase(root, snapshot, { pauseAfterDev: true });
    const devSeal = parent.events.find(event => event.type === 'handoff/accepted' && event.data.taskId === 'dev')?.data;
    assert.ok(devSeal); assert.equal(parent.terminalResults.length, 1);
    const mapping = new Map(parent.created.tasks.map(task => [task.task_id, task.seed_id]));
    const states = new Map(parent.state.tasks.map(task => [mapping.get(task.id), task]));
    const completed = new Map([['dev', states.get('dev')]]), sealed = { ...snapshot, handoffCheckpoints: [devSeal] };
    const recovery = buildCheckpointContext(sealed, parent.events, states, completed, parent.files, parent.archive.id);
    const childSnapshot = { ...structuredClone(snapshot), recovery, handoffCheckpoints: [devSeal],
      executionBudget: 1 - parent.budget.run.spent,
      costCarryover: { recordedCost: parent.budget.run.spent - .03, reserved: .03, availableBudget: 1 - parent.budget.run.spent },
      budgetHistory: { calls: parent.budget.run.calls, tasks: Object.fromEntries([...parent.budget.tasks].map(([key, bucket]) => [key, { cost: bucket.spent, reserved: bucket.reserved, calls: bucket.calls }])) } };
    const originalHash = sha(JSON.stringify(childSnapshot)), child = await runPhase(root, childSnapshot, { restoredFile: readFileSync(join(parent.files, 'fixture.test.mjs')) });
    assertManagerEvidence(child);
    assert.ok(!child.executed.some(operation => operation.taskId === 'dev'));
    assert.ok(!child.requests.some(request => request.context?.task?.id === 'dev'));
    assert.deepEqual(child.terminalResults.map(result => result.taskId), ['qa']);
    assert.equal(sha(readFileSync(join(child.files, 'fixture.test.mjs'))), devSeal.outputs[0].sha256);
    const qaContext = child.requests.find(request => request.context?.task?.id === 'qa').context.runEvidence;
    assert.equal(qaContext.completedAncestors[0].restored, true); assert.equal(qaContext.completedAncestors[0].sourceRunId, parent.archive.id);
    assert.equal(qaContext.recoveryBudget.sourceCheckpoint.status, 'available');
    assert.equal(qaContext.recoveryBudget.sourceCheckpoint.project.callsUsed, parent.budget.run.calls);
    assert.equal(qaContext.recoveryBudget.inherited.callsUsed, parent.budget.run.calls);
    assert.equal(qaContext.recoveryBudget.inherited.retainedUnknownReservation, .03);
    assert.equal(sha(JSON.stringify(childSnapshot)), originalHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});
