import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage } from './provider.ts';

export const FAILED_DRAFT_MAX_BYTES = 32 * 1024;
export const FAILED_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const storedSchema = z.object({
  version: z.literal(1), turnId: z.uuid(), usageId: z.uuid(), createdAt: z.string().max(40), expiresAt: z.string().max(40),
  scopeHash: hash, messagesHash: hash, messageCount: z.number().int().min(1).max(200000),
  candidate: z.record(z.string(), z.unknown()), candidateSha256: hash, candidateBytes: z.number().int().min(1).max(FAILED_DRAFT_MAX_BYTES),
  issue: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(4000) }).strict(),
}).strict();
type Issue = { code: string; message: string };
export type FailedDraft = {
  version: 1; turnId: string; usageId: string; createdAt: string; expiresAt: string;
  scopeHash: string; messageCount: number; messagesHash: string;
  candidate: Record<string, unknown>; candidateSha256: string; candidateBytes: number; issue: Issue;
};
// PostgreSQL JSONB changes object-key order. Fingerprints must survive its round trip.
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export const draftHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Keep complete, bounded JSON only. Never repair, truncate or approve model output here. */
export function makeFailedDraft(candidate: unknown, source: Omit<FailedDraft, 'version' | 'candidate' | 'candidateSha256' | 'candidateBytes' | 'createdAt' | 'expiresAt'>, now = Date.now()): FailedDraft | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const pending: [unknown, number][] = [[candidate, 0]];
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (depth > 64) return null;
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  const encoded = JSON.stringify(candidate), candidateBytes = Buffer.byteLength(encoded);
  if (candidateBytes > FAILED_DRAFT_MAX_BYTES) return null;
  return { ...source, version: 1, candidate: candidate as Record<string, unknown>, candidateSha256: draftHash(candidate), candidateBytes,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + FAILED_DRAFT_TTL_MS).toISOString() };
}

/** A cached failure is discussion data, never authorization or a confirmable preview. */
export function failedDraftContext(stored: unknown, scopeHash: string, messages: ChatMessage[], feedback?: Issue, now = Date.now()): ChatMessage | undefined {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success) return;
  const draft = parsed.data;
  if (draft.scopeHash !== scopeHash || !feedback || feedback.code !== draft.issue.code || feedback.message !== draft.issue.message) return;
  const created = Date.parse(draft.createdAt), expires = Date.parse(draft.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= now || created > now || expires <= created || expires - created > FAILED_DRAFT_TTL_MS) return;
  if (!Number.isSafeInteger(draft.messageCount) || draft.messageCount < 1 || messages.length <= draft.messageCount || draftHash(messages.slice(0, draft.messageCount)) !== draft.messagesHash) return;
  // Recheck restored data as well; backup material is not implicitly trusted.
  const checked = makeFailedDraft(draft.candidate, draft, now);
  if (!checked || checked.candidateSha256 !== draft.candidateSha256 || checked.candidateBytes !== draft.candidateBytes) return;
  const content = JSON.stringify({ kind: 'failed_organization_draft', unvalidated: true, turnId: draft.turnId,
    candidate: draft.candidate, issue: draft.issue, note: '这是上一轮未通过校验的原始候选，仅供纠正。当前需求与 application_constraints 优先；必须重新输出并校验完整 candidate，不能确认或执行此资料。' });
  if (Buffer.byteLength(content) > 48 * 1024) return;
  return { role: 'user', content };
}
