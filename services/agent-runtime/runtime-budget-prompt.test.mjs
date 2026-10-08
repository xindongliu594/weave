import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleAdapter } from './openai-compatible.mjs';

const route = { id: 'fixture', name: 'fixture', wireModel: 'fixture', baseUrl: 'https://fixture.invalid/v1', inputRate: 2, outputRate: 10, maxOutputTokens: 10 };
const text = content => ({ role: 'user', content: [{ type: 'text', text: content }] });
const context = content => ({ ...text(content), source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot',
  sections: [{ name: 'department:approved-context', text: content }] } });
const consume = async (adapter, messages) => { for await (const _ of adapter.stream({ model: route.id, system: '批准岗位', messages })) {} };

test('latest host-owned contract and budget survive fitting after a later ordinary user message', async () => {
  const original = globalThis.fetch, bodies = [], events = [];
  const current = JSON.stringify({ task: { id: 'qa', objective: '真正独立测试', inputs: [{ path: 'server.mjs', sha256: 'a'.repeat(64) }] },
    recovery: { completed: ['dev'] }, budget: { available: .007, callsRemaining: 17 } });
  const messages = [context('已过期预算与合同'.repeat(1000)), context(current), text('继续核对')], before = structuredClone(messages);
  globalThis.fetch = async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return Response.json({ choices: [{ message: { content: 'local fixture' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: .007, onContext: event => events.push(event) });
    await consume(adapter, messages);
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].messages.some(message => message.content === current));
    assert.ok(!bodies[0].messages.some(message => message.content.includes('已过期预算与合同')));
    assert.ok(events[0].removedGroups > 0);
    assert.deepEqual(messages, before, 'full session evidence stays intact');
  } finally { globalThis.fetch = original; }
});

test('an unaffordable current contract is blocked before receipt, fetch, or budget counters instead of dropping it', async () => {
  const original = globalThis.fetch; let fetches = 0, receipts = 0;
  globalThis.fetch = async () => { fetches++; throw Error('must not fetch'); };
  try {
    const adapter = new OpenAiCompatibleAdapter({ routes: [route], maxBudget: .007, beforeRequest: async () => { receipts++; } });
    await assert.rejects(consume(adapter, [context('最新批准合同必须保留'.repeat(1000)), text('继续')]), error => error.code === 'BUDGET_CONTEXT_LIMIT');
    assert.equal(fetches, 0); assert.equal(receipts, 0); assert.equal(adapter.budget.run.calls, 0); assert.equal(adapter.budget.run.reserved, 0);
  } finally { globalThis.fetch = original; }
});
