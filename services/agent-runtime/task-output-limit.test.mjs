import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { ExecutionBudget } from './budget.mjs';
import { executionBudgetContext } from './budget-context.mjs';
import { ReworkGate } from './rework.mjs';

const primary = { id: 'primary', name: 'local fixture', wireModel: 'local-fixture', baseUrl: 'https://fixture.invalid/v1',
  inputRate: 1, outputRate: 2, maxOutputTokens: 4096 };
const task = { id: 'implementation', assigneeId: 'developer', estimatedInputTokens: 100000, estimatedOutputTokens: 50000 };
const actor = { sessionId: 'member-session', taskId: task.id, employeeId: task.assigneeId };
const options = { model: primary.id, sessionId: actor.sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: '执行已批准任务' }] }] };
const consume = async (adapter, overrides = {}) => { for await (const _ of adapter.stream({ ...options, ...overrides })) {} };

// Every transport below is intercepted before any network operation. Verify
// the persistent fee admission and in-memory reservation at the fetch boundary.
async function withCapture(config, work, response = (_index, body) => Response.json({
  choices: [{ message: { content: 'local response' } }], usage: { prompt_tokens: 17, completion_tokens: Math.min(3, body.max_tokens) },
})) {
  const original = globalThis.fetch, receipts = [], wires = [], failures = [], usage = [];
  let adapter;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
    const body = JSON.parse(init.body), receipt = receipts.at(-1);
    assert.equal(receipts.length, wires.length + 1, 'persist a distinct receipt before each dispatch');
    assert.ok(adapter.budget.run.reserved >= receipt.reservation, 'reserve synchronously before fetch');
    const route = adapter.routes.get(receipt.modelId);
    const upper = Buffer.byteLength(JSON.stringify({ messages: body.messages })) + 1024;
    assert.equal(receipt.reservation, (upper * route.inputRate + body.max_tokens * route.outputRate) / 1e6,
      'the exact wire output cap must be charged by the unchanged byte+1024 reservation formula');
    wires.push(body);
    return response(wires.length, body);
  };
  try {
    adapter = new OpenAiCompatibleAdapter({ routes: [primary], maxBudget: 1, ...config,
      beforeRequest: async receipt => { receipts.push(structuredClone(receipt)); },
      onCallError: async failure => { failures.push(structuredClone(failure)); }, onUsage: async item => { usage.push(item); } });
    return await work({ adapter, receipts, wires, failures, usage });
  } finally { globalThis.fetch = original; }
}

test('legacy snapshots preserve pinned route output caps, regardless of cumulative task estimate', async () => {
  const old = structuredClone(task), hash = JSON.stringify(old);
  await withCapture({ tasks: [old] }, async ({ adapter, receipts, wires }) => {
    adapter.attribution = () => actor;
    assert.equal((await adapter.resolveModel('fixture', primary.id)).defaultMaxTokens, 4096);
    await consume(adapter);
    await consume(adapter, { maxTokens: 2800 });
    assert.deepEqual(wires.map(wire => wire.max_tokens), [4096, 2800]);
    assert.ok(receipts[0].reservation > receipts[1].reservation);
    assert.equal(JSON.stringify(old), hash, 'do not migrate or rewrite a legacy task');
  });
});

test('employees sharing one model keep independent approved per-request caps and the stricter request/route boundary', async () => {
  const tasks = [{ ...task, maxOutputTokens: 800 }, { ...task, id: 'verification', assigneeId: 'tester', maxOutputTokens: 2100 }];
  await withCapture({ tasks }, async ({ adapter, wires, receipts }) => {
    let current = actor;
    adapter.attribution = () => current;
    await consume(adapter, { maxTokens: 9999 });
    current = { ...actor, taskId: 'verification', employeeId: 'tester' };
    await consume(adapter);
    await consume(adapter, { maxTokens: 300 });
    assert.deepEqual(wires.map(wire => wire.max_tokens), [800, 2100, 300]);
    assert.deepEqual(receipts.map(receipt => receipt.taskId), [task.id, 'verification', 'verification']);
    assert.equal(adapter.taskOutputCaps.get(task.id), 800);
    assert.equal(adapter.taskOutputCaps.get('verification'), 2100);
  });
  await withCapture({ routes: [{ ...primary, maxOutputTokens: 128 }], tasks }, async ({ adapter, wires }) => {
    adapter.attribution = () => actor;
    await consume(adapter);
    assert.equal(wires[0].max_tokens, 128, 'an explicit task cap cannot enlarge the pinned route');
  });
});

