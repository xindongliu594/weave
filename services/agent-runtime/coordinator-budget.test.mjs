import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBudget } from './budget.mjs';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { ProductDshRuntime } from './product-runtime.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const route = { id: 'fixture', name: 'local fixture', wireModel: 'no-network', baseUrl: 'https://fixture.invalid/v1',
  inputRate: 0, outputRate: 1, maxOutputTokens: 10 };
const options = { model: route.id, sessionId: 'captain', messages: [{ role: 'user', content: [{ type: 'text', text: 'Coordinate the approved work' }] }] };
const consume = async adapter => { for await (const _ of adapter.stream(options)) {} };
const state = budget => structuredClone({ run: budget.run, tasks: budget.tasks, coordinator: budget.coordinator });

test('sealed coordination allowance is absolute, survives release and another reconstruction, and leaves task calls distinct', () => {
  const tasks = [{ id: 'manager', assigneeId: 'manager-employee', maxModelCalls: 8 }];
  const budget = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 20, priorModelCalls: 7,
    coordinatorCallCeiling: 5, priorCoordinatorCalls: 4, tasks, taskUsage: { manager: { cost: .01, calls: 3 } } });
  const reserved = budget.reserve(.1); reserved.release(); reserved.release();
  assert.throws(() => budget.reserve(.01), error => error.code === 'COORDINATOR_TURN_LIMIT');
  assert.equal(budget.run.calls, 8); assert.equal(budget.run.reserved, 0); assert.equal(budget.coordinator.calls, 5);
  const taskRequest = budget.reserve(.1, { taskId: 'manager', employeeId: 'manager-employee' }); taskRequest.settle(.02);
  assert.equal(budget.run.calls, 9); assert.equal(budget.tasks.get('manager').calls, 4); assert.equal(budget.coordinator.calls, 5);
  const restored = new ExecutionBudget({ maxBudget: .98, priorSpend: .02, maxModelCalls: 20, priorModelCalls: budget.run.calls,
    coordinatorCallCeiling: 5, priorCoordinatorCalls: budget.coordinator.calls, tasks, taskUsage: { manager: { cost: .03, calls: 4 } } });
  assert.throws(() => restored.peekAvailable(), error => error.code === 'COORDINATOR_TURN_LIMIT');
  assert.throws(() => restored.reserve(.01), error => error.code === 'COORDINATOR_TURN_LIMIT');
  assert.equal(restored.run.calls, 9); assert.equal(restored.coordinator.calls, 5);
});

test('coordination shares the existing project money and total-call gates rather than receiving a new money bucket', () => {
  const byMoney = new ExecutionBudget({ maxBudget: .1, maxModelCalls: 10, coordinatorCallCeiling: 5 });
  const first = byMoney.reserve(.09);
  assert.throws(() => byMoney.reserve(.02), error => error.code === 'BUDGET_EXCEEDED');
  assert.equal(byMoney.coordinator?.calls, 1); assert.equal(byMoney.run.calls, 1);
  first.settle(.08);
  const byCalls = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 5, priorModelCalls: 5, coordinatorCallCeiling: 4, priorCoordinatorCalls: 3 });
  assert.throws(() => byCalls.reserve(.01), error => error.code === 'TURN_LIMIT');
  assert.equal(byCalls.coordinator.calls, 3); assert.equal(byCalls.run.calls, 5);
});

test('peek checks coordination exhaustion without counters, warnings, reservations or stopped events', () => {
  const events = [], budget = new ExecutionBudget({ maxBudget: .2, priorSpend: .8, maxModelCalls: 10, priorModelCalls: 4,
    coordinatorCallCeiling: 5, priorCoordinatorCalls: 4, onEvent: event => events.push(event) });
  const before = state(budget);
  assert.ok(Math.abs(budget.peekAvailable() - .2) < 1e-10); assert.deepEqual(state(budget), before); assert.deepEqual(events, []);
  const pending = budget.reserve(.01); pending.release();
  const exhausted = state(budget), emitted = structuredClone(events);
  assert.throws(() => budget.peekAvailable(), error => error.code === 'COORDINATOR_TURN_LIMIT');
  assert.deepEqual(state(budget), exhausted); assert.deepEqual(events, emitted);
});

