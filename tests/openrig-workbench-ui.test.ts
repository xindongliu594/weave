import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../apps/web/src/api.ts';
import { OpenRigProjectLink, type useOpenRigWorkbench } from '../apps/web/src/OpenRigWorkbench.tsx';
import { canSyncOpenRigProject, hasOpenRigIntent, mergeOpenRigProject, readOpenRigProjects, reconcileOpenRigProject, syncOpenRigProject, type IntentStorage, type OpenRigClient, type OpenRigProject } from '../apps/web/src/openrig-workbench.ts';

const projectId = 'f5ee1214-4b1f-4496-bc33-6ff733e9bd2b';
const queueId = 'qitem-weiwu-' + 'a'.repeat(64);
const view = (status: OpenRigProject['status'], extra: Partial<OpenRigProject> = {}): OpenRigProject => ({ projectId, enabled: true, status, queueItemId: status === 'synced' || status === 'unknown' ? queueId : null, queueState: null, acceptanceAuthority: 'weiwu', ...extra });
function storage(): IntentStorage { const values = new Map<string, string>(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }; }
const client = (fn: (path: string, method?: string, body?: unknown, key?: string) => unknown | Promise<unknown>) => (async (path: string, method?: string, body?: unknown, key?: string) => await fn(path, method, body, key)) as OpenRigClient;
function render(row: OpenRigProject, pending = false, enabled = true, busy = false) {
  const state: ReturnType<typeof useOpenRigWorkbench> = { status: { enabled, status: enabled ? 'ready' : 'disabled', acceptanceAuthority: 'weiwu' }, rows: { [projectId]: row }, pending: { [projectId]: pending }, busy: { [projectId]: busy }, errors: {}, act: async () => { throw Error('Rendering cannot submit'); } };
  return renderToStaticMarkup(createElement(OpenRigProjectLink, { projectId, version: 3, state }));
}

test('disabled integration renders nothing; unbound departments expose no synchronization action', () => {
  assert.equal(render(view('not_synced'), false, false), '');
  assert.match(render(view('not_bound')), /部门尚未连接 OpenRig/);
  assert.doesNotMatch(render(view('not_bound')), /<button/);
  assert.match(render(view('not_synced')), /同步为待办/);
  assert.match(render(view('not_synced'), false, true, true), /disabled=""/);
});

test('queue done is shown as queue state and never as Weiwu acceptance', () => {
  const html = render(view('synced', { queueState: 'done' }));
  assert.match(html, /队列状态：已结束/); assert.match(html, /核对待办/);
  assert.match(html, new RegExp(queueId)); assert.doesNotMatch(html, /验收通过|已交付|同步为待办/);
  assert.match(render(view('not_synced'), true), /同步结果待核对/);
  assert.doesNotMatch(render(view('not_synced'), true), /同步为待办/);
});

test('explicit synchronization saves identity before the sole POST and clears it only after confirmation', async () => {
  const store = storage(); let count = 0;
  const result = await syncOpenRigProject(projectId, 3, store, client((path, method, body, key) => {
    count++; assert.equal(path, '/projects/' + projectId + '/openrig/sync'); assert.equal(method, 'POST');
    assert.deepEqual(body, { version: 3 }); assert.match(key!, /^[a-f0-9-]{36}$/); assert.equal(hasOpenRigIntent(projectId, store), true);
    return view('synced', { queueState: 'pending' });
  }));
  assert.equal(count, 1); assert.equal(result.queueItemId, queueId); assert.equal(hasOpenRigIntent(projectId, store), false);
});

test('lost responses survive remounts; absent remote items allow GET reconciliation only, never a new POST', async () => {
  const store = storage(); let writes = 0, reads = 0;
  await assert.rejects(syncOpenRigProject(projectId, 3, store, client(() => { writes++; throw Error('lost response'); })), /lost response/);
  await assert.rejects(syncOpenRigProject(projectId, 3, store, client(() => { writes++; return view('synced'); })), /先核对/);
  const absent = await reconcileOpenRigProject(projectId, store, client((path, method) => { reads++; assert.equal(path, '/projects/' + projectId + '/openrig'); assert.equal(method, undefined); return view('not_synced'); }));
  assert.equal(hasOpenRigIntent(projectId, store), true); assert.equal(canSyncOpenRigProject(absent, true), false);
  await reconcileOpenRigProject(projectId, store, client(() => { reads++; return view('synced'); }));
  assert.equal(hasOpenRigIntent(projectId, store), false); assert.equal(writes, 1); assert.equal(reads, 2);
});

