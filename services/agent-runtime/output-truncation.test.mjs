import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

// Loopback engineering fixtures only. No gateway, original credentials,
// employee deliverables or real model acceptance are exercised here.
const route = { id: 'fixture-model', name: 'Local fixture', wireModel: 'fixture-wire',
  apiKey: 'synthetic-fixture-key', inputRate: 1, outputRate: 2, maxOutputTokens: 1000 };
const task = { id: 'qa_verify', assigneeId: 'qa', maxOutputTokens: 800 };
const options = { model: route.id, sessionId: 'fixture-session',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Approved fixture task' }] }],
  tools: [{ name: 'artifact_write', description: 'Fixture tool only', parameters: { type: 'object' } }] };
const call = (argumentsText, id = 'fixture-call') => ({ id, type: 'function', function: { name: 'artifact_write', arguments: argumentsText } });
const reply = (calls, outputTokens = task.maxOutputTokens, finishReason = 'tool_calls') => ({
  choices: [{ message: { content: 'synthetic response', tool_calls: calls }, finish_reason: finishReason }],
  usage: { prompt_tokens: 17, completion_tokens: outputTokens },
});
const consume = async (adapter, chunks = []) => { for await (const chunk of adapter.stream(options)) chunks.push(chunk); };

async function withFixture(response, work) {
  const wires = [];
  const server = http.createServer(async (request, result) => {
    let text = ''; for await (const part of request) text += part;
    wires.push({ method: request.method, path: request.url, body: JSON.parse(text) });
    result.setHeader('content-type', 'application/json');
    result.end(JSON.stringify(typeof response === 'function' ? response(wires.at(-1).body) : response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await work({ wires, fixtureRoute: { ...route, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('a capped incomplete tool call awaits its paid fee, emits no native call and never retries or falls back', async () => {
  const partial = '{"path":"acceptance.test.mjs","content":"' + route.apiKey;
  await withFixture(reply([call('{"path":"allowed.txt","content":"valid"}', 'valid-before-partial'), call(partial)]), async ({ wires, fixtureRoute }) => {
    const receipts = [], failures = [], errors = [], fallbacks = [], chunks = [];
    let beginSave, finishSave;
    const saving = new Promise(resolve => { beginSave = resolve; });
    const saved = new Promise(resolve => { finishSave = resolve; });
    const record = {};
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...fixtureRoute, protocol: 'chat-completions', thinkingMode: 'disabled' }, { ...fixtureRoute, id: 'backup' }], tasks: [task], maxBudget: 1,
      beforeRequest: async receipt => { receipts.push(receipt); Object.assign(record, { id: receipt.id, state: 'pending' }); },
      onUsage: async usage => { beginSave(); await saved; Object.assign(record, { state: 'paid', usage }); },
      onCallError: failure => failures.push(failure), onFallback: event => fallbacks.push(event),
      onError: error => { assert.equal(record.state, 'paid'); errors.push(error); },
    });
    adapter.attribution = () => ({ sessionId: options.sessionId, taskId: task.id, employeeId: task.assigneeId });
    adapter.sessionPolicies.set(options.sessionId, { fallbackModelId: 'backup' });
    const running = assert.rejects(consume(adapter, chunks), error => error.code === 'OUTPUT_TRUNCATED'
      && error.message.includes(route.wireModel) && error.message.includes('800 Token')
      && error.message.includes('AI 重新规划') && !error.message.includes(route.apiKey));
    await saving;
    assert.equal(record.state, 'pending'); assert.deepEqual(chunks, []); assert.deepEqual(errors, []);
    finishSave(); await running;
    assert.equal(wires.length, 1); assert.equal(receipts.length, 1);
    assert.equal(wires[0].method, 'POST'); assert.equal(wires[0].path, '/v1/chat/completions');
    assert.equal(wires[0].body.max_tokens, 800); assert.deepEqual(wires[0].body.thinking, { type: 'disabled' });
    assert.equal(record.usage.id, record.id); assert.equal(record.usage.outputTokens, 800);
    assert.equal(record.usage.cost, 1617 / 1e6); assert.equal(adapter.spent, record.usage.cost);
    assert.equal(adapter.reserved, 0); assert.equal(adapter.pendingRequests, 0);
    assert.deepEqual(chunks, []); assert.deepEqual(failures, []); assert.deepEqual(fallbacks, []);
    assert.equal(errors.length, 1);
  });
});

test('valid JSON exactly at the cap remains a tool call for explicit and legacy Chat configurations', async () => {
  const complete = '{"path":"fixture.txt","content":"complete"}';
  await withFixture(reply([call(complete)]), async ({ wires, fixtureRoute }) => {
    for (const configuration of [{}, { protocol: 'chat-completions', thinkingMode: 'disabled' }]) {
      const usage = [], chunks = [];
      const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...fixtureRoute, ...configuration }], tasks: [task], maxBudget: 1, onUsage: item => usage.push(item) });
      adapter.attribution = () => ({ sessionId: options.sessionId, taskId: task.id, employeeId: task.assigneeId });
      await consume(adapter, chunks);
      assert.equal(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').length, 1);
      assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.arguments, complete);
      assert.equal(chunks.at(-1).reason.kind, 'tool-calls'); assert.equal(usage.length, 1);
      assert.equal(wires.at(-1).body.max_tokens, 800);
      assert.equal(Object.hasOwn(wires.at(-1).body, 'thinking'), configuration.thinkingMode !== undefined);
      assert.equal(Object.hasOwn(wires.at(-1).body, 'protocol'), false);
    }
    assert.equal(wires.length, 2);
  });
});