test('unknown tasks cannot disguise coordination, and rejected foreign tasks never consume the coordination allowance', () => {
  const budget = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, coordinatorCallCeiling: 1,
    tasks: [{ id: 'qa', assigneeId: 'tester' }] });
  for (const actor of [{ taskId: 'unknown' }, { taskId: '', employeeId: 'tester' }])
    assert.throws(() => budget.reserve(.01, actor), error => error.code === 'TASK_BUDGET_UNKNOWN');
  assert.throws(() => budget.reserve(.01, { taskId: 'qa', employeeId: 'foreign' }), error => error.code === 'TASK_BUDGET_IDENTITY');
  assert.equal(budget.run.calls, 0); assert.equal(budget.coordinator.calls, 0);
  const coordinationOnly = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, coordinatorCallCeiling: 1 });
  assert.throws(() => coordinationOnly.reserve(.01, { taskId: 'invented' }), error => error.code === 'TASK_BUDGET_UNKNOWN');
  assert.equal(coordinationOnly.run.calls, 0);
});

test('invalid sealed ceilings or historical counts fail closed rather than defaulting history to zero', () => {
  for (const coordinatorCallCeiling of [null, 0, -1, .5, NaN, Infinity, '5', 11, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, coordinatorCallCeiling }), error => error.code === 'INVALID_COORDINATOR_CALL_CEILING');
  for (const priorCoordinatorCalls of [null, -1, .5, NaN, Infinity, '4', 6, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, priorModelCalls: 5, coordinatorCallCeiling: 8, priorCoordinatorCalls }),
      error => error.code === 'INVALID_COORDINATOR_CALL_HISTORY');
  assert.throws(() => new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, priorModelCalls: 5, coordinatorCallCeiling: 8 }),
    error => error.code === 'INVALID_COORDINATOR_CALL_HISTORY');
  for (const priorModelCalls of [-1, NaN, Infinity, .5])
    assert.throws(() => new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, priorModelCalls, coordinatorCallCeiling: 8, priorCoordinatorCalls: 0 }),
      error => error.code === 'INVALID_COORDINATOR_CALL_HISTORY');
  const alreadyOver = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 10, priorModelCalls: 6, coordinatorCallCeiling: 4, priorCoordinatorCalls: 5 });
  assert.throws(() => alreadyOver.reserve(.01), error => error.code === 'COORDINATOR_TURN_LIMIT');
});

test('legacy snapshots without a coordination ceiling keep the existing shared project semantics', () => {
  const budget = new ExecutionBudget({ maxBudget: 1, maxModelCalls: 4, priorModelCalls: 2 });
  budget.reserve(.1).release(); budget.reserve(.1).release();
  assert.equal(budget.run.calls, 4);
  assert.throws(() => budget.reserve(.1), error => error.code === 'TURN_LIMIT');
  assert.equal(budget.run.reserved, 0);
});

test('adapter passes the sealed coordination ceiling/history through before preview, durable admission or transport', async () => {
  const original = globalThis.fetch; let fetches = 0, receipts = 0;
  globalThis.fetch = async () => { fetches++; throw Error('must never reach transport'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, maxModelCalls: 20, priorModelCalls: 8,
      coordinatorCallCeiling: 5, priorCoordinatorCalls: 5, beforeRequest: async () => { receipts++; } });
    assert.throws(() => adapter.prepareRequest(options), error => error.code === 'COORDINATOR_TURN_LIMIT');
    await assert.rejects(consume(adapter), error => error.code === 'COORDINATOR_TURN_LIMIT');
    assert.equal(fetches, 0); assert.equal(receipts, 0); assert.equal(adapter.budget.run.calls, 8); assert.equal(adapter.calls, 0);
    assert.equal(adapter.budget.coordinator.calls, 5);
  } finally { globalThis.fetch = original; }
});

test('a dispatched unknown request consumes the last coordination call and is never replayed after its reservation is released', async () => {
  const original = globalThis.fetch; let fetches = 0; const receipts = [], errors = [];
  globalThis.fetch = async () => { fetches++; throw Error('ambiguous local transport fixture'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, maxModelCalls: 20, priorModelCalls: 8,
      coordinatorCallCeiling: 6, priorCoordinatorCalls: 5, beforeRequest: async receipt => { receipts.push(receipt); }, onCallError: error => { errors.push(error); } });
    await assert.rejects(consume(adapter), error => error.code === 'CONNECTION_FAILED');
    await assert.rejects(consume(adapter), error => error.code === 'COORDINATOR_TURN_LIMIT');
    assert.equal(fetches, 1); assert.equal(receipts.length, 1); assert.equal(errors.length, 1); assert.equal(errors[0].dispatched, true);
    assert.equal(adapter.budget.run.calls, 9); assert.equal(adapter.budget.coordinator.calls, 6); assert.equal(adapter.reserved, 0);
  } finally { globalThis.fetch = original; }
});

