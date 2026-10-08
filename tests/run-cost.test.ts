import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runCostSummary } from '../apps/web/src/run-cost.ts';
import { BudgetStatus } from '../apps/web/src/BudgetStatus.tsx';

const usage = (cost: number) => ({ type: 'billing/usage', data: { cost } });

test('normal execution includes the saved planning cost in project spend', () => {
  const cost = runCostSummary({ policy: { maxBudget: 1 }, executionBudget: .99, budgetVersion: 1 }, [usage(.02), usage(.03)]);
  assert.equal(cost.current, .05);
  assert.ok(Math.abs(cost.inherited! - .01) < 1e-12);
  assert.ok(Math.abs(cost.total! - .06) < 1e-12);
  assert.equal(cost.limit, 1);
});

test('a resumed run displays inherited spend without counting old model records a second time', () => {
  const snapshot = { policy: { maxBudget: 1, maxModelCalls: 10 }, executionBudget: .8, budgetVersion: 1, budgetHistory: { calls: 6 } };
  const events = [usage(.025), { type: 'runtime/status', data: {} }, { type: 'billing/unconfirmed', data: { cost: .2 } }];
  const cost = runCostSummary(snapshot, events);
  assert.ok(Math.abs(cost.total! - .225) < 1e-12);
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events }));
  assert.match(text, /项目累计费用：\$0.225000/);
  assert.match(text, /本次运行 \$0.025000/);
  assert.match(text, /启动前已用 \$0.200000/);
  assert.match(text, /以中转站账单为准/);
  assert.match(text, /待核对调用可能尚未计入/);
  assert.ok(!text.includes('已调用 1'), 'usage record counts are not total provider attempts');
});

test('legacy archives without execution-budget evidence show only known current spend', () => {
  for (const snapshot of [{}, { budgetVersion: 1, policy: { maxBudget: 1 } }, { budgetVersion: 1, policy: { maxBudget: 1 }, executionBudget: null }]) {
    const cost = runCostSummary(snapshot, [usage(.04)]);
    assert.equal(cost.current, .04);
    assert.equal(cost.inherited, undefined);
    assert.equal(cost.total, undefined);
    const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events: [usage(.04)] }));
    assert.match(text, /本次已记录费用：\$0.040000/);
    assert.ok(!text.includes('项目累计费用'));
  }
});

test('historical budget notices do not present their old occupied amount or call count as the latest ledger', () => {
  const snapshot = { policy: { maxBudget: .48, maxModelCalls: 37 }, executionBudget: .1012552, budgetVersion: 1,
    costCarryover: { retained: true, recordedCost: .3508754, reserved: .0278694, availableBudget: .1012552, receipts: [] } };
  const events = [usage(.015542), { seq: 1, type: 'budget/warning', data: {
    scope: 'project', threshold: 70, spent: .3787448, reserved: 0, limit: .48, calls: 20, maxCalls: 37 } }];
  const ledger = { recordedCost: .3664174, reserved: .0278694, availableBudget: .0857132, pendingCount: 0, uncertainCount: 2, receipts: [] };
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events, costReadiness: ledger }));
  assert.match(text, /项目累计费用：\$0.366417/);
  assert.match(text, /未结算预留 \$0.027869 · 可用 \$0.085713/);
  assert.match(text, /role="status"/);
  assert.match(text, /项目 · 历史预算通知 · 达到 70% 预算/);
  assert.match(text, /通知时预算占用（含预留） \$0.378745 \/ \$0.480000 · 当时已调用 20 \/ 37 次/);
  assert.match(text, /历史阈值通知，请结合上方当前费用状态查看/);
  assert.ok(!text.includes('已记录 $0.378745'));
  assert.ok(!text.includes('当时已调用 21'), 'known usage rows cannot replace the captured provider-attempt count');
});

test('a stopped notice includes captured in-flight reservations and keeps the task failure message', () => {
  const snapshot = { tasks: [{ id: 'qa', subject: '独立测试' }] };
  const events = [{ seq: 2, type: 'budget/stopped', data: { scope: 'task', taskId: 'qa', spent: .1,
    reserved: .04, limit: .15, calls: 4, maxCalls: 10, message: '本次请求预留将超过任务费用上限' } }];
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events }));
  assert.match(text, /role="alert"/);
  assert.match(text, /任务 独立测试 · 历史预算通知 · 当时停止后续执行/);
  assert.match(text, /通知时预算占用（含预留） \$0.140000 \/ \$0.150000 · 当时已调用 4 \/ 10 次/);
  assert.match(text, /本次请求预留将超过任务费用上限/);
});

test('legacy notices with incomplete captures never invent zero reservations or current call counts', () => {
  const events = [{ seq: 3, type: 'budget/warning', data: { scope: 'project', threshold: 70, spent: .07, limit: .1 } }];
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot: {}, events }));
  assert.match(text, /通知时预算占用未完整记录（已占用 \$0.070000；在途预留 未记录）/);
  assert.match(text, /当时已调用 未记录 \/ 未记录 次/);
  assert.ok(!text.includes('通知时预算占用（含预留）'));
  assert.ok(!text.includes('NaN'));
});
