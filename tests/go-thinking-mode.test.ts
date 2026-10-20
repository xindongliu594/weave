import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import http from 'node:http';
import type pg from 'pg';

// Run only with scripts/test-integration.mjs: fresh PGlite and local HTTP fixtures.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, app: any, server: http.Server, gateway: http.Server, directory: string, url: string, gatewayId: string;
const wires: any[] = [], faults: unknown[] = [];
let reasoning = false, skipTool = false;
const close = (instance?: http.Server) => instance ? new Promise<void>(done => { instance.closeAllConnections(); instance.close(() => done()); }) : Promise.resolve();
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'go-thinking-mode-'));
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = join(directory, 'runs'); process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); wires.push(body); assert.equal(request.url, '/v1/chat/completions');
      let message: any = { content: 'OK' };
      if (body.tool_choice && !skipTool) {
        const nonce = body.tools[0].function.parameters.properties.nonce.enum[0];
        message = { content: null, tool_calls: [{ id: 'synthetic-local-probe', type: 'function', function: { name: 'capability_probe', arguments: JSON.stringify({ nonce }) } }] };
      } else if (body.messages.at(-1).role === 'tool') message = { content: JSON.parse(body.messages.at(-1).content).result };
      if (reasoning) message.reasoning_content = 'Synthetic reasoning state from an ignored option';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    } catch (error) { faults.push(error); response.writeHead(500); response.end('{}'); }
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const { createApp } = await import('../apps/api/src/app.ts'); app = createApp(); await app.locals.shutdownBackground();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
  const configured = await call('/gateways', 'POST', { name: 'Local thinking protocol fixture', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1' });
  assert.equal(configured.status, 201, JSON.stringify(configured.data)); gatewayId = configured.data.id;
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE usage,model_reservations,model_capability_tests,models,request_keys CASCADE');
  await pool.query('UPDATE product_settings SET data=$1 WHERE id=1', [{ autoBudgetLimit: .25, dailyBudgetLimit: 20, maxActiveRuns: 2, retentionDays: 0 }]);
  wires.length = 0; faults.length = 0; reasoning = false; skipTool = false;
});
after(async () => {
  if (!isolated) return;
  await app?.locals.shutdown(); await close(server); await close(gateway); await pool?.end();
  assert.deepEqual(faults, []);
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('go-thinking-mode-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const modelData = (patch: Record<string, unknown> = {}) => ({ gatewayId, name: 'Opaque local fixture', model: 'opaque-local-model', inputRate: 2, outputRate: 10, ...patch });
const savedModel = async (id: string) => (await call('/models')).data.find((model: any) => model.id === id);
const ledger = async () => ({ receipts: (await pool.query('SELECT status,amount FROM model_reservations ORDER BY amount')).rows,
  usage: (await pool.query('SELECT cost FROM usage ORDER BY cost')).rows });

test('explicit thinking disable persists and reaches API text plus complete synthetic tool roundtrip with exact wire reservations', { skip: !isolated }, async () => {
  const data = { ...modelData(), thinkingMode: 'disabled' }, created = await call('/models', 'POST', data);
  assert.equal(created.status, 201, JSON.stringify(created.data)); const id = created.data.id;
  assert.equal((await savedModel(id)).thinkingMode, 'disabled');
  assert.equal((await call('/models/' + id + '/test', 'POST', {})).status, 200);
  const probed = await call('/models/' + id + '/test-tools', 'POST', { maxCost: .1 });
  assert.equal(probed.status, 200, JSON.stringify(probed.data)); assert.equal(wires.length, 3);
  for (const wire of wires) assert.deepEqual(wire.thinking, { type: 'disabled' });
  assert.equal(wires[1].tool_choice, 'auto');
  assert.equal(wires[2].messages.at(-1).role, 'tool'); assert.equal(wires[2].messages.at(-2).tool_calls[0].id, 'synthetic-local-probe');
  const costs = await ledger(); assert.equal(costs.receipts.length, 3); assert.equal(costs.usage.length, 3);
  assert.ok(costs.receipts.every(receipt => receipt.status === 'settled'));
  const expected = wires.map(wire => ((Buffer.byteLength(JSON.stringify(wire)) + 1024) * 2 + wire.max_tokens * 10) / 1e6).sort((a, b) => a - b);
  costs.receipts.forEach((receipt, index) => near(Number(receipt.amount), expected[index]));
  costs.usage.forEach(usage => near(Number(usage.cost), (11 * 2 + 7 * 10) / 1e6));
  skipTool = true;
  const absentCall = await call('/models/' + id + '/test-tools', 'POST', { maxCost: .1 });
  assert.equal(absentCall.status, 422); assert.equal(absentCall.data.code, 'TOOL_PROBE_FAILED');
  assert.equal(wires.length, 4, 'Auto selection without the required call cannot pass or create a second probe request');
  assert.equal((await ledger()).usage.length, 4); assert.ok((await ledger()).receipts.every(receipt => receipt.status === 'settled'));
  skipTool = false;
  const configured = await savedModel(id);
  const { thinkingMode: _omitted, ...cleared } = data;
  assert.equal((await call('/models/' + id, 'PUT', { ...cleared, version: configured.version })).status, 200);
  const reset = await savedModel(id); assert.equal(Object.hasOwn(reset, 'thinkingMode'), false); assert.equal(reset.status, 'untested');
  assert.deepEqual(reset.capabilities, {});
  assert.equal((await call('/models/' + id + '/test', 'POST', {})).status, 200);
  assert.equal(Object.hasOwn(wires[4], 'thinking'), false);
});

test('missing thinking config preserves the legacy Chat body and reservation even for a DeepSeek model name', { skip: !isolated }, async () => {
  const created = await call('/models', 'POST', modelData({ model: 'deepseek-v4.1-flash' }));
  assert.equal(created.status, 201); const id = created.data.id;
  assert.equal(Object.hasOwn(await savedModel(id), 'thinkingMode'), false);
  assert.equal((await call('/models/' + id + '/test', 'POST', {})).status, 200);
  assert.equal(wires.length, 1); assert.equal(Object.hasOwn(wires[0], 'thinking'), false);
  assert.deepEqual(wires[0], { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false });
  const costs = await ledger(); assert.equal(costs.receipts.length, 1); assert.equal(costs.receipts[0].status, 'settled');
  near(Number(costs.receipts[0].amount), ((Buffer.byteLength(JSON.stringify({ messages: wires[0].messages })) + 1024) * 2 + 16 * 10) / 1e6);
  assert.equal((await call('/models/' + id + '/test-tools', 'POST', { maxCost: .1 })).status, 200);
  assert.equal(wires.length, 3); assert.deepEqual(wires[1].tool_choice, { type: 'function', function: { name: 'capability_probe' } });
  assert.ok(wires.every(wire => !Object.hasOwn(wire, 'thinking')));
});

test('ignored disabled thinking rejects API tool state after settling known usage without a second probe request', { skip: !isolated }, async () => {
  const created = await call('/models', 'POST', modelData({ thinkingMode: 'disabled' })); assert.equal(created.status, 201);
  const id = created.data.id; assert.equal((await call('/models/' + id + '/test', 'POST', {})).status, 200);
  reasoning = true;
  const rejected = await call('/models/' + id + '/test-tools', 'POST', { maxCost: .1 });
  assert.equal(rejected.status, 502); assert.equal(rejected.data.code, 'THINKING_MODE_IGNORED');
  assert.equal(wires.length, 2, 'The rejected first tool reply cannot trigger a second roundtrip');
  const costs = await ledger(); assert.equal(costs.receipts.length, 2); assert.equal(costs.usage.length, 2);
  assert.ok(costs.receipts.every(receipt => receipt.status === 'settled'));
  const probe = (await pool.query('SELECT status,code FROM model_capability_tests')).rows[0];
  assert.equal(probe.status, 'failed'); assert.equal(probe.code, 'THINKING_MODE_IGNORED');
  const ignoredText = await call('/models/' + id + '/test', 'POST', {});
  assert.equal(ignoredText.status, 502); assert.equal(ignoredText.data.code, 'THINKING_MODE_IGNORED');
  assert.equal(wires.length, 3); assert.equal((await ledger()).usage.length, 3);
  assert.ok((await ledger()).receipts.every(receipt => receipt.status === 'settled'));
});

test('unsupported thinking values and Responses combinations cannot persist or dispatch', { skip: !isolated }, async () => {
  for (const thinkingMode of ['enabled', null, true]) assert.equal((await call('/models', 'POST', modelData({ thinkingMode }))).status, 422);
  assert.equal((await call('/models', 'POST', modelData({ protocol: 'responses', thinkingMode: 'disabled' }))).status, 422);
  assert.deepEqual((await call('/models')).data, []); assert.equal(wires.length, 0); assert.deepEqual(await ledger(), { receipts: [], usage: [] });
});