test('simultaneous clicks from repeated project cards cannot issue a second POST', async () => {
  const store = storage(); let count = 0, finish!: (value: unknown) => void;
  const send = client(() => { count++; return new Promise(resolve => { finish = resolve; }); });
  const first = syncOpenRigProject(projectId, 3, store, send);
  await assert.rejects(syncOpenRigProject(projectId, 3, store, send), /先核对/);
  finish(view('synced')); await first; assert.equal(count, 1);
});

test('only explicit preflight rejection codes release intent; an in-flight idempotency 409 stays unknown', async () => {
  for (const [status, code, retained] of [[409, 'OPENRIG_PROJECT_VERSION_CHANGED', false], [422, 'OPENRIG_INPUT_INVALID', false], [409, 'IN_PROGRESS', true], [500, 'OPENRIG_INPUT_INVALID', true]] as const) {
    const store = storage();
    await assert.rejects(syncOpenRigProject(projectId, 3, store, client(() => { throw new ApiError('rejected', status, code); })));
    assert.equal(hasOpenRigIntent(projectId, store), retained, code);
  }
});

test('unknown, invalid identities and unexpected acceptance authorities cannot clear an unresolved write', async () => {
  for (const result of [view('unknown'), view('synced', { projectId: 'wrong-project' }), { ...view('synced'), acceptanceAuthority: 'openrig' }, view('synced', { queueItemId: null })]) {
    const store = storage(); await syncOpenRigProject(projectId, 3, store, client(() => result)).catch(() => {});
    assert.equal(hasOpenRigIntent(projectId, store), true);
  }
});

test('only a consistent explicit POST notSubmitted receipt can release a preflight failure', async () => {
  const safe = storage();
  await syncOpenRigProject(projectId, 3, safe, client(() => view('unavailable', { notSubmitted: true })));
  assert.equal(hasOpenRigIntent(projectId, safe), false);
  const ambiguous = storage();
  await syncOpenRigProject(projectId, 3, ambiguous, client(() => view('unavailable')));
  assert.equal(hasOpenRigIntent(projectId, ambiguous), true);
  await reconcileOpenRigProject(projectId, ambiguous, client(() => view('unavailable', { notSubmitted: true })));
  assert.equal(hasOpenRigIntent(projectId, ambiguous), true, 'a later read cannot prove an earlier lost POST was never dispatched');
  const inconsistent = storage();
  await assert.rejects(syncOpenRigProject(projectId, 3, inconsistent, client(() => view('unknown', { notSubmitted: true }))));
  assert.equal(hasOpenRigIntent(projectId, inconsistent), true);
});

test('unavailable browser bookkeeping stops writes before any request', async () => {
  let count = 0;
  const store: IntentStorage = { getItem: () => null, setItem: () => { throw Error('storage unavailable'); }, removeItem: () => {} };
  await assert.rejects(syncOpenRigProject(projectId, 3, store, client(() => { count++; return view('synced'); })), /storage unavailable/);
  assert.equal(count, 0);
});

test('batch reads deduplicate IDs, stay bounded and preserve previously reconciled queue state', async () => {
  let count = 0;
  const data = await readOpenRigProjects('department', [projectId, projectId], client((path, method) => {
    count++; assert.equal(method, 'GET'); assert.equal(path, '/openrig/projects?departmentId=department&projectIds=' + projectId);
    return { enabled: true, status: 'ready', items: [view('synced')] };
  }));
  assert.equal(count, 1); assert.equal(data.items.length, 1);
  await assert.rejects(readOpenRigProjects('department', Array.from({ length: 101 }, (_, i) => String(i)), client(() => { count++; })), /100/);
  assert.equal(count, 1);
  const previous = view('synced', { queueState: 'done', checkedAt: '2026-10-09T00:00:00Z' });
  assert.deepEqual(mergeOpenRigProject(previous, view('synced')), previous);
  assert.equal(mergeOpenRigProject(previous, view('unknown')).queueState, null);
  assert.equal(mergeOpenRigProject(previous, view('synced', { queueItemId: 'different-item' })).queueState, null);
});
