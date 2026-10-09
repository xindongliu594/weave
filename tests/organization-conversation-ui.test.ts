import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { Model, Policy } from '../packages/contracts/index.ts';
import { organizationSettingsFingerprint, type Draft, type Preview } from '../apps/web/src/organization-draft.ts';

// Isolated SSR and browser-storage fixture. No product service, backend or model.
let server: ViteDevServer, directory: string;
let ui: typeof import('../apps/web/src/OrganizationChat.tsx');
let costs: typeof import('../apps/web/src/CostControl.tsx');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'organization-conversation-ui-'));
  server = await createServer({ configFile: false, root: process.cwd(), cacheDir: directory, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } });
  ui = await server.ssrLoadModule('/apps/web/src/OrganizationChat.tsx') as typeof ui;
  costs = await server.ssrLoadModule('/apps/web/src/CostControl.tsx') as typeof costs;
});
after(async () => {
  await server?.close();
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-conversation-ui-'));
    await rm(directory, { recursive: true, force: true });
  }
});
const storageKey = 'agent-department:organization-chat:v1';
class MemoryStorage {
  values = new Map<string, string>(); writes = 0;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); this.writes++; }
}
const policy: Policy = { maxBudget: 5, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 300, allowedModelIds: ['planner'] };
const manager = { id: 'manager', name: '经理', role: 'manager' as const, title: '验收经理', instructions: '核对真实回执', modelId: 'planner', tools: [] };
const preview = (): Preview => ({ previewId: 'legacy-preview', source: 'model', requirement: '原始需求', policy,
  department: { name: '保留的团队', description: '完整旧候选', agents: [manager] },
  plan: { agents: [manager], rationale: '真实独立验收', tasks: [{ id: 'review', subject: '核验交付', objective: '查看真实测试结果', assigneeId: 'manager',
    dependencies: [], acceptanceCriteria: ['保存真实验收结果'], estimatedInputTokens: 100, estimatedOutputTokens: 100 }] }, validation: { valid: true, errors: [] } });
const draft = (): Draft => ({ messages: [{ role: 'user', content: '原始需求' }, { role: 'assistant', content: '旧回复完整保留' }], modelId: 'planner', policy, maxPlanningCost: .1, input: '',
  preview: preview(), previewSettings: JSON.stringify({ modelId: 'planner', policy, maxPlanningCost: .1 }) });
test('first conversation gets a 128000-byte context policy without changing the execution budget', () => {
  const storage = new MemoryStorage(), first = ui.readOrganizationDraft(storage);
  assert.equal(first.policy.contextBytes, 128000);
  assert.equal(first.policy.maxBudget, 1); assert.equal(first.policy.maxModelCalls, 100);
  assert.deepEqual(first.messages, []); assert.equal(first.preview, undefined); assert.equal(first.pendingRequest, undefined);
  assert.equal(storage.writes, 0);
});

test('valid legacy explicit 64000 and absent context policies reload without migration or preview changes', () => {
  for (const legacyPolicy of [{ ...policy, contextBytes: 64000 }, { ...policy }]) {
    const value = draft(); value.policy = legacyPolicy; value.preview!.policy = legacyPolicy;
    const original = JSON.stringify(value), storage = new MemoryStorage(); storage.values.set(storageKey, original);
    const read = ui.readOrganizationDraft(storage);
    assert.deepEqual(read.policy, legacyPolicy); assert.deepEqual(read.preview, value.preview);
    assert.equal(read.policy.contextBytes, legacyPolicy.contextBytes);
    assert.equal(storage.getItem(storageKey), original); assert.equal(storage.writes, 0);
    const reset = ui.resetOrganizationDraft(read, { confirm: () => true });
    assert.deepEqual(reset?.draft.policy, legacyPolicy, 'explicit new dialogue retains the user-selected policy');
  }
});

