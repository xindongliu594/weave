import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecoveryConditionsView, recoveryConditionsKey, recoveryConditionsResultKey, recoveryConditionsAllow, type RecoveryConditions } from '../apps/web/src/RecoveryConditions.tsx';

const result: RecoveryConditions = {
  runId: 'fixture-run', projectId: 'fixture-project', planVersion: 6, checkedAt: '2026-10-05T06:00:00.000Z', originalBudget: .48,
  costReadiness: { recordedCost: .3664174, reserved: .0278694, availableBudget: .0857132, pendingCount: 0, uncertainCount: 2,
    receipts: [{ id: 'first-unknown', amount: .02, status: 'uncertain' }, { id: 'second-unknown', amount: .0078694, status: 'uncertain' }] },
  calls: { used: 21, limit: 37, remaining: 16 }, choices: { retainUncertainCosts: true, acknowledgeUnknownOperations: false },
  tasks: [{ id: 'prepare', subject: '开发', recordedCost: .1, reserved: 0, budgetLimit: .1, availableBudget: 0,
    calls: 4, callLimit: 10, remainingCalls: 6, completed: true }],
  resume: { allowed: true, reasons: [], completedTaskIds: ['prepare'] }, retry: { allowed: false,
    reasons: [{ status: 422, code: 'TASK_BUDGET_EXHAUSTED', message: '任务已达到费用或调用次数上限', taskId: 'prepare' }], completedTaskIds: [] },
  unknownOperationCount: 0, unknownOperationIds: [], nativeRequestChecked: false,
};
const key = () => recoveryConditionsKey(result.runId, result.planVersion, result.costReadiness, true, false);
const render = (props: Partial<Parameters<typeof RecoveryConditionsView>[0]> = {}) => renderToStaticMarkup(createElement(RecoveryConditionsView,
  { stale: false, checking: false, onCheck: () => {}, ...props }));

test('inspection names coordination usage and sealed remaining calls separately from employee tasks',()=>{
  const limited={...result,coordinatorCalls:{used:16,limit:20,remaining:4}};
  assert.match(render({result:limited}),/经理协调已调用 16 \/ 20 次 · 剩余 4 次/);
  const shared={...result,coordinatorCalls:{used:16}};
  assert.match(render({result:shared}),/经理协调已调用 16 次 · 与员工共享项目总上限/);
  assert.doesNotMatch(render({result:shared}),/协调已调用 0|协调.*不限/);
});

test('an unchecked, loading or failed inspection is distinguishable and never claims a current approval', () => {
  assert.match(render(), /尚未检查/); assert.match(render(), /检查不会调用模型或创建运行/);
  assert.match(render({ checking: true }), /正在只读检查/);
  assert.match(render({ error: '读取请求超时' }), /role="alert"/);
  assert.ok(!render({ error: '读取请求超时' }).includes('本地条件通过'));
  assert.equal(recoveryConditionsAllow(undefined, undefined, key(), true), false);
});

test('inspection displays its version, current ledger, complete calls and separate resume/full-retry limits', () => {
  const text = render({ result, staticEstimate: .033276 });
  assert.match(text, /检查时间/); assert.match(text, /原方案 v6/);
  assert.match(text, /已记录 \$0.366417/); assert.match(text, /未结算预留 \$0.027869/); assert.match(text, /净可用 \$0.085713/);
  assert.match(text, /原方案已调用 21 \/ 37 次 · 剩余 16 次/);
  assert.match(text, /恢复未完成任务：本地条件通过/); assert.match(text, /完整重试：检查时不能继续/);
  assert.match(text, /TASK_BUDGET_EXHAUSTED/); assert.match(text, /批准时方案静态估算 \$0.033276/);
  assert.match(text, /尚未检查具体模型请求/); assert.match(text, /不保证下一次请求或整个项目可付/);
  assert.match(text, /自身剩余 \$0.000000/); assert.match(text, /不代表为该阶段单独锁定的资金/);
  assert.equal(recoveryConditionsAllow(result, key(), key(), true), true);
  assert.equal(recoveryConditionsAllow(result, key(), key(), false), false);
});

test('changed receipts, amounts, fee consent, external acknowledgement and plan identity invalidate a previous result', () => {
  const changed = [
    recoveryConditionsKey(result.runId, 7, result.costReadiness, true, false),
    recoveryConditionsKey('other-run', 6, result.costReadiness, true, false),
    recoveryConditionsKey(result.runId, 6, result.costReadiness, false, false),
    recoveryConditionsKey(result.runId, 6, result.costReadiness, true, true),
    recoveryConditionsKey(result.runId, 6, result.costReadiness, true, false, ['new-unknown-operation']),
    recoveryConditionsKey(result.runId, 6, { ...result.costReadiness, recordedCost: .38 }, true, false),
    recoveryConditionsKey(result.runId, 6, { ...result.costReadiness, receipts: [{ id: 'new-unknown', amount: .0278694, status: 'uncertain' }] }, true, false),
  ];
  for (const current of changed) assert.equal(recoveryConditionsAllow(result, key(), current, true), false);
  assert.match(render({ result, stale: true }), /上次检查结果/);
  const reordered = recoveryConditionsKey(result.runId, 6, { ...result.costReadiness, receipts: [...result.costReadiness.receipts].reverse() }, true, false);
  assert.equal(reordered, key(), 'query ordering cannot invalidate unchanged receipt evidence');
});

test('missing history is displayed as unknown rather than zero remaining and failed modes cannot enable continuation', () => {
  const unavailable: RecoveryConditions = { ...result, calls: undefined, tasks: [], resume: { allowed: false,
    reasons: [{ status: 409, code: 'BUDGET_HISTORY_MISSING', message: '缺少此前执行档案' }], completedTaskIds: [] } };
  assert.match(render({ result: unavailable }), /调用历史尚未核验/);
  assert.match(render({ result: unavailable }), /BUDGET_HISTORY_MISSING/);
  assert.ok(!render({ result: unavailable }).includes('原方案已调用 0'));
  assert.equal(recoveryConditionsAllow(unavailable, key(), key(), true), false);
});

test('a fresh response containing newly unknown operations cannot reuse consent for the previously shown operation', () => {
  const visibleKey = recoveryConditionsKey(result.runId, 6, result.costReadiness, true, true, ['previous-operation']);
  const late: RecoveryConditions = { ...result, choices: { retainUncertainCosts: true, acknowledgeUnknownOperations: true },
    unknownOperationCount: 1, unknownOperationIds: ['new-operation'] };
  assert.equal(late.resume.allowed, true, 'the server received a boolean acknowledgement');
  assert.equal(recoveryConditionsAllow(late, recoveryConditionsResultKey(late), visibleKey, true), false,
    'the browser must not submit recovery for an operation the user has not seen');
  assert.match(render({ result: late, stale: true }), /刷新本页读取最新操作记录/);
});
