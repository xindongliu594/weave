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