test('unattributed captain coordination retains its pinned route even when all employee task caps are smaller', async () => {
  await withCapture({ tasks: [{ ...task, maxOutputTokens: 64 }] }, async ({ adapter, wires, receipts }) => {
    adapter.attribution = () => ({ sessionId: 'captain', employeeId: 'manager' });
    await consume(adapter, { sessionId: 'captain' });
    assert.equal(wires[0].max_tokens, 4096);
    assert.equal(receipts[0].taskId, undefined);
  });
});

test('cold recovery preserves task cap, historical fees/calls and counts authorized rework against the original task', async () => {
  const tasks = [{ ...task, maxOutputTokens: 500, maxBudget: .6, maxModelCalls: 8 }];
  const approved = JSON.stringify(tasks);
  await withCapture({ tasks, maxBudget: .52, priorSpend: .48, priorModelCalls: 12,
    taskUsage: { [task.id]: { cost: .21, calls: 4 } } }, async ({ adapter, wires, receipts }) => {
    adapter.attribution = () => ({ ...actor, runtimeTaskId: 'new-repair-node', reworkRound: 1 });
    assert.equal(adapter.budget.run.spent, .48);
    assert.equal(adapter.budget.run.calls, 12);
    assert.equal(adapter.budget.tasks.get(task.id).spent, .21);
    await consume(adapter);
    assert.equal(wires[0].max_tokens, 500);
    assert.equal(receipts[0].taskId, task.id);
    assert.equal(receipts[0].runtimeTaskId, 'new-repair-node');
    assert.equal(adapter.budget.run.calls, 13);
    assert.equal(adapter.budget.tasks.get(task.id).calls, 5);
    assert.equal(JSON.stringify(tasks), approved);
  });
});

test('an already authorized fallback keeps the original task cap and reserves each request at its actual route rate', async () => {
  const backup = { ...primary, id: 'backup', inputRate: 2, outputRate: 5, maxOutputTokens: 6000 };
  await withCapture({ routes: [primary, backup], tasks: [{ ...task, maxOutputTokens: 700 }] },
    async ({ adapter, wires, receipts, failures }) => {
      adapter.attribution = () => actor;
      adapter.sessionPolicies.set(actor.sessionId, { fallbackModelId: backup.id });
      await consume(adapter);
      assert.deepEqual(wires.map(wire => wire.max_tokens), [700, 700]);
      assert.deepEqual(receipts.map(receipt => receipt.modelId), [primary.id, backup.id]);
      assert.equal(failures.length, 1); assert.equal(failures[0].dispatched, true);
      assert.equal(failures[0].id, receipts[0].id); assert.notEqual(receipts[0].id, receipts[1].id);
      assert.equal(adapter.budget.tasks.get(task.id).calls, 2);
    }, (index, body) => index === 1 ? new Response('', { status: 503 }) : Response.json({
      choices: [{ message: { content: 'local backup' } }], usage: { prompt_tokens: 17, completion_tokens: Math.min(3, body.max_tokens) },
    }));
});

