import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import { createServer, type ViteDevServer } from 'vite';
import { createOrganizationChatRequest, ensureOrganizationConversation, finishOrganizationReply,
  isOrganizationConversationId, type Draft } from '../apps/web/src/organization-draft.ts';

// Engineering regression only: fresh PGlite/HTTP fixture, no real gateway or product data.
assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Run this fixture with scripts/test-integration.mjs');
assert.ok(process.env.DATABASE_URL, 'The isolated PGlite runner must provide its temporary database');
const base = process.env.DATABASE_URL;
const schema = 'organization_session_' + Date.now(), admin = new pg.Pool({ connectionString: base });
let pool: pg.Pool, directory: string, vite: ViteDevServer;
let ui: typeof import('../apps/web/src/OrganizationChat.tsx');
let server: http.Server, gateway: http.Server, url: string, modelId: string, gatewayId: string, localGatewayUrl: string;
const wires: { body: any; headers: http.IncomingHttpHeaders }[] = [];
const storageKey = 'agent-department:organization-chat:v1';
const policy = { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 300 };
const empty = (): Draft => ({ messages: [], modelId, policy, maxPlanningCost: .1, input: '' });
class MemoryStorage {
  values = new Map<string, string>();
  writes: { key: string; value: string }[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); this.writes.push({ key, value }); }
}
async function call(body: unknown, key: string = randomUUID()) {
  const response = await fetch(url + '/organizations/chat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function receiptCounts() {
  return (await pool.query('SELECT (SELECT count(*)::int FROM model_reservations) AS receipts,(SELECT count(*)::int FROM usage) AS usages,(SELECT count(*)::int FROM organization_previews) AS previews,(SELECT count(*)::int FROM projects) AS projects')).rows[0];
}
before(async () => {
  await admin.query('CREATE SCHEMA ' + schema);
  const connection = new URL(base); connection.searchParams.set('options', '-c search_path=' + schema);
  process.env.DATABASE_URL = connection.toString();
  directory = await mkdtemp(join(tmpdir(), 'organization-session-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: join(directory, 'vite'), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } });
  ui = await vite.ssrLoadModule('/apps/web/src/OrganizationChat.tsx') as typeof ui;
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined, 'the fixture has no credential');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(body.model, 'fixture-session');
    wires.push({ body, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '请继续补充使用场景。' }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 15 } }));
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  gatewayId = randomUUID(); modelId = randomUUID();
  localGatewayUrl = 'http://127.0.0.1:' + (gateway.address() as AddressInfo).port + '/v1';
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', [gatewayId,
    { name: 'Isolated session fixture', baseUrl: localGatewayUrl, pricingSource: 'models' }]);
  await pool.query("INSERT INTO models(id,data,status) VALUES($1,$2,'available')", [modelId,
    { name: 'Session fixture', gatewayId, model: 'fixture-session', inputRate: .1, outputRate: .2 }]);
  const { organizationChatRouter } = await import('../apps/api/src/organization-chat.ts');
  const { idempotency } = await import('../apps/api/src/idempotency.ts');
  const { AppError } = await import('../apps/api/src/provider.ts');
  const app = express(); app.use(express.json()); app.use('/api', idempotency, organizationChatRouter());
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error instanceof AppError ? error.status : error?.name === 'ZodError' ? 422 : 500)
      .json({ code: error instanceof AppError ? error.code : 'INVALID_INPUT', message: 'Local fixture rejected the request' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api';
});
after(async () => {
  for (const current of [server, gateway]) if (current) {
    current.closeAllConnections(); await new Promise<void>(done => current.close(() => done()));
  }
  await vite?.close(); await pool?.end();
  await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end();
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'organization-session-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent new conversations with identical first prompts have distinct UUIDs and request keys', () => {
  const first = ensureOrganizationConversation(empty()), second = ensureOrganizationConversation(empty());
  assert.ok(isOrganizationConversationId(first.conversationId)); assert.ok(isOrganizationConversationId(second.conversationId));
  assert.notEqual(first.conversationId, second.conversationId);
  const one = createOrganizationChatRequest(first, '开发相同的 Todo API', 'same-settings');
  const two = createOrganizationChatRequest(second, '开发相同的 Todo API', 'same-settings');
  assert.notEqual(one.body.conversationId, two.body.conversationId); assert.notEqual(one.key, two.key);
  assert.equal(first.messages.length, 0, 'request preparation must not mutate the existing draft');
});

test('stored UUID survives reload, consultation, model settings changes and further turns', () => {
  const storage = new MemoryStorage(); const first = ui.readOrganizationDraft(storage);
  assert.ok(isOrganizationConversationId(first.conversationId));
  storage.setItem(storageKey, JSON.stringify({ ...first, modelId }));
  const reloaded = ui.readOrganizationDraft(storage); assert.equal(reloaded.conversationId, first.conversationId);
  const request = createOrganizationChatRequest(reloaded, '请先讨论需求', 'settings-v1');
  const reply = finishOrganizationReply(reloaded, request, { reply: '谁来使用？' });
  storage.setItem(storageKey, JSON.stringify(reply));
  const again = ui.readOrganizationDraft(storage);
  const next = createOrganizationChatRequest({ ...again, modelId: 'different-planner' }, '内部团队使用', 'settings-v2');
  assert.equal(next.body.conversationId, first.conversationId); assert.notEqual(next.key, request.key);
  assert.equal(next.body.messages.length, 3);
});

test('legacy stored draft gains metadata once while a persisted pending body and idempotency key remain byte-identical', () => {
  const storage = new MemoryStorage();
  const legacy = { ...empty(), pendingRequest: {
    key: 'legacy-request-unchanged', settings: 'original-settings', body: {
      messages: [{ role: 'user', content: '固定合同与证据必须保留。' }], modelId, policy, templateId: 'software', maxPlanningCost: .1,
    },
  } };
  const bodyBefore = JSON.stringify(legacy.pendingRequest.body), requestBefore = JSON.stringify(legacy.pendingRequest);
  storage.setItem(storageKey, JSON.stringify(legacy));
  const migrated = ui.readOrganizationDraft(storage);
  assert.ok(isOrganizationConversationId(migrated.conversationId));
  assert.equal(JSON.stringify(migrated.pendingRequest), requestBefore);
  assert.equal(JSON.stringify(migrated.pendingRequest!.body), bodyBefore);
  assert.equal('conversationId' in migrated.pendingRequest!.body, false);
  storage.setItem(storageKey, JSON.stringify(migrated));
  const reloaded = ui.readOrganizationDraft(storage);
  assert.equal(reloaded.conversationId, migrated.conversationId);
  assert.equal(JSON.stringify(reloaded.pendingRequest), requestBefore);
  const replied = finishOrganizationReply(reloaded, reloaded.pendingRequest!, { reply: '继续讨论。' });
  const newTurn = createOrganizationChatRequest(replied, '追加使用说明', 'new-turn-settings');
  assert.equal(newTurn.body.conversationId, migrated.conversationId, 'only a newly submitted turn may add the migrated UUID');
});

test('new pending request UUID is authoritative on reload without altering any stored request fields', () => {
  const current = ensureOrganizationConversation(empty()); const request = createOrganizationChatRequest(current, '新需求', 'settings');
  const before = JSON.stringify(request), storage = new MemoryStorage();
  storage.setItem(storageKey, JSON.stringify({ ...current, conversationId: randomUUID(), pendingRequest: request }));
  const reloaded = ui.readOrganizationDraft(storage);
  assert.equal(reloaded.conversationId, request.body.conversationId);
  assert.equal(JSON.stringify(reloaded.pendingRequest), before);
});

test('cancelled reset is immutable; confirmed reset archives original UUID/body before renewing the conversation', t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw Error('reset must not dispatch'); });
  const old = ensureOrganizationConversation(empty()), request = createOrganizationChatRequest(old, '相同首条需求', 'settings');
  const value = { ...old, pendingRequest: request }, before = JSON.stringify(value), storage = new MemoryStorage();
  storage.setItem(storageKey, before); storage.values.set('unknown-receipt', 'unchanged');
  assert.equal(ui.resetOrganizationDraft(value, { storage, confirm: () => false }), undefined);
  assert.equal(storage.getItem(storageKey), before); assert.equal(JSON.stringify(value), before);
  const reset = ui.resetOrganizationDraft(value, { storage, confirm: () => true })!;
  assert.notEqual(reset.draft.conversationId, old.conversationId); assert.ok(isOrganizationConversationId(reset.draft.conversationId));
  assert.equal(reset.history![0].conversationId, old.conversationId);
  assert.equal(JSON.stringify(reset.history![0].request), JSON.stringify(request));
  assert.deepEqual(storage.writes.slice(-2).map(write => write.key), [ui.organizationPendingHistoryStorageKey, storageKey]);
  assert.equal(storage.getItem('unknown-receipt'), 'unchanged'); assert.equal(network.mock.calls.length, 0);
  assert.equal(ui.readOrganizationDraft(storage).conversationId, reset.draft.conversationId);
  const another = createOrganizationChatRequest(reset.draft, '相同首条需求', 'settings');
  assert.notEqual(another.body.conversationId, request.body.conversationId);
});

