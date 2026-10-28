import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import type { Model } from '../packages/contracts/index.ts';

// Local engineering fixtures only: these tests do not exercise employees or
// accept a real model. The runner supplies a new in-memory PGlite database.
assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Use scripts/test-integration.mjs; no production DB fallback is allowed');
assert.ok(process.env.DATABASE_URL, 'The fresh PGlite runner must supply DATABASE_URL');
assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');

const fixtureKey = 'synthetic-responses-api-fixture-key';
const originalFetch = globalThis.fetch;
const inputRate = 2, outputRate = 4, inputTokens = 100, outputTokens = 20;
const fee = (inputTokens * inputRate + outputTokens * outputRate) / 1e6;
type Entry = { path: string; headers: http.IncomingHttpHeaders; body: any; wireBytes: number };
const entries: Entry[] = [], faults: unknown[] = [], rejectedTargets: string[] = [];
const mappedTargets: { target: string; local: string }[] = [];
let pool: pg.Pool, app: any, api: http.Server, fixture: http.Server;
let apiOrigin = '', fixtureOrigin = '', directory = '';
let mode: 'ok' | 'malformed-tool' | 'no-usage' | 'http-502' = 'ok';

const usage = () => ({ input_tokens: inputTokens, output_tokens: outputTokens,
  input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + outputTokens });
const textItem = (text: string) => ({ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] });
const reservation = (entry: Entry) => ((entry.wireBytes + 1024) * inputRate + entry.body.max_output_tokens * outputRate) / 1e6;

async function call(path: string, method = 'GET', body?: unknown) {
  const result = await fetch(apiOrigin + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, data: await result.json() as any };
}
async function createGateway(baseUrl = fixtureOrigin + '/v1') {
  const result = await call('/gateways', 'POST', { name: 'Local protocol engineering fixture', baseUrl, apiKey: fixtureKey });
  assert.equal(result.status, 201); assert.ok(!JSON.stringify(result.data).includes(fixtureKey));
  return result.data.id as string;
}
async function createModel(gatewayId: string, fields: Record<string, unknown> = {}) {
  const result = await call('/models', 'POST', { gatewayId, name: 'Local protocol fixture', model: 'fixture-' + randomUUID(), inputRate, outputRate, contextWindowTokens: 5000, ...fields });
  assert.equal(result.status, 201); return model(result.data.id);
}
async function model(id: string): Promise<Model> { return (await call('/models')).data.find((value: Model) => value.id === id); }
async function clearLedger() { await pool.query('TRUNCATE model_capability_tests, model_reservations, usage CASCADE'); }
async function ledgerCounts() {
  const row = (await pool.query('SELECT (SELECT count(*)::int FROM model_reservations) AS receipts, (SELECT count(*)::int FROM usage) AS usage')).rows[0];
  return { receipts: row.receipts, usage: row.usage };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'completion-protocol-api-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  // Map only the exact Go completion endpoint to the local fixture. No request
  // can fall through to a real gateway, a different host, or a different port.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === apiOrigin || url.origin === fixtureOrigin) return originalFetch(input, init);
    if (url.protocol === 'https:' && url.hostname === 'opencode.ai' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && ['/zen/go/v1/responses', '/zen/go/v1/chat/completions'].includes(url.pathname)) {
      const local = fixtureOrigin + url.pathname; mappedTargets.push({ target: url.href, local });
      assert.equal(typeof input, 'string', 'The provider must supply its explicit URL');
      return originalFetch(local, init);
    }
    rejectedTargets.push(url.origin); throw Error('External target denied by the local protocol fixture');
  };
  const db = await import('../apps/api/src/db.ts'); pool = db.pool;
  assert.equal((await pool.query("SELECT to_regclass('public.gateways') AS existing")).rows[0].existing, null, 'The PGlite database must be fresh');
  await db.migrate();
  app = (await import('../apps/api/src/app.ts')).createApp();
  // Disable background work so the file tests only API completion/probe paths.
  await app.locals.shutdownBackground();
  await app.locals.ready;
  api = app.listen(0, '127.0.0.1'); await once(api, 'listening'); apiOrigin = 'http://127.0.0.1:' + (api.address() as AddressInfo).port;
  fixture = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = Buffer.concat(chunks), body = JSON.parse(wire.toString('utf8'));
      const entry = { path: request.url!, headers: request.headers, body, wireBytes: wire.byteLength }; entries.push(entry);
      assert.equal(request.headers.authorization, 'Bearer ' + fixtureKey);
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('X-Oneapi-Request-Id', fixtureKey); // Must be filtered before storage or API output.
      response.setHeader('X-Upstream-Request-Id', 'local-up-' + entries.length); response.setHeader('X-Request-Id', 'local-wire-' + entries.length);
      if (mode === 'http-502') { response.writeHead(502); response.end(JSON.stringify({ error: { message: fixtureKey, extra: 'untrusted synthetic body' } })); return; }
      if (!entry.path.endsWith('/responses')) {
        assert.ok(entry.path.endsWith('/chat/completions')); assert.ok(Array.isArray(body.messages)); assert.equal(body.input, undefined);
        response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })); return;
      }
      assert.equal(body.store, false); assert.equal(body.stream, false); assert.deepEqual(body.reasoning, { effort: 'none' });
      assert.equal(body.previous_response_id, undefined); assert.equal(body.conversation, undefined);
      let output: any[] = [textItem('OK')];
      if (body.tools?.length) {
        const tool = body.tools[0]; assert.equal(tool.name, 'capability_probe'); assert.equal(tool.strict, false);
        const nonce = tool.parameters.properties.nonce.enum[0];
        output = [textItem('Calling the harmless local probe.'), { type: 'function_call', id: 'fc-item-' + entries.length,
          call_id: 'call-operation-' + entries.length, status: 'completed', name: 'capability_probe',
          arguments: mode === 'malformed-tool' ? '{"nonce":"' + fixtureKey + '"' : JSON.stringify({ nonce }) }];
      } else {
        const result = body.input.find((item: any) => item.type === 'function_call_output');
        if (result) output = [textItem(JSON.parse(result.output).result)];
      }
      response.end(JSON.stringify({ id: 'resp-local-' + entries.length, status: 'completed', output, ...(mode === 'no-usage' ? {} : { usage: usage() }) }));
    } catch (error) { faults.push(error); response.writeHead(500); response.end('{}'); }
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening'); fixtureOrigin = 'http://127.0.0.1:' + (fixture.address() as AddressInfo).port;
});

