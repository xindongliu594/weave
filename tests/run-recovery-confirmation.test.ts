import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRunRecoveryConfirmation, type RunRecoveryContext, type RunRecoveryIntent } from '../apps/web/src/run-recovery-confirmation.ts';
import { recoveryConditionsResultKey, type RecoveryConditions } from '../apps/web/src/RecoveryConditions.tsx';
import { RunRecoveryConfirmationPanel } from '../apps/web/src/RunExtras.tsx';

const checked = (): RecoveryConditions => ({ runId: 'original-run', projectId: 'project', planVersion: 4, checkedAt: '2026-10-08T00:00:00Z', originalBudget: .4,
 costReadiness: { recordedCost: .15, reserved: .02, availableBudget: .23, pendingCount: 0, uncertainCount: 1, receipts: [{ id: 'unknown-receipt', amount: .02, status: 'uncertain' }] },
 choices: { retainUncertainCosts: true, acknowledgeUnknownOperations: true }, unknownOperationCount: 1, unknownOperationIds: ['external-operation'], nativeRequestChecked: false,
 tasks: [], resume: { allowed: true, reasons: [], completedTaskIds: ['dev'] }, retry: { allowed: true, reasons: [], completedTaskIds: [] } });
const context = (result = checked()): RunRecoveryContext => ({ runId: result.runId, version: result.planVersion, key: recoveryConditionsResultKey(result), retainUncertainCosts: result.choices.retainUncertainCosts,
 acknowledged: result.choices.acknowledgeUnknownOperations, allowResume: result.resume.allowed, allowRetry: result.retry.allowed });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
 const controller = createRunRecoveryConfirmation(), result = checked(); let current = context(result), gets = 0;
 const posts: RunRecoveryIntent[] = [], navigations: string[] = [];
 const callbacks = { current: () => current, check: async () => { gets++; return result; }, dispatch: async (intent: RunRecoveryIntent) => { posts.push(structuredClone(intent)); return { id: 'only-child' }; }, navigate: (id: string) => { navigations.push(id); } };
 return { controller, result, callbacks, posts, navigations, get gets() { return gets; }, get current() { return current; }, set current(value) { current = value; controller.sync(current); } };
}

test('opening and cancelling either confirmation is local and never dispatches a check or retry', () => {
 const f = fixture();
 for (const resume of [true, false]) { assert.equal(f.controller.open(f.current, resume), true); assert.equal(f.controller.intent?.resume, resume); f.controller.cancel(); assert.equal(f.controller.intent, undefined); }
 assert.equal(f.gets, 0); assert.deepEqual(f.posts, []); assert.deepEqual(f.navigations, []);
 assert.equal(f.controller.open({ ...f.current, allowResume: false }, true), false);
 assert.equal(f.controller.open({ ...f.current, allowRetry: false }, false), false);
});

test('run, version, ledger, receipt, fee consent and unknown-operation acknowledgement changes permanently cancel an intent', () => {
 const base = checked();
 const changed = [
  { ...base, runId: 'other-run' }, { ...base, planVersion: 5 },
  { ...base, costReadiness: { ...base.costReadiness, recordedCost: .16 } },
  { ...base, costReadiness: { ...base.costReadiness, receipts: [{ id: 'another-receipt', amount: .02, status: 'uncertain' as const }] } },
  { ...base, choices: { ...base.choices, retainUncertainCosts: false } },
  { ...base, choices: { ...base.choices, acknowledgeUnknownOperations: false } },
  { ...base, unknownOperationIds: ['new-external-operation'] },
 ];
 for (const result of changed) { const f = fixture(); f.controller.open(f.current, true); const original = f.current; f.current = context(result); assert.equal(f.controller.intent, undefined); f.current = original; assert.equal(f.controller.intent, undefined, 'reverting values cannot resurrect consent'); }
});

test('explicit confirmation rechecks and dispatches the exact mode and choices only once under double click', async () => {
 const f = fixture(), pending = deferred<RecoveryConditions>(); f.controller.open(f.current, true);
 const callbacks = { ...f.callbacks, check: () => pending.promise };
 const first = f.controller.confirm(callbacks); assert.equal(f.controller.inFlight, true);
 assert.equal(await f.controller.confirm(callbacks), false); assert.equal(f.controller.open(f.current, false), false);
 pending.resolve(f.result); assert.equal(await first, true); assert.equal(f.posts.length, 1);
 assert.deepEqual(f.posts[0], { runId: 'original-run', version: 4, key: f.current.key, retainUncertainCosts: true, acknowledged: true, resume: true });
 assert.deepEqual(f.navigations, ['only-child']); assert.equal(f.controller.inFlight, false); assert.equal(f.controller.intent, undefined);
 assert.equal(await f.controller.confirm(callbacks), false); assert.equal(f.posts.length, 1);
});