test('ReworkGate binds generated repair and re-review to the original approved task caps instead of model-proposed limits', async () => {
  const source = { ...task, assignee: 'employee-dev', kind: 'implementation', maxOutputTokens: 700, inScope: ['server.mjs'],
    outOfScope: ['private'], verify: ['local-test'], inputs: [], outputs: [{ path: 'server.mjs', format: 'text' }] };
  const review = { id: 'review', assigneeId: 'tester', assignee: 'employee-qa', kind: 'review', reviewedTaskId: source.id,
    maxReworkRounds: 1, maxOutputTokens: 200, dependencies: [source.id], inputs: [{ path: 'server.mjs', producerTaskId: source.id }], outputs: [] };
  const runtimeSource = 'native-source', runtimeReview = 'native-review', runtimeRepair = 'native-repair', runtimeRecheck = 'native-recheck';
  const snapshot = { tasks: [source, review] }, taskIds = new Map([[runtimeSource, source.id], [runtimeReview, review.id]]);
  const state = { tasks: [{ id: runtimeSource }, { id: runtimeReview, reviewedTaskId: runtimeSource, round: 1 }] }, events = [];
  const handoff = { tasks: new Map(snapshot.tasks.map(item => [item.id, item])), begin() {}, block(_id, _attempt, error) { return error; } };
  const gate = new ReworkGate({ snapshot, handoff, taskIds, state: () => structuredClone(state),
    archive: { append(type, data) { events.push({ type, data }); } } });
  gate.prepare({ taskId: review.id, attemptId: 'review-attempt', task: state.tasks[1] }, { verdict: 'needs_revision',
    findings: [{ id: 'F1', severity: 'high', file: 'server.mjs', problem: 'local fixture issue', requiredFix: 'fix within original scope' }] });
  state.tasks.push({ id: runtimeRepair, kind: 'repair', assignee: source.assignee, sourceTaskId: runtimeSource,
    dependencies: [runtimeSource], round: 2, verify: source.verify, sourceFindingIds: ['F1'], inScope: ['server.mjs'], outOfScope: source.outOfScope,
    maxOutputTokens: 9999 },
  { id: runtimeRecheck, kind: 'review', assignee: review.assignee, reviewedTaskId: runtimeRepair, dependencies: [runtimeRepair], round: 2, maxOutputTokens: 9999 });
  gate.check();
  assert.equal(gate.contractFor(runtimeRepair).maxOutputTokens, 700);
  assert.equal(gate.contractFor(runtimeRecheck).maxOutputTokens, 200);
  assert.equal(taskIds.get(runtimeRepair), source.id); assert.equal(taskIds.get(runtimeRecheck), review.id);
  assert.ok(events.some(event => event.type === 'run/task-mapping' && event.data.tasks.some(binding => binding.task_id === runtimeRepair && binding.seed_id === source.id)));
  await withCapture({ tasks: snapshot.tasks }, async ({ adapter, wires, receipts }) => {
    let runtimeId = runtimeRepair;
    adapter.attribution = () => { const contract = gate.contractFor(runtimeId); return { sessionId: 'local-member', taskId: taskIds.get(runtimeId),
      runtimeTaskId: runtimeId, employeeId: contract.assigneeId, reworkRound: contract.reworkRound }; };
    await consume(adapter);
    runtimeId = runtimeRecheck; await consume(adapter);
    assert.deepEqual(wires.map(wire => wire.max_tokens), [700, 200]);
    assert.deepEqual(receipts.map(receipt => receipt.taskId), [source.id, review.id]);
    assert.equal(adapter.budget.tasks.get(source.id).calls, 1); assert.equal(adapter.budget.tasks.get(review.id).calls, 1);
  });
});

test('unknown or foreign task attribution fails before any receipt, reservation or fetch', async () => {
  await withCapture({ tasks: [{ ...task, maxOutputTokens: 400 }] }, async ({ adapter, receipts, wires }) => {
    adapter.attribution = () => ({ ...actor, taskId: 'unapproved' });
    await assert.rejects(consume(adapter), error => error.code === 'TASK_BUDGET_UNKNOWN');
    adapter.attribution = () => ({ ...actor, employeeId: 'foreign' });
    await assert.rejects(consume(adapter), error => error.code === 'TASK_BUDGET_IDENTITY');
    assert.equal(receipts.length, 0); assert.equal(wires.length, 0);
    assert.equal(adapter.budget.run.reserved, 0); assert.equal(adapter.budget.run.calls, 0);
  });
});

