import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { Model } from '../packages/contracts/index.ts';
import { isOrganizationConversationId, type Draft } from '../apps/web/src/organization-draft.ts';

// Exercise the real reset used by the component with only local, isolated storage.
let server: ViteDevServer, directory: string;
let ui: typeof import('../apps/web/src/OrganizationChat.tsx');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'organization-reset-ui-'));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: directory, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } });
  ui = await server.ssrLoadModule('/apps/web/src/OrganizationChat.tsx') as typeof ui;
});
after(async () => {
  await server?.close();
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-reset-ui-'));
    await rm(directory, { recursive: true, force: true });
  }
});

const activeKey = 'agent-department:organization-chat:v1';
class MemoryStorage {
  values = new Map<string, string>();
  writes: { key: string; value: string }[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); this.writes.push({ key, value }); }
}
function pendingDraft(): Draft {
  const policy = { maxBudget: 5, maxAgents: 4, maxConcurrentAgents: 2, deadlineSeconds: 3600,
    allowedModelIds: ['astra', 'luna', 'sol'], allowedTools: ['filesystem', 'artifact_write', 'terminal_test'] as const };
  const value: Draft = { messages: [], modelId: 'astra', policy: { ...policy, allowedTools: [...policy.allowedTools] }, maxPlanningCost: .75, input: '' };
  value.pendingRequest = { key: 'original-request-with-unknown-result', settings: 'exact-original-settings',
    body: { messages: [{ role: 'user', content: '验收资料 version-1 / 固定 SHA ' + 'a'.repeat(64) }], modelId: value.modelId,
      policy: value.policy, templateId: 'software', maxPlanningCost: value.maxPlanningCost, previousPreviewId: 'original-preview' } };
  return value;
}
const models = [{ id: 'astra', name: 'Astra', model: 'fixture', gatewayId: 'fixture', inputRate: 1, outputRate: 2, status: 'available', version: 1 } as Model];
function markup(storage: MemoryStorage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    return renderToStaticMarkup(createElement(ui.OrganizationChat, { models, onSaved: async () => {}, onDepartments: () => {}, onProject: () => {}, onModels: () => {} }));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}

test('first disconnected request with zero messages exposes an explicit exit and keeps same-request retrieval', () => {
  const storage = new MemoryStorage(), value = pendingDraft();
  storage.values.set(activeKey, JSON.stringify(value));
  const html = markup(storage);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>.*?保留未知费用，开始新需求<\/button>/);
  assert.match(html, /继续获取回复/);
  assert.match(html, /开始新需求不会取消原请求/);
  assert.match(html, /费用记录和已有未知费用预留都会保留，不代表没有扣费/);
  assert.match(html, /<button[^>]*aria-label="发送需求"[^>]*disabled=""/);
  assert.equal(storage.writes.length, 0, 'rendering the escape must not reset, archive, or send a request');
  assert.equal(JSON.parse(storage.getItem(activeKey)!).pendingRequest.key, value.pendingRequest!.key);
});

test('canceling the unknown-request confirmation preserves every byte and the original request key', () => {
  const value = pendingDraft(), before = JSON.stringify(value), storage = new MemoryStorage();
  storage.values.set(activeKey, before);
  let prompted = 0;
  const result = ui.resetOrganizationDraft(value, { storage, confirm: message => {
    prompted++;
    assert.match(message, /不会取消后台请求/);
    assert.match(message, /不代表未收费/);
    assert.match(message, /未知费用预留仍会保留/);
    return false;
  } });
  assert.equal(result, undefined);
  assert.equal(prompted, 1, 'a pending request needs confirmation even without messages or composer text');
  assert.equal(JSON.stringify(value), before);
  assert.equal(storage.getItem(activeKey), before);
  assert.equal(storage.writes.length, 0);
  assert.equal(value.pendingRequest!.key, 'original-request-with-unknown-result');
});

test('confirmed reset archives the full original request first and opens an empty conversation without network calls', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('reset cannot make network calls'); });
  const value = pendingDraft(), before = JSON.stringify(value), storage = new MemoryStorage();
  storage.values.set(activeKey, before);
  storage.values.set('existing-cost-record', 'unknown-hold-kept');
  const result = ui.resetOrganizationDraft(value, { storage, archivedAt: '2026-10-05T12:00:00.000Z', confirm: () => true })!;
  assert.ok(isOrganizationConversationId(result.draft.conversationId));
  assert.deepEqual(result.draft, { messages: [], modelId: value.modelId, policy: value.policy, maxPlanningCost: .75, input: '', conversationId: result.draft.conversationId });
  assert.deepEqual(result.history, [{ archivedAt: '2026-10-05T12:00:00.000Z', result: 'unknown', request: value.pendingRequest }]);
  assert.deepEqual(storage.writes.map(write => write.key), [ui.organizationPendingHistoryStorageKey, activeKey]);
  assert.deepEqual(JSON.parse(storage.getItem(ui.organizationPendingHistoryStorageKey)!)[0].request, value.pendingRequest);
  assert.deepEqual(JSON.parse(storage.getItem(activeKey)!), result.draft);
  assert.equal(JSON.stringify(value), before, 'the old request itself is immutable');
  assert.equal(storage.getItem('existing-cost-record'), 'unknown-hold-kept');
  assert.equal(fetch.mock.calls.length, 0);
  const html = markup(storage);
  assert.match(html, /待核对的旧请求（1）/);
  assert.match(html, /original-request-with-unknown-result/);
  assert.match(html, /exact-original-settings/);
  assert.match(html, /固定 SHA a{64}/);
  assert.doesNotMatch(html, /继续获取回复/);
  assert.doesNotMatch(html, /确认组建部门/);
});

