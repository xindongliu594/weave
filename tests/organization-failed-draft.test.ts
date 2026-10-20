import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftHash, makeFailedDraft, failedDraftContext, FAILED_DRAFT_MAX_BYTES, FAILED_DRAFT_TTL_MS } from '../apps/api/src/organization-failed-draft.ts';

const now = Date.parse('2026-10-20T00:00:00Z');
const messages = [{ role: 'user' as const, content: '请为测试任务组织团队。' }];
const next = [...messages, { role: 'user' as const, content: '请修正刚才的字段错误。' }];
const issue = { code: 'INVALID_DRAFT', message: '缺少编排字段' };
const source = { turnId: '051f11a4-ade4-4f88-977d-5c2f3539de12', usageId: '051f11a4-ade4-4f88-977d-5c2f3539de13', scopeHash: draftHash('scope-1'), messagesHash: draftHash(messages), messageCount: 1, issue };
const draft = () => makeFailedDraft({ tasks: [{ id: 'work' }], rationale: '原始草案' }, source, now)!;

test('failed draft survives JSONB key ordering and enters context as unvalidated data', () => {
  const stored = draft(); stored.candidate = { rationale: '原始草案', tasks: [{ id: 'work' }] };
  const result = failedDraftContext(stored, source.scopeHash, next, issue, now);
  assert.equal(result?.role, 'user'); assert.equal(JSON.parse(result!.content!).unvalidated, true);
  assert.deepEqual(JSON.parse(result!.content!).candidate, stored.candidate);
});
test('changed authorization, error or conversation history prevents cached correction', () => {
  assert.equal(failedDraftContext(draft(), 'changed-scope', next, issue, now), undefined);
  assert.equal(failedDraftContext(draft(), source.scopeHash, next, { ...issue, message: '别的错误' }, now), undefined);
  assert.equal(failedDraftContext(draft(), source.scopeHash, [{ ...messages[0], content: '其他需求' }, next[1]], issue, now), undefined);
  assert.equal(failedDraftContext(draft(), source.scopeHash, messages, issue, now), undefined);
  assert.equal(failedDraftContext(draft(), source.scopeHash, next, undefined, now), undefined);
});
test('expired, future, malformed and altered stored candidates are omitted', () => {
  assert.equal(failedDraftContext(draft(), source.scopeHash, next, issue, now + FAILED_DRAFT_TTL_MS), undefined);
  assert.equal(failedDraftContext(draft(), source.scopeHash, next, issue, now - 1), undefined);
  assert.equal(failedDraftContext({ ...draft(), expiresAt: 'invalid' }, source.scopeHash, next, issue, now), undefined);
  assert.equal(failedDraftContext({ ...draft(), candidate: { injected: true } }, source.scopeHash, next, issue, now), undefined);
  assert.equal(failedDraftContext(null, source.scopeHash, next, issue, now), undefined);
});
test('UTF-8 size and nesting limits never return a partial candidate', () => {
  for (const candidate of [false, [], 'partial', null, { content: '中'.repeat(FAILED_DRAFT_MAX_BYTES / 2) }]) assert.equal(makeFailedDraft(candidate, source, now), null);
  const bounded = { content: 'x'.repeat(FAILED_DRAFT_MAX_BYTES - 14) };
  assert.ok(makeFailedDraft(bounded, source, now));
  const deep: any = {}; let cursor = deep; for (let i = 0; i < 66; i++) cursor = cursor.child = {};
  assert.equal(makeFailedDraft(deep, source, now), null);
});

test('restored cache metadata cannot bypass lifetime or context size bounds', () => {
  for (const patch of [{ createdAt: 'invalid' }, { expiresAt: '2100-01-01T00:00:00Z' }, { turnId: 'x'.repeat(1000000) }, { usageId: 'invalid' }, { messageCount: -1 }]) {
    assert.equal(failedDraftContext({ ...draft(), ...patch }, source.scopeHash, next, issue, now), undefined);
  }
});
