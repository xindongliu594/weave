import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';
import { createTeamHost } from './host.mjs';
import { createRunArchive } from './trace-store.mjs';
import { ExecutionBudget } from './budget.mjs';
import { Semaphore } from './limits.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const marker = 'ORIGINAL_APPROVED_REQUIREMENT_WITHOUT_TRUNCATION';
const fileMarker = '\n\n文件合同（由宿主核验；未就绪不得完成）：\n';
const contracts = () => [
  { id: 'build', subject: 'Build', taskPrompt: marker.repeat(300), objective: 'Approved implementation', assignee: 'dev', dependencies: [], kind: 'implementation',
    acceptanceCriteria: ['full criteria'], inScope: ['server.mjs'], outOfScope: ['private'], verify: ['fixture-only-test'],
    inputs: [{ path: 'reference.json', sha256: 'a'.repeat(64) }], outputs: [{ path: 'server.mjs', format: 'text' }] },
  { id: 'review', subject: 'Review', taskPrompt: marker.repeat(200), objective: 'Independent review', assignee: 'qa', dependencies: ['build'], kind: 'review',
    acceptanceCriteria: ['independent criteria'], inScope: ['server.mjs'], outOfScope: ['private'], verify: ['fixture-only-test'], reviewedTaskId: 'build',
    inputs: [{ path: 'server.mjs', producerTaskId: 'build', sha256: 'b'.repeat(64) }], outputs: [] },
  { id: 'repair', subject: 'Repair', taskPrompt: marker.repeat(100), objective: 'Approved repair', assignee: 'dev', dependencies: ['review'], kind: 'repair',
    acceptanceCriteria: ['close finding'], inScope: ['server.mjs'], outOfScope: ['private'], verify: ['fixture-only-test'], sourceTaskId: 'build', sourceFindingIds: ['F1'],
    inputs: [{ path: 'server.mjs', producerTaskId: 'build', sha256: 'b'.repeat(64) }], outputs: [{ path: 'server.mjs', format: 'text' }] },
];

test('compact product mapping changes only duplicated description while generic mapping and immutable contracts retain their complete hashes', () => {
  const tasks = contracts(), original = structuredClone(tasks), originalHash = hash(JSON.stringify(tasks));
  let assertions = 0;
  const generic = teamTaskPlan(tasks), compact = teamTaskPlan(tasks, { hostContext: true, assertHostContext: input => { assertions++; assert.equal(input, tasks); return true; } });
  assert.equal(assertions, 1); assert.equal(hash(JSON.stringify(tasks)), originalHash); assert.deepEqual(tasks, original);
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index], { description: oldText, ...oldFields } = generic[index], { description: compactText, ...compactFields } = compact[index];
    assert.equal(oldText, task.taskPrompt + fileMarker + JSON.stringify({ inputs: task.inputs, outputs: task.outputs }));
    assert.deepEqual(compactFields, oldFields, 'all native ids, dependency and quality contract fields stay exactly equal');
    assert.equal(hash(JSON.stringify(compactFields)), hash(JSON.stringify(oldFields)));
    assert.ok(compactText.includes('department:approved-context')); assert.ok(!compactText.includes(marker));
    assert.deepEqual(JSON.parse(compactText.split(fileMarker)[1]), { inputs: task.inputs, outputs: task.outputs });
    assert.ok(Buffer.byteLength(compactText) < Buffer.byteLength(oldText));
  }
  assert.deepEqual(teamTaskPlan(tasks, { hostContext: false, assertHostContext: () => { throw Error('must not run for generic mapping'); } }), generic);
});

test('compact mapping fails closed without a verified host context instead of producing placeholder contracts', () => {
  const tasks = contracts(), before = hash(JSON.stringify(tasks));
  for (const option of [{}, { assertHostContext: () => false }, { assertHostContext: () => undefined }, { assertHostContext: () => Promise.resolve(true) },
    { assertHostContext: () => { throw Error('PRIVATE_CALLBACK_FAILURE_MUST_NOT_LEAK'); } }]) {
    assert.throws(() => teamTaskPlan(tasks, { ...option, hostContext: true }), error => error.code === 'APPROVED_TASK_CONTEXT_REQUIRED' &&
      error.message.startsWith('APPROVED_TASK_CONTEXT_REQUIRED:') && !error.message.includes('PRIVATE_CALLBACK_FAILURE'));
  }
  assert.equal(hash(JSON.stringify(tasks)), before);
});

