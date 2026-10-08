import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionBudget } from './budget.mjs';
import { executionBudgetContext } from './budget-context.mjs';

const tasks = [
  { id: 'dev', assigneeId: 'developer', estimatedInputTokens: 1000, estimatedOutputTokens: 1000 },
  { id: 'qa', assigneeId: 'reviewer', estimatedInputTokens: 2100, estimatedOutputTokens: 1400 },
  { id: 'manager', assigneeId: 'manager', estimatedInputTokens: 1000, estimatedOutputTokens: 500 },
];
const snapshot = { tasks, agents: [{ id: 'developer', modelId: 'cheap' }, { id: 'reviewer', modelId: 'review' }, { id: 'manager', modelId: 'cheap' }] };
const routes = [{ id: 'cheap', inputRate: .1, outputRate: .5 }, { id: 'review', inputRate: 2, outputRate: 10 }];

test('restored budget feedback retains occupied history and call limits without releasing unknown holds', () => {
  const events = [], budget = new ExecutionBudget({ maxBudget: .1012552, priorSpend: .3787448, maxModelCalls: 37, priorModelCalls: 20,
    tasks, taskUsage: { qa: { cost: .068018, calls: 3 } }, onEvent: event => events.push(event) });
  const before = JSON.stringify({ run: budget.run, tasks: [...budget.tasks] });
  const context = executionBudgetContext({ budget, snapshot: { ...snapshot, recovery: { completed: [{ taskId: 'dev' }] } }, routes, taskId: 'qa' });
  assert.equal(context.project.limit, .48);
  assert.equal(context.project.occupied, .3787448);
  assert.equal(context.project.available, .1012552);
  assert.equal(context.project.callsRemaining, 17);
  assert.equal(context.task.recordedTaskCost, .068018);
  assert.equal(context.task.estimateExceeded, true);
  assert.equal(context.unfinished.count, 2);
  assert.equal(context.unfinished.exceededEstimates, 1, 'unfinished QA cannot be described as zero remaining cost');
  assert.equal(context.unfinished.originalRemainingEstimate, .00042, 'only the unexceeded manager baseline remains known');
  assert.equal(JSON.stringify({ run: budget.run, tasks: [...budget.tasks] }), before);
  assert.deepEqual(events, []);
});

test('feedback changes after reservation and settlement while preserving the stricter task cap', () => {
  const budget = new ExecutionBudget({ maxBudget: 1, tasks: [{ ...tasks[1], maxBudget: .06, maxModelCalls: 4 }] });
  const actor = { taskId: 'qa', employeeId: 'reviewer' }, ticket = budget.reserve(.03, actor);
  const during = executionBudgetContext({ budget, snapshot, routes, taskId: 'qa' });
  assert.equal(during.project.available, .97);
  assert.equal(during.task.available, .03);
  assert.equal(during.task.callsRemaining, 3);
  ticket.settle(.02);
  const after = executionBudgetContext({ budget, snapshot, routes, taskId: 'qa' });
  assert.equal(after.project.available, .98);
  assert.equal(after.task.available, .04);
  assert.equal(after.task.recordedTaskCost, .02);
  assert.equal(after.task.estimateExceeded, false);
  assert.equal(budget.tasks.get('qa').limit, .06);
});

test('unknown model pricing stays unknown and completed nodes do not inflate remaining estimates', () => {
  const budget = new ExecutionBudget({ maxBudget: .5, tasks });
  const context = executionBudgetContext({ budget, snapshot, routes: routes.slice(0, 1), statuses: new Map([['dev', 'completed']]), taskId: 'qa' });
  assert.equal(context.task.originalEstimateUnknown, true);
  assert.equal(context.unfinished.unknownEstimates, 1);
  assert.equal(context.unfinished.count, 2);
  assert.equal(context.unfinished.originalRemainingEstimate, .00042);
});

test('runtime aliases resolve prices by original employee identity, matching real restored snapshots', () => {
  const aliased = { ...snapshot,
    tasks: tasks.map((task, index) => ({ ...task, assignee: 'employee-' + (index + 1) })),
    agents: snapshot.agents.map((agent, index) => ({ ...agent, id: 'employee-' + (index + 1), employeeId: agent.id })) };
  const budget = new ExecutionBudget({ maxBudget: .5, tasks: aliased.tasks });
  const context = executionBudgetContext({ budget, snapshot: aliased, routes, taskId: 'qa' });
  assert.equal(context.task.originalEstimate, .02184);
  assert.equal(context.task.inputRate, 2);
  assert.equal(context.task.outputRate, 10);
  assert.equal(context.unfinished.unknownEstimates, 0);
  assert.equal(context.unfinished.originalRemainingEstimate, .02298);
});

test('project occupation bounds a larger task cap and overrun stays visible without increasing limits', () => {
  const budget = new ExecutionBudget({ maxBudget: .01, priorSpend: .47, tasks: [{ ...tasks[1], maxBudget: .2 }], taskUsage: { qa: { cost: .3, calls: 4 } } });
  const context = executionBudgetContext({ budget, snapshot, routes, taskId: 'qa' });
  assert.equal(context.project.limit, .48);
  assert.equal(context.task.limit, .2);
  assert.equal(context.task.available, 0);
  assert.equal(context.task.estimateExceeded, true);
  assert.equal(budget.tasks.get('qa').spent, .3);
  assert.throws(() => budget.reserve(.001, { taskId: 'qa', employeeId: 'reviewer' }), error => error.code === 'TASK_BUDGET_EXCEEDED');
});