test('periodic ledger refresh disables submission without dismissing an unchanged confirmation', async () => {
 const f=fixture(); f.controller.open(f.current,true); const intent=f.controller.intent;
 f.current={...f.current,allowResume:false,allowRetry:false};
 assert.equal(f.controller.intent,intent);
 assert.equal(await f.controller.confirm(f.callbacks),false);
 assert.equal(f.gets,0); assert.equal(f.posts.length,0); assert.equal(f.controller.intent,intent);
 f.current={...f.current,allowResume:true,allowRetry:true};
 assert.equal(await f.controller.confirm(f.callbacks),true);
 assert.equal(f.gets,1); assert.equal(f.posts.length,1);
});

test('cancel or changed context while the readonly check is pending prevents the retry POST', async () => {
 for (const cancel of [true, false]) {
  const f = fixture(), pending = deferred<RecoveryConditions>(); f.controller.open(f.current, true);
  const confirmation = f.controller.confirm({ ...f.callbacks, check: () => pending.promise });
  if(cancel)f.controller.cancel(); else f.current = { ...f.current, key: 'ledger-changed' };
  pending.resolve(f.result); assert.equal(await confirmation, false); assert.deepEqual(f.posts, []); assert.deepEqual(f.navigations, []);
 }
});

test('a fresh server check with changed fees or rejected mode never dispatches from an old successful check', async () => {
 for (const changed of [{ ...checked(), costReadiness: { ...checked().costReadiness, reserved: .03 } }, { ...checked(), retry: { allowed: false, reasons: [], completedTaskIds: [] } }]) {
  const f = fixture(); f.controller.open(f.current, false);
  assert.equal(await f.controller.confirm({ ...f.callbacks, check: async () => changed }), false); assert.deepEqual(f.posts, []);
 }
 const f = fixture(); f.controller.open(f.current, false); assert.equal(await f.controller.confirm(f.callbacks), true); assert.equal(f.posts[0].resume, false);
});

test('a delayed submitted response cannot navigate a different run, changed ledger or cancelled confirmation', async () => {
 for (const change of ['cancel', 'run', 'ledger']) {
  const f = fixture(), pending = deferred<{ id: string }>(), sent = deferred<void>(); f.controller.open(f.current, true);
  const confirmation = f.controller.confirm({ ...f.callbacks, dispatch: async intent => { f.posts.push(intent); sent.resolve(); return pending.promise; } });
  await sent.promise;
  if(change==='cancel')f.controller.cancel(); else f.current = change==='run'?{ ...f.current, runId: 'new-page' }:{ ...f.current, key: 'ledger-changed' };
  pending.resolve({ id: 'late-child' }); assert.equal(await confirmation, true); assert.equal(f.posts.length, 1); assert.deepEqual(f.navigations, []);
 }
});

test('dispatch failure releases the lock, closes consent and propagates the error without automatic retry', async () => {
 const f = fixture(); f.controller.open(f.current, true); let calls = 0;
 const callbacks = { ...f.callbacks, dispatch: async () => { calls++; throw Error('response unknown; inspect original run'); } };
 await assert.rejects(f.controller.confirm(callbacks), /response unknown/);
 assert.equal(f.controller.inFlight, false); assert.equal(f.controller.intent, undefined); assert.equal(await f.controller.confirm(callbacks), false); assert.equal(calls, 1);
});

test('accessible inline panels show identity, preserved budget and mode-specific risks with explicit event callbacks', () => {
 for (const resume of [true, false]) {
  const f = fixture(); f.controller.open(f.current, resume); let cancel = 0, confirm = 0;
  const props = { intent: f.controller.intent!, submitting: false, disabled: false, onCancel: () => { cancel++; }, onConfirm: () => { confirm++; } };
  const html = renderToStaticMarkup(createElement(RunRecoveryConfirmationPanel, props));
  assert.match(html, /role="group"/); assert.doesNotMatch(html, /aria-modal|<dialog/); assert.match(html, /original-run/); assert.match(html, /原方案 v4/);
  assert.match(html, /费用上限不变/); assert.match(html, /未知费用预留继续占用原预算/);
  assert.match(html, resume ? /保留已核验的完成节点和文件/ : /可能重复之前的操作，并再次产生费用/);
  assert.match(html, resume ? /确认恢复<\/button>/ : /确认完整重试<\/button>/); assert.match(html, /取消<\/button>/);
  assert.equal(cancel, 0); assert.equal(confirm, 0); assert.equal(f.gets, 0); assert.deepEqual(f.posts, []);
  const element = RunRecoveryConfirmationPanel(props), children = element.props.children as any[];
  children.find(child => child?.type === 'button' && child.props.children === '取消').props.onClick();
  children.find(child => child?.type === 'button' && child.props.className === 'primary').props.onClick();
  assert.equal(cancel, 1); assert.equal(confirm, 1);
  assert.match(renderToStaticMarkup(createElement(RunRecoveryConfirmationPanel, { ...props, submitting: true, disabled: true })), /disabled=""/);
 }
});