test('failed history persistence cannot replace the active conversation or mutate its pending request', () => {
  const old = ensureOrganizationConversation(empty()), request = createOrganizationChatRequest(old, '保持未知结果', 'settings');
  const value = { ...old, pendingRequest: request }, storage = new MemoryStorage(), before = JSON.stringify(value);
  storage.setItem(storageKey, before);
  storage.setItem = () => { throw Error('isolated storage failure'); };
  assert.throws(() => ui.resetOrganizationDraft(value, { storage, confirm: () => true }), /isolated storage failure/);
  assert.equal(storage.getItem(storageKey), before); assert.equal(JSON.stringify(value), before);
});

test('actual API uses UUID attribution on multiple turns; duplicate same-key retrieval neither re-dispatches nor adds cost', async () => {
  const draft = ensureOrganizationConversation(empty()), request = createOrganizationChatRequest(draft, '开发内部团队使用的 Todo API', 'settings');
  const beforeCalls = wires.length, first = await call(request.body, request.key);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const afterFirst = await receiptCounts();
  assert.deepEqual(await call(request.body, request.key), first); assert.equal(wires.length, beforeCalls + 1);
  assert.equal(wires.at(-1)!.headers['x-opencode-session'], undefined, 'Go identity is confined to the Go endpoint');
  assert.deepEqual(await receiptCounts(), afterFirst);
  const next = createOrganizationChatRequest(finishOrganizationReply(draft, request, first.data), '还要给用户操作说明', 'settings');
  assert.equal((await call(next.body, next.key)).status, 200);
  const rows = (await pool.query("SELECT r.context,r.status,u.session_id FROM model_reservations r JOIN usage u ON u.id=r.id WHERE r.context->>'sessionId'=$1", ['organization:' + draft.conversationId])).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'settled' && row.session_id === 'organization:' + draft.conversationId));
  assert.equal(wires.length, beforeCalls + 2); assert.equal((await receiptCounts()).projects, afterFirst.projects);
  assert.equal((await receiptCounts()).previews, afterFirst.previews, 'a conversation UUID cannot save a team or dispatch tasks');
  assert.equal((await call({ ...request.body, conversationId: randomUUID() }, request.key)).status, 409, 'same key still binds the exact original body');
  assert.equal(wires.length, beforeCalls + 2);
});