test('legacy pending policy bytes remain exact when new conversations have a larger default', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('reload must not call a model'); });
  for (const legacyPolicy of [{ ...policy, contextBytes: 64000 }, { ...policy }]) {
    const value = draft(); value.policy = legacyPolicy; value.preview!.policy = legacyPolicy;
    value.pendingRequest = { key: 'legacy-context-key', settings: value.previewSettings!, body: {
      messages: [...value.messages, { role: 'user', content: '保留原请求' }], modelId: value.modelId, policy: legacyPolicy, templateId: 'software', previousPreviewId: value.preview!.previewId } };
    const original = JSON.stringify(value.pendingRequest), storage = new MemoryStorage(); storage.values.set(storageKey, JSON.stringify(value));
    const read = ui.readOrganizationDraft(storage);
    assert.equal(JSON.stringify(read.pendingRequest), original); assert.deepEqual(read.preview, value.preview);
    assert.equal(JSON.stringify(JSON.parse(storage.getItem(storageKey)!).pendingRequest), original);
    assert.equal(storage.writes, 0); assert.equal(fetch.mock.calls.length, 0);
  }
});
const models: Model[] = [{ id: 'planner', name: 'Planner fixture', model: 'fixture', gatewayId: 'local-fixture', inputRate: 1, outputRate: 2, version: 1, status: 'available' }];
function markup(storage: MemoryStorage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try { return renderToStaticMarkup(createElement(ui.OrganizationChat, { models, onSaved: async () => {}, onDepartments: () => {}, onProject: () => {}, onModels: () => {} })); }
  finally { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
}

test('fresh storage needs no fee limit and home exposes only execution budget and staffing inputs', () => {
  const storage = new MemoryStorage(), fresh = ui.readOrganizationDraft(storage);
  assert.equal(Object.hasOwn(fresh, 'maxPlanningCost'), false);
  const html = markup(storage);
  assert.match(html, /需求对话由中转站计费，本机不做预算预留或费用上限拦截/);
  assert.match(html, /项目预算（确认后执行，USD）/);
  assert.match(html, /项目预算用于确认保存后的执行/);
  assert.doesNotMatch(html, /每轮上限|单次回复费用上限/);
  assert.equal((html.match(/type="number"/g) ?? []).length, 2);
  assert.equal(storage.writes, 0, 'rendering and reading cannot send or auto-save a request');
});

test('valid old conversations and previews survive absent, retired or invalid fee metadata without a false settings change', () => {
  for (const fee of [undefined, 0, .1, 100, null]) {
    const storage = new MemoryStorage(), value = { ...draft(), maxPlanningCost: fee };
    storage.values.set(storageKey, JSON.stringify(value));
    const read = ui.readOrganizationDraft(storage);
    assert.deepEqual(read.messages, value.messages); assert.deepEqual(read.preview, value.preview);
    assert.equal(read.previewSettings, organizationSettingsFingerprint(read));
    const html = markup(storage), confirm = html.match(/<button[^>]*class="primary organization-confirm"[^>]*>/)?.[0];
    assert.ok(confirm); assert.doesNotMatch(confirm, /disabled/);
    assert.doesNotMatch(html, /需求或设置有调整/); assert.match(html, /这份旧方案按原收费规则保存/);
    assert.equal(storage.writes, 0);
  }
});

test('unknown old preview settings keep the dialogue and candidate but remain explicitly unconfirmed', () => {
  const storage = new MemoryStorage(), value = { ...draft(), previewSettings: 'unparseable-legacy-settings' };
  storage.values.set(storageKey, JSON.stringify(value));
  const read = ui.readOrganizationDraft(storage);
  assert.deepEqual(read.messages, value.messages); assert.deepEqual(read.preview, value.preview);
  assert.equal(read.previewSettings, value.previewSettings);
  const html = markup(storage); assert.match(html, /需求或设置有调整/);
  assert.match(html, /<button[^>]*class="primary organization-confirm"[^>]*disabled/);
});

test('legacy pending key/body/settings remain byte-identical across reload; retrieval and explicit reset are available with no automatic call', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('reload and render cannot request a model'); });
  const value = draft(); value.pendingRequest = { key: 'legacy-exact-key', settings: value.previewSettings!, body: {
    messages: [...value.messages, { role: 'user', content: '待返回的补充' }], modelId: value.modelId, policy, templateId: 'software', maxPlanningCost: .75, previousPreviewId: 'legacy-preview' } };
  const original = JSON.stringify(value.pendingRequest), storage = new MemoryStorage(); storage.values.set(storageKey, JSON.stringify(value));
  const read = ui.readOrganizationDraft(storage); assert.equal(JSON.stringify(read.pendingRequest), original);
  assert.deepEqual(read.preview, value.preview); assert.deepEqual(read.messages, value.messages);
  const html = markup(storage); assert.match(html, /继续获取回复/); assert.match(html, /保留未知费用，开始新需求/);
  assert.match(html, /<button[^>]*aria-label="发送需求"[^>]*disabled/);
  assert.equal(storage.writes, 0); assert.equal(fetch.mock.calls.length, 0);
  assert.equal(JSON.stringify(JSON.parse(storage.getItem(storageKey)!).pendingRequest), original);
});

