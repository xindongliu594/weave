import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { createTeamHost } from './host.mjs';
import { teamTaskPlan, stageApprovedTeam } from './handoff.mjs';
import { createRunArchive, readRun } from './trace-store.mjs';
import { Semaphore } from './limits.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const contextName = 'department:approved-context';
const route = { id: 'shared', name: 'local-only fixture', wireModel: 'no-network', baseUrl: 'https://fixture.invalid/v1',
  inputRate: 1, outputRate: 2, maxOutputTokens: 4096 };

async function nativeScenario(resume) {
  const root = await mkdtemp(join(tmpdir(), 'task-cap-native-')), originalFetch = globalThis.fetch;
  const contents = 'local fixed-version reference\n', sha256 = digest(contents);
  writeFileSync(join(root, 'server.mjs'), contents);
  const check = { id: 'check', subject: 'Check fixed reference', kind: 'work', assignee: 'qa', assigneeId: 'original-qa',
    dependencies: resume ? ['producer'] : [], objective: 'Read only the approved fixed version', taskPrompt: 'ORIGINAL_TASK_BACKGROUND',
    acceptanceCriteria: ['read the fixed version'], estimatedInputTokens: 6000, estimatedOutputTokens: 9000, maxOutputTokens: 321,
    inputs: [{ path: 'server.mjs', sha256, ...(resume ? { producerTaskId: 'producer' } : {}) }], outputs: [] };
  const producer = { id: 'producer', subject: 'Prior producer', kind: 'work', assignee: 'dev', assigneeId: 'original-dev', dependencies: [],
    objective: 'Prior fixed output', taskPrompt: 'PRIOR_LOCAL_FIXTURE', acceptanceCriteria: ['fixed producer'], outputs: [{ path: 'server.mjs', format: 'text' }],
    estimatedInputTokens: 1000, estimatedOutputTokens: 16000, maxOutputTokens: 128 };
  const snapshot = { requirement: 'Keep the complete local fixture contract', executionDescription: 'Approved local per-call cap regression', policy: { maxBudget: .5 },
    agents: [{ id: 'manager', employeeId: 'original-manager', role: 'manager', modelId: 'captain', tools: [], rolePrompt: 'local coordinator' },
      ...(resume ? [{ id: 'dev', employeeId: 'original-dev', role: 'member', modelId: route.id, tools: ['artifact_write'], rolePrompt: 'local developer' }] : []),
      { id: 'qa', employeeId: 'original-qa', role: 'member', modelId: route.id, tools: ['filesystem'], rolePrompt: 'local read-only reviewer' }],
    tasks: [...(resume ? [producer] : []), check],
    ...(resume ? {
      recovery: { version: 1, sourceRunId: 'local-fixture-parent', completed: [{ taskId: 'producer', attemptId: 'prior-producer-attempt', attempt: 1, round: 1, output: 'prior fixed output' }],
        files: [{ path: 'server.mjs', sha256 }], nodes: {
          producer: { taskId: 'producer', status: 'completed', output: 'prior fixed output', commands: [], errors: [], historyRunId: 'local-fixture-parent' },
          check: { taskId: 'check', status: 'restart', output: '', commands: [], errors: [], historyRunId: 'local-fixture-parent' },
        } },
      handoffCheckpoints: [{ taskId: 'producer', attemptId: 'prior-producer-attempt', inputs: [], outputs: [{ path: 'server.mjs', sha256, size: Buffer.byteLength(contents) }], commands: [] }],
    } : {}) };
  const originalHash = digest(JSON.stringify(snapshot)), archive = createRunArchive(join(root, 'runs'), snapshot);
  const receipts = [], wires = [], admitted = [], usage = []; let host, calls = 0, sandboxCalls = 0;
  const adapter = new OpenAiCompatibleAdapter({ routes: [route, { ...route, id: 'captain' }], maxBudget: resume ? .4 : .5,
    priorSpend: resume ? .1 : 0, priorModelCalls: resume ? 4 : 0, tasks: snapshot.tasks,
    taskUsage: resume ? { check: { cost: .02, calls: 2, reserved: .03 } } : {},
    beforeRequest: async receipt => { receipts.push(structuredClone(receipt)); },
    onRequest: wire => { wires.push(structuredClone(wire)); archive.append('fixture/wire', wire); },
    onUsage: async item => { usage.push(item); archive.append('fixture/usage', item); },
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(init.body), receipt = receipts.at(-1), current = admitted.at(-1).contract;
    assert.equal(receipt.taskId, 'check'); assert.equal(receipt.employeeId, 'original-qa');
    assert.equal(body.max_tokens, 321); assert.equal(current.task.maxOutputTokens, 321);
    assert.equal(current.task.estimatedOutputTokens, 9000);
    assert.equal(current.budget.task.maxOutputTokens, 321);
    const tools = body.tools, bytes = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools })) + 1024;
    assert.equal(receipt.reservation, (bytes * route.inputRate + body.max_tokens * route.outputRate) / 1e6);
    assert.ok(adapter.budget.run.reserved >= receipt.reservation);
    calls++;
    return Response.json({ choices: [{ message: calls === 1 ? { tool_calls: [{ id: randomUUID(), type: 'function',
      function: { name: 'agent_teams_claim_task', arguments: JSON.stringify({ task_id: current.runtimeTaskId }) } }] } : { content: 'local inspection only' },
    finish_reason: calls === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 4 } });
  };
  try {
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'sessions'), archive,
      product: { snapshot, sandbox: { root, async execute() { sandboxCalls++; throw Error('no artifact or command dispatch in this fixture'); } }, gate: new Semaphore(2) } });
    host.ctx.on('llm/stream', async function* (options, next) {
      const message = options.messages.findLast(item => item.source?.plugin === '@deepseek-ai/dsh-system-prompt' && item.source.form === 'snapshot' &&
        item.source.sections.some(section => section.name === contextName));
      const contract = JSON.parse(message.source.sections.find(section => section.name === contextName).text);
      admitted.push({ sessionId: options.sessionId, contract, message: structuredClone(message) });
      yield* next();
    });
    const captain = await host.captain({ cwd: root, model: 'captain', instructions: snapshot.agents[0].rolePrompt });
    const created = await stageApprovedTeam(host, captain, { name: 'cap-' + (resume ? 'restored' : 'first'), description: snapshot.executionDescription,
      members: snapshot.agents.slice(1).map(employee => ({ name: employee.id, role: employee.rolePrompt, provider: 'fixture', model: route.id })),
      tasks: teamTaskPlan(snapshot.tasks, { hostContext: true, assertHostContext: () => host.assertApprovedTaskContext(snapshot.tasks) }) });
    host.bindTaskMapping(created.tasks, created.team_id); await host.restoreCheckpoints(created.tasks);
    assert.equal(calls, 0, 'native setup and restore cannot invoke a model');
    await host.call(captain, 'agent_teams_approve', { confirmation: 'Local isolated output-limit fixture' }); host.lockPlan();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && calls < 2) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 2); assert.equal(receipts.length, 2); assert.equal(wires.length, 2); assert.equal(usage.length, 2);
    assert.deepEqual(wires.map(wire => wire.body.max_tokens), [321, 321]);
    assert.deepEqual(wires.map(wire => wire.taskId), ['check', 'check']);
    for (const current of admitted) {
      assert.deepEqual(current.contract.task.inputs, check.inputs); assert.equal(current.contract.requirement, snapshot.requirement);
      assert.equal(current.contract.task.estimatedOutputTokens, 9000); assert.equal(current.contract.task.maxOutputTokens, 321);
      const session = host.ctx.agents.get(current.sessionId).session;
      assert.ok(session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data) === JSON.stringify(current.message)),
        'the cap and full contract supplied to the model are durably archived as the same native user snapshot');
      if (resume) {
        assert.equal(current.contract.recovery.sourceRunId, 'local-fixture-parent');
        assert.equal(current.contract.recovery.files[0].sha256, sha256);
        assert.equal(current.contract.budget.task.retainedTaskReservations, .03);
      }
    }
    assert.equal(adapter.budget.run.calls, (resume ? 4 : 0) + 2);
    assert.equal(adapter.budget.tasks.get('check').calls, (resume ? 2 : 0) + 2);
    if (resume) {
      const status = await host.call(captain, 'agent_teams_status');
      assert.equal(status.tasks[0].status, 'completed'); assert.equal(status.tasks[0].attempt_id, 'prior-producer-attempt');
      assert.ok(Math.abs(adapter.budget.tasks.get('check').reserved - .03) <= Number.EPSILON,
        'reservation arithmetic retains the same .03 hold within floating-point precision');
      assert.equal(adapter.budget.run.reserved, 0, 'historical task holds already occupy global priorSpend and are not deducted twice');
    }
    assert.equal(digest(JSON.stringify(snapshot)), originalHash); assert.equal(sandboxCalls, 0);
    assert.equal(readFileSync(join(root, 'server.mjs'), 'utf8'), contents);
    assert.equal(readRun(join(root, 'runs'), archive.id).integrity, 'ok');
  } finally { await host?.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
}

test('first native employee turn persists the explicit cap and full contract before deterministic fee reservation and wire dispatch', { timeout: 10000 }, () => nativeScenario(false));
test('cold native restore retains completed attempts, fixed SHA, unknown task holds and the original per-call cap without producer replay', { timeout: 10000 }, () => nativeScenario(true));
