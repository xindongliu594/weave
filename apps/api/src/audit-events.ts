import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IdentityQueryExecutor } from './identity-schema.ts';
import { identityText, principalKey, type Principal, type HumanStatus, type OrgRole } from './identity-types.ts';

const id = z.string().refine(value => identityText(value, 128), 'Invalid audit identifier');
const hash = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase());
const version = id;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const departments = z.array(id).max(100).transform(values => [...new Set(values)].sort());
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const empty = z.strictObject({});
const identityChanges = z.strictObject({ status: z.enum(['pending','active','disabled']).optional(), orgRole: z.enum(['member','admin','auditor']).optional(),
  sessionEpoch: count.optional(), version: count.min(1).optional(), role: z.enum(['viewer','operator','manager']).optional(), canApprove: z.boolean().optional() });
const membership = z.strictObject({ role: z.enum(['viewer','operator','manager']).optional(), canApprove: z.boolean().optional(), version: count.min(1).optional() });
const revision = z.strictObject({ beforeVersion: version.optional(), afterVersion: version.optional(), sha256: hash.optional() });
const configuration = z.strictObject({ version: version.optional(), sha256: hash.optional(), enabled: z.boolean().optional() });
const operation = z.strictObject({ state: z.enum(['prepared','dispatched','confirmed','failed-known','unknown','reconciled','denied']),
  capabilityId: id.optional(), capabilityVersion: version.optional(), capabilitySha256: hash.optional(),
  effect: z.enum(['read','workspace','external','unknown']).optional(), durationMs: z.number().finite().nonnegative().optional(), receiptId: id.optional() });
const definitions = {
  'identity.mode.activated': { resource: 'identity_mode', changes: empty },
  'identity.bootstrap': { resource: 'human_user', changes: identityChanges },
  'identity.bootstrap.closed': { resource: 'identity_mode', changes: empty },
  'identity.login': { resource: 'human_user', changes: empty },
  'identity.logout': { resource: 'human_session', changes: empty },
  'identity.user.updated': { resource: 'human_user', changes: identityChanges },
  'identity.sessions.revoked': { resource: 'human_user', changes: z.strictObject({ sessionEpoch: count, version: count.min(1).optional() }) },
  'identity.membership.updated': { resource: 'department_membership', changes: membership },
  'identity.membership.removed': { resource: 'department_membership', changes: z.strictObject({ version: count.min(1).optional() }) },
  'project.plan': { resource: 'project', changes: revision },
  'project.approve': { resource: 'project', changes: z.strictObject({ version, snapshotSha256: hash.optional() }) },
  'run.cancel': { resource: 'run', changes: z.strictObject({ state: z.enum(['cancel-requested','cancelled','unknown']) }) },
  'run.recover': { resource: 'run', changes: z.strictObject({ checkpointId: id.optional(), state: z.enum(['requested','resumed','unknown']) }) },
  'tool.approval': { resource: 'tool_operation', changes: z.strictObject({ decision: z.enum(['approved','denied']), policyVersion: version.optional() }) },
  'tool.dispatch': { resource: 'tool_operation', changes: operation.extend({ state: z.enum(['dispatched','denied','unknown']) }) },
  'tool.result': { resource: 'tool_operation', changes: operation.extend({ state: z.enum(['confirmed','failed-known','unknown']) }) },
  'tool.reconcile': { resource: 'tool_operation', changes: operation.extend({ state: z.enum(['confirmed','failed-known','unknown','reconciled']) }) },
  'task.merge': { resource: 'task', changes: z.strictObject({ beforeRevision: hash, afterRevision: hash, scopeSha256: hash, state: z.enum(['committed','conflict','unknown']) }) },
  'budget.policy.updated': { resource: 'budget_policy', changes: z.strictObject({ version, policySha256: hash, amount: z.number().finite().nonnegative().optional(), callLimit: count.optional() }) },
  'knowledge.publish': { resource: 'knowledge', changes: revision },
  'knowledge.withdraw': { resource: 'knowledge', changes: revision },
  'capability.configure': { resource: 'capability', changes: configuration },
  'device.configure': { resource: 'device', changes: configuration },
  'model.configure': { resource: 'model', changes: configuration },
  'backup.create': { resource: 'backup', changes: z.strictObject({ backupId: id, sha256: hash.optional(), state: z.enum(['created','unknown','failed']) }) },
  'backup.restore': { resource: 'backup', changes: z.strictObject({ backupId: id, sha256: hash, state: z.enum(['restored','unknown','failed']) }) },
  'storage.cleanup': { resource: 'storage', changes: z.strictObject({ planId: id, state: z.enum(['confirmed','completed','unknown','reconciled']), itemCount: count.optional() }) },
  'audit.read': { resource: 'audit', changes: z.strictObject({ count: count.optional(), filterSha256: hash.optional() }) },
  'audit.export': { resource: 'audit', changes: z.strictObject({ count: count.optional(), filterSha256: hash.optional() }) },
} as const;
export type AuditAction = keyof typeof definitions;
export type AuditResource = typeof definitions[AuditAction]['resource'];
export type AuditChanges = { [A in AuditAction]: z.infer<typeof definitions[A]['changes']> }[AuditAction];
const reasons = ['unauthenticated','forbidden','csrf-invalid','invalid-request','authority-revoked','conflict','not-found','storage-unavailable','execution-failed','result-unknown','existing-administration','disabled-bootstrap-identity','legacy-reason-unclassified'] as const;
export type AuditReason = typeof reasons[number];
const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), userId: id, orgRole: z.enum(['member','admin','auditor']) }),
  z.strictObject({ kind: z.literal('local-owner') }), z.strictObject({ kind: z.literal('device'), deviceId: id }),
  z.strictObject({ kind: z.literal('system'), service: id }), z.strictObject({ kind: z.literal('unidentified') }),
]);
export type AuditActor = z.infer<typeof actorSchema>;
const correlationSchema = z.strictObject({ correlationId: id, requestId: id.optional(), modelRequestId: id.optional(), projectId: id.optional(),
  runId: id.optional(), taskId: id.optional(), attemptId: id.optional(), operationId: id.optional(), parentOperationId: id.optional(), approvalId: id.optional(), mergeId: id.optional() });
