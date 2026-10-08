import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';

// These fixtures verify parser/transport behavior, never real relay acceptance.
const fixtureKey = 'local-fixture-credential-only';
let billing: typeof import('../apps/api/src/new-api-billing.ts');
let provider: typeof import('../apps/api/src/provider.ts');
let pool: pg.Pool, originalQuery: pg.Pool['query'];
let server: http.Server, directory: string, gateway: any;
let fixtureBaseUrl: string, originalFetch: typeof fetch;
let mode = 'ok', version = 1;
const requests: { path: string; method?: string; authorization?: string }[] = [];
const usage = { code: true, message: fixtureKey, data: { total_granted: 100, total_used: 20, total_available: 80, unlimited_quota: false, expires_at: -1 } };
const logs = { success: true, message: fixtureKey, data: [{ id: 999, created_at: 1720000000, type: 2, model_name: 'fixture-model', quota: 12, prompt_tokens: 3, completion_tokens: 4, request_id: 'relay-request-1', upstream_request_id: 'provider-request-1', username: 'private-user', content: fixtureKey, other: { key: fixtureKey } }] };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'new-api-billing-'));
  process.env.DATA_DIR = directory;
  ({ pool } = await import('../apps/api/src/db.ts'));
  provider = await import('../apps/api/src/provider.ts');
  billing = await import('../apps/api/src/new-api-billing.ts');
  const { seal } = await import('../apps/api/src/vault.ts');
  server = http.createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    requests.push({ path, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Oneapi-Request-Id', 'fixture-header-id');
    response.setHeader('X-Upstream-Request-Id', 'fixture-upstream-id');
    response.setHeader('X-Request-Id', 'fixture-response-id');
    response.setHeader('X-Private-Key', fixtureKey);
    if (mode === 'header-echo-key') {
      response.setHeader('X-Oneapi-Request-Id', fixtureKey);
      response.setHeader('X-Upstream-Request-Id', 'relay-' + fixtureKey);
      response.setHeader('X-Request-Id', 'sk-private-key-like-id');
    }
    if (mode === 'bad-id-header') {
      response.setHeader('X-Oneapi-Request-Id', 'contains whitespace');
      response.setHeader('X-Upstream-Request-Id', 'x'.repeat(129));
      response.setHeader('X-Request-Id', 'unsafe/identifier');
    }
    if (mode === 'redirect' && path === '/api/log/token') { response.writeHead(302, { Location: '/must-not-follow' }); response.end(); return; }
    if (mode === 'forbidden' && path === '/api/log/token') { response.writeHead(403); response.end(JSON.stringify({ message: fixtureKey })); return; }
    if (mode.startsWith('logs-http-') && path === '/api/log/token') { response.writeHead(Number(mode.slice('logs-http-'.length))); response.end(JSON.stringify({ message: fixtureKey })); return; }
    if (mode === 'logs-denied' && path === '/api/log/token') { response.end(JSON.stringify({ success: false, message: fixtureKey })); return; }
    if (mode === 'logs-unsupported' && path === '/api/log/token') { response.end(JSON.stringify({ success: true, data: { items: [] }, message: fixtureKey })); return; }
    if (mode === 'logs-drop' && path === '/api/log/token') { request.socket.destroy(); return; }
    if (mode === 'large' && path === '/api/log/token') { response.end(JSON.stringify({ secret: fixtureKey, padding: 'x'.repeat(8 * 1024 * 1024) })); return; }
    if (mode === 'slow') { return; }
    if (mode === 'changed' && path === '/api/log/token') version = 2;
    if (mode === 'malformed' && path === '/api/log/token') { response.end('{not-json:' + fixtureKey); return; }
    if (path === '/api/usage/token/' && mode.startsWith('compat-')) {
      if (mode === 'compat-format') response.end(JSON.stringify({ legacy: true, key: fixtureKey }));
      else if (mode === 'compat-denied') response.end(JSON.stringify({ code: false, message: fixtureKey }));
      else { response.writeHead(mode === 'compat-auth' ? 401 : mode === 'compat-forbidden' ? 403 : mode === 'compat-rate' ? 429 : 404); response.end(JSON.stringify({ message: fixtureKey })); }
    }
    else if (path === '/api/usage/token/') response.end(JSON.stringify(mode === 'bad-usage' ? { code: true, data: { total_used: '20', key: fixtureKey } } : usage));
    else if (path === '/api/log/token') response.end(JSON.stringify(mode.startsWith('compat-') ? { success: true, data: { items: [] } } : mode === 'echo-key' ? { ...logs, data: [{ ...logs.data[0], request_id: fixtureKey }] } : logs));
    else if (path === '/api/status') { if (mode === 'status-failed') response.writeHead(403); response.end(JSON.stringify({ success: true, data: { display_in_currency: true, quota_per_unit: 500000, secret: fixtureKey } })); }
    else if (path.endsWith('/dashboard/billing/usage')) {
      if (mode === 'compat-usage-forbidden') response.writeHead(403);
      response.end(JSON.stringify({ object: 'list', total_usage: mode === 'compat-bad-usage' ? 'unknown' : 695.9646, content: fixtureKey }));
    }
    else if (path.endsWith('/dashboard/billing/subscription')) {
      if (mode === 'compat-changed') version++;
      const limit = mode === 'compat-unlimited' ? 100000000 : 5;
      response.end(JSON.stringify({ object: 'billing_subscription', hard_limit_usd: limit, soft_limit_usd: limit, system_hard_limit_usd: limit, access_until: 0, content: fixtureKey }));
    }
    else if (path === '/v1/chat/completions') response.end(mode === 'bad-completion' ? 'invalid-json' : JSON.stringify({ choices: [{ message: { content: 'fixture response' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    else { response.writeHead(404); response.end(JSON.stringify({ secret: fixtureKey })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
  gateway = { id: 'fixture', version: 1, data: { baseUrl: fixtureBaseUrl + '/v1' }, credential: seal(fixtureKey) };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    // The documented-host branch is exercised entirely against this local fixture.
    // No request from this file, including synthetic Bearer credentials, can leave it.
    if (url.origin === 'https://api.rcouyi.com') return originalFetch(new URL(url.pathname + url.search, fixtureBaseUrl), options);
    if (url.origin !== fixtureBaseUrl) throw new Error('Unexpected fixture network target');
    return originalFetch(input, options);
  };
  originalQuery = pool.query;
  pool.query = (async (_sql: string, parameters: unknown[]) => ({ rows: parameters[0] === 'fixture' ? [{ ...gateway, version }] : [] })) as any;
});

beforeEach(() => { mode = 'ok'; version = 1; requests.length = 0; gateway.data.baseUrl = fixtureBaseUrl + '/v1'; });
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (pool) { pool.query = originalQuery; await pool.end(); }
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('usage retains explicit quota units and values without assuming money, unlimited usage or a balance', () => {
  assert.deepEqual(billing.parseNewApiUsage(usage), { unit: 'quota', totalGranted: 100, totalUsed: 20, totalAvailable: 80, unlimitedQuota: false, expiresAt: -1 });
  assert.equal(billing.parseNewApiUsage({ ...usage, data: { ...usage.data, total_available: -2 } })?.totalAvailable, -2);
  for (const data of [null, {}, { ...usage, code: false }, { ...usage, success: false }, { ...usage, data: { ...usage.data, total_used: '' } }, { ...usage, data: { ...usage.data, total_granted: Infinity } }, { ...usage, data: { ...usage.data, unlimited_quota: 1 } }, { ...usage, data: { ...usage.data, total_available: undefined } }])
    assert.equal(billing.parseNewApiUsage(data), undefined);
});

test('logs preserve missing fields, log types and refunds without leaking display IDs or private content', () => {
  assert.deepEqual(billing.parseNewApiLogs(logs), [{ createdAt: 1720000000, type: 2, modelName: 'fixture-model', quota: 12, promptTokens: 3, completionTokens: 4, requestId: 'relay-request-1', upstreamRequestId: 'provider-request-1' }]);
  assert.deepEqual(billing.parseNewApiLogs({ success: true, data: [{ type: 6, quota: -12, model_name: '', request_id: '', upstream_request_id: null }, { type: 5 }, {}] }), [{ type: 6, quota: -12 }, { type: 5 }, {}]);
  assert.deepEqual(billing.parseNewApiLogs({ success: true, data: [] }), []);
  for (const data of [null, { success: false, data: [] }, { success: true, data: Array(1001).fill({}) }, { success: true, data: [{ prompt_tokens: '' }] }, { success: true, data: [{ request_id: 'sk-key-that-is-not-a-request-id' }] }, { success: true, data: [{ model_name: 'Bearer ' + fixtureKey }] }, { success: true, data: [{ type: 2.5 }] }]) {
    assert.equal(billing.parseNewApiLogs(data), undefined);
  }
});

test('public billing unit requires explicit compatible status metadata and never defaults to 500000', () => {
  assert.deepEqual(billing.parseNewApiBillingUnit({ success: true, data: { display_in_currency: true, quota_per_unit: 250000 } }), { quotaPerUSD: 250000, basis: 'new-api-status' });
  for (const data of [undefined, { success: true, data: {} }, { success: false, data: { display_in_currency: true, quota_per_unit: 500000 } }, { success: true, data: { display_in_currency: false, quota_per_unit: 500000 } }, { success: true, data: { display_in_currency: true, quota_per_unit: 0 } }]) assert.equal(billing.parseNewApiBillingUnit(data), undefined);
});

test('queries saved-key endpoints at the same origin, public status without a key and strips private response fields', async () => {
  const result = await billing.queryNewApiBilling('fixture', 1);
  assert.equal(result.gatewayVersion, 1); assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(result.usage.status, 'available'); assert.equal(result.logs.status, 'available');
  assert.deepEqual(result.billingUnit, { quotaPerUSD: 500000, basis: 'new-api-status' });
  if (result.logs.status === 'available') assert.equal(result.logs.recordCount, 1);
  assert.equal(JSON.stringify(result).includes(fixtureKey), false);
  assert.equal(JSON.stringify(result).includes('private-user'), false);
  assert.deepEqual(requests.map(request => request.path).sort(), ['/api/log/token', '/api/status', '/api/usage/token/']);
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.ok(requests.filter(request => request.path !== '/api/status').every(request => request.authorization === `Bearer ${fixtureKey}`));
  assert.equal(requests.find(request => request.path === '/api/status')?.authorization, undefined);
  mode = 'echo-key';
  const echoed = await billing.queryNewApiBilling('fixture', 1);
  assert.equal(echoed.logs.status, 'available');
  if (echoed.logs.status === 'available') assert.equal(echoed.logs.records[0].requestId, undefined);
  assert.equal(JSON.stringify(echoed).includes(fixtureKey), false);
});

test('logs refusal, malformed JSON and oversized responses preserve available usage without exposing provider bodies', async () => {
  for (const failure of ['forbidden', 'malformed', 'large']) {
    mode = failure;
    const result = await billing.queryNewApiBilling('fixture', 1);
    assert.equal(result.usage.status, 'available'); assert.equal(result.logs.status, 'failed');
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
    if (result.logs.status === 'failed') assert.equal(result.logs.code, failure === 'large' ? 'GATEWAY_RESPONSE_TOO_LARGE' : failure === 'malformed' ? 'GATEWAY_INVALID_RESPONSE' : 'GATEWAY_REJECTED');
  }
  mode = 'bad-usage';
  const partial = await billing.queryNewApiBilling('fixture', 1);
  assert.equal(partial.usage.status, 'failed'); assert.equal(partial.logs.status, 'available');
  mode = 'status-failed';
  const statusFailure = await billing.queryNewApiBilling('fixture', 1);
  assert.equal(statusFailure.usage.status, 'available'); assert.equal(statusFailure.logs.status, 'available'); assert.equal(statusFailure.billingUnit, undefined);
});

test('only structured permission and fixed endpoint failures pause automatic queries; transient failures keep no permanent classification', async () => {
  for (const status of [401, 403, 404, 405, 410, 429, 500, 503]) {
    mode = 'logs-http-' + status; requests.length = 0;
    const result = await billing.queryNewApiBilling('fixture', 1);
    assert.equal(result.usage.status, 'available'); assert.equal(result.logs.status, 'failed'); assert.equal(requests.length, 3);
    if (result.logs.status === 'failed') {
      assert.equal(result.logs.upstreamStatus, status);
      assert.equal(result.logs.failureReason, [401, 403].includes(status) ? 'permission-denied' : [404, 405, 410].includes(status) ? 'endpoint-unsupported' : undefined);
    }
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
  }
  for (const [failure, expected] of [['logs-denied', 'permission-denied'], ['logs-unsupported', 'endpoint-unsupported'], ['malformed', undefined], ['logs-drop', undefined]] as const) {
    mode = failure;
    const result = await billing.queryNewApiBilling('fixture', 1);
    assert.equal(result.logs.status, 'failed');
    if (result.logs.status === 'failed') assert.equal(result.logs.failureReason, expected);
    assert.equal(JSON.stringify(result).includes(fixtureKey), false);
  }
  assert.equal(billing.billingFailureReason('GATEWAY_CONNECTION_FAILED', 403), undefined);
  assert.equal(billing.billingFailureReason('UNTRUSTED_PROVIDER_PROSE', 403), undefined);
});

test('read-only routes reject posts and arbitrary paths before querying, never follow redirects and enforce timeout', async () => {
  await assert.rejects(provider.gatewayRequest('fixture', '/api/log/token', {}, { newApiPath: '/api/log/token' }), error => (error as any).code === 'NEW_API_READ_ONLY');
  await assert.rejects(provider.gatewayRequest('fixture', '/api/admin', undefined, { newApiPath: '/api/admin' as any }), error => (error as any).code === 'NEW_API_READ_ONLY');
  await assert.rejects(provider.gatewayRequest('fixture', '/api/usage/token/', undefined, { publicNewApiStatus: true }), error => (error as any).code === 'NEW_API_READ_ONLY');
  assert.equal(requests.length, 0);
  mode = 'redirect'; const redirect = await billing.queryNewApiBilling('fixture', 1);
  assert.equal(redirect.logs.status, 'failed'); assert.equal(requests.some(request => request.path === '/must-not-follow'), false);
  mode = 'slow';
  await assert.rejects(provider.gatewayRequest('fixture', '/api/log/token', undefined, { newApiPath: '/api/log/token', timeoutMs: 20 }), error => (error as any).code === 'GATEWAY_TIMEOUT');
  mode = 'large';
  await assert.rejects(provider.gatewayRequest('fixture', '/api/log/token', undefined, { newApiPath: '/api/log/token', maxBytes: 0 }), error => (error as any).code === 'GATEWAY_RESPONSE_TOO_LARGE');
});

test('configuration versions are checked before sending and after independent queries finish', async () => {
  await assert.rejects(billing.queryNewApiBilling('fixture', 2), error => (error as any).code === 'VERSION_CONFLICT'); assert.equal(requests.length, 0);
  await assert.rejects(billing.queryNewApiBilling('missing'), error => (error as any).status === 404);
  mode = 'changed'; await assert.rejects(billing.queryNewApiBilling('fixture', 1), error => (error as any).code === 'VERSION_CONFLICT');
});

test('completion persists response headers before parsing and preserves evidence callback failures', async () => {
  const model = { gatewayId: 'fixture', model: 'fixture-model' } as any;
  const seen: string[] = [];
  const callback = async (response: Response) => {
    seen.push(response.headers.get('x-oneapi-request-id')!);
    assert.equal(response.body, null); assert.equal(response.bodyUsed, false);
    assert.equal(response.headers.get('x-private-key'), null);
    assert.equal(response.headers.get('content-type'), null);
  };
  const complete = await provider.complete(model, [{ role: 'user', content: 'fixture' }], 3, undefined, {}, { onResponse: callback });
  assert.equal(complete.usage?.completion_tokens, 2); assert.deepEqual(seen, ['fixture-header-id']);
  mode = 'bad-completion'; await assert.rejects(provider.complete(model, [], 3, undefined, {}, { onResponse: callback }), error => (error as any).code === 'GATEWAY_INVALID_RESPONSE');
  assert.deepEqual(seen, ['fixture-header-id', 'fixture-header-id']);
  const evidenceError = new Error('fixture evidence store unavailable');
  await assert.rejects(provider.complete(model, [], 3, undefined, {}, { onResponse: async () => { throw evidenceError; } }), error => error === evidenceError);
});

test('response evidence rejects exact Key, a prefixed Key, secret-like IDs and unsafe headers', async () => {
  const model = { gatewayId: 'fixture', model: 'fixture-model' } as any;
  for (const failure of ['header-echo-key', 'bad-id-header']) {
    mode = failure;
    let called = false;
    await provider.complete(model, [], 3, undefined, {}, { onResponse: async response => {
      called = true;
      assert.equal(response.status, 200); assert.equal(response.body, null);
      assert.equal(response.headers.get('x-oneapi-request-id'), null);
      assert.equal(response.headers.get('x-upstream-request-id'), null);
      assert.equal(response.headers.get('x-request-id'), null);
      assert.deepEqual([...response.headers], []);
    } });
    assert.equal(called, true);
  }
});

test('compatibility parsers preserve unknown raw units and discard unlimited authorization sentinels', () => {
  assert.deepEqual(billing.parseDashboardBillingUsage({ object: 'list', total_usage: 695.9646, message: fixtureKey }), { unit: 'unknown', totalUsage: 695.9646 });
  assert.deepEqual(billing.parseDashboardBillingSubscription({ object: 'billing_subscription', hard_limit_usd: 5, soft_limit_usd: 5, system_hard_limit_usd: 5, access_until: 0 }), { unit: 'USD', unlimited: false, hardLimitUSD: 5, softLimitUSD: 5, systemHardLimitUSD: 5, accessUntil: 0 });
  assert.deepEqual(billing.parseDashboardBillingSubscription({ object: 'billing_subscription', hard_limit_usd: 100000000, soft_limit_usd: 100000000, system_hard_limit_usd: 100000000 }), { unit: 'USD', unlimited: true });
  for (const data of [null, {}, { object: 'list', total_usage: '' }, { object: 'list', total_usage: -1 }, { object: 'list', total_usage: Infinity }, { object: 'list', total_usage: 1, success: false }]) assert.equal(billing.parseDashboardBillingUsage(data), undefined);
  for (const data of [null, {}, { object: 'billing_subscription', hard_limit_usd: undefined }, { object: 'billing_subscription', hard_limit_usd: -1 }, { object: 'billing_subscription', hard_limit_usd: 1, code: false }]) assert.equal(billing.parseDashboardBillingSubscription(data), undefined);
});

test('documented compatibility routes use the configured prefix and independent saved-key reads after modern 404', async () => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/proxy/v1'; version = 101; mode = 'compat-limited';
  const result = await billing.queryNewApiBilling('fixture', version);
  assert.equal(result.usage.status, 'failed'); assert.equal(result.logs.status, 'failed');
  assert.equal(result.compatibility?.source, 'documented-dashboard-billing');
  assert.equal(result.compatibility?.usage.status, 'available'); assert.equal(result.compatibility?.subscription.status, 'available');
  if (result.compatibility?.usage.status === 'available') assert.deepEqual(result.compatibility.usage.data, { unit: 'unknown', totalUsage: 695.9646 });
  if (result.compatibility?.subscription.status === 'available') assert.equal(result.compatibility.subscription.data.hardLimitUSD, 5);
  assert.equal(JSON.stringify(result).includes(fixtureKey), false);
  assert.deepEqual(requests.filter(request => request.path.includes('/dashboard/')).map(request => request.path).sort(), ['/proxy/v1/dashboard/billing/subscription', '/proxy/v1/dashboard/billing/usage']);
  assert.ok(requests.filter(request => request.path.includes('/dashboard/')).every(request => request.method === 'GET' && request.authorization === `Bearer ${fixtureKey}`));
  assert.ok(!('totalAvailableUSD' in result));
});

test('compatibility failures stay independent and unlimited Key limits never become a displayed balance', async () => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1'; version = 102; mode = 'compat-usage-forbidden';
  const partial = await billing.queryNewApiBilling('fixture', version);
  assert.equal(partial.compatibility?.usage.status, 'failed'); assert.equal(partial.compatibility?.subscription.status, 'available');
  assert.equal(JSON.stringify(partial).includes(fixtureKey), false);
  version = 103; mode = 'compat-unlimited';
  const unlimited = await billing.queryNewApiBilling('fixture', version);
  assert.equal(unlimited.compatibility?.subscription.status, 'available');
  if (unlimited.compatibility?.subscription.status === 'available') assert.deepEqual(unlimited.compatibility.subscription.data, { unit: 'USD', unlimited: true, accessUntil: 0 });
  version = 104; mode = 'compat-bad-usage';
  const invalid = await billing.queryNewApiBilling('fixture', version);
  assert.equal(invalid.compatibility?.usage.status, 'failed'); assert.equal(invalid.compatibility?.subscription.status, 'available');
});

test('unsupported endpoint cache avoids repeated probes, expires and is invalidated by configuration version', async context => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1'; version = 105; mode = 'compat-limited';
  await billing.queryNewApiBilling('fixture', version);
  assert.equal(requests.length, 5);
  requests.length = 0;
  const cached = await billing.queryNewApiBilling('fixture', version);
  assert.deepEqual(requests.map(request => request.path).sort(), ['/api/status', '/v1/dashboard/billing/subscription', '/v1/dashboard/billing/usage']);
  if (cached.usage.status === 'failed') assert.match(cached.usage.message, /近期检测/);
  const now = Date.now(); context.mock.method(Date, 'now', () => now + 5 * 60 * 1000 + 1);
  requests.length = 0; await billing.queryNewApiBilling('fixture', version); assert.equal(requests.length, 5);
  version = 106; requests.length = 0; await billing.queryNewApiBilling('fixture', version); assert.equal(requests.length, 5);
});

test('an explicit user probe bypasses only the unsupported capability cache and preserves safe independent results', async () => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1'; version = 115; mode = 'compat-limited';
  await billing.queryNewApiBilling('fixture', version); assert.equal(requests.length, 5);
  requests.length = 0; await billing.queryNewApiBilling('fixture', version); assert.equal(requests.length, 3);
  requests.length = 0;
  const reprobed = await billing.queryNewApiBilling('fixture', version, { forceProbe: true });
  assert.equal(requests.length, 5); assert.equal(reprobed.logs.status, 'failed');
  if (reprobed.logs.status === 'failed') assert.equal(reprobed.logs.failureReason, 'endpoint-unsupported');
  assert.equal(JSON.stringify(reprobed).includes(fixtureKey), false);
});

test('authentication/rate denials do not trigger alternate routes or cache permissions; other origins are not guessed', async () => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1';
  for (const [index, failure] of ['compat-auth', 'compat-forbidden', 'compat-rate', 'compat-denied'].entries()) {
    version = 107 + index; mode = failure; requests.length = 0;
    const result = await billing.queryNewApiBilling('fixture', version);
    assert.equal(result.compatibility, undefined); assert.equal(requests.some(request => request.path.includes('/dashboard/')), false);
    requests.length = 0; await billing.queryNewApiBilling('fixture', version);
    assert.ok(requests.some(request => request.path === '/api/usage/token/'));
  }
  gateway.data.baseUrl = fixtureBaseUrl + '/v1'; mode = 'compat-limited'; version = 111; requests.length = 0;
  const unverified = await billing.queryNewApiBilling('fixture', version);
  assert.equal(unverified.compatibility, undefined); assert.equal(requests.some(request => request.path.includes('/dashboard/')), false);
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1'; mode = 'ok'; version = 112; requests.length = 0;
  const modern = await billing.queryNewApiBilling('fixture', version);
  assert.equal(modern.usage.status, 'available'); assert.equal(modern.compatibility, undefined); assert.equal(requests.length, 3);
});

test('format-only fallback keeps version protection and rejects arbitrary compatibility URLs or posts', async () => {
  gateway.data.baseUrl = 'https://api.rcouyi.com/v1'; version = 113; mode = 'compat-format';
  assert.equal((await billing.queryNewApiBilling('fixture', version)).compatibility?.usage.status, 'available');
  version = 114; mode = 'compat-changed';
  await assert.rejects(billing.queryNewApiBilling('fixture', version), error => (error as any).code === 'VERSION_CONFLICT');
  requests.length = 0;
  await assert.rejects(provider.gatewayRequest('fixture', '/dashboard/billing/usage', {}, { dashboardBillingPath: '/dashboard/billing/usage' }), error => (error as any).code === 'NEW_API_READ_ONLY');
  await assert.rejects(provider.gatewayRequest('fixture', '/dashboard/billing/usage?key=unsafe', undefined, { dashboardBillingPath: '/dashboard/billing/usage?key=unsafe' as any }), error => (error as any).code === 'NEW_API_READ_ONLY');
  await assert.rejects(provider.gatewayRequest('fixture', '/dashboard/billing/subscription', undefined, { dashboardBillingPath: '/dashboard/billing/subscription', publicNewApiStatus: true }), error => (error as any).code === 'NEW_API_READ_ONLY');
  assert.equal(requests.length, 0);
});
