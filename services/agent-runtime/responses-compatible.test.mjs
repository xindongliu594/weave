import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';
import { completionRequest } from './completion-protocol.mjs';

const route = { id: 'luna-fixture', name: 'Local Responses fixture', wireModel: 'gpt-6-luna', protocol: 'responses',
  baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'isolated-fixture-only', inputRate: .125, outputRate: .5, maxOutputTokens: 3000, contextWindowTokens: 272000 };
const options = { model: route.id, sessionId: 'stable-local-session', system: 'approved job and permission scope',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read the pinned source' }] }],
  tools: [{ name: 'filesystem', description: 'read assigned local source', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
const output = items => ({ id: 'resp-local-fixture', status: 'completed', output: items,
  usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 130 } });
const textOutput = text => [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }];
const callOutput = () => [{ type: 'function_call', id: 'fc-native-item', call_id: 'call-native-operation', status: 'completed', name: 'filesystem', arguments: '{"path":"server.mjs"}' }];
async function fixture(handler) {
  const requests = [], faults = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const wire = Buffer.concat(chunks);
      const entry = { path: request.url, headers: request.headers, wireBytes: wire.byteLength, body: JSON.parse(wire.toString('utf8')) }; requests.push(entry);
      const result = await handler(entry, requests.length);
      response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', 'X-Request-Id': 'local-fixture-' + requests.length });
      response.end(result.rawBody ?? JSON.stringify(result.payload));
    } catch (error) { faults.push(error); response.writeHead(500); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, faults, route: { ...route, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(faults, []); } };
}
async function consume(adapter, request = options) {
  const events = []; for await (const event of adapter.stream(request)) events.push(event); return events;
}
const completedBlocks = events => events.filter(event => event.type === 'block-end').map(event => event.block);
const localState = adapter => structuredClone({ run: adapter.budget.run, tasks: adapter.budget.tasks, calls: adapter.calls, reserved: adapter.reserved, spent: adapter.spent });

test('real local HTTP Responses exchange persists the actual path/body and replays complete call/output history without remote conversation', async () => {
  const source = { path: 'server.mjs', sha256: 'b'.repeat(64), content: '固定文件原文\nexport const ready = true;' }, receipts = [], traces = [], usages = [];
  const local = await fixture((request, count) => {
    assert.equal(request.path, '/v1/responses'); assert.equal(request.body.store, false); assert.deepEqual(request.body.reasoning, { effort: 'none' });
    assert.equal(request.body.tools[0].strict, false); assert.equal(request.body.max_output_tokens, 3000);
    assert.equal(request.headers.authorization, 'Bearer isolated-fixture-only');
    assert.equal(request.headers['x-opencode-session'], undefined, 'Go headers are not sent to this local fixture');
    if (count === 1) return { payload: output(callOutput()) };
    assert.deepEqual(request.body.input.slice(-2), [
      { type: 'function_call', call_id: 'call-native-operation', name: 'filesystem', arguments: '{"path":"server.mjs"}' },
      { type: 'function_call_output', call_id: 'call-native-operation', output: JSON.stringify(source) },
    ]);
    assert.equal(request.body.previous_response_id, undefined); assert.equal(request.body.conversation, undefined);
    return { payload: output(textOutput('verified complete source')) };
  });
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1,
      beforeRequest: async event => receipts.push(event), onRequest: event => traces.push(event), onUsage: event => usages.push(event) });
    const first = await consume(adapter), blocks = completedBlocks(first);
    assert.deepEqual(blocks, [{ type: 'tool-call', id: 'call-native-operation', name: 'filesystem', arguments: '{"path":"server.mjs"}' }]);
    const second = await consume(adapter, { ...options, messages: [...options.messages,
      { role: 'assistant', content: blocks }, { role: 'tool', source: { kind: 'tool', callId: 'call-native-operation' }, content: [{ type: 'tool-result', toolCallId: 'call-native-operation', isError: false, content: [{ type: 'text', text: JSON.stringify(source) }] }] }] });
    assert.deepEqual(completedBlocks(second), [{ type: 'text', text: 'verified complete source' }]);
    assert.equal(local.requests.length, 2); assert.equal(receipts.length, 2); assert.equal(usages.length, 2);
    for (let index = 0; index < 2; index++) {
      const wire = local.requests[index].body;
      assert.equal(traces[index].path, '/responses'); assert.equal(traces[index].protocol, 'responses'); assert.deepEqual(traces[index].body, wire);
      assert.equal(local.requests[index].wireBytes, Buffer.byteLength(JSON.stringify(wire)), 'captured HTTP bytes match the reserved serialized envelope');
      assert.equal(receipts[index].reservation, ((Buffer.byteLength(JSON.stringify(wire)) + 1024) * .125 + 3000 * .5) / 1e6);
      assert.equal(usages[index].inputTokens, 100, 'cached input stays in the original total for conservative configured billing');
      assert.equal(usages[index].outputTokens, 30, 'reasoning output is included, not added twice');
      assert.equal(usages[index].cost, (100 * .125 + 30 * .5) / 1e6);
    }
    const usage = first.find(event => event.type === 'usage').usage;
    assert.equal(usage.inputTokens, 20); assert.equal(usage.cacheReadTokens, 80); assert.equal(usage.reasoningTokens, 10); assert.equal(usage.outputTokens, 30);
  } finally { await local.close(); }
});