beforeEach(async () => {
  assert.deepEqual(faults, []); assert.deepEqual(rejectedTargets, []);
  await pool.query('TRUNCATE model_capability_tests, model_reservations, usage, models, gateways CASCADE');
  await pool.query("UPDATE product_settings SET data=jsonb_set(data,'{dailyBudgetLimit}','100'::jsonb) WHERE id=1");
  entries.length = 0; mappedTargets.length = 0; mode = 'ok';
});
after(async () => {
  globalThis.fetch = originalFetch;
  await app?.locals.shutdown();
  for (const server of [api, fixture]) if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  await pool?.end();
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('completion-protocol-api-'));
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(faults, []); assert.deepEqual(rejectedTargets, []);
});

test('API stores explicit protocol, keeps omitted legacy Chat fields, and rejects invalid protocol without creating a model', async () => {
  const gatewayId = await createGateway();
  const responses = await createModel(gatewayId, { protocol: 'responses', model: 'stored-responses-fixture' });
  assert.equal(responses.protocol, 'responses'); assert.equal((await pool.query('SELECT data FROM models WHERE id=$1', [responses.id])).rows[0].data.protocol, 'responses');
  const legacy = await createModel(gatewayId, { model: 'gpt-6-luna' });
  assert.equal(Object.hasOwn(legacy, 'protocol'), false);
  for (const protocol of ['auto', 'responses-v2', null]) {
    const rejected = await call('/models', 'POST', { gatewayId, name: 'Rejected fixture', model: 'invalid-' + randomUUID(), inputRate, outputRate, protocol });
    assert.equal(rejected.status, 422); assert.equal(rejected.data.code, 'VALIDATION_ERROR');
  }
  assert.equal((await call('/models')).data.length, 2); assert.equal(entries.length, 0);
  assert.equal((await call('/models/' + legacy.id + '/test', 'POST', {})).status, 200);
  assert.equal(entries.length, 1); assert.equal(entries[0].path, '/v1/chat/completions'); assert.equal(entries[0].body.max_tokens, 16);
  assert.equal(Object.hasOwn(await model(legacy.id), 'protocol'), false, 'The model name and successful test cannot infer protocol');
  const explicitChat = await call('/models/' + responses.id, 'PUT', { ...responses, protocol: 'chat-completions', version: responses.version });
  assert.equal(explicitChat.status, 200); assert.equal((await model(responses.id)).protocol, 'chat-completions');
  const current = await model(responses.id), { protocol: _protocol, ...withoutProtocol } = current;
  assert.equal((await call('/models/' + current.id, 'PUT', withoutProtocol)).status, 200);
  assert.equal(Object.hasOwn(await model(current.id), 'protocol'), false);
});

