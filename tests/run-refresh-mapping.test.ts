import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeRunDetailPage, runTaskView } from '../apps/web/src/run-detail-view.ts';
import { RunExtras } from '../apps/web/src/RunExtras.tsx';
import { handoffNotices } from '../apps/web/src/run-handoff.ts';
import { recoveryConditionsAllow, recoveryConditionsKey, recoveryConditionsResultKey, type RecoveryConditions } from '../apps/web/src/RecoveryConditions.tsx';
import type { RunDetail, TraceEvent } from '../services/agent-runtime/trace-store.mjs';

const runId = 'synthetic-run';
const event = (seq: number, type: string, data: any): TraceEvent => ({ seq, type, data, at: '2026-10-06T00:00:00.000Z' });
const contracts = [
  { id: 'dev', subject: '开发', taskPrompt: '批准的开发合同', assignee: 'developer', dependencies: [], outputs: [{ path: 'todo.mjs' }] },
  { id: 'qa_verify', subject: '独立测试', taskPrompt: '批准的验收合同', assignee: 'qa', dependencies: ['dev'] },
];
const snapshot = { requirement: 'synthetic fixture only', planVersion: 8, templateVersion: 'fixture', approval: {},
  tasks: contracts, approvedTasks: contracts, policy: { maxBudget: 1 }, executionBudget: 1,
  agents: [{ id: 'developer', name: '开发员工', model: 'fixture', roleVersion: 1, rolePrompt: 'fixture' },
    { id: 'qa', name: '独立 QA', model: 'fixture', roleVersion: 1, rolePrompt: 'fixture' }] };
const mapping = event(1, 'run/task-mapping', { tasks: [{ task_id: 't1', seed_id: 'dev' }, { task_id: 't2', seed_id: 'qa_verify' }] });
const native = (status = 'failed') => event(4, 'team/checkpoint', { tasks: [
  { id: 't1', subject: 'native title', assignee: 'untrusted-label', status, attemptId: 'dev-attempt', dependencies: [], output: 'current output' },
  { id: 't2', status: 'pending', dependencies: ['t1'] },
] });
const acceptance = (extra = {}) => event(3, 'handoff/accepted', { runId, taskId: 'dev', attemptId: 'dev-attempt', ...extra });
type Detail = RunDetail & { nextCursor: number; hasMore: boolean; error?: string; summaryEvents: TraceEvent[];
  recovery: { unknownOperations: { callId: string }[]; checkpointBlocked?: string } };
const detail = (extra: Partial<Detail> = {}): Detail => ({ id: runId, title: 'fixture', mode: 'product', status: 'failed', integrity: 'ok',
  createdAt: '2026-10-06T00:00:00.000Z', snapshot, eventCount: 4, events: [mapping, event(2, 'tool/result', {})],
  nextCursor: 2, hasMore: true, summaryEvents: [native()], recovery: { unknownOperations: [{ callId: 'old-operation' }] }, ...extra });

