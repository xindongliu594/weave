import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BudgetStatus } from '../apps/web/src/BudgetStatus.tsx';
import { CostContinuation, CostCarryoverChoice, costConsentKey, costContinuationBlocked, costReadinessForBudget, runContinuationBlocked, type CostContinuationState, type CostReadiness } from '../apps/web/src/CostCarryoverChoice.tsx';

const readiness: CostReadiness = { recordedCost: .12, reserved: .06, availableBudget: .3, pendingCount: 0, uncertainCount: 1,
  receipts: [{ id: 'unknown-call', amount: .06, status: 'uncertain', runId: 'original-run' }] };
const view = (value: CostReadiness, retain = false): CostContinuationState => ({ readiness: value, retainUncertainCosts: retain, blocked: costContinuationBlocked(value, retain), loading: false, error: '', refresh: () => {}, setRetainUncertainCosts: () => {} });

test('unknown-cost continuation requires explicit consent and never releases its reserved amount', () => {
  assert.equal(costContinuationBlocked(readiness, false), true);
  assert.equal(costContinuationBlocked(readiness, true), false);
  const text = renderToStaticMarkup(createElement(CostCarryoverChoice, { state: view(readiness, true) }));
  assert.match(text, /已记录费用<\/span><span>\$0.120000/);
  assert.match(text, /未结算预留<\/span><span>\$0.060000/);
  assert.match(text, /扣除预留后可用预算<\/span><strong>\$0.300000/);
  assert.match(text, /未知金额不计为已消费，也不按零费用结算/);
  assert.match(text, /准确账单/);
  assert.deepEqual(readiness.receipts, [{ id: 'unknown-call', amount: .06, status: 'uncertain', runId: 'original-run' }]);
});

test('an active request and an exhausted original budget stay blocked even after cost consent', () => {
  const pending = { ...readiness, pendingCount: 1, receipts: [...readiness.receipts, { id: 'active-call', amount: .01, status: 'pending' as const }] };
  assert.equal(costContinuationBlocked(pending, true), true);
  const text = renderToStaticMarkup(createElement(CostCarryoverChoice, { state: view(pending, true) }));
  assert.match(text, /调用仍在进行中/);
  assert.match(text, /type="checkbox"[^>]*disabled=""/);
  assert.equal(costContinuationBlocked({ ...readiness, availableBudget: 0 }, true), true);
  assert.equal(costContinuationBlocked({ ...readiness, availableBudget: -.01 }, true), true);
  assert.equal(costContinuationBlocked(undefined, true), true);
});

test('settled projects use their original actions without an unnecessary consent checkbox', () => {
  const settled = { ...readiness, reserved: 0, availableBudget: .36, uncertainCount: 0, receipts: [] };
  assert.equal(costContinuationBlocked(settled, false), false);
  const text = renderToStaticMarkup(createElement(CostCarryoverChoice, { state: view(settled) }));
  assert.ok(!text.includes('type="checkbox"'));
  assert.ok(!text.includes('费用尚未确定'));
  assert.match(text, /\$0.360000/);
});

test('new receipts, changed amounts, or a different project version invalidate the earlier cost choice', () => {
  const before = costConsentKey('plan-v5', readiness);
  assert.notEqual(costConsentKey('plan-v6', readiness), before);
  assert.notEqual(costConsentKey('plan-v5', { ...readiness, receipts: [{ ...readiness.receipts[0], amount: .08 }] }), before);
  const two = { ...readiness, uncertainCount: 2, receipts: [...readiness.receipts, { id: 'new-unknown', amount: .02, status: 'uncertain' as const }] };
  assert.notEqual(costConsentKey('plan-v5', two), before);
  assert.equal(costConsentKey('plan-v5', two), costConsentKey('plan-v5', { ...two, receipts: [...two.receipts].reverse() }));
});

test('recovery uses the archive budget and cost consent does not acknowledge unknown external operations', () => {
  const latestPlan = { ...readiness, availableBudget: 5.82 };
  const archive = costReadinessForBudget(latestPlan, .48)!;
  assert.ok(Math.abs(archive.availableBudget - .3) < 1e-12);
  assert.equal(latestPlan.availableBudget, 5.82);
  const costs = view(archive, true), base = { busy: false, unknownCount: 1, acknowledged: false, resume: true };
  assert.equal(runContinuationBlocked(costs, base), true);
  assert.equal(runContinuationBlocked(costs, { ...base, acknowledged: true }), false);
  assert.equal(runContinuationBlocked(costs, { ...base, acknowledged: true, checkpointBlocked: 'File version could not be verified' }), true);
  assert.equal(runContinuationBlocked(costs, { ...base, acknowledged: true, checkpointBlocked: 'File version could not be verified', resume: false }), false);
  assert.equal(runContinuationBlocked({ ...costs, blocked: true }, { ...base, acknowledged: true }), true);
});

test('carried reservation is shown as the approval evidence and never counted as recorded spend or renewed consent', () => {
  const carryover = { retained: true, recordedCost: .12, reserved: .06, availableBudget: .3, receipts: [{ id: 'unknown-call', amount: .06, runId: 'original-run' }] };
  const snapshot = { policy: { maxBudget: .48 }, executionBudget: .3, budgetVersion: 1, costCarryover: carryover };
  const events = [{ type: 'billing/usage', data: { cost: .025 } }];
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events }));
  assert.match(text, /项目累计费用：\$0.145000/);
  assert.match(text, /启动前已用 \$0.120000/);
  assert.match(text, /保留预留 \$0.060000/);
  assert.match(text, /不代表再次同意继续执行/);
  assert.ok(!text.includes('项目累计费用：$0.205000'));
  let consent: boolean | undefined;
  renderToStaticMarkup(createElement(CostContinuation, { identity: 'new-recovery', initial: readiness, children: state => {
    consent = state.retainUncertainCosts;
    return createElement(CostCarryoverChoice, { state });
  } }));
  assert.equal(consent, false);
});

test('fresh ledger totals update the budget display independently from the immutable archive', () => {
  const snapshot = { policy: { maxBudget: .48 }, executionBudget: .3, budgetVersion: 1,
    costCarryover: { retained: true, recordedCost: .12, reserved: .06, availableBudget: .3, receipts: [{ id: 'unknown-call', amount: .06 }] } };
  const current = { ...readiness, recordedCost: .15, reserved: 0, availableBudget: .33, uncertainCount: 0, receipts: [] };
  const text = renderToStaticMarkup(createElement(BudgetStatus, { snapshot, events: [], costReadiness: current }));
  assert.match(text, /项目累计费用：\$0.150000/);
  assert.match(text, /未结算预留 \$0.000000 · 可用 \$0.330000/);
  assert.match(text, /保留预留 \$0.060000/);
});
