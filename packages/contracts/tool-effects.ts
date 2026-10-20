import type { TaskAttemptKey } from './task-execution.ts';

/** Serialized metadata only. A valid contract is not an execution authorization. */
export type EffectContract = Readonly<{
  schema: 1;
  capabilityId: string;
  namespace: string;
  toolName: string;
  source: Readonly<{ kind: 'builtin' | 'native' | 'mcp'; reference: string; version: string; digest: string }>;
  definitionSha256: string;
  effect: 'read' | 'workspace' | 'external' | 'unknown';
  isolationProfile: string;
  permissions: readonly string[];
  retry: 'bounded-read' | 'provider-key' | 'never';
  cost: Readonly<{ kind: 'free' | 'metered' | 'unknown'; adapterId?: string }>;
  reconciliation: Readonly<{ kind: 'receipt' | 'query' | 'manual'; resolverId?: string; version?: string }>;
  compensation: Readonly<{ kind: 'none' | 'operation'; capabilityId?: string; contractSha256?: string; requiresApproval: true }>;
  evidenceRefs: readonly string[];
}>;

export type EffectIntent = Readonly<{
  schema: 1;
  operationId: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  rootCallId: string;
  callId: string;
  parentOperationId: string | null;
  principal: Readonly<{ kind: 'employee' | 'system'; id: string; sessionId: string; authorizationVersion: string }>;
  contractSha256: string;
  argumentsSha256: string;
  resourcePreconditions: Readonly<Record<string, string>>;
  scopeRef: Readonly<{ key: Readonly<TaskAttemptKey>; scopeHash: string; workRevision: string }> | null;
  approvalId: string | null;
  budgetRefs: readonly string[];
  providerKey: Readonly<{ key: string; endpointIdentity: string; accountRef: string; expiresAt: string }> | null;
  compensatesOperationId: string | null;
}>;

export type EffectState = 'prepared' | 'dispatched' | 'confirmed' | 'failed-known' | 'unknown';

export type EffectEvidence = Readonly<{
  schema: 1;
  evidenceId: string;
  operationId: string;
  intentSha256: string;
  source: 'device' | 'runtime' | 'resolver' | 'human';
  observedAt: string;
  outcome: 'confirmed' | 'failed-known' | 'unknown';
  receiptSha256: string;
  artifactRefs: readonly string[];
  reasonCode: string;
}>;
