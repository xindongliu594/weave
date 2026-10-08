import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completionRequest, completionResponse, completionUsage, conversationHeaders } from './completion-protocol.mjs';

const body = { model: 'fixture-luna', stream: false, max_tokens: 3000, messages: [{ role: 'system', content: 'approved scope' }, { role: 'user', content: 'perform task' }] };
const tool = { type: 'function', function: { name: 'filesystem', description: 'permission-pinned file reads', parameters: {
  type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string' } }, required: ['path'], additionalProperties: false } } };
const response = output => ({ id: 'resp-fixture', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20,
  input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } });

test('legacy Chat request and response are returned unchanged, with no protocol inference from the model name', () => {
  const chat = { ...body, reasoning_effort: 'high', stop: ['END'], unknownLegacyOption: true }, payload = { legacy: true };
  for (const protocol of [undefined, 'chat-completions']) {
    assert.equal(completionRequest(protocol, chat).path, '/chat/completions');
    assert.equal(completionRequest(protocol, chat).body, chat);
    assert.equal(completionResponse(protocol, payload), payload);
  }
  assert.throws(() => completionRequest('auto', body), error => error.code === 'INVALID_COMPLETION_PROTOCOL');
});

test('stateless Responses maps the complete multi-function history using call_id and preserves full file/knowledge JSON', () => {
  const file = JSON.stringify({ path: 'server.mjs', sha256: 'f'.repeat(64), content: '完整文件\nconst x = 1;' });
  const knowledge = JSON.stringify({ documentId: 'rules', version: 2, sha256: 'a'.repeat(64), content: '固定版本原文' });
  const chat = { ...body, tools: [tool], messages: [...body.messages,
    { role: 'assistant', content: 'read fixed sources', tool_calls: [
      { id: 'call-file', type: 'function', function: { name: 'filesystem', arguments: '{"path":"server.mjs"}' } },
      { id: 'call-kb', type: 'function', function: { name: 'knowledge_read', arguments: '{"documentId":"rules","version":2}' } },
    ] }, { role: 'tool', tool_call_id: 'call-file', content: file }, { role: 'tool', tool_call_id: 'call-kb', content: knowledge },
    { role: 'user', content: 'verify both sources' }] };
  const original = structuredClone(chat), wire = completionRequest('responses', chat);
  assert.equal(wire.path, '/responses');
  assert.deepEqual(wire.body.input, [
    { role: 'system', content: 'approved scope' }, { role: 'user', content: 'perform task' }, { role: 'assistant', content: 'read fixed sources' },
    { type: 'function_call', call_id: 'call-file', name: 'filesystem', arguments: '{"path":"server.mjs"}' },
    { type: 'function_call', call_id: 'call-kb', name: 'knowledge_read', arguments: '{"documentId":"rules","version":2}' },
    { type: 'function_call_output', call_id: 'call-file', output: file }, { type: 'function_call_output', call_id: 'call-kb', output: knowledge },
    { role: 'user', content: 'verify both sources' },
  ]);
  assert.equal(wire.body.max_output_tokens, 3000); assert.equal(wire.body.store, false); assert.equal(wire.body.stream, false);
  assert.deepEqual(wire.body.reasoning, { effort: 'none' });
  assert.equal(wire.body.previous_response_id, undefined); assert.equal(wire.body.conversation, undefined);
  assert.deepEqual(wire.body.tools[0], { type: 'function', name: 'filesystem', description: tool.function.description, parameters: tool.function.parameters, strict: false });
  wire.body.tools[0].parameters.required.push('expectedSha256');
  assert.deepEqual(chat, original, 'conversion does not mutate or strict-normalize the permission schema');
});

test('tool choice and JSON text format are explicit while unsupported options, built-ins and multimodal input fail', () => {
  const wire = completionRequest('responses', { ...body, tools: [tool], tool_choice: { type: 'function', function: { name: 'filesystem' } },
    parallel_tool_calls: false, response_format: { type: 'json_object' }, temperature: .2 });
  assert.deepEqual(wire.body.tool_choice, { type: 'function', name: 'filesystem' });
  assert.deepEqual(wire.body.text, { format: { type: 'json_object' } });
  assert.equal(wire.body.parallel_tool_calls, false); assert.equal(wire.body.temperature, .2);
  for (const choice of ['none', 'required', 'auto']) assert.equal(completionRequest('responses', { ...body, tool_choice: choice }).body.tool_choice, choice);
  for (const extra of [{ stop: ['END'] }, { stream: true }, { seed: 42 }, { tools: [{ type: 'web_search' }] }, { response_format: { type: 'json_schema' } }])
    assert.throws(() => completionRequest('responses', { ...body, ...extra }), error => error.code === 'UNSUPPORTED_COMPLETION_OPTION');
  assert.throws(() => completionRequest('responses', { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'unused' }] }] }), error => error.code === 'INVALID_COMPLETION_HISTORY');
});

