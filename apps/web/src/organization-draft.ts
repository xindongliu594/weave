import { policySchema, type DepartmentInput, type Plan, type Policy } from '../../../packages/contracts/index.ts';
import {ApiError} from './api.ts';

export type Message = { role: 'user' | 'assistant'; content: string };
export type Preview = { previewId: string; department: DepartmentInput; plan: Plan; policy: Policy; requirement: string; source: string; costAccounting?: 'conversation'; validation: { valid: boolean; errors: string[]; warnings?: string[] } };
export type ChatRequest = { key: string; settings: string; body: { messages: Message[]; modelId: string; policy: Policy; templateId: string; maxPlanningCost?: number; previousPreviewId?: string; conversationId?: string; previousDraftIssue?: DraftIssue & { truncated?: boolean } } };
export type SavedTeam = { departmentId: string; projectId: string; departmentVersion: number; projectVersion: number; previewId: string };
export type DraftIssue = { code: string; message: string };
export type Draft = { messages: Message[]; modelId: string; policy: Policy; maxPlanningCost?: number; input: string; conversationId?: string; preview?: Preview; previewSettings?: string; projectId?: string; saved?: SavedTeam; draftIssue?: DraftIssue; previousPreviewId?: string; pendingRequest?: ChatRequest; awaitingPlan?: boolean };
export type ChatReply = { reply: string; preview?: Preview; draftIssue?: DraftIssue };
/** The old per-reply cost remains legacy metadata, never a new setting. */
export function organizationSettingsFingerprint(value: Pick<Draft, 'modelId' | 'policy'>): string {
  const policy = policySchema.safeParse(value.policy);
  function ordered(item: any): any { return Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item; }
  return JSON.stringify(ordered({ modelId: value.modelId, policy: policy.success ? policy.data : value.policy }));
}
/** Normalize preview comparison metadata only, never a pending request's settings. */
export function normalizeOrganizationSettings(settings: string): string {
  try {
    const value = JSON.parse(settings);
    if (value && typeof value.modelId === 'string' && policySchema.safeParse(value.policy).success) return organizationSettingsFingerprint(value);
  } catch { /* Unrecognized legacy metadata stays stale, without discarding the conversation. */ }
  return settings;
}
/** Match the component's confirmed-failure rule; protocol/transport failures
 * retain the exact original request identity for explicit continuation. */
export function organizationReplyFailure(previous:Draft,cause:unknown):Draft{
  return cause instanceof ApiError&&cause.status!==409?{...previous,pendingRequest:undefined}:previous;
}

export function isOrganizationConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Migrate only draft metadata. A persisted pending body belongs to its original key. */
export function ensureOrganizationConversation(draft: Draft): Draft {
  const pendingId = draft.pendingRequest?.body.conversationId;
  const conversationId = isOrganizationConversationId(pendingId) ? pendingId :
    isOrganizationConversationId(draft.conversationId) ? draft.conversationId : crypto.randomUUID();
  return conversationId === draft.conversationId ? draft : { ...draft, conversationId };
}

/** Used only for a new turn; retrieving an existing request never calls this factory. */
export function createOrganizationChatRequest(draft: Draft, content: string, settings: string): ChatRequest {
  const current = ensureOrganizationConversation(draft);
  return { key: crypto.randomUUID(), settings, body: {
    messages: [...draft.messages, { role: 'user', content }], modelId: draft.modelId, policy: draft.policy,
    templateId: 'software',
    previousPreviewId: draft.preview?.previewId ?? draft.previousPreviewId, conversationId: current.conversationId,
    ...(draft.draftIssue ? { previousDraftIssue: { code: draft.draftIssue.code.slice(0, 100), message: draft.draftIssue.message.slice(0, 4000), ...(draft.draftIssue.message.length > 4000 ? { truncated: true } : {}) } } : {}),
  } };
}

export function finishOrganizationReply(previous: Draft, request: ChatRequest, result: ChatReply): Draft {
  return {
    ...previous,
    ...(isOrganizationConversationId(request.body.conversationId) ? { conversationId: request.body.conversationId } : {}),
    messages: [...request.body.messages, { role: 'assistant', content: result.reply }],
    input: '',
    preview: result.preview ?? previous.preview,
    previewSettings: result.preview ? normalizeOrganizationSettings(request.settings) : previous.previewSettings,
    previousPreviewId: result.preview?.previewId ?? previous.preview?.previewId ?? previous.previousPreviewId,
    // A reply alone cannot prove that new user requirements are in the retained plan.
    // Only a newly generated preview may unlock confirmation after further discussion.
    awaitingPlan: result.preview ? false : !!previous.preview || !!result.draftIssue || !!previous.awaitingPlan,
    draftIssue: result.draftIssue,
    pendingRequest: undefined,
  };
}

export function hasUnconfirmedOrganizationChanges(draft: Draft, settingsChanged: boolean): boolean {
  return settingsChanged || !!draft.input.trim() || !!draft.pendingRequest || !!draft.awaitingPlan;
}