test('actual Responses envelope expansion is checked before taking calls, reserving or dispatching', async () => {
  const local = await fixture(() => ({ payload: output(textOutput('must not be called')) }));
  try {
    const chat = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, protocol: undefined }], maxBudget: 1 }).prepareRequest(options);
    const actual = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 }).prepareRequest(options);
    assert.ok(actual.reservation > chat.reservation);
    const receipts = [], adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: (actual.reservation + chat.reservation) / 2, beforeRequest: async event => receipts.push(event) });
    const before = localState(adapter);
    assert.throws(() => adapter.prepareRequest(options), error => error.code === 'BUDGET_CONTEXT_LIMIT' && error.contextBudget.minimumReservation === actual.reservation);
    await assert.rejects(consume(adapter), error => error.code === 'BUDGET_CONTEXT_LIMIT');
    assert.deepEqual(localState(adapter), before); assert.deepEqual(receipts, []); assert.equal(local.requests.length, 0);
  } finally { await local.close(); }
});

test('context window guards include actual wire bytes, the 1024 guard and unchanged output, at the exact boundary', async () => {
  const local = await fixture(() => ({ payload: output(textOutput('must not be called')) }));
  try {
    const prepared = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 }).prepareRequest(options);
    const boundary = prepared.fitted.inputUpperBound + prepared.maxTokens;
    const exact = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, contextWindowTokens: boundary }], maxBudget: 1 });
    assert.deepEqual(exact.prepareRequest(options).body, prepared.body);
    for (const override of [{ contextWindowTokens: boundary - 1 }, { contextBytes: prepared.fitted.afterBytes - 1 }]) {
      const receipts = [], adapter = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, ...override }], maxBudget: 1, beforeRequest: async event => receipts.push(event) });
      await assert.rejects(consume(adapter), error => error.code === 'CONTEXT_LIMIT');
      assert.equal(adapter.calls, 0); assert.equal(adapter.reserved, 0); assert.deepEqual(receipts, []);
    }
    assert.equal(local.requests.length, 0);
  } finally { await local.close(); }
});