test('terminal detail refresh replaces full recovery and summary metadata while retaining loaded pages', () => {
  const current = detail({ events: [mapping, event(2, 'tool/result', {}), acceptance(), native()], nextCursor: 4, hasMore: false,
    error: 'old error' });
  const late = event(5, 'runtime/outcome-unknown', { callId: 'new-operation' });
  const incoming = detail({ events: [late], nextCursor: 5, eventCount: 5, hasMore: false, error: 'fresh error',
    integrity: 'incomplete', summaryEvents: [native(), late], recovery: { unknownOperations: [{ callId: 'new-operation' }], checkpointBlocked: 'new blocker' } });
  const before = structuredClone(current);
  const merged = mergeRunDetailPage(current, incoming);
  assert.deepEqual(merged.events.map(item => item.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(merged.summaryEvents, incoming.summaryEvents);
  assert.deepEqual(merged.recovery, incoming.recovery);
  assert.equal(merged.error, 'fresh error'); assert.equal(merged.integrity, 'incomplete');
  assert.equal(merged.nextCursor, 5); assert.equal(merged.hasMore, false);
  assert.deepEqual(current, before, 'refresh does not mutate the previously loaded detail');
});

test('overlapping manual refresh and polling keep the furthest cursor and newer metadata', () => {
  const current = detail({ events: [mapping, event(2, 'tool/result', {}), acceptance(), native()], nextCursor: 4, hasMore: false });
  const firstPageAgain = detail({ events: [mapping, event(2, 'tool/result', {})], nextCursor: 2, hasMore: true });
  const refreshed = mergeRunDetailPage(current, firstPageAgain);
  assert.equal(refreshed.nextCursor, 4); assert.equal(refreshed.hasMore, false);
  const newest = mergeRunDetailPage(refreshed, detail({ eventCount: 6, events: [event(5, 'tool/result', {}), event(6, 'run/finished', {})],
    nextCursor: 6, hasMore: false, status: 'interrupted', recovery: { unknownOperations: [] } }));
  const delayed = mergeRunDetailPage(newest, firstPageAgain);
  assert.equal(delayed.status, 'interrupted'); assert.deepEqual(delayed.recovery.unknownOperations, []);
  assert.deepEqual(delayed.events.map(item => item.seq), [1, 2, 3, 4, 5, 6]); assert.equal(delayed.hasMore, false);
});

test('a stale response from a different run or plan version cannot attach events or completion state', () => {
  const current = detail();
  assert.equal(mergeRunDetailPage(current, detail({ id: 'other-run', summaryEvents: [acceptance()] })), current);
  assert.equal(mergeRunDetailPage(current, detail({ snapshot: { ...snapshot, planVersion: 9 }, summaryEvents: [acceptance()] })), current);
});

test('terminal refresh changes the recovery key while the existing cost and acknowledgement checks remain strict', () => {
  const readiness = { recordedCost: .2, reserved: .1, availableBudget: .7, pendingCount: 0, uncertainCount: 1,
    receipts: [{ id: 'unknown-fee', amount: .1, status: 'uncertain' as const }] };
  const checked: RecoveryConditions = { runId, projectId: 'fixture-project', planVersion: 8, checkedAt: '2026-10-06T00:00:00.000Z',
    originalBudget: 1, costReadiness: readiness, choices: { retainUncertainCosts: true, acknowledgeUnknownOperations: true },
    calls: { used: 4, limit: 20, remaining: 16 }, tasks: [], resume: { allowed: true, reasons: [], completedTaskIds: [] },
    retry: { allowed: true, reasons: [], completedTaskIds: [] }, unknownOperationCount: 1, unknownOperationIds: ['new-operation'], nativeRequestChecked: false };
  const current = detail();
  const fresh = mergeRunDetailPage(current, detail({ recovery: { unknownOperations: [{ callId: 'new-operation' }] } }));
  const key = (value: Detail, retain = true, acknowledge = true) => recoveryConditionsKey(runId, 8, readiness, retain, acknowledge,
    value.recovery.unknownOperations.map(item => item.callId));
  const resultKey = recoveryConditionsResultKey(checked);
  assert.equal(recoveryConditionsAllow(checked, resultKey, key(current), true), false);
  assert.equal(recoveryConditionsAllow(checked, resultKey, key(fresh), true), true);
  assert.equal(recoveryConditionsAllow(checked, resultKey, key(fresh, false), true), false);
  assert.equal(recoveryConditionsAllow(checked, resultKey, key(fresh, true, false), true), false);
});

test('native states use approved task IDs, contracts and dependencies even when summary omits the mapping', () => {
  const state = native(), before = structuredClone([snapshot, state, mapping]);
  const tasks = runTaskView(runId, snapshot, [state], [mapping]);
  assert.deepEqual(tasks.map(task => task.id), ['dev', 'qa_verify']);
  assert.equal(tasks[0].runtimeTaskId, 't1'); assert.equal(tasks[0].status, 'failed');
  assert.equal(tasks[0].subject, '开发'); assert.equal(tasks[0].assignee, 'developer');
  assert.deepEqual(tasks[1].dependencies, ['dev']); assert.equal(tasks[0].taskPrompt, contracts[0].taskPrompt);
  assert.deepEqual([snapshot, state, mapping], before);
  const blocked = event(5, 'handoff/blocked', { taskId: 'dev', message: 'actual fixture failure' });
  assert.equal(handoffNotices([blocked], tasks).current[0].taskId, 'dev');
});

test('the latest rework mapping supersedes an older accepted completion regardless of native array order', () => {
  const state = event(8, 'team/checkpoint', { tasks: [
    { id: 'repair-1', status: 'blocked', attemptId: 'repair-attempt' },
    { id: 't1', status: 'completed', attemptId: 'dev-attempt' },
  ] });
  const repair = event(6, 'quality/rework-created', { bindings: [{ task_id: 'repair-1', seed_id: 'dev' }] });
  const blocked = event(9, 'handoff/blocked', { taskId: 'dev', attemptId: 'repair-attempt', message: 'repair blocked' });
  const tasks = runTaskView(runId, snapshot, [acceptance(), repair, state, blocked], [mapping]);
  assert.equal(tasks[0].runtimeTaskId, 'repair-1'); assert.equal(tasks[0].status, 'blocked');
  assert.equal(handoffNotices([acceptance(), blocked], tasks).current.length, 1);
  const missingFreshState = runTaskView(runId, snapshot, [acceptance(), repair, native('completed')], [mapping]);
  assert.equal(missingFreshState[0].status, 'pending', 'an old completed native task cannot hide a newly mapped repair');
});

test('native completed requires acceptance for this run, plan and exact current attempt', () => {
  const state = native('completed');
  for (const records of [[], [acceptance({ runId: 'other-run' })], [acceptance({ planVersion: 7 })], [acceptance({ attemptId: 'old-attempt' })]]) {
    assert.equal(runTaskView(runId, snapshot, [...records, state], [mapping])[0].status, 'awaiting_acceptance');
  }
  assert.equal(runTaskView(runId, snapshot, [acceptance(), state], [mapping])[0].status, 'completed');
});

test('only an explicitly inherited accepted checkpoint may show a parent completion in a child run', () => {
  const restored = { ...snapshot, recovery: { sourceRunId: 'parent-run', completed: [{ taskId: 'dev', attemptId: 'prior-attempt' }] },
    handoffCheckpoints: [{ runId: 'parent-run', taskId: 'dev', attemptId: 'prior-attempt' }] };
  assert.equal(runTaskView(runId, restored, [])[0].status, 'completed');
  assert.equal(runTaskView(runId, { ...restored, handoffCheckpoints: [] }, [])[0].status, 'awaiting_acceptance');
  assert.equal(runTaskView(runId, { ...restored, handoffCheckpoints: [{ runId: 'parent-run', taskId: 'dev', attemptId: 'prior-attempt', planVersion: 7 }] }, [])[0].status, 'awaiting_acceptance');
});

test('an ancestor seal is inherited only through the current approved snapshot after repeated recovery', () => {
  const ancestorSeal = { runId: 'grandparent-run', taskId: 'dev', attemptId: 'prior-attempt' };
  const restored = { ...snapshot, recovery: { sourceRunId: 'parent-run', completed: [{ taskId: 'dev', attemptId: 'prior-attempt' }] },
    handoffCheckpoints: [ancestorSeal] };
  assert.equal(runTaskView(runId, restored, [])[0].status, 'completed');
  const unrelatedEvent = event(1, 'handoff/accepted', ancestorSeal);
  assert.equal(runTaskView(runId, { ...restored, handoffCheckpoints: [] }, [unrelatedEvent])[0].status, 'awaiting_acceptance');
  assert.equal(runTaskView(runId, { ...restored, recovery: { ...restored.recovery, completed: [] } }, [])[0].status, 'pending');
});

test('seed_id and restored profileSeedId fallback keep unmapped nodes distinct and unapproved', () => {
  const state = event(1, 'team/checkpoint', { tasks: [{ id: 'native-dev', seed_id: 'dev', status: 'failed' },
    { id: 'native-qa', profileSeedId: 'qa_verify', status: 'in_progress' }, { id: 'unknown-node', status: 'completed' }] });
  const tasks = runTaskView(runId, snapshot, [state]);
  assert.deepEqual(tasks.map(task => task.id), ['dev', 'qa_verify', 'unknown-node']);
  assert.equal(tasks[0].runtimeTaskId, 'native-dev'); assert.equal(tasks[1].runtimeTaskId, 'native-qa');
  assert.equal(tasks[2].unapproved, true); assert.equal(tasks[2].status, 'awaiting_acceptance');
});

test('the actual RunExtras render shows mapped task failure, dependencies and unaccepted completion without actions', () => {
  let actions = 0;
  const render = (events: TraceEvent[]) => renderToStaticMarkup(createElement(RunExtras, { id: runId, status: 'failed', snapshot,
    traceEvents: [mapping], events, onOpenProject: () => { actions++; }, onRefreshDetail: async () => { actions++; } }));
  const failed = render([native(), event(5, 'handoff/blocked', { taskId: 'dev', message: 'fixture handoff blocker' })]);
  assert.match(failed, /dev（原生 t1）/); assert.match(failed, /开发 · 任务仍未完成，最近交接失败/);
  assert.match(failed, /前置：开发/); assert.match(failed, /fixture handoff blocker/);
  assert.doesNotMatch(failed, /untrusted-label/);
  assert.match(render([native('completed')]), /等待交接核验/);
  assert.equal(actions, 0, 'rendering never requests a model, creates a run or triggers a mutation');
});
