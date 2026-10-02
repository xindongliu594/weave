import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

const route = { id: 'model-record', name: 'Relay model', wireModel: 'upstream-model', baseUrl: 'https://relay.invalid/v1', apiKey: 'not-a-real-key', inputRate: 1, outputRate: 2, maxOutputTokens: 1000 };
const message = { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the task' }] };

test('an abort during durable reservation never dispatches a request or reports an unknown sent call', async () => {
  const original = globalThis.fetch, controller = new AbortController(), failures = [], requests = [];
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw Error('must not send'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: 1, signal: controller.signal,
      beforeRequest: async () => { controller.abort(Error('approved deadline')); },
      onRequest: event => requests.push(event), onCallError: event => failures.push(event),
    });
    await assert.rejects(async () => { for await (const _ of adapter.stream({ model: route.id, messages: [message] })) {} }, /approved deadline/);
    assert.equal(fetched, false); assert.equal(requests.length, 0);
    assert.equal(failures.length, 1); assert.equal(failures[0].dispatched, false);
    assert.equal(adapter.reserved, 0);
  } finally { globalThis.fetch = original; }
});

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

test('fallback is explicit, bounded, attributed and never retries ambiguous network failures', async()=>{
 const original=globalThis.fetch, calls=[],usages=[],events=[];
 const fallback={...route,id:'backup',wireModel:'backup-wire'};
 const adapter=new OpenAiCompatibleAdapter({routes:[route,fallback],maxBudget:1,onUsage:u=>usages.push(u),onFallback:e=>events.push(e)});
 adapter.sessionPolicies.set('employee',{fallbackModelId:'backup',reasoningEffort:'low'});
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);return body.model===route.wireModel?new Response('',{status:429}):Response.json({choices:[{message:{content:'success'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}});};
 try{for await(const _ of adapter.stream({model:route.id,sessionId:'employee',messages:[message]})){}
  assert.equal(calls.length,2);assert.equal(calls[1].reasoning_effort,'low');assert.equal(usages[0].modelId,'backup');assert.equal(events.length,1);assert.equal(adapter.reserved,0);
  globalThis.fetch=async()=>{calls.push({});throw Error('Connection dropped');};
  await assert.rejects(async()=>{for await(const _ of adapter.stream({model:route.id,sessionId:'employee',messages:[message]})){}},e=>e.code==='CONNECTION_FAILED');assert.equal(calls.length,3);
 }finally{globalThis.fetch=original;}
});

test('summaries read every selected source message and refuse oversized input before dispatch', async () => {
  const original = globalThis.fetch, bodies = [], requests = [], usages = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: 'checkpoint' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...route, contextBytes: 4096 }], maxBudget: 1, onRequest: r => requests.push(r), onUsage: u => usages.push(u) });
    const history = [message, { ...message, id: 'old', role: 'assistant', content: [{ type: 'text', text: 'FULL_SOURCE ' + 'x'.repeat(5000) }] }, { ...message, id: 'directive', content: [{ type: 'text', text: 'Summarize all the history above' }] }];
    await assert.rejects(async () => { for await (const _ of adapter.stream({ model: route.id, sessionId: 'worker', messages: history, purpose: 'compaction' })) {} }, e => e.code === 'CONTEXT_LIMIT');
    assert.equal(bodies.length, 0);
    history[1].content[0].text = 'FULL_SOURCE ' + 'x'.repeat(1000);
    for await (const _ of adapter.stream({ model: route.id, sessionId: 'worker', messages: history, purpose: 'compaction' })) {}
    assert.equal(bodies[0].messages.length, history.length);
    assert.equal(bodies[0].messages[1].content, history[1].content[0].text);
    assert.equal(requests[0].requestPurpose, 'compaction');
    assert.equal(usages[0].requestPurpose, 'compaction');
    assert.equal(usages[0].sessionId, 'worker');
  } finally { globalThis.fetch = original; }
});

test('wire clipping protects the most recent durable checkpoint and rejects when protected context cannot fit', async () => {
  const original = globalThis.fetch, bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: 'continue' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [{ ...route, contextBytes: 4096 }], maxBudget: 1 });
    const checkpoint = { ...message, id: 'checkpoint', source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: 'APPROVED_CHECKPOINT ' + 's'.repeat(2000) }] };
    const latest = { ...message, id: 'latest', content: [{ type: 'text', text: 'CURRENT_TASK ' + 't'.repeat(1000) }] };
    const history = [{ ...message, content: [{ type: 'text', text: 'OLD_SOURCE ' + 'x'.repeat(3000) }] }, checkpoint, latest];
    for await (const _ of adapter.stream({ model: route.id, messages: history })) {}
    assert.ok(bodies[0].messages.some(m => m.content.startsWith('APPROVED_CHECKPOINT')));
    assert.ok(bodies[0].messages.some(m => m.content.startsWith('CURRENT_TASK')));
    assert.ok(!bodies[0].messages.some(m => m.content.startsWith('OLD_SOURCE')));
    latest.content[0].text += 't'.repeat(3000);
    await assert.rejects(async () => { for await (const _ of adapter.stream({ model: route.id, messages: history })) {} }, /CONTEXT_LIMIT/);
    assert.equal(bodies.length, 1);
  } finally { globalThis.fetch = original; }
});
