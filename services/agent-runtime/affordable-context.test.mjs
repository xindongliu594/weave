import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fitAffordableMessages } from './limits.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const tools = [{ type: 'function', function: { name: 'filesystem', description: '读取批准工作文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const options = { maxBytes: 192000, inputRate: 2, outputRate: 10, maxTokens: 1400, availableBudget: .08 };
const sha = value => createHash('sha256').update(value).digest('hex');

test('affordable fitting drops old complete groups while retaining the canonical contract and latest knowledge result intact', () => {
  const approved = { requirement: '完整已批准需求。'.repeat(900), task: { id: 'qa', objective: '独立测试当前文件', inputs: [{ path: 'server.mjs', sha256: 'a'.repeat(64) }] }, fixedKnowledge: [{ documentId: 'doc', version: 7, sha256: 'b'.repeat(64) }] };
  const knowledge = [{ documentId: 'doc', version: 7, sha256: 'b'.repeat(64), content: '已授权且固定版本的测试资料' }];
  const messages = [{ role: 'system', content: JSON.stringify(approved) }, { role: 'user', content: '旧重复说明'.repeat(10000) },
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'claim', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: '旧领取合同'.repeat(6000) }, { role: 'user', content: '继续独立验证本次批准任务。' },
    { role: 'assistant', tool_calls: [{ id: 'latest', type: 'function', function: { name: 'knowledge_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'latest', content: JSON.stringify(knowledge) }];
  const before = structuredClone(messages), result = fitAffordableMessages(messages, tools, options, [6]);
  assert.ok(result.removed > 0);
  for (const index of [0, 4, 5, 6]) assert.ok(result.messages.includes(messages[index]));
  assert.equal(result.messages.some(message => message.tool_call_id === 'old'), false);
  assert.equal(result.messages.some(message => message.tool_calls?.some(call => call.id === 'old')), false);
  assert.deepEqual(JSON.parse(result.messages[0].content), approved);
  assert.deepEqual(JSON.parse(result.messages.at(-1).content), knowledge);
  assert.deepEqual(messages, before);
  assert.equal(result.beforeBytes, bytes({ messages, tools }));
  assert.equal(result.afterBytes, bytes({ messages: result.messages, tools }));
  assert.equal(result.inputUpperBound, result.afterBytes + 1024);
  assert.equal(result.reservation, (result.inputUpperBound * 2 + 1400 * 10) / 1e6);
  assert.ok(result.reservation <= options.availableBudget);
});

test('every protected full file read and its assistant call survive even when a later user message exists', () => {
  const content = 'export const value = "完整文件🧪";\n'.repeat(100);
  const file = { path: 'server.mjs', sha256: sha(content), content };
  const messages = [{ role: 'system', content: '当前合同与固定资料版本' }, { role: 'user', content: '过期历史'.repeat(30000) },
    { role: 'assistant', tool_calls: [{ id: 'file', type: 'function', function: { name: 'filesystem', arguments: '{"path":"server.mjs"}' } }] },
    { role: 'tool', tool_call_id: 'file', content: JSON.stringify(file) }, { role: 'user', content: '请依据完整文件进行验证' }];
  const result = fitAffordableMessages(messages, tools, { ...options, availableBudget: .04 }, [3]);
  assert.deepEqual(result.messages, [messages[0], messages[2], messages[3], messages[4]]);
  const read = JSON.parse(result.messages[2].content);
  assert.deepEqual(read, file);
  assert.equal(sha(read.content), read.sha256);
});

test('an unaffordable protected file and pinned knowledge fail without truncating or silently dropping the evidence', () => {
  const content = '文件原文不可截断'.repeat(5000), file = { path: 'server.mjs', sha256: sha(content), content };
  const messages = [{ role: 'system', content: JSON.stringify({ fixedKnowledge: [{ documentId: 'doc', version: 7, sha256: 'c'.repeat(64) }] }) },
    { role: 'assistant', tool_calls: [{ id: 'file', type: 'function', function: { name: 'filesystem', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'file', content: JSON.stringify(file) }, { role: 'user', content: '继续' }];
  const before = structuredClone(messages);
  assert.throws(() => fitAffordableMessages(messages, tools, options, [2]), error => error.code === 'BUDGET_CONTEXT_LIMIT' && !error.message.includes(content));
  assert.deepEqual(messages, before);
  assert.equal(sha(JSON.parse(messages[2].content).content), file.sha256);
});

test('an earlier protected source contract cannot be sacrificed for a cheaper request', () => {
  const contract = { requirement: '不可删除的批准原始范围'.repeat(3000), version: 5, inputs: [{ path: 'server.mjs', sha256: 'd'.repeat(64) }] };
  const messages = [{ role: 'system', content: '岗位说明' }, { role: 'user', content: JSON.stringify(contract) },
    { role: 'assistant', content: '较早工作记录' }, { role: 'user', content: '当前请求' }];
  const before = structuredClone(messages);
  assert.throws(() => fitAffordableMessages(messages, tools, options, [1]), { code: 'BUDGET_CONTEXT_LIMIT' });
  assert.deepEqual(messages, before);
  assert.deepEqual(JSON.parse(messages[1].content), contract);
});

test('tools undefined and an empty tools array keep their actual distinct envelope and original output reservation', () => {
  const messages = [{ role: 'system', content: 'Contract' }, { role: 'user', content: 'Task' }];
  for (const schema of [undefined, []]) {
    const result = fitAffordableMessages(messages, schema, { ...options, availableBudget: 1 });
    assert.equal(result.removed, 0);
    assert.equal(result.afterBytes, bytes({ messages, tools: schema }));
    assert.equal(result.reservation, ((result.afterBytes + 1024) * 2 + 1400 * 10) / 1e6);
  }
  assert.notEqual(fitAffordableMessages(messages, undefined, options).afterBytes, fitAffordableMessages(messages, [], options).afterBytes);
});

test('the exact UTF-8 byte boundary is enforced and output-only excess cannot be solved by dropping instructions', () => {
  const messages = [{ role: 'system', content: '中文和emoji🧪'.repeat(15) }, { role: 'user', content: '任务' }];
  const exact = ((bytes({ messages, tools }) + 1024) * 2 + 1400 * 10) / 1e6;
  const result = fitAffordableMessages(messages, tools, { ...options, availableBudget: exact });
  assert.equal(result.reservation, exact);
  assert.equal(result.removed, 0);
  assert.throws(() => fitAffordableMessages(messages, tools, { ...options, availableBudget: exact - 2 / 1e6 }), { code: 'BUDGET_CONTEXT_LIMIT' });
  assert.throws(() => fitAffordableMessages(messages, tools, { ...options, inputRate: 0, availableBudget: .013 }), { code: 'BUDGET_CONTEXT_LIMIT' });
  const zeroInput = fitAffordableMessages(messages, tools, { ...options, inputRate: 0, availableBudget: .014 });
  assert.equal(zeroInput.reservation, .014);
  assert.deepEqual(zeroInput.messages, messages);
});

test('invalid finance values and invalid protected indexes reject rather than bypassing a guard', () => {
  const messages = [{ role: 'system', content: 'Contract' }];
  for (const patch of [{ inputRate: NaN }, { outputRate: -1 }, { availableBudget: Infinity }, { maxTokens: 0 }, { maxBytes: 0 }])
    assert.throws(() => fitAffordableMessages(messages, tools, { ...options, ...patch }), { code: 'INVALID_BUDGET_CONTEXT' });
  assert.throws(() => fitAffordableMessages(messages, tools, options, [2]), { code: 'INVALID_BUDGET_CONTEXT' });
});

test('the original byte guard and the financial guard have independent accurate failure codes', () => {
  const messages = [{ role: 'system', content: 'x'.repeat(220) }, { role: 'user', content: 'Approved current task' }];
  const before = structuredClone(messages);
  assert.throws(() => fitAffordableMessages(messages, undefined, { ...options, maxBytes: 100, availableBudget: 1 }), error => {
    assert.equal(error.code, 'CONTEXT_LIMIT'); assert.ok(error.message.startsWith('CONTEXT_LIMIT:')); return true;
  });
  assert.throws(() => fitAffordableMessages(messages, undefined, { ...options, maxBytes: 10000, availableBudget: .014 }), error => {
    assert.equal(error.code, 'BUDGET_CONTEXT_LIMIT'); assert.equal(error.details.availableBudget, .014); return true;
  });
  assert.deepEqual(messages, before);
});