test('a stored team remains a history reference and cannot silently bind the next empty requirement', () => {
  const value = pendingDraft(), storage = new MemoryStorage();
  value.projectId = 'saved-project';
  value.saved = { departmentId: 'saved-department', projectId: 'saved-project', departmentVersion: 3, projectVersion: 2, previewId: 'saved-preview' };
  const result = ui.resetOrganizationDraft(value, { storage, confirm: () => true })!;
  assert.equal(result.draft.projectId, undefined);
  assert.equal(result.draft.saved, undefined);
  assert.equal(result.draft.preview, undefined);
  assert.equal(result.draft.previousPreviewId, undefined);
  assert.equal(result.history![0].projectId, value.projectId);
  assert.deepEqual(result.history![0].saved, value.saved);
  assert.equal(value.saved.projectVersion, 2);
});

test('archive failure cannot clear the active request; a later retry preserves history and does not duplicate its key', () => {
  const value = pendingDraft(), storage = new MemoryStorage(), before = JSON.stringify(value);
  storage.values.set(activeKey, before);
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, text) => { if (key === activeKey) throw Error('isolated write failure'); setItem(key, text); };
  assert.throws(() => ui.resetOrganizationDraft(value, { storage, confirm: () => true }), /isolated write failure/);
  assert.equal(storage.getItem(activeKey), before);
  assert.equal(JSON.stringify(value), before);
  assert.equal(ui.readOrganizationPendingHistory(storage).length, 1, 'old request survives even when clearing the active draft fails');
  storage.setItem = setItem;
  const result = ui.resetOrganizationDraft(value, { storage, confirm: () => true })!;
  assert.equal(result.history!.length, 1);
  assert.equal(result.history![0].request.key, value.pendingRequest!.key);
  assert.equal(JSON.parse(storage.getItem(activeKey)!).pendingRequest, undefined);
});

test('malformed history or inability to store it blocks reset instead of overwriting evidence', () => {
  const value = pendingDraft(), storage = new MemoryStorage(), before = JSON.stringify(value);
  storage.values.set(activeKey, before);
  storage.values.set(ui.organizationPendingHistoryStorageKey, '{not valid JSON');
  assert.throws(() => ui.resetOrganizationDraft(value, { storage, confirm: () => true }));
  assert.equal(storage.getItem(ui.organizationPendingHistoryStorageKey), '{not valid JSON');
  assert.equal(storage.getItem(activeKey), before);
  storage.values.delete(ui.organizationPendingHistoryStorageKey);
  storage.setItem = () => { throw Error('isolated quota exceeded'); };
  assert.throws(() => ui.resetOrganizationDraft(value, { storage, confirm: () => true }), /isolated quota exceeded/);
  assert.equal(storage.getItem(activeKey), before);
  assert.equal(JSON.stringify(value), before);
});

test('an archived key cannot be reused for a different body, and ordinary reset keeps its existing confirmation rules', () => {
  const value = pendingDraft(), storage = new MemoryStorage();
  ui.resetOrganizationDraft(value, { storage, confirm: () => true });
  const priorHistory = storage.getItem(ui.organizationPendingHistoryStorageKey);
  const changed = { ...value, pendingRequest: { ...value.pendingRequest!, settings: 'different settings' } };
  assert.throws(() => ui.resetOrganizationDraft(changed, { storage, confirm: () => true }), /历史内容不同/);
  const changedLegacyCost = { ...value, pendingRequest: { ...value.pendingRequest!, body: { ...value.pendingRequest!.body, maxPlanningCost: .5 } } };
  assert.throws(() => ui.resetOrganizationDraft(changedLegacyCost, { storage, confirm: () => true }), /历史内容不同/,
    'ignoring the retired setting for previews must never permit rewriting an archived idempotency body');
  assert.equal(storage.getItem(ui.organizationPendingHistoryStorageKey), priorHistory);
  const normal = { ...value, pendingRequest: undefined, messages: [{ role: 'user' as const, content: 'existing conversation' }] };
  let prompts = 0;
  assert.equal(ui.resetOrganizationDraft(normal, { confirm: message => { prompts++; assert.match(message, /已经创建的部门和项目会保留/); return false; } }), undefined);
  assert.equal(prompts, 1);
  const empty = { ...normal, messages: [], input: '' };
  assert.ok(ui.resetOrganizationDraft(empty, { confirm: () => { throw Error('an empty ordinary draft does not need confirmation'); } }));
});
