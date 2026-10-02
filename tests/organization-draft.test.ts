import test from 'node:test';
import assert from 'node:assert/strict';
import { finishOrganizationReply, hasUnconfirmedOrganizationChanges, type ChatRequest, type Draft, type Preview } from '../apps/web/src/organization-draft.ts';

const policy = { maxBudget: 1, maxAgents: 3, maxConcurrentAgents: 2, deadlineSeconds: 300 };
const initial = (): Draft => ({ messages: [], modelId: 'model', policy, maxPlanningCost: .1, input: '' });
const preview = (id: string): Preview => ({
  previewId: id, source: 'model', requirement: '开发 Todo API', policy,
  department: { name: 'Todo 团队', description: '开发及验收', agents: [{ id: 'manager', role: 'manager', name: '经理', title: '项目经理', instructions: '记录验收结果', modelId: 'model', tools: [] }] },
  plan: { rationale: '分步实现与验收', agents: [], tasks: [] },
  validation: { valid: true, errors: [] },
});
function request(draft: Draft, content: string, settings = 'settings'): ChatRequest {
  return { key: 'request-key', settings, body: { messages: [...draft.messages, { role: 'user', content }], modelId: draft.modelId, policy, templateId: 'software', maxPlanningCost: .1, previousPreviewId: draft.preview?.previewId } };
}

test('consultation without a proposal does not create a confirmable draft or a saved team', () => {
  const draft = initial(), reply = finishOrganizationReply(draft, request(draft, '先讨论需求'), { reply: '请介绍使用场景' });
  assert.equal(reply.preview, undefined);
  assert.equal(reply.projectId, undefined);
  assert.equal(reply.saved, undefined);
  assert.equal(reply.awaitingPlan, false);
  assert.equal(reply.messages.length, 2);
  assert.deepEqual(draft.messages, [], 'the previous conversation remains unchanged');
});

test('additional requirements followed by clarification cannot accidentally confirm the old plan', () => {
  const previous: Draft = { ...initial(), preview: preview('old'), previewSettings: 'settings' };
  assert.equal(hasUnconfirmedOrganizationChanges(previous, false), false);
  const sent = request(previous, '增加优先级字段和验收测试');
  const awaiting = finishOrganizationReply({ ...previous, pendingRequest: sent, input: '增加优先级字段和验收测试' }, sent, { reply: '优先级需要几个级别？' });
  assert.equal(awaiting.input, '');
  assert.equal(awaiting.pendingRequest, undefined);
  assert.equal(awaiting.preview, previous.preview, 'a discussion must preserve the old draft');
  assert.equal(awaiting.awaitingPlan, true);
  assert.equal(hasUnconfirmedOrganizationChanges(awaiting, false), true, 'the confirmation guard remains active after the composer is cleared');
  assert.equal(awaiting.projectId, undefined);
  const clarified = finishOrganizationReply(awaiting, request(awaiting, '三个级别'), { reply: '还需要筛选功能吗？' });
  assert.equal(hasUnconfirmedOrganizationChanges(clarified, false), true);
  assert.ok(clarified.messages.some(message => message.content.includes('增加优先级字段')));
});

test('failed revisions stay blocked through consultation and only a fresh proposal unlocks confirmation', () => {
  const previous: Draft = { ...initial(), preview: preview('old'), previewSettings: 'settings', projectId: 'saved-project', saved: { departmentId: 'saved-department', projectId: 'saved-project', departmentVersion: 1, projectVersion: 1, previewId: 'old' } };
  const failed = finishOrganizationReply(previous, request(previous, '修改团队'), { reply: '需要进一步整理', draftIssue: { code: 'ORGANIZATION_CHAT_PLAN_INVALID', message: '本轮方案不完整' } });
  assert.equal(failed.preview, previous.preview);
  assert.equal(hasUnconfirmedOrganizationChanges(failed, false), true);
  const discussing = finishOrganizationReply(failed, request(failed, '我来补充'), { reply: '继续讨论' });
  assert.equal(discussing.draftIssue, undefined, 'a successful conversational reply clears the previous error label');
  assert.equal(hasUnconfirmedOrganizationChanges(discussing, false), true);
  const updatedPreview = preview('updated');
  const updated = finishOrganizationReply(discussing, request(discussing, '请整理更新方案', 'updated-settings'), { reply: '请核对更新方案', preview: updatedPreview });
  assert.equal(hasUnconfirmedOrganizationChanges(updated, false), false);
  assert.equal(updated.preview, updatedPreview);
  assert.equal(updated.previewSettings, 'updated-settings');
  assert.equal(updated.previousPreviewId, 'updated');
  assert.deepEqual(updated.saved, previous.saved, 'receiving a preview must never save or update the formal team');
  assert.equal(updated.projectId, previous.projectId);
});

test('unsent changes and requests with unknown results prevent confirmation even with a valid preview', () => {
  const previous: Draft = { ...initial(), preview: preview('old'), previewSettings: 'settings' };
  assert.equal(hasUnconfirmedOrganizationChanges({ ...previous, input: '新需求' }, false), true);
  assert.equal(hasUnconfirmedOrganizationChanges(previous, true), true);
  assert.equal(hasUnconfirmedOrganizationChanges({ ...previous, pendingRequest: request(previous, '修改方案') }, false), true);
});