test('generic native host cannot opt into context-backed descriptions or dispatch before failed assertion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-context-missing-')); let calls = 0;
  const adapter = new class extends LlmAdapter { async *stream() { calls++; throw Error('must not dispatch'); } }();
  const host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions') });
  try {
    const tasks = contracts();
    assert.equal(host.assertApprovedTaskContext(tasks), false);
    assert.throws(() => teamTaskPlan(tasks, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(tasks) }), error => error.code === 'APPROVED_TASK_CONTEXT_REQUIRED');
    assert.equal(calls, 0); assert.deepEqual(teamTaskPlan(tasks), teamTaskPlan(tasks, { hostContext: false }));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('native restored task claim retains canonical file hashes and quality fields without replaying the completed producer or repeating requirement in its receipt', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-context-native-')), sha256 = hash('fixed producer file\n');
  const workspace = join(root, 'artifacts'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'server.mjs'), 'fixed producer file\n');
  const snapshot = { requirement: marker.repeat(300), executionDescription: 'UNCHANGED_APPROVED_EXECUTION_DESCRIPTION', policy: { maxBudget: .5 },
    agents: [{ id: 'manager', employeeId: 'original-manager', role: 'manager', modelId: 'captain', tools: [], rolePrompt: 'UNCHANGED_MANAGER_ROLE' },
      { id: 'dev', employeeId: 'original-dev', role: 'member', modelId: 'fixture', tools: ['artifact_write', 'terminal_test'], rolePrompt: 'UNCHANGED_DEVELOPER_ROLE' },
      { id: 'qa', employeeId: 'original-qa', role: 'member', modelId: 'fixture', tools: ['filesystem', 'terminal_test'], rolePrompt: 'UNCHANGED_QA_ROLE' }],
    tasks: [{ id: 'dev', subject: 'Completed producer', kind: 'implementation', assignee: 'dev', assigneeId: 'original-dev', dependencies: [], objective: 'Produce fixed file',
      taskPrompt: marker.repeat(300), inputs: [], outputs: [{ path: 'server.mjs', format: 'text' }], inScope: ['server.mjs'], verify: ['fixture-only-test'], acceptanceCriteria: ['fixed producer'] },
    { id: 'qa', subject: 'Independent version check', kind: 'verification', assignee: 'qa', assigneeId: 'original-qa', dependencies: ['dev'], objective: 'Verify exact producer version independently',
      taskPrompt: marker.repeat(300), inputs: [{ path: 'server.mjs', producerTaskId: 'dev', sha256 }], outputs: [], inScope: ['server.mjs'], outOfScope: ['private'],
      verify: ['fixture-only-test'], acceptanceCriteria: ['exact file version'] }],
    recovery: { version: 1, sourceRunId: 'local-parent', completed: [{ taskId: 'dev', attemptId: 'prior-dev-attempt', attempt: 1, round: 1, output: 'PRIOR_PRODUCER_HANDOFF' }],
      files: [{ path: 'server.mjs', sha256 }], nodes: {
        dev: { taskId: 'dev', status: 'completed', output: 'PRIOR_PRODUCER_HANDOFF', commands: [], errors: [], historyRunId: 'local-parent' },
        qa: { taskId: 'qa', status: 'restart', output: '', commands: [], errors: [], historyRunId: 'local-parent' },
      } },
    handoffCheckpoints: [{ taskId: 'dev', attemptId: 'prior-dev-attempt', inputs: [], outputs: [{ path: 'server.mjs', sha256, size: 20 }], commands: [] }] };
  const originalHash = hash(JSON.stringify(snapshot)), requests = [], claims = []; let host, sandboxCalls = 0;
  const archive = createRunArchive(join(root, 'runs'), snapshot);
  const adapter = new class extends LlmAdapter {
    async *stream(options) {
      const message = options.messages.findLast(item => item.source?.plugin === '@deepseek-ai/dsh-system-prompt' && item.source.form === 'snapshot' && item.source.sections.some(section => section.name === 'department:approved-context'));
      const current = message && JSON.parse(message.source.sections.find(section => section.name === 'department:approved-context').text);
      requests.push({ options, current });
      if (current?.task?.id === 'qa' && requests.filter(item => item.current?.task?.id === 'qa').length === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'agent_teams_claim_task', arguments: JSON.stringify({ task_id: current.runtimeTaskId }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'local canonical claim inspection' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }();
  adapter.routes = new Map([['fixture', { id: 'fixture', inputRate: 2, outputRate: 10 }]]);
  adapter.budget = new ExecutionBudget({ maxBudget: .4, priorSpend: .1, priorModelCalls: 4, tasks: snapshot.tasks });
  try {
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      product: { snapshot, sandbox: { root: workspace, async execute() { sandboxCalls++; throw Error('no employee file or command operation is needed'); } }, gate: new Semaphore(2) } });
    const captain = await host.captain({ cwd: root, model: 'captain', instructions: snapshot.agents[0].rolePrompt });
    assert.equal(host.assertApprovedTaskContext(snapshot.tasks), true);
    const altered = structuredClone(snapshot.tasks); altered[1].inputs[0].sha256 = 'b'.repeat(64);
    assert.equal(host.assertApprovedTaskContext(altered), false);
    assert.throws(() => teamTaskPlan(altered, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(altered) }), error => error.code === 'APPROVED_TASK_CONTEXT_REQUIRED');
    host.ctx.on('tools/result', (exec, result) => { if (exec.name === 'agent_teams_claim_task') claims.push(result); });
    const created = await stageApprovedTeam(host, captain, { name: 'compact-native-contract', description: snapshot.executionDescription,
      members: snapshot.agents.slice(1).map(employee => ({ name: employee.id, role: employee.rolePrompt, provider: 'fixture', model: 'fixture' })),
      tasks: teamTaskPlan(snapshot.tasks, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(snapshot.tasks) }) });
    host.bindTaskMapping(created.tasks, created.team_id); await host.restoreCheckpoints(created.tasks);
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Only local native contract regression' }); host.lockPlan();
    const deadline = Date.now() + 4000;
    // Plain text intentionally leaves the node open: wait for the one existing
    // handoff reminder instead of racing the loop between requests two and three.
    while (Date.now() < deadline && requests.filter(item => item.current?.task?.id === 'qa').length < 3) await new Promise(resolve => setTimeout(resolve, 20));
    const qaRequests = requests.filter(item => item.current?.task?.id === 'qa');
    await host.ctx.agents.get(qaRequests[0]?.options.sessionId)?.whenIdle();
    assert.equal(qaRequests.length, 3); assert.ok(!requests.some(item => item.current?.task?.id === 'dev'), 'completed producer is not dispatched again');
    assert.equal(claims.length, 1); assert.equal(claims[0].isError, false);
    const details = claims[0].value.task_details;
    assert.ok(!details.includes(marker)); assert.ok(details.includes('department:approved-context'));
    for (const text of [sha256, 'server.mjs', snapshot.tasks[1].objective, 'exact file version', 'fixture-only-test', 'PRIOR_PRODUCER_HANDOFF']) assert.ok(details.includes(text), text);
    const fileContract = JSON.parse(details.split(fileMarker)[1].split('\n')[0]);
    assert.deepEqual(fileContract, { inputs: snapshot.tasks[1].inputs, outputs: snapshot.tasks[1].outputs });
    for (const request of qaRequests) {
      assert.equal(request.current.requirement, snapshot.requirement); assert.deepEqual(request.current.task.inputs, snapshot.tasks[1].inputs);
      assert.deepEqual(request.current.task.acceptanceCriteria, snapshot.tasks[1].acceptanceCriteria); assert.deepEqual(request.current.task.verify, snapshot.tasks[1].verify);
      assert.equal(request.current.recovery.sourceRunId, 'local-parent'); assert.equal(request.current.recovery.files[0].sha256, sha256);
    }
    const status = await host.call(captain, 'agent_teams_status');
    assert.equal(status.tasks[0].status, 'completed'); assert.equal(status.tasks[0].attempt_id, 'prior-dev-attempt');
    assert.deepEqual(status.tasks[1].dependencies, [created.tasks.find(task => task.seed_id === 'dev').task_id]);
    assert.equal(hash(JSON.stringify(snapshot)), originalHash); assert.equal(sandboxCalls, 0);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