test('new conversation preview keeps its server accounting marker and clearly excludes chat cost from the saved execution budget', () => {
  const value = draft(); value.preview = { ...preview(), costAccounting: 'conversation' };
  const storage = new MemoryStorage(); storage.values.set(storageKey, JSON.stringify(value));
  assert.equal(ui.readOrganizationDraft(storage).preview?.costAccounting, 'conversation');
  const html = markup(storage); assert.match(html, /需求对话费用单独记录，确认保存不会计入项目执行预算/);
  assert.doesNotMatch(html, /这份旧方案按原收费规则保存/);
});

test('real model, budget and permission changes still require another proposal after the fee field is retired', () => {
  for (const patch of [{ ...policy, maxBudget: 6 }, { ...policy, allowedModelIds: ['planner', 'worker'] }, { ...policy, allowedTools: ['filesystem' as const] }]) {
    const storage = new MemoryStorage(); storage.values.set(storageKey, JSON.stringify({ ...draft(), policy: patch }));
    const html = markup(storage); assert.match(html, /需求或设置有调整/);
    assert.match(html, /<button[^>]*class="primary organization-confirm"[^>]*disabled/);
  }
});

test('conversation pending and unknown receipt labels never represent an unreserved amount as a zero bill', () => {
  for (const status of ['pending', 'uncertain']) {
    const html = renderToStaticMarkup(createElement(costs.CostCallSummary, { call: { modelName: 'Fixture', purpose: 'planning', status, amount: 0, accountingMode: 'conversation' } }));
    assert.match(html, /需求对话/); assert.match(html, /不设预算预留，实际费用待核对/);
    assert.doesNotMatch(html, /\$0|零费用|已结算|未收费/);
    assert.match(html, status === 'pending' ? /请求进行中/ : /费用待核对/);
  }
});

test('budgeted and legacy held receipts retain their exact original reserve labels; zero alone cannot classify a conversation', () => {
  for (const mode of [undefined, 'budgeted' as const]) {
    const html = renderToStaticMarkup(createElement(costs.CostCallSummary, { call: { modelName: 'Fixture', purpose: 'planning', status: 'uncertain', amount: .37821, accountingMode: mode } }));
    assert.match(html, /预留 \$0\.378210/); assert.match(html, /项目规划/); assert.doesNotMatch(html, /不设预算预留/);
  }
  const zero = renderToStaticMarkup(createElement(costs.CostCallSummary, { call: { modelName: 'Fixture', purpose: 'planning', status: 'uncertain', amount: 0 } }));
  assert.doesNotMatch(zero, /需求对话|不设预算预留/);
});

test('cost totals distinguish actual conversation charges from the amount charged to the execution daily budget', () => {
  const html = renderToStaticMarkup(createElement(costs.CostTotals, { data: { spent: .3, reserved: .2, conversationSpent: 1.2, recordedSpent: 1.5, timezone: 'UTC' } }));
  assert.match(html, /今日预算计入的已确认费用 \$0\.300000/);
  assert.match(html, /未结算预留 \$0\.200000/);
  assert.match(html, /需求对话已记录费用 \$1\.200000（不计入执行预算）/);
  assert.match(html, /今日全部已记录费用 \$1\.500000/);
  const legacy = renderToStaticMarkup(createElement(costs.CostTotals, { data: { spent: .3, reserved: .2, timezone: 'UTC' } }));
  assert.doesNotMatch(legacy, /需求对话已记录费用/, 'a missing breakdown is unknown, never fabricated as zero');
});