test('financial fitting preserves the latest contract, old full SHA file and pinned knowledge groups while removing old discussion', () => {
  const file = { path: 'server.mjs', sha256: 'e'.repeat(64), content: 'FULL_SOURCE\n'.repeat(170) };
  const kb = { documentId: 'rules', version: 4, sha256: 'a'.repeat(64), content: 'FIXED_VERSION\n'.repeat(100) };
  const request = { ...options, tools: [...options.tools, { name: 'knowledge_read', description: 'authorized version-pinned reads', parameters: { type: 'object', properties: { documentId: { type: 'string' }, version: { type: 'integer' } } } }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'old unprotected discussion\n'.repeat(3000) }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'file', name: 'filesystem', arguments: '{"path":"server.mjs"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'file', content: [{ type: 'text', text: JSON.stringify(file) }] }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'kb', name: 'knowledge_read', arguments: '{"documentId":"rules","version":4}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'kb', content: [{ type: 'text', text: JSON.stringify(kb) }] }] },
    { role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'department:approved-context', text: 'LATEST_FULL_APPROVED_CONTRACT' }] }, content: [{ type: 'text', text: 'LATEST_FULL_APPROVED_CONTRACT' }] },
  ] };
  const original = structuredClone(request), adapter = new OpenAiCompatibleAdapter({ routes: [{ ...route, inputRate: 1, outputRate: 2, maxOutputTokens: 1000 }], contextBytes: 192000, maxBudget: .01 });
  const prepared = adapter.prepareRequest(request);
  assert.ok(prepared.fitted.removed > 0); assert.ok(prepared.reservation <= .01);
  assert.equal(prepared.body.max_output_tokens, 1000);
  assert.deepEqual(prepared.body.input.filter(item => item.type === 'function_call_output').map(item => item.output), [JSON.stringify(file), JSON.stringify(kb)]);
  assert.ok(prepared.body.input.some(item => item.content === 'LATEST_FULL_APPROVED_CONTRACT'));
  assert.deepEqual(request, original); assert.equal(adapter.calls, 0);
});

test('per-task max output cap remains distinct from whole-task estimates and is honored on Responses wire', async () => {
  const local = await fixture(request => { assert.equal(request.body.max_output_tokens, 600); return { payload: output(textOutput('done')) }; });
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, tasks: [{ id: 'qa', assigneeId: 'tester', maxOutputTokens: 600, estimatedOutputTokens: 50000 }] });
    adapter.attribution = () => ({ sessionId: options.sessionId, taskId: 'qa', employeeId: 'tester' });
    const prepared = adapter.prepareRequest({ ...options, maxTokens: 2200 });
    assert.equal(prepared.maxTokens, 600); await consume(adapter, { ...options, maxTokens: 2200 });
    assert.equal(local.requests.length, 1);
  } finally { await local.close(); }
});

test('HTTP failures and missing or invalid usage retain one run/task hold despite a configured fallback, with no retry or tool execution', async () => {
  for (const [status, payload, code] of [
    ...[401, 403, 429, 502, 503].map(status => [status, { error: { code: 'fixture_overload', message: 'unavailable' } },
      status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR']),
    [200, { status: 'completed', output: callOutput() }, 'USAGE_MISSING'],
    [200, { ...output(callOutput()), usage: { input_tokens: -1, output_tokens: 30 } }, 'USAGE_MISSING'],
    [200, { ...output(callOutput()), usage: { input_tokens: 100, output_tokens: 1.5 } }, 'USAGE_MISSING'],
    [200, null, 'USAGE_MISSING'],
  ]) {
    const local = await fixture(() => ({ status, payload })), failures = [], usages = [], receipts = [], blocks = [], fallbacks = [];
    try {
      const amount = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 }).prepareRequest(options).reservation;
      const backup = { ...local.route, id: 'backup', wireModel: 'backup-fixture' };
      const adapter = new OpenAiCompatibleAdapter({ routes: [local.route, backup], maxBudget: amount * 1.5,
        tasks: [{ id: 'task', assigneeId: 'employee', maxBudget: amount * 1.5 }],
        beforeRequest: async event => receipts.push(event), onCallError: event => failures.push(event), onUsage: event => usages.push(event), onFallback: event => fallbacks.push(event) });
      adapter.attribution = () => ({ sessionId: options.sessionId, taskId: 'task', employeeId: 'employee' });
      adapter.sessionPolicies.set(options.sessionId, { fallbackModelId: backup.id });
      await assert.rejects(async () => { for await (const event of adapter.stream(options)) if (event.type === 'block-end') blocks.push(event.block); }, error => error.code === code);
      assert.equal(local.requests.length, 1); assert.equal(receipts.length, 1); assert.equal(failures.length, 1);
      assert.equal(failures[0].dispatched, true); assert.equal(failures[0].id, receipts[0].id); assert.ok(receipts[0].reservation > 0);
      assert.deepEqual(usages, []); assert.deepEqual(blocks, []); assert.equal(adapter.spent, 0, 'local known spend excludes the retained unknown reservation');
      assert.deepEqual(fallbacks, []); assert.equal(adapter.reserved, amount); assert.equal(adapter.budget.run.reserved, amount);
      assert.equal(adapter.budget.tasks.get('task').reserved, amount); assert.equal(adapter.pendingRequests, 0);
      const before = localState(adapter);
      await assert.rejects(consume(adapter), error => error.code === 'BUDGET_CONTEXT_LIMIT');
      assert.deepEqual(localState(adapter), before); assert.equal(local.requests.length, 1); assert.equal(receipts.length, 1);
    } finally { await local.close(); }
  }
});