test('execution text length failure settles known usage before MAX_TOKENS and never emits partial work or fallback', async () => {
  const partial = { choices: [{ message: { content: 'Truncated review ends in Inf' }, finish_reason: 'length' }], usage: { prompt_tokens: 17, completion_tokens: 800 } };
  await withFixture(partial, async ({ wires, fixtureRoute }) => {
    const usage = [], errors = [], failures = [], fallbacks = [], chunks = [], saved = Promise.withResolvers();
    const adapter = new OpenAiCompatibleAdapter({ routes: [fixtureRoute, { ...fixtureRoute, id: 'backup' }], tasks: [task], maxBudget: 1,
      onUsage: async item => { await saved.promise; usage.push(item); }, onError: error => { assert.equal(usage.length, 1); errors.push(error); },
      beforeRequest: async () => {}, onCallError: error => failures.push(error), onFallback: item => fallbacks.push(item) });
    adapter.attribution = () => ({ sessionId: options.sessionId, taskId: task.id, employeeId: task.assigneeId });
    adapter.sessionPolicies.set(options.sessionId, { fallbackModelId: 'backup' });
    const done = assert.rejects(consume(adapter, chunks), error => error.code === 'MAX_TOKENS' && /800 Token/.test(error.message) && !error.message.includes('Truncated review'));
    while (!wires.length) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(chunks, []); assert.deepEqual(errors, []);
    saved.resolve(); await done;
    assert.equal(wires.length, 1); assert.equal(usage.length, 1); assert.equal(usage[0].cost, 1617 / 1e6);
    assert.equal(adapter.spent, usage[0].cost); assert.equal(adapter.reserved, 0); assert.equal(adapter.pendingRequests, 0);
    assert.deepEqual(chunks, []); assert.deepEqual(failures, []); assert.deepEqual(fallbacks, []); assert.equal(errors.length, 1);
  });
});

test('length text cannot bypass the gate through an apparently complete tool JSON or smaller reported output', async () => {
  await withFixture(reply([call('{"path":"fixture.txt","content":"complete"}')], 7, 'length'), async ({ fixtureRoute, wires }) => {
    const usage = [], chunks = [];
    const adapter = new OpenAiCompatibleAdapter({ routes: [fixtureRoute], tasks: [task], maxBudget: 1, onUsage: item => usage.push(item) });
    adapter.attribution = () => ({ taskId: task.id, employeeId: task.assigneeId });
    await assert.rejects(consume(adapter, chunks), error => error.code === 'MAX_TOKENS');
    assert.deepEqual(chunks, []); assert.equal(wires.length, 1); assert.equal(usage[0].outputTokens, 7); assert.equal(adapter.reserved, 0);
  });
});

test('compaction retains native max-tokens signalling and normal stop text never implies task completion', async () => {
  for (const purpose of ['compaction', 'execution']) await withFixture({ choices: [{ message: { content: 'local text only' }, finish_reason: purpose === 'compaction' ? 'length' : 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 5 } }, async ({ fixtureRoute, wires }) => {
    const usage = [], chunks = [], adapter = new OpenAiCompatibleAdapter({ routes: [fixtureRoute], maxBudget: 1, onUsage: item => usage.push(item) });
    for await (const chunk of adapter.stream({ ...options, purpose, tools: undefined })) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, purpose === 'compaction' ? 'max-tokens' : 'stop');
    assert.equal(wires.length, 1); assert.equal(usage.length, 1); assert.equal(adapter.reserved, 0);
    assert.ok(chunks.every(chunk => chunk.type !== 'block-end' || chunk.block.type !== 'tool-call'));
  });
});

test('invalid JSON below the cap or without upstream tool_calls does not invent a truncation diagnosis', async () => {
  const incomplete = '{"path":"unfinished';
  for (const [outputTokens, finishReason] of [[799, 'tool_calls'], [800, 'stop']]) {
    await withFixture(reply([call(incomplete)], outputTokens, finishReason), async ({ wires, fixtureRoute }) => {
      const adapter = new OpenAiCompatibleAdapter({ routes: [fixtureRoute], tasks: [task], maxBudget: 1 });
      adapter.attribution = () => ({ sessionId: options.sessionId, taskId: task.id, employeeId: task.assigneeId });
      const chunks = []; await consume(adapter, chunks);
      assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block.arguments, incomplete);
      assert.equal(wires.length, 1); assert.equal(wires[0].body.max_tokens, 800);
    });
  }
});

test('missing usage keeps the single dispatched call uncertain and never claims output truncation or a paid fee', async () => {
  const response = reply([call('{"path":"unfinished')]); delete response.usage;
  await withFixture(response, async ({ wires, fixtureRoute }) => {
    const failures = [], usage = [], chunks = [];
    const adapter = new OpenAiCompatibleAdapter({ routes: [fixtureRoute], tasks: [task], maxBudget: 1,
      beforeRequest: async () => {}, onUsage: item => usage.push(item), onCallError: failure => failures.push(failure) });
    adapter.attribution = () => ({ sessionId: options.sessionId, taskId: task.id, employeeId: task.assigneeId });
    await assert.rejects(consume(adapter, chunks), error => error.code === 'USAGE_MISSING');
    assert.equal(wires.length, 1); assert.equal(failures.length, 1); assert.equal(failures[0].dispatched, true);
    assert.equal(failures[0].code, 'USAGE_MISSING'); assert.deepEqual(usage, []); assert.deepEqual(chunks, []); assert.equal(adapter.spent, 0);
  });
});