test('non-none or historical reasoning is never silently converted into plain text', () => {
  for (const extra of [{ reasoning_effort: 'low' }, { reasoning_effort: null }, { reasoning_effort: '' }, { reasoning: { effort: null } }, { reasoning: { effort: 'high' } }, { reasoning: { effort: 'none', summary: 'auto' } },
    { messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'private reasoning' }] }])
    assert.throws(() => completionRequest('responses', { ...body, ...extra }), error => error.code === 'UNSUPPORTED_REASONING');
  assert.deepEqual(completionRequest('responses', { ...body, reasoning_effort: 'none' }).body.reasoning, { effort: 'none' });
});

test('malformed, duplicated or unfinished historical calls fail locally rather than replaying external operations', () => {
  const call = { id: 'call-id', type: 'function', function: { name: 'filesystem', arguments: '{}' } };
  for (const messages of [
    [{ role: 'tool', tool_call_id: 'orphan', content: '{}' }],
    [{ role: 'assistant', content: null, tool_calls: [call] }],
    [{ role: 'assistant', content: null, tool_calls: [call, call] }],
    [{ role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'filesystem', arguments: '{' } }] }],
    [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'call-id', content: '{}' }, { role: 'tool', tool_call_id: 'call-id', content: '{}' }],
  ]) assert.throws(() => completionRequest('responses', { ...body, messages }), error => error.code === 'INVALID_COMPLETION_HISTORY');
});

test('Responses uses call_id rather than output-item id, preserving cached and reasoning usage within total tokens', () => {
  const payload = response([{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] },
    { type: 'function_call', id: 'fc-item-id', call_id: 'call-execution-id', status: 'completed', name: 'filesystem', arguments: '{"path":"README.md"}' }]);
  payload.usage.output_tokens_details.reasoning_tokens = 5;
  const chat = completionResponse('responses', payload);
  assert.equal(chat.choices[0].message.content, 'ready');
  assert.deepEqual(chat.choices[0].message.tool_calls, [{ id: 'call-execution-id', type: 'function', function: { name: 'filesystem', arguments: '{"path":"README.md"}' } }]);
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chat.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 5 } });
});

test('incomplete or invalid function output is rejected after usage remains independently readable', () => {
  const call = { type: 'function_call', status: 'completed', call_id: 'call', name: 'filesystem', arguments: '{}' };
  for (const payload of [
    { ...response([call]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    response([{ ...call, status: 'in_progress' }]), response([{ ...call, arguments: '{"partial":' }]),
    response([{ ...call, call_id: '' }]), response([call, call]), response([{ type: 'web_search_call', status: 'completed' }]),
  ]) {
    assert.equal(completionUsage('responses', payload).prompt_tokens, 100);
    assert.throws(() => completionResponse('responses', payload), error => ['INVALID_RESPONSE', 'INCOMPLETE_RESPONSE'].includes(error.code));
  }
});

test('only a provably empty none-effort reasoning container is accepted; encrypted or unknown state is rejected', () => {
  const empty = { type: 'reasoning', id: 'empty', summary: [] }, message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
  assert.equal(completionResponse('responses', response([empty, message])).choices[0].message.content, 'done');
  for (const item of [{ ...empty, encrypted_content: 'opaque-cipher' }, { ...empty, summary: [{ type: 'summary_text', text: 'summary' }] }, { ...empty, custom_state: 'unknown' }])
    assert.throws(() => completionResponse('responses', response([item, message])), error => error.code === 'UNSUPPORTED_REASONING');
  const unknown = response([empty, message]); delete unknown.usage.output_tokens_details;
  assert.throws(() => completionResponse('responses', unknown), error => error.code === 'UNSUPPORTED_REASONING');
  const nonzero = response([empty, message]); nonzero.usage.output_tokens_details.reasoning_tokens = 1;
  assert.throws(() => completionResponse('responses', nonzero), error => error.code === 'UNSUPPORTED_REASONING');
});

test('Go headers use this product and hashed stable conversation ID, without spoofing or leaking IDs to unrelated URLs', () => {
  const session = 'local-project/version/private-id', first = conversationHeaders('https://opencode.ai/zen/go/v1', session);
  assert.equal(first['User-Agent'], 'AgentDepartment/0.2.0');
  assert.equal(first['x-opencode-session'], 'agent-department-' + createHash('sha256').update(session).digest('hex'));
  assert.deepEqual(first, conversationHeaders('https://opencode.ai/zen/go/v1/', session));
  assert.notEqual(first['x-opencode-session'], conversationHeaders('https://opencode.ai/zen/go/v1', 'other')['x-opencode-session']);
  assert.ok(!JSON.stringify(first).includes(session));
  for (const url of ['https://relay.invalid/v1', 'http://opencode.ai/zen/go/v1', 'https://opencode.ai.evil.invalid/zen/go/v1',
    'https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1?key=unused', 'https://user@opencode.ai/zen/go/v1'])
    assert.deepEqual(conversationHeaders(url, session), {});
  assert.throws(() => conversationHeaders('https://opencode.ai/zen/go/v1'), error => error.code === 'SESSION_REQUIRED');
});