test('invalid, incomplete, unapproved and nonempty reasoning outputs settle actual usage but yield no executable calls', async () => {
  const cases = [
    [output([{ ...callOutput()[0], arguments: '{"partial":' }]), 'INVALID_RESPONSE'],
    [{ ...output(callOutput()), status: 'incomplete' }, 'INCOMPLETE_RESPONSE'],
    [output([{ ...callOutput()[0], status: 'in_progress' }]), 'INCOMPLETE_RESPONSE'],
    [output([{ ...callOutput()[0], name: 'unauthorized_command' }]), 'INVALID_RESPONSE'],
    [output([{ type: 'reasoning', id: 'opaque', encrypted_content: 'nonempty', summary: [] }, ...callOutput()]), 'UNSUPPORTED_REASONING'],
  ];
  for (const [payload, code] of cases) {
    const local = await fixture(() => ({ payload })), failures = [], usages = [], blocks = [];
    try {
      const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, beforeRequest: async () => {},
        onCallError: event => failures.push(event), onUsage: event => usages.push(event) });
      await assert.rejects(async () => { for await (const event of adapter.stream(options)) if (event.type === 'block-end') blocks.push(event.block); }, error => error.code === code);
      assert.equal(local.requests.length, 1); assert.equal(usages.length, 1); assert.deepEqual(failures, []); assert.deepEqual(blocks, []);
      assert.equal(adapter.spent, (100 * .125 + 30 * .5) / 1e6);
    } finally { await local.close(); }
  }
});

test('reasoning policy refusal and malformed native history occur before any durable receipt or HTTP request', async () => {
  const local = await fixture(() => ({ payload: output(callOutput()) }));
  try {
    for (const request of [...['low', 'high', '', null, false].map(reasoningEffort => ({ ...options, reasoningEffort })),
      { ...options, messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'state cannot be replayed' }, { type: 'text', text: 'answer' }] }] }]) {
      const receipts = [], adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, beforeRequest: async event => receipts.push(event) });
      await assert.rejects(consume(adapter, request), error => error.code === 'UNSUPPORTED_REASONING');
      assert.deepEqual(receipts, []); assert.equal(adapter.calls, 0);
    }
    for (const messages of [undefined, [null], [{ role: 'user', content: [null] }], [{ role: 'user', content: [{ type: 'text', text: 42 }] }]]) {
      const receipts = [], adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, beforeRequest: async event => receipts.push(event) });
      await assert.rejects(consume(adapter, { ...options, messages }), error => error.code === 'INVALID_COMPLETION_HISTORY');
      assert.deepEqual(receipts, []); assert.equal(adapter.calls, 0); assert.equal(adapter.reserved, 0);
    }
    assert.equal(local.requests.length, 0);
  } finally { await local.close(); }
});

