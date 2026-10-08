import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSchema } from '../packages/contracts/index.ts';

const task = { id: 'test_task', subject: '本地验证', objective: '完成原任务', assigneeId: 'member', dependencies: [],
  acceptanceCriteria: ['真实输出'], estimatedInputTokens: 100000, estimatedOutputTokens: 50000 };

test('task schema preserves legacy cumulative estimates and accepts only an explicit bounded integer per-call output cap', () => {
  const old = taskSchema.parse(task);
  assert.equal(Object.hasOwn(old, 'maxOutputTokens'), false);
  assert.equal(old.estimatedOutputTokens, 50000);
  for (const maxOutputTokens of [1, 800, 32768]) {
    const current = taskSchema.parse({ ...task, maxOutputTokens });
    assert.equal(current.maxOutputTokens, maxOutputTokens);
    assert.equal(current.estimatedOutputTokens, 50000);
  }
  for (const maxOutputTokens of [null, 0, -1, 1.5, '800', NaN, Infinity, 32769])
    assert.equal(taskSchema.safeParse({ ...task, maxOutputTokens }).success, false);
});