test('Responses text API settles the full cached input and reserves captured wire bytes plus 1024 and the output cap', async () => {
  const current = await createModel(await createGateway(), { protocol: 'responses' });
  const result = await call('/models/' + current.id + '/test', 'POST', {});
  assert.equal(result.status, 200); assert.equal(result.data.usageReported, true); assert.equal((await model(current.id)).status, 'available');
  assert.equal(entries.length, 1); const sent = entries[0];
  assert.equal(sent.path, '/v1/responses'); assert.equal(sent.body.max_output_tokens, 16);
  assert.deepEqual(sent.body.input, [{ role: 'user', content: 'Reply with OK.' }]);
  assert.equal(sent.wireBytes, Buffer.byteLength(JSON.stringify(sent.body))); assert.equal(sent.headers['x-opencode-session'], undefined);
  const receipt = (await pool.query('SELECT * FROM model_reservations')).rows[0], paid = (await pool.query('SELECT * FROM usage')).rows[0];
  assert.equal(receipt.status, 'settled'); assert.equal(Number(receipt.amount), reservation(sent)); assert.equal(paid.id, receipt.id);
  assert.equal(paid.input_tokens, 100, '80 cached tokens remain within the original conservative total'); assert.equal(paid.output_tokens, 20); assert.equal(Number(paid.cost), fee);
  assert.equal(receipt.context.providerRequestId, undefined); assert.equal(receipt.context.upstreamRequestId, 'local-up-1');
  const costs = (await call('/costs')).data; assert.equal(costs.spent, fee); assert.equal(costs.reserved, 0); assert.ok(!JSON.stringify(costs).includes(fixtureKey));
});