test('explicit cap changes both wire and pre-billing affordability without reducing legacy reservations or fixed evidence', async () => {
  const messages = [{ role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
    sections: [{ name: 'department:approved-context', text: 'approved' }] },
  content: [{ type: 'text', text: JSON.stringify({ task: { id: task.id, inputs: [{ path: 'server.mjs', sha256: 'a'.repeat(64) }] } }) }] }];
  await withCapture({ maxBudget: .004, tasks: [task] }, async ({ adapter, receipts, wires }) => {
    adapter.attribution = () => actor;
    await assert.rejects(consume(adapter, { messages }), error => error.code === 'BUDGET_CONTEXT_LIMIT');
    assert.equal(receipts.length, 0); assert.equal(wires.length, 0); assert.equal(adapter.budget.run.calls, 0);
  });
  await withCapture({ maxBudget: .004, tasks: [{ ...task, maxOutputTokens: 600 }] }, async ({ adapter, receipts, wires }) => {
    adapter.attribution = () => actor;
    await consume(adapter, { messages });
    assert.equal(receipts.length, 1); assert.equal(wires.length, 1); assert.equal(wires[0].max_tokens, 600);
    assert.ok(wires[0].messages[0].content.includes('a'.repeat(64)));
    assert.equal(adapter.budget.run.calls, 1);
  });
});

test('invalid explicit cap fails closed at adapter construction while 1 and 32768 are accepted', async () => {
  for (const maxOutputTokens of [null, 0, -1, 1.5, '800', NaN, Infinity, 32769]) {
    assert.throws(() => new OpenAiCompatibleAdapter({ routes: [primary], maxBudget: 1, tasks: [{ ...task, maxOutputTokens }] }),
      error => error.code === 'INVALID_TASK_OUTPUT_LIMIT');
  }
  for (const maxOutputTokens of [1, 32768]) {
    await withCapture({ tasks: [{ ...task, maxOutputTokens }] }, async ({ adapter, wires }) => {
      adapter.attribution = () => actor;
      await consume(adapter);
      assert.equal(wires[0].max_tokens, Math.min(maxOutputTokens, primary.maxOutputTokens));
    });
  }
});

test('read-only budget feedback separates cumulative estimate and approved single-call cap, including legacy routes', () => {
  const tasks = [{ ...task, maxOutputTokens: 800 }], snapshot = { tasks, agents: [{ id: 'employee-1', employeeId: 'developer', modelId: primary.id }] };
  const budget = new ExecutionBudget({ maxBudget: .7, priorSpend: .3, priorModelCalls: 8, tasks, taskUsage: { [task.id]: { cost: .1, calls: 2, reserved: .025 } } });
  const before = JSON.stringify({ run: budget.run, tasks: [...budget.tasks], snapshot });
  const feedback = executionBudgetContext({ budget, snapshot, routes: [primary], taskId: task.id });
  assert.equal(feedback.task.estimatedOutputTokens, 50000);
  assert.equal(feedback.task.maxOutputTokens, 800);
  assert.equal(feedback.task.configuredOutputLimit, 800);
  assert.equal(feedback.task.originalEstimate, .24, 'whole-task estimate remains based on cumulative tokens');
  assert.equal(feedback.task.retainedTaskReservations, .025);
  assert.equal(feedback.task.recordedTaskCost, .1, 'an uncertain hold is not recorded consumption');
  assert.equal(feedback.task.occupied, .125);
  assert.equal(feedback.project.available, .7); assert.equal(feedback.project.occupied, .3);
  assert.equal(JSON.stringify({ run: budget.run, tasks: [...budget.tasks], snapshot }), before);
  const legacy = executionBudgetContext({ budget, snapshot: { ...snapshot, tasks: [task] }, routes: [primary], taskId: task.id });
  assert.equal(legacy.task.maxOutputTokens, undefined);
  assert.equal(legacy.task.configuredOutputLimit, 4096);
  const smallRoute = executionBudgetContext({ budget, snapshot, routes: [{ ...primary, maxOutputTokens: 300 }], taskId: task.id });
  assert.equal(smallRoute.task.maxOutputTokens, 800);
  assert.equal(smallRoute.task.configuredOutputLimit, 300);
});