test('two actual conversations with the same prompt remain separately attributed; UUID does not enter model messages', async () => {
  const bodyIds: string[] = [];
  for (const draft of [ensureOrganizationConversation(empty()), ensureOrganizationConversation(empty())]) {
    const request = createOrganizationChatRequest(draft, '一样的 Todo API 首条需求', 'settings');
    const result = await call(request.body, request.key); assert.equal(result.status, 200);
    bodyIds.push(request.body.conversationId!);
    assert.equal(JSON.stringify(wires.at(-1)!.body.messages).includes(request.body.conversationId!), false);
  }
  assert.notEqual(bodyIds[0], bodyIds[1]);
  for (const id of bodyIds) {
    const rows = (await pool.query('SELECT session_id FROM usage WHERE session_id=$1', ['organization:' + id])).rows;
    assert.equal(rows.length, 1);
  }
});

test('legacy pending same-key request keeps its exact input; invalid UUIDs are rejected before reserve and fetch', async () => {
  const body = { messages: [{ role: 'user', content: '旧版请求需要继续使用原始幂等正文。' }], modelId, policy, templateId: 'software', maxPlanningCost: .1 };
  const key = randomUUID(), beforeWire = wires.length;
  const first = await call(body, key); assert.equal(first.status, 200);
  const counts = await receiptCounts();
  const storage = new MemoryStorage(); storage.setItem(storageKey, JSON.stringify({ ...empty(), pendingRequest: { key, settings: 'legacy', body } }));
  const restored = ui.readOrganizationDraft(storage);
  assert.deepEqual(await call(restored.pendingRequest!.body, key), first);
  assert.deepEqual(await receiptCounts(), counts); assert.equal(wires.length, beforeWire + 1);
  const cached = (await pool.query('SELECT response,status FROM request_keys WHERE key=$1', [key])).rows[0];
  assert.equal(cached.status, 200);
  const legacyId = 'organization:' + createHash('sha256').update(modelId + '\n' + body.messages[0].content).digest('hex');
  const legacyRows = (await pool.query('SELECT session_id FROM usage WHERE session_id=$1', [legacyId])).rows;
  assert.equal(legacyRows.length, 1, 'an unchanged old-client request retains its safe deterministic fallback');
  for (const conversationId of ['not-a-uuid', 'uuid\nx-extra: value', 123, null]) {
    assert.equal((await call({ ...body, conversationId })).status, 422);
  }
  assert.deepEqual(await receiptCounts(), counts); assert.equal(wires.length, beforeWire + 1);
});