test('two API tool probes replay call_id history and keep Go session stable within each probe and isolated between probes', async () => {
  const current = await createModel(await createGateway('https://opencode.ai/zen/go/v1'), { protocol: 'responses', model: 'stored-go-responses-fixture' });
  assert.equal((await call('/models/' + current.id + '/test', 'POST', {})).status, 200);
  await clearLedger(); entries.length = 0; mappedTargets.length = 0;
  const probeIds: string[] = [];
  for (let probe = 0; probe < 2; probe++) {
    const tested = await call('/models/' + current.id + '/test-tools', 'POST', {});
    assert.equal(tested.status, 200); probeIds.push(tested.data.testId);
    const first = entries[probe * 2], second = entries[probe * 2 + 1];
    assert.equal(first.path, '/zen/go/v1/responses'); assert.equal(second.path, '/zen/go/v1/responses');
    assert.equal(first.headers['user-agent'], 'AgentDepartment/0.2.0'); assert.equal(second.headers['user-agent'], 'AgentDepartment/0.2.0');
    assert.match(first.headers['x-opencode-session'] as string, /^agent-department-[a-f0-9]{64}$/);
    assert.equal(first.headers['x-opencode-session'], second.headers['x-opencode-session']); assert.ok(!(first.headers['x-opencode-session'] as string).includes(tested.data.testId));
    const nonce = first.body.tools[0].parameters.properties.nonce.enum[0], callId = 'call-operation-' + (probe * 2 + 1);
    assert.deepEqual(second.body.input.slice(0, -1), [...first.body.input, { role: 'assistant', content: 'Calling the harmless local probe.' },
      { type: 'function_call', call_id: callId, name: 'capability_probe', arguments: JSON.stringify({ nonce }) }]);
    const returned = second.body.input.at(-1); assert.equal(returned.type, 'function_call_output'); assert.equal(returned.call_id, callId);
    assert.match(JSON.parse(returned.output).result, /^[a-f0-9-]{36}$/);
    const history = (await pool.query('SELECT * FROM model_capability_tests WHERE id=$1', [tested.data.testId])).rows[0];
    assert.equal(history.status, 'supported'); assert.equal(history.request_ids.length, 2);
    const receipts = (await pool.query('SELECT * FROM model_reservations WHERE id=ANY($1::text[])', [history.request_ids])).rows;
    assert.equal(receipts.length, 2); assert.ok(receipts.every(row => row.status === 'settled' && row.context.probeId === tested.data.testId));
    assert.equal((await pool.query('SELECT id FROM usage WHERE id=ANY($1::text[])', [history.request_ids])).rowCount, 2);
  }
  assert.notEqual(probeIds[0], probeIds[1]); assert.notEqual(entries[0].headers['x-opencode-session'], entries[2].headers['x-opencode-session']);
  assert.equal(entries.length, 4); assert.equal(mappedTargets.length, 4); assert.ok(mappedTargets.every(item => item.target === 'https://opencode.ai/zen/go/v1/responses' && item.local.startsWith(fixtureOrigin + '/')));
  assert.equal((await model(current.id)).capabilities?.tools?.status, 'supported'); assert.equal((await call('/costs')).data.reserved, 0);
});

test('actual Responses wire budget and context limits reject before dispatch or a model reservation is inserted', async () => {
  const gatewayId = await createGateway(), current = await createModel(gatewayId, { protocol: 'responses' });
  assert.equal((await call('/models/' + current.id + '/test', 'POST', {})).status, 200);
  const sent = entries[0], actual = reservation(sent);
  const legacyAmount = ((Buffer.byteLength(JSON.stringify({ messages: sent.body.input })) + 1024) * inputRate + 16 * outputRate) / 1e6;
  assert.ok(actual > legacyAmount);
  await clearLedger(); entries.length = 0;
  await pool.query("UPDATE product_settings SET data=jsonb_set(data,'{dailyBudgetLimit}',to_jsonb($1::float8)) WHERE id=1", [(actual + legacyAmount) / 2]);
  const rejected = await call('/models/' + current.id + '/test', 'POST', {});
  assert.equal(rejected.status, 422); assert.equal(rejected.data.code, 'DAILY_BUDGET_EXCEEDED'); assert.equal(entries.length, 0); assert.deepEqual(await ledgerCounts(), { receipts: 0, usage: 0 });
  await pool.query("UPDATE product_settings SET data=jsonb_set(data,'{dailyBudgetLimit}','100'::jsonb) WHERE id=1");
  const wide = await createModel(gatewayId, { protocol: 'responses', model: 'fixture-' + '界'.repeat(180), contextWindowTokens: 5000 });
  assert.equal((await call('/models/' + wide.id + '/test', 'POST', {})).status, 200);
  assert.equal((await call('/models/' + wide.id + '/test-tools', 'POST', {})).status, 200);
  const toolWire = entries.find(entry => entry.body.model === wide.model && entry.body.tools?.length)!;
  const boundary = toolWire.wireBytes + 1024 + toolWire.body.max_output_tokens;
  assert.ok(boundary > 2048);
  let version = await model(wide.id);
  assert.equal((await call('/models/' + wide.id, 'PUT', { ...version, contextWindowTokens: boundary })).status, 200);
  assert.equal((await call('/models/' + wide.id + '/test', 'POST', {})).status, 200);
  assert.equal((await call('/models/' + wide.id + '/test-tools', 'POST', {})).status, 200, 'The exact byte guard plus output boundary permits the probe');
  version = await model(wide.id);
  assert.equal((await call('/models/' + wide.id, 'PUT', { ...version, contextWindowTokens: boundary - 1 })).status, 200);
  assert.equal((await call('/models/' + wide.id + '/test', 'POST', {})).status, 200, 'The separate text request fits this configured context');
  await clearLedger(); entries.length = 0;
  const contextRejected = await call('/models/' + wide.id + '/test-tools', 'POST', {});
  assert.equal(contextRejected.status, 422); assert.equal(contextRejected.data.code, 'CONTEXT_LIMIT'); assert.equal(entries.length, 0); assert.deepEqual(await ledgerCounts(), { receipts: 0, usage: 0 });
  const history = (await call('/models/' + wide.id + '/capability-tests')).data[0]; assert.deepEqual(history.requestIds, []);
});