test('legacy Chat route keeps its endpoint and body despite a Responses-named wire model', async () => {
  const local = await fixture(request => {
    assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.body.max_tokens, 3000);
    assert.ok(Array.isArray(request.body.messages)); assert.equal(request.body.input, undefined);
    return { payload: { choices: [{ message: { content: 'legacy done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } } };
  });
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...local.route, protocol: undefined }], maxBudget: 1 });
    assert.equal(adapter.prepareRequest(options).path, '/chat/completions');
    const events = await consume(adapter); assert.deepEqual(completedBlocks(events), [{ type: 'text', text: 'legacy done' }]);
    assert.equal(local.requests.length, 1);
  } finally { await local.close(); }
});

test('multiple tool rounds replay every text, parallel call and full file/knowledge result with stable call IDs', async () => {
  const file = JSON.stringify({ path: 'server.mjs', sha256: 'c'.repeat(64), content: '完整来源\n'.repeat(200) });
  const knowledge = JSON.stringify({ documentId: 'rules', version: 7, sha256: 'd'.repeat(64), content: '固定知识原文\n'.repeat(150) });
  const calls = [callOutput()[0], { type: 'function_call', id: 'fc-kb-item', call_id: 'call-kb', status: 'completed', name: 'knowledge_read', arguments: '{"documentId":"rules","version":7}' }];
  const nextCall = { ...callOutput()[0], id: 'fc-verify-item', call_id: 'call-verify', arguments: '{"path":"verified.txt"}' };
  const expected = [
    { role: 'system', content: options.system }, { role: 'user', content: 'read the pinned source' },
    { role: 'assistant', content: 'Reading both pinned sources.' },
    { type: 'function_call', call_id: 'call-native-operation', name: 'filesystem', arguments: '{"path":"server.mjs"}' },
    { type: 'function_call', call_id: 'call-kb', name: 'knowledge_read', arguments: '{"documentId":"rules","version":7}' },
    { type: 'function_call_output', call_id: 'call-native-operation', output: file },
    { type: 'function_call_output', call_id: 'call-kb', output: knowledge },
  ];
  const local = await fixture((request, count) => {
    assert.equal(request.path, '/v1/responses'); assert.equal(request.body.store, false);
    assert.equal(request.body.previous_response_id, undefined); assert.equal(request.body.conversation, undefined);
    if (count === 1) return { payload: output([...textOutput('Reading both pinned sources.'), ...calls]) };
    assert.deepEqual(request.body.input, count === 2 ? expected : [...expected,
      { type: 'function_call', call_id: 'call-verify', name: 'filesystem', arguments: '{"path":"verified.txt"}' },
      { type: 'function_call_output', call_id: 'call-verify', output: '{"verified":true}' }]);
    return { payload: output(count === 2 ? [nextCall] : textOutput('All pinned sources verified.')) };
  });
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 });
    const request = { ...options, tools: [...options.tools, { name: 'knowledge_read', description: 'Read the fixed knowledge version', parameters: { type: 'object', properties: { documentId: { type: 'string' }, version: { type: 'integer' } }, required: ['documentId', 'version'] } }] };
    const first = completedBlocks(await consume(adapter, request));
    const result = (id, content) => ({ role: 'tool', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: content }] }] });
    const history = [...request.messages, { role: 'assistant', content: first }, result('call-native-operation', file), result('call-kb', knowledge)];
    const second = completedBlocks(await consume(adapter, { ...request, messages: history }));
    assert.deepEqual(second, [{ type: 'tool-call', id: 'call-verify', name: 'filesystem', arguments: '{"path":"verified.txt"}' }]);
    assert.deepEqual(completedBlocks(await consume(adapter, { ...request, messages: [...history, { role: 'assistant', content: second }, result('call-verify', '{"verified":true}')] })), [{ type: 'text', text: 'All pinned sources verified.' }]);
    assert.equal(local.requests.length, 3); assert.equal(adapter.calls, 3); assert.equal(adapter.reserved, 0);
    for (const entry of local.requests) assert.equal(entry.wireBytes, Buffer.byteLength(JSON.stringify(entry.body)));
  } finally { await local.close(); }
});