test('Go transport hashes each conversation UUID stably across retrieval, reload and further turns without external traffic', async t => {
  const fetchLocal = globalThis.fetch, goUrl = 'https://opencode.ai/zen/go/v1';
  // Generate headers for the exact Go URL, then route its fetch to the credential-free local HTTP fixture.
  // Any other target is refused before fetch, so this test cannot reach a real gateway.
  t.mock.method(globalThis, 'fetch', async (target: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const targetUrl = String(target);
    if (targetUrl === goUrl + '/chat/completions') return fetchLocal(localGatewayUrl + '/chat/completions', options);
    if (targetUrl === url + '/organizations/chat') return fetchLocal(target, options);
    throw Error('Only the isolated API and gateway fixtures may receive test traffic');
  });
  await pool.query("UPDATE gateways SET data=jsonb_set(data,'{baseUrl}',to_jsonb($1::text)) WHERE id=$2", [goUrl, gatewayId]);
  try {
    const storage = new MemoryStorage(), draft = ensureOrganizationConversation(empty());
    const request = createOrganizationChatRequest(draft, '同一句首条需求用于 Go 隔离验证', 'settings');
    const expectedHeader = (id: string) => 'agent-department-' + createHash('sha256').update('organization:' + id).digest('hex');
    const beforeCalls = wires.length, first = await call(request.body, request.key);
    assert.equal(first.status, 200);
    const headers = wires.at(-1)!.headers;
    assert.equal(headers['x-opencode-session'], expectedHeader(draft.conversationId!));
    assert.equal(headers['user-agent'], 'AgentDepartment/0.2.0');
    assert.equal(String(headers['x-opencode-session']).includes(draft.conversationId!), false);
    storage.setItem(storageKey, JSON.stringify({ ...draft, pendingRequest: request }));
    const pending = ui.readOrganizationDraft(storage), counts = await receiptCounts();
    assert.equal(pending.conversationId, draft.conversationId);
    assert.deepEqual(await call(pending.pendingRequest!.body, pending.pendingRequest!.key), first);
    assert.deepEqual(await receiptCounts(), counts); assert.equal(wires.length, beforeCalls + 1);
    storage.setItem(storageKey, JSON.stringify(finishOrganizationReply(pending, request, first.data)));
    const next = createOrganizationChatRequest(ui.readOrganizationDraft(storage), '补充第二轮需求', 'settings');
    assert.equal((await call(next.body, next.key)).status, 200);
    assert.equal(wires.at(-1)!.headers['x-opencode-session'], headers['x-opencode-session']);
    const reset = ui.resetOrganizationDraft(ui.readOrganizationDraft(storage), { confirm: () => true })!;
    const independent = createOrganizationChatRequest(reset.draft, request.body.messages[0].content, 'settings');
    assert.equal((await call(independent.body, independent.key)).status, 200);
    assert.equal(wires.at(-1)!.headers['x-opencode-session'], expectedHeader(reset.draft.conversationId!));
    assert.notEqual(wires.at(-1)!.headers['x-opencode-session'], headers['x-opencode-session']);
    assert.equal(wires.length, beforeCalls + 3);
  } finally {
    await pool.query("UPDATE gateways SET data=jsonb_set(data,'{baseUrl}',to_jsonb($1::text)) WHERE id=$2", [localGatewayUrl, gatewayId]);
  }
});