export type Correlation = z.infer<typeof correlationSchema>;
const authoritySchema = z.strictObject({ decisionId: id, checkedAt: instant, policyVersion: version, principalKey: id, departmentIds: departments,
  membershipVersions: z.array(z.strictObject({ departmentId: id, version: count.min(1) })).max(100),
  grantVersions: z.array(z.strictObject({ kind: z.enum(['employee','capability','device']), id, version })).max(100),
  permissionSha256: hash, approvalId: id.optional(), budgetApprovalId: id.optional() });
export type AuthorityEvidence = z.infer<typeof authoritySchema>;
const envelope = z.strictObject({ eventId: id, action: z.enum(Object.keys(definitions) as [AuditAction,...AuditAction[]]), actor: actorSchema,
  requestedByAuditId: id.optional(), executedEmployee: z.strictObject({ employeeId: id, agentId: id, sessionId: id }).optional(),
  authority: authoritySchema.optional(), correlation: correlationSchema, resource: z.strictObject({ type: id, id, departmentIds: departments, version: version.optional() }),
  outcome: z.enum(['success','denied','failure','unknown']), reasonCode: z.enum(reasons).optional(), changes: z.unknown() });
type Base = Omit<z.infer<typeof envelope>, 'action'|'changes'|'resource'|'outcome'|'authority'>;
type EvidenceOnlyAction = 'tool.result'|'tool.reconcile';
export type AuditInput = { [A in AuditAction]: Base & { action: A; changes: z.infer<typeof definitions[A]['changes']>;
  resource: { type: typeof definitions[A]['resource']; id: string; departmentIds: string[]; version?: string } } &
  (A extends EvidenceOnlyAction ? { outcome: 'success'|'denied'|'failure'|'unknown'; authority?: AuthorityEvidence }
    : { outcome: 'success'; authority: AuthorityEvidence } | { outcome: 'denied'|'failure'|'unknown'; authority?: AuthorityEvidence }) }[AuditAction];

