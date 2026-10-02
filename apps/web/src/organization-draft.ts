import type { DepartmentInput, Plan, Policy } from '../../../packages/contracts/index.ts';

export type Message = { role: 'user' | 'assistant'; content: string };
export type Preview = { previewId: string; department: DepartmentInput; plan: Plan; policy: Policy; requirement: string; source: string; validation: { valid: boolean; errors: string[]; warnings?: string[] } };
export type ChatRequest = { key: string; settings: string; body: { messages: Message[]; modelId: string; policy: Policy; templateId: string; maxPlanningCost: number; previousPreviewId?: string } };
export type SavedTeam = { departmentId: string; projectId: string; departmentVersion: number; projectVersion: number; previewId: string };
export type DraftIssue = { code: string; message: string };
export type Draft = { messages: Message[]; modelId: string; policy: Policy; maxPlanningCost: number; input: string; preview?: Preview; previewSettings?: string; projectId?: string; saved?: SavedTeam; draftIssue?: DraftIssue; previousPreviewId?: string; pendingRequest?: ChatRequest; awaitingPlan?: boolean };
export type ChatReply = { reply: string; preview?: Preview; draftIssue?: DraftIssue };

export function finishOrganizationReply(previous: Draft, request: ChatRequest, result: ChatReply): Draft {
  return {
    ...previous,
    messages: [...request.body.messages, { role: 'assistant', content: result.reply }],
    input: '',
    preview: result.preview ?? previous.preview,
    previewSettings: result.preview ? request.settings : previous.previewSettings,
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