test('unknown dispatched fees stay held even without durable callbacks or when success JSON is malformed', async () => {
  for (const response of [{ payload: { status: 'completed', output: callOutput() } }, { rawBody: '{"partial":' }]) {
    const local = await fixture(() => response);
    try {
      const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 });
      const prepared = adapter.prepareRequest(options);
      await assert.rejects(consume(adapter), error => error.code === (response.rawBody ? 'INVALID_RESPONSE' : 'USAGE_MISSING'));
      assert.equal(adapter.reserved, prepared.reservation); assert.equal(adapter.budget.run.reserved, prepared.reservation);
      assert.equal(adapter.spent, 0); assert.equal(local.requests.length, 1);
    } finally { await local.close(); }
  }
});

test('metadata, usage or unknown-fee persistence failures retain the sent hold and never yield executable output', async () => {
  for (const phase of ['metadata', 'usage', 'unknown-fee']) {
    const local = await fixture(() => ({ payload: phase === 'unknown-fee' ? { status: 'completed', output: callOutput() } : output(callOutput()) }));
    const receipts = [], failures = [], blocks = [];
    try {
      const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, beforeRequest: async event => receipts.push(event),
        onResponse: async () => { if (phase === 'metadata') throw Error('synthetic metadata storage failure'); },
        onUsage: async () => { if (phase === 'usage') throw Error('synthetic fee storage failure'); },
        onCallError: async event => { failures.push(event); if (phase === 'unknown-fee') throw Error('synthetic unknown-fee storage failure'); } });
      await assert.rejects(async () => { for await (const event of adapter.stream(options)) if (event.type === 'block-end') blocks.push(event.block); }, error => error.code === 'BILLING_PERSISTENCE_FAILED');
      assert.equal(local.requests.length, 1); assert.equal(receipts.length, 1); assert.equal(failures.length, 1);
      assert.equal(failures[0].id, receipts[0].id); assert.equal(failures[0].dispatched, true);
      assert.equal(adapter.reserved, receipts[0].reservation); assert.equal(adapter.budget.run.reserved, receipts[0].reservation);
      assert.equal(adapter.spent, 0); assert.deepEqual(blocks, []);
    } finally { await local.close(); }
  }
});

test('the run/task reservation remains held while known usage persists, then settles before invalid output is rejected', async () => {
  const local = await fixture(() => ({ payload: output([{ ...callOutput()[0], arguments: '{"partial":' }]) }));
  let releaseUsage, usageStarted;
  const entered = new Promise(resolve => { usageStarted = resolve; });
  const saving = new Promise(resolve => { releaseUsage = resolve; });
  const receipts = [], usages = [], blocks = [];
  try {
    const amount = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1 }).prepareRequest(options).reservation;
    const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: amount * 1.5, tasks: [{ id: 'task', assigneeId: 'employee', maxBudget: amount * 1.5 }],
      beforeRequest: async event => receipts.push(event), onUsage: async event => { usages.push(event); usageStarted(); await saving; } });
    adapter.attribution = () => ({ sessionId: options.sessionId, taskId: 'task', employeeId: 'employee' });
    const running = assert.rejects(async () => { for await (const event of adapter.stream(options)) if (event.type === 'block-end') blocks.push(event.block); }, error => error.code === 'INVALID_RESPONSE');
    await entered;
    assert.equal(adapter.reserved, amount); assert.equal(adapter.budget.run.reserved, amount); assert.equal(adapter.budget.tasks.get('task').reserved, amount);
    assert.equal(adapter.spent, 0); assert.deepEqual(blocks, []);
    assert.throws(() => adapter.prepareRequest(options), error => error.code === 'BUDGET_CONTEXT_LIMIT');
    releaseUsage(); await running;
    assert.equal(usages.length, 1); assert.equal(usages[0].id, receipts[0].id); assert.equal(local.requests.length, 1);
    assert.equal(adapter.spent, (100 * .125 + 30 * .5) / 1e6); assert.equal(adapter.budget.tasks.get('task').spent, adapter.spent);
    assert.equal(adapter.reserved, 0); assert.equal(adapter.budget.run.reserved, 0); assert.equal(adapter.budget.tasks.get('task').reserved, 0); assert.deepEqual(blocks, []);
  } finally { releaseUsage(); await local.close(); }
});

