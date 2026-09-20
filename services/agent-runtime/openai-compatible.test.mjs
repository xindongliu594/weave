import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

const route = { id: 'model-record', name: 'Relay model', wireModel: 'upstream-model', baseUrl: 'https://relay.invalid/v1', apiKey: 'not-a-real-key', inputRate: 1, outputRate: 2, maxOutputTokens: 1000 };
const message = { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the task' }] };

test('OpenAI compatible adapter translates tool calls, usage, routing and authorization', async () => {
  const original = globalThis.fetch;
  const usages = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://relay.invalid/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer not-a-real-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'upstream-model');
    assert.equal(body.messages[0].content, 'Do the task');
    assert.equal(body.tools[0].function.name, 'complete_task');
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'complete_task', arguments: '{"ok":true}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, onUsage: usage => usages.push(usage) });
    const chunks = [];
    for await (const chunk of adapter.stream({ provider: 'department-relay', model: route.id, messages: [message], tools: [{ name: 'complete_task', description: 'Complete it', parameters: { type: 'object' } }] })) chunks.push(chunk);
    assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.name, 'complete_task');
    assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
    assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
    assert.equal(usages.length, 1);
    assert.equal(usages[0].modelId, route.id);
  } finally { globalThis.fetch = original; }
});

test('adapter refuses a request before fetch when its reservation exceeds the run budget', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...route, outputRate: 10000 }], maxBudget: 0.001 });
    await assert.rejects(async () => { for await (const _chunk of adapter.stream({ provider: 'department-relay', model: route.id, messages: [message] })) {} }, error => error.code === 'BUDGET_EXCEEDED');
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});