/** Clone descriptors before examining values: getters, toJSON, custom prototypes and cycles never execute. */
function plain(value: unknown, seen = new Set<object>(), depth = 0): any {
  if (depth>20) throw Error('Invalid audit nesting');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || seen.has(value)) throw Error('Invalid audit value');
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw Error('Invalid audit prototype');
  seen.add(value);
  const result: any = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || key === '__proto__'
      || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) throw Error('Invalid audit property');
    result[key] = plain(descriptor.value, seen, depth+1);
  }
  seen.delete(value); return result;
}
function bytes(value: unknown, maximum: number) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw Error('Audit input too large'); }
function parse(input: AuditInput) {
  const copy = plain(input); bytes(copy, 16384);
  const parsed = envelope.parse(copy); const definition = definitions[parsed.action];
  if (parsed.resource.type !== definition.resource) throw Error('Invalid audit resource');
  const changes = definition.changes.parse(parsed.changes); bytes(changes, 8192);
  if (parsed.actor.kind === 'unidentified' && parsed.outcome === 'success') throw Error('Unidentified audit success');
  if (parsed.outcome === 'success' && !(['tool.result','tool.reconcile'] as AuditAction[]).includes(parsed.action) && !parsed.authority) throw Error('Current audit authority required');
  if (parsed.authority) {
    const a = parsed.authority;
    a.membershipVersions.sort((a,b) => a.departmentId.localeCompare(b.departmentId));
    a.grantVersions.sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if (new Set(a.membershipVersions.map(v=>v.departmentId)).size !== a.membershipVersions.length || new Set(a.grantVersions.map(v=>`${v.kind}:${v.id}`)).size !== a.grantVersions.length) throw Error('Duplicate audit authority version');
    if (['identity-bootstrap-v1','oidc-login-v1'].includes(a.policyVersion)) {
      const validDecision = parsed.actor.kind === 'system' && (a.policyVersion === 'identity-bootstrap-v1'
        ? ((parsed.actor.service === 'identity' && parsed.action === 'identity.mode.activated')
          || (parsed.actor.service === 'identity-bootstrap' && ['identity.bootstrap','identity.bootstrap.closed'].includes(parsed.action)))
        : parsed.actor.service === 'oidc' && parsed.action === 'identity.login');
      if (!validDecision || parsed.actor.kind !== 'system' || a.principalKey !== `system:${parsed.actor.service}`
        || a.departmentIds.length || a.membershipVersions.length || a.grantVersions.length || a.approvalId || a.budgetApprovalId) throw Error('Invalid identity authority scope');
    }
  }
  const normalized = { ...parsed, changes }; bytes(normalized, 16384); return normalized;
}
function actorSnapshot(principal: Principal): AuditActor {
  return principal.kind === 'human' ? { kind: principal.kind, userId: principal.userId, orgRole: principal.orgRole }
    : principal.kind === 'device' ? { kind: principal.kind, deviceId: principal.deviceId }
    : principal.kind === 'system' ? { kind: principal.kind, service: principal.service } : { kind: principal.kind };
}
export function auditActor(principal: Principal|null): AuditActor {
  if (principal === null) return { kind: 'unidentified' };
  const trusted = plain(principal); principalKey(trusted);
  return actorSchema.parse(actorSnapshot(trusted));
}

// The caller owns its business transaction. One statement keeps audit+outbox atomic in autocommit too.
async function store(db: IdentityQueryExecutor, input: ReturnType<typeof parse>, schemaVersion: 1|2): Promise<string> {
  const correlation = input.correlation;
  const result = await db.query(`WITH inserted AS (
    INSERT INTO human_audit_events(id,actor_kind,actor_user_id,actor_snapshot,action,resource_type,resource_id,department_id,request_id,outcome,reason,changes,
      schema_version,source_event_id,correlation_id,project_id,run_id,task_id,attempt_id,operation_id,parent_operation_id,approval_id,merge_id,requested_by_audit_id,executed_employee,authority_evidence,resource_versions,canonical_payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$1,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT(source_event_id) DO NOTHING RETURNING id
  ), outboxed AS (
    INSERT INTO audit_outbox(id,audit_event_id,run_id,event_type,payload)
    SELECT id,id,$16,$5,$27 FROM inserted RETURNING audit_event_id
  ) SELECT audit_event_id AS id FROM outboxed`,
  [input.eventId,input.actor.kind,input.actor.kind === 'human' ? input.actor.userId : null,input.actor,input.action,input.resource.type,input.resource.id,
    input.resource.departmentIds[0] ?? null,correlation.requestId ?? null,input.outcome,input.reasonCode ?? null,input.changes,schemaVersion,
    correlation.correlationId,correlation.projectId ?? null,correlation.runId ?? null,correlation.taskId ?? null,correlation.attemptId ?? null,
    correlation.operationId ?? null,correlation.parentOperationId ?? null,correlation.approvalId ?? null,correlation.mergeId ?? null,
    input.requestedByAuditId ?? null,input.executedEmployee ?? null,input.authority ?? null,input.resource,input]);
  if (result.rows[0]) return result.rows[0].id;
  // A separate statement also observes a concurrent identical insert after its unique-key wait.
  const { rows } = await db.query(`SELECT a.id,a.canonical_payload=$2::jsonb AS same,
    o.audit_event_id IS NOT NULL AND o.run_id IS NOT DISTINCT FROM a.run_id AND o.event_type=a.action AND o.payload=a.canonical_payload
    AND ((o.published_at IS NULL AND p.audit_event_id IS NULL) OR (o.published_at IS NOT NULL AND p.audit_event_id IS NOT NULL
      AND p.run_id IS NOT DISTINCT FROM a.run_id AND p.correlation_id=a.correlation_id AND p.occurred_at=a.occurred_at)) AS related
    FROM human_audit_events a LEFT JOIN audit_outbox o ON o.audit_event_id=a.id LEFT JOIN audit_run_projection p ON p.audit_event_id=a.id WHERE a.source_event_id=$1`, [input.eventId,input]);
  if (!rows[0]?.same) throw Error('AUDIT_SOURCE_CONFLICT');
  if (!rows[0].related) throw Error('AUDIT_RELATION_CONFLICT');
  return rows[0].id;
}
export async function appendAudit(db: IdentityQueryExecutor, input: AuditInput): Promise<string> { return store(db, parse(input), 2); }