test('a cancellation before dispatch releases the local hold, while cancellation after headers retains it', async () => {
  for (const phase of ['admission', 'headers']) {
    const local = await fixture(() => ({ payload: output(callOutput()) })), controller = new AbortController(), receipts = [], failures = [], usages = [];
    try {
      const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1, signal: controller.signal,
        beforeRequest: async event => { receipts.push(event); if (phase === 'admission') controller.abort(Error('approved synthetic stop')); },
        onResponse: async () => { if (phase === 'headers') controller.abort(Error('approved synthetic stop')); },
        onCallError: event => failures.push(event), onUsage: event => usages.push(event) });
      await assert.rejects(consume(adapter), /approved synthetic stop/);
      assert.equal(local.requests.length, phase === 'admission' ? 0 : 1); assert.equal(receipts.length, 1); assert.equal(failures.length, 1);
      assert.equal(failures[0].dispatched, phase === 'headers'); assert.deepEqual(usages, []);
      assert.equal(adapter.reserved, phase === 'admission' ? 0 : receipts[0].reservation);
      assert.equal(adapter.budget.run.reserved, adapter.reserved); assert.equal(adapter.pendingRequests, 0);
    } finally { await local.close(); }
  }
});

test('Go identity is stable across previews and requires a local session before reservation; unrelated routes receive no Go identity', async () => {
  const goRoute = { ...route, baseUrl: 'https://opencode.ai/zen/go/v1' };
  const adapter = new OpenAiCompatibleAdapter({ routes: [goRoute], maxBudget: 1 });
  const first = adapter.prepareRequest(options), second = adapter.prepareRequest({ ...options, messages: [...options.messages, { role: 'assistant', content: [{ type: 'text', text: 'known previous answer' }] }, { role: 'user', content: [{ type: 'text', text: 'continue the same session' }] }] });
  assert.deepEqual(first.headers, second.headers); assert.equal(first.headers['User-Agent'], 'AgentDepartment/0.2.0');
  assert.match(first.headers['x-opencode-session'], /^agent-department-[a-f0-9]{64}$/); assert.ok(!JSON.stringify(first.headers).includes(options.sessionId));
  const before = localState(adapter);
  await assert.rejects(consume(adapter, { ...options, sessionId: undefined }), error => error.code === 'SESSION_REQUIRED');
  assert.deepEqual(localState(adapter), before);
  assert.deepEqual(new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1 }).prepareRequest(options).headers, {});
});

test('an internal stop settles only the late original Responses receipt and never executes its tool call or sends another request', async () => {
  let sendResponse, arrived;
  const gate = new Promise(resolve => { sendResponse = resolve; });
  const observed = new Promise(resolve => { arrived = resolve; });
  const local = await fixture(async () => { arrived(); await gate; return { payload: output(callOutput()) }; });
  const receipts = [], usages = [], failures = [], blocks = [];
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [local.route], maxBudget: 1,
      beforeRequest: async event => receipts.push(event), onUsage: event => usages.push(event), onCallError: event => failures.push(event) });
    const stop = Object.assign(Error('NO_PROGRESS: synthetic internal stop'), { code: 'NO_PROGRESS' });
    const running = assert.rejects(async () => { for await (const event of adapter.stream(options)) if (event.type === 'block-end') blocks.push(event.block); }, error => error === stop);
    await observed;
    adapter.stopAdmission(stop); const settled = adapter.drain(1000);
    await assert.rejects(consume(adapter), error => error === stop); assert.equal(local.requests.length, 1);
    sendResponse(); await running;
    assert.deepEqual(await settled, { pendingRequests: 0, finishedRequests: 1, timedOut: false, aborted: false });
    assert.equal(usages.length, 1); assert.equal(usages[0].id, receipts[0].id); assert.equal(usages[0].cost, (100 * .125 + 30 * .5) / 1e6);
    assert.equal(adapter.reserved, 0); assert.deepEqual(failures, []); assert.deepEqual(blocks, []); assert.equal(local.requests.length, 1);
  } finally { sendResponse(); await local.close(); }
});
