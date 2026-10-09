import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCompletionGuidance } from './host.mjs';

test('review and requirements have a compact native completion guide while all contracts remain unchanged', () => {
 for (const kind of ['review', 'requirements']) {
  const contract = { id: 'review', kind, outputs: [], acceptanceCriteria: ['first', 'second'], maxOutputTokens: 2048, verify: [], reviewedTaskId: 'dev' };
  const original = structuredClone(contract), guide = reviewCompletionGuidance(contract, 1024);
  assert.match(guide, /1024 Token/); assert.match(guide, /600中文字/); assert.match(guide, /全部验收/);
  for (const field of ['agent_teams_update_task', 'runtimeTaskId', 'attemptId', 'status=completed', 'verdict=pass', 'status=failed', 'findings', 'requiredFix', 'acceptanceResults', 'commandsRun']) assert.ok(guide.includes(field));
  assert.match(guide, /outputs为空时保持只读/); assert.match(guide, /普通最终文字、send_message均不能完成节点/);
  assert.doesNotMatch(guide, /submit_review|自动重试/); assert.deepEqual(contract, original);
 }
});
test('the guide invents no numeric output cap and unrelated task kinds receive no review instructions', () => {
 for (const outputLimit of [undefined, 0, NaN, -1]) assert.match(reviewCompletionGuidance({ kind: 'review' }, outputLimit), /本次请求已批准的 Token 上限/);
 for (const kind of ['work', 'implementation', 'verification', 'repair', 'integration']) assert.equal(reviewCompletionGuidance({ kind }, 2048), undefined);
});
