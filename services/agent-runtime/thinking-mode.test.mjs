import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

const route = { id: 'thinking-fixture', name: 'Local explicit thinking option', wireModel: 'opaque-local-model', baseUrl: 'http://127.0.0.1:1/v1',
  apiKey: '', inputRate: 2, outputRate: 10, maxOutputTokens: 128 };
const options = { model: route.id, sessionId: 'local-thinking-session', system: 'Preserve approved permissions.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this exact local fixture.' }] }] };
const tool = { name: 'local_read', description: 'Synthetic protocol tool, never executed', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const output = message => ({ choices: [{ message }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
const blocks = events => events.filter(event => event.type === 'block-end').map(event => event.block);
async function consume(adapter, request = options) { const events = []; for await (const event of adapter.stream(request)) events.push(event); return events; }
const state = adapter => structuredClone({ calls: adapter.calls, spent: adapter.spent, reserved: adapter.reserved, run: adapter.budget.run, tasks: adapter.budget.tasks });
async function fixture(handler) {
  const requests = [], faults = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const entry = { path: request.url, body: JSON.parse(raw), bytes: Buffer.byteLength(raw) }; requests.push(entry);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(handler(entry, requests.length)));
    } catch (error) { faults.push(error); response.writeHead(500); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, route: { ...route, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); assert.deepEqual(faults, []); } };
}

test('explicit thinking disable reaches real local runtime HTTP and uses full wire reservations while retaining existing reasoning tool history', async () => {
  const local = await fixture((entry, count) => {
    assert.equal(entry.path, '/v1/chat/completions'); assert.deepEqual(entry.body.thinking, { type: 'disabled' });
    if (count === 1) return output({ content: null, reasoning_content: 'Synthetic ignored-disable reasoning', tool_calls: [{ id: 'local-call', type: 'function', function: { name: tool.name, arguments: '{"path":"fixture.txt"}' } }] });
    assert.equal(entry.body.messages.at(-2).reasoning_content, 'Synthetic ignored-disable reasoning');
    assert.equal(entry.body.messages.at(-1).tool_call_id, 'local-call'); assert.equal(entry.body.messages.at(-1).content, 'complete synthetic tool result');
    return output({ content: 'verified local result' });
  });
  const receipts = [], traces = [], usages = [];
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, thinkingMode: 'disabled' }], maxBudget: 1,
      beforeRequest: async event => receipts.push(event), onRequest: event => traces.push(event), onUsage: event => usages.push(event) });
    const first = blocks(await consume(adapter, { ...options, tools: [tool] }));
    assert.deepEqual(first, [{ type: 'reasoning', text: 'Synthetic ignored-disable reasoning' }, { type: 'tool-call', id: 'local-call', name: tool.name, arguments: '{"path":"fixture.txt"}' }]);
    const second = await consume(adapter, { ...options, tools: [tool], messages: [...options.messages,
      { role: 'assistant', content: first }, { role: 'tool', source: { kind: 'tool', callId: 'local-call' }, content: [{ type: 'tool-result', toolCallId: 'local-call', isError: false, content: [{ type: 'text', text: 'complete synthetic tool result' }] }] }] });
    assert.deepEqual(blocks(second), [{ type: 'text', text: 'verified local result' }]);
    assert.equal(local.requests.length, 2); assert.equal(receipts.length, 2); assert.equal(usages.length, 2);
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(traces[index].body, local.requests[index].body);
      assert.equal(local.requests[index].bytes, Buffer.byteLength(JSON.stringify(traces[index].body)));
      assert.equal(receipts[index].reservation, ((local.requests[index].bytes + 1024) * 2 + 128 * 10) / 1e6);
      assert.equal(usages[index].cost, (11 * 2 + 7 * 10) / 1e6);
    }
  } finally { await local.close(); }
});

test('legacy runtime routes never infer thinking from a DeepSeek wire name and keep their original Chat estimate', async () => {
  const local = await fixture(entry => { assert.equal(Object.hasOwn(entry.body, 'thinking'), false); return output({ content: 'legacy local result' }); });
  const receipts = [];
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, wireModel: 'deepseek-v4.1-flash' }], maxBudget: 1, beforeRequest: async event => receipts.push(event) });
    assert.deepEqual(blocks(await consume(adapter)), [{ type: 'text', text: 'legacy local result' }]);
    assert.equal(local.requests.length, 1); const body = local.requests[0].body;
    assert.deepEqual(body, { model: 'deepseek-v4.1-flash', messages: [{ role: 'system', content: options.system }, { role: 'user', content: 'Read this exact local fixture.' }], stream: false, max_tokens: 128 });
    assert.equal(receipts[0].reservation, ((Buffer.byteLength(JSON.stringify({ messages: body.messages })) + 1024) * 2 + 128 * 10) / 1e6);
  } finally { await local.close(); }
});

test('explicit Chat configuration counts the protected whole envelope and rejects insufficient funds without lowering output or changing state', () => {
  const configured = { ...route, thinkingMode: 'disabled' };
  const available = new OpenAiCompatibleAdapter({ routes: [configured], maxBudget: 1 }), before = state(available);
  const prepared = available.prepareRequest({ ...options, tools: [tool] });
  const reservation = ((Buffer.byteLength(JSON.stringify(prepared.body)) + 1024) * 2 + 128 * 10) / 1e6;
  assert.equal(prepared.reservation, reservation); assert.equal(prepared.body.max_tokens, 128); assert.deepEqual(state(available), before);
  const scarce = new OpenAiCompatibleAdapter({ routes: [configured], maxBudget: reservation - 1e-8 }), initial = state(scarce);
  assert.throws(() => scarce.prepareRequest({ ...options, tools: [tool] }), error => {
    assert.equal(error.code, 'BUDGET_CONTEXT_LIMIT'); assert.equal(error.contextBudget.maxTokens, 128); return true;
  });
  assert.deepEqual(state(scarce), initial);
});

test('invalid thinking configuration and Responses combination are refused before runtime admission or dispatch', async () => {
  for (const [patch, code] of [[{ thinkingMode: 'enabled' }, 'INVALID_THINKING_MODE'], [{ protocol: 'responses', thinkingMode: 'disabled' }, 'THINKING_PROTOCOL_MISMATCH']]) {
    const admissions = [], requests = [];
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...route, ...patch }], maxBudget: 1, beforeRequest: event => admissions.push(event), onRequest: event => requests.push(event) });
    const initial = state(adapter);
    await assert.rejects(consume(adapter), { code });
    assert.deepEqual(admissions, []); assert.deepEqual(requests, []); assert.deepEqual(state(adapter), initial);
  }
});