test('concurrent coordination requests cannot share the final sealed call while durable admission is waiting', async () => {
  const original = globalThis.fetch, entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  let fetches = 0, admissions = 0;
  globalThis.fetch = async () => { fetches++; return Response.json({ choices: [{ message: { content: 'local protocol fixture' } }], usage: { prompt_tokens: 0, completion_tokens: 1 } }); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, maxModelCalls: 10, priorModelCalls: 2,
      coordinatorCallCeiling: 1, priorCoordinatorCalls: 0, beforeRequest: async () => { admissions++; entered.resolve(); await proceed.promise; } });
    const running = consume(adapter); await entered.promise;
    assert.throws(() => adapter.prepareRequest(options), error => error.code === 'COORDINATOR_TURN_LIMIT');
    await assert.rejects(consume(adapter), error => error.code === 'COORDINATOR_TURN_LIMIT');
    assert.equal(fetches, 0); assert.equal(admissions, 1); assert.equal(adapter.budget.coordinator.calls, 1);
    proceed.resolve(); await running;
    assert.equal(fetches, 1); assert.equal(adapter.budget.run.calls, 3); assert.equal(adapter.budget.coordinator.calls, 1);
  } finally { proceed.resolve(); globalThis.fetch = original; }
});

test('an authorized fallback cannot create another coordination request after the first consumed its final call', async () => {
  const original = globalThis.fetch, receipts = [], unknown = []; let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response('{}', { status: 503 }); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route, { ...route, id: 'backup' }], maxBudget: 1, maxModelCalls: 10,
      coordinatorCallCeiling: 1, beforeRequest: async row => { receipts.push(row); }, onCallError: row => { unknown.push(row); } });
    adapter.sessionPolicies.set(options.sessionId, { fallbackModelId: 'backup' });
    await assert.rejects(consume(adapter), error => error.code === 'COORDINATOR_TURN_LIMIT');
    assert.equal(fetches, 1); assert.equal(receipts.length, 1); assert.equal(unknown.length, 1);
    assert.equal(unknown[0].id, receipts[0].id); assert.equal(unknown[0].dispatched, true);
    assert.equal(adapter.budget.run.calls, 1); assert.equal(adapter.budget.coordinator.calls, 1);
  } finally { globalThis.fetch = original; }
});

test('a locally rejected durable admission releases money but never refunds its already reserved coordination call', async () => {
  const original = globalThis.fetch; let fetches = 0, admissions = 0;
  globalThis.fetch = async () => { fetches++; throw Error('must not reach transport'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, coordinatorCallCeiling: 1,
      beforeRequest: async () => { admissions++; throw Object.assign(Error('local gate denied'), { status: 422, code: 'BUDGET_EXCEEDED' }); } });
    await assert.rejects(consume(adapter), error => error.code === 'BUDGET_EXCEEDED');
    await assert.rejects(consume(adapter), error => error.code === 'COORDINATOR_TURN_LIMIT');
    assert.equal(fetches, 0); assert.equal(admissions, 1); assert.equal(adapter.budget.coordinator.calls, 1);
    assert.equal(adapter.budget.run.calls, 1); assert.equal(adapter.reserved, 0); assert.equal(adapter.budget.run.reserved, 0);
  } finally { globalThis.fetch = original; }
});

test('ProductDshRuntime actually forwards raw sealed ceiling and history into adapter validation before employee hosts exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-budget-forward-'));
  const original = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw Error('no network in constructor forwarding regression'); };
  try {
    for (const [resourceApproval, budgetHistory, expected] of [
      [{ coordinatorCallCeiling: null }, { calls: 5, coordinatorCalls: 3 }, '恢复阶段的累计协调调用上限无效'],
      [{ coordinatorCallCeiling: 8 }, { calls: 5, coordinatorCalls: null }, '恢复阶段的协调调用历史无效'],
      [{ coordinatorCallCeiling: 8 }, { calls: 5 }, '恢复阶段的协调调用历史无效'],
    ]) {
      const events = [], task = { id: 'unused', get maxOutputTokens() { throw Error('ADAPTER_VALIDATION_WAS_BYPASSED'); } };
      const snapshot = { policy: { maxBudget: 1, maxModelCalls: 10, maxConcurrentAgents: 1, deadlineSeconds: 60 },
        executionBudget: 1, tasks: [task], agents: [], resourceApproval, budgetHistory };
      let closed = false;
      const runtime = new ProductDshRuntime({ traceRoot: root, createExecutor: () => ({ root, async close() { closed = true; } }) });
      const result = await runtime.execute({ controller: new AbortController() }, { id: 'local-only', dir: root,
        append(type, data) { events.push({ type, data }); } }, snapshot, [route]);
      assert.equal(result.status, 'failed'); assert.equal(result.message, expected);
      assert.equal(events.findLast(event => event.type === 'run/finished').data.message, expected);
      assert.equal(closed, true); assert.ok(!events.some(event => event.type === 'run/captain' || event.type === 'model/wire-request'));
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