test('valid usage plus malformed tool output is a settled paid probe failure with safe diagnostics', async () => {
  const current = await createModel(await createGateway(), { protocol: 'responses' });
  // Fixture-only text availability lets this test isolate the paid tool failure.
  await pool.query("UPDATE models SET status='available' WHERE id=$1", [current.id]); mode = 'malformed-tool';
  const result = await call('/models/' + current.id + '/test-tools', 'POST', {});
  assert.equal(result.status, 502); assert.equal(result.data.code, 'GATEWAY_INVALID_RESPONSE'); assert.ok(!JSON.stringify(result.data).includes(fixtureKey));
  assert.equal(entries.length, 1); const receipt = (await pool.query('SELECT * FROM model_reservations')).rows[0];
  assert.equal(receipt.status, 'settled'); assert.equal(Number(receipt.amount), reservation(entries[0]));
  const paid = (await pool.query('SELECT * FROM usage')).rows[0]; assert.equal(paid.id, receipt.id); assert.equal(Number(paid.cost), fee); assert.equal(paid.input_tokens, inputTokens);
  const costs = (await call('/costs')).data; assert.equal(costs.spent, fee); assert.equal(costs.reserved, 0); assert.equal(costs.calls.length, 0); assert.ok(!JSON.stringify(costs).includes(fixtureKey));
  const history = (await call('/models/' + current.id + '/capability-tests')).data[0]; assert.equal(history.status, 'failed'); assert.deepEqual(history.requestIds, [receipt.id]);
  assert.equal((await model(current.id)).capabilities?.tools?.status, 'failed');
});

test('missing usage and HTTP 502 retain one uncertain fee and one dispatch without retry or synthetic-key leakage', async () => {
  const gatewayId = await createGateway();
  for (const failure of ['no-usage', 'http-502'] as const) {
    await clearLedger(); entries.length = 0;
    const current = await createModel(gatewayId, { protocol: 'responses' });
    await pool.query("UPDATE models SET status='available' WHERE id=$1", [current.id]); mode = failure;
    const result = await call('/models/' + current.id + '/test-tools', 'POST', {});
    assert.equal(result.status, 502); assert.equal(result.data.code, failure === 'no-usage' ? 'USAGE_MISSING' : 'GATEWAY_REJECTED');
    assert.ok(!JSON.stringify(result.data).includes(fixtureKey)); assert.equal(entries.length, 1); assert.deepEqual(await ledgerCounts(), { receipts: 1, usage: 0 });
    const receipt = (await pool.query('SELECT * FROM model_reservations')).rows[0]; assert.equal(receipt.status, 'uncertain'); assert.equal(Number(receipt.amount), reservation(entries[0]));
    assert.equal(receipt.context.providerRequestId, undefined); assert.equal(receipt.context.providerStatus, failure === 'http-502' ? 502 : 200);
    const costs = (await call('/costs')).data; assert.equal(costs.spent, 0); assert.equal(costs.reserved, Number(receipt.amount)); assert.equal(costs.calls.length, 1); assert.equal(costs.calls[0].status, 'uncertain'); assert.ok(!JSON.stringify(costs).includes(fixtureKey));
    const history = (await call('/models/' + current.id + '/capability-tests')).data[0]; assert.equal(history.status, 'failed'); assert.deepEqual(history.requestIds, [receipt.id]);
    assert.equal(entries.length, 1, 'Reading the error, costs and history cannot dispatch a retry');
  }
});
