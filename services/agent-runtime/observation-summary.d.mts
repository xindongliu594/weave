/** Internal persistence adapter input, never an HTTP DTO or authorization proof. */
export type TrustedObservation =
  | {kind:'trace';runId:string;event:unknown;correlation?:unknown}
  | {kind:'audit';projection:unknown};
export type ObservationAuditAction =
  | 'identity.mode.activated' | 'identity.bootstrap' | 'identity.bootstrap.closed'
  | 'identity.login' | 'identity.logout' | 'identity.user.updated' | 'identity.sessions.revoked'
  | 'identity.membership.updated' | 'identity.membership.removed'
  | 'project.plan' | 'department.configure' | 'employee.restore' | 'project.message' | 'file.create'
  | 'project.approve' | 'run.cancel' | 'run.recover' | 'run.authority'
  | 'tool.approval' | 'tool.dispatch' | 'tool.result' | 'tool.reconcile' | 'task.merge'
  | 'budget.policy.updated' | 'knowledge.publish' | 'knowledge.withdraw' | 'capability.configure'
  | 'device.configure' | 'model.configure' | 'backup.create' | 'backup.restore' | 'storage.cleanup'
  | 'audit.read' | 'audit.export';
export type ObservationName = `audit.${ObservationAuditAction}`
  | 'run.created' | 'run.finished' | 'tool.started' | 'tool.result'
  | 'operation.started' | 'operation.finished' | 'operation.failed' | 'operation.unknown'
  | 'billing.usage' | 'billing.unknown' | 'runtime.status' | 'runtime.anomaly'
  | 'task.merge' | 'task.checkpoint' | 'task.accepted';
export type RuntimePhase = 'working' | 'executing_tool' | 'waiting_model' | 'waiting_approval'
  | 'waiting_capacity' | 'waiting_coordinator' | 'idle_unfinished';
export type ObservationReason = 'unauthenticated' | 'forbidden' | 'csrf-invalid' | 'invalid-request'
  | 'authority-revoked' | 'conflict' | 'not-found' | 'storage-unavailable' | 'execution-failed'
  | 'result-unknown' | 'existing-administration' | 'disabled-bootstrap-identity' | 'legacy-reason-unclassified';
export type ObservationCorrelation = Readonly<Partial<Record<
  'correlationId' | 'requestId' | 'modelRequestId' | 'projectId' | 'runId' | 'taskId' | 'attemptId'
  | 'operationId' | 'parentOperationId' | 'approvalId' | 'mergeId', string>>>;
export type ObservationSummary = Readonly<{
  schema:1;sourceEventId:string;at:string;name:ObservationName;correlation:ObservationCorrelation;
  actorKind?:'human'|'local-owner'|'device'|'system'|'unidentified';
  outcome?:'success'|'denied'|'failure'|'unknown';reasonCode?:ObservationReason;phase?:RuntimePhase;
  durationMs?:number;inputTokens?:number;outputTokens?:number;confirmedCost?:number;costUnknown?:boolean;
  capabilityId?:string;capabilityVersion?:string;capabilitySha256?:string;
}>;
export const observationNames:readonly ObservationName[];
export const observationPhases:readonly RuntimePhase[];
export function summarizeObservation(source:TrustedObservation):ObservationSummary|null;
export function validateObservationSummary(input:unknown):ObservationSummary|null;
export function observationCorrelation(input:unknown):ObservationCorrelation;