const legacyActions = ['identity.mode.activated','identity.bootstrap','identity.bootstrap.closed','identity.login','identity.user.updated','identity.sessions.revoked','identity.membership.updated','identity.membership.removed','identity.logout'] as const;
export type HumanAuditEvent = { actor: Principal; action: typeof legacyActions[number]; resourceType: 'identity_mode'|'human_user'|'department_membership'|'human_session';
  resourceId: string; departmentId?: string; requestId?: string; outcome: 'success'|'denied'|'failure'; reason?: string;
  changes?: { status?: HumanStatus; orgRole?: OrgRole; sessionEpoch?: number; version?: number; role?: 'viewer'|'operator'|'manager'; canApprove?: boolean } };
const legacySchema = z.strictObject({ actor: z.unknown(), action: z.enum(legacyActions), resourceType: z.enum(['identity_mode','human_user','department_membership','human_session']),
  resourceId: z.string().refine(value=>identityText(value)), departmentId: z.string().refine(value=>identityText(value)).optional(), requestId: z.string().refine(value=>identityText(value)).optional(),
  outcome: z.enum(['success','denied','failure']), reason: z.string().refine(value=>identityText(value)).optional(), changes: identityChanges.optional() });
/** Compatibility for the old identity-only API; it never supplies business authority. */
export async function appendHumanAudit(db: IdentityQueryExecutor, event: HumanAuditEvent): Promise<string> {
  const old = legacySchema.parse(plain(event)); principalKey(old.actor as Principal);
  const actor = actorSnapshot(old.actor as Principal); const eventId = randomUUID();
  const matchesCurrentIdentityShape = !old.departmentId && old.resourceType === definitions[old.action].resource
    && identityText(old.resourceId,128) && (!old.requestId || identityText(old.requestId,128)) && definitions[old.action].changes.safeParse(old.changes ?? {}).success;
  const trustedPolicy = !matchesCurrentIdentityShape ? null : actor.kind === 'system' &&
    ((actor.service === 'identity' && old.action === 'identity.mode.activated') || (actor.service === 'identity-bootstrap' && ['identity.bootstrap','identity.bootstrap.closed'].includes(old.action))) ? 'identity-bootstrap-v1'
    : actor.kind === 'system' && actor.service === 'oidc' && old.action === 'identity.login' ? 'oidc-login-v1' : null;
  const authority = trustedPolicy && actor.kind === 'system' ? { decisionId: eventId, checkedAt: new Date().toISOString(), policyVersion: trustedPolicy,
    principalKey: `system:${actor.service}`, departmentIds: [], membershipVersions: [], grantVersions: [], permissionSha256: createHash('sha256').update(trustedPolicy).digest('hex') } : undefined;
  const input = { eventId, actor, action: old.action, correlation: { correlationId: eventId, ...(old.requestId ? { requestId: old.requestId } : {}) },
    resource: { type: old.resourceType, id: old.resourceId, departmentIds: old.departmentId ? [old.departmentId] : [] }, outcome: old.outcome,
    ...(old.reason ? { reasonCode: (reasons as readonly string[]).includes(old.reason) ? old.reason : 'legacy-reason-unclassified' } : {}), changes: old.changes ?? {}, ...(authority ? { authority } : {}) };
  if (trustedPolicy) return appendAudit(db, input as AuditInput);
  // Existing identity callers cannot furnish current resource authority. Preserve that historical contract as schema 1.
  return store(db, input as ReturnType<typeof parse>, 1);
}
