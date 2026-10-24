import type pg from 'pg';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { normalizeAuditInput, type AuditInput } from './audit-events.ts';
import { identityText } from './identity-types.ts';
import {summarizeObservation,type ObservationSummary} from '../../../services/agent-runtime/observation-summary.mjs';

type ProjectionListener={sink:(summary:ObservationSummary)=>unknown;pending:boolean};
type ProjectionObservers={listeners:Set<ProjectionListener>;emitted:number;dropped:number;failures:number};
const projectionObservers=new WeakMap<pg.Pool,ProjectionObservers>();let observedPools=0;
const increment=(value:number)=>Math.min(Number.MAX_SAFE_INTEGER,value+1);
/** Optional local observation only. No observer participates in the SQL transaction. */
export function observeAuditProjections(pool:pg.Pool,sink:(summary:ObservationSummary)=>unknown):()=>void{
  if(!pool||typeof sink!=='function')throw Error('AUDIT_OBSERVER_INVALID');
  let state=projectionObservers.get(pool);
  if(!state){if(observedPools>=16)throw Error('AUDIT_OBSERVER_POOL_LIMIT');state={listeners:new Set(),emitted:0,dropped:0,failures:0};projectionObservers.set(pool,state);observedPools++;}
  if(state.listeners.size>=8)throw Error('AUDIT_OBSERVER_LIMIT');const listener={sink,pending:false};state.listeners.add(listener);let disposed=false;
  return ()=>{if(disposed)return;disposed=true;state.listeners.delete(listener);if(!state.listeners.size){projectionObservers.delete(pool);observedPools--;}};
}
export function auditProjectionObservationHealth(pool:pg.Pool){const state=projectionObservers.get(pool);return {subscribers:state?.listeners.size??0,emitted:state?.emitted??0,dropped:state?.dropped??0,failures:state?.failures??0};}
function observeCommittedProjections(pool:pg.Pool,projections:unknown[]){
  const state=projectionObservers.get(pool);if(!state)return;
  for(const projection of projections){
    const summary=summarizeObservation({kind:'audit',projection});if(!summary){state.dropped=increment(state.dropped);continue;}state.emitted=increment(state.emitted);
    for(const listener of [...state.listeners]){if(!state.listeners.has(listener))continue;if(listener.pending){state.dropped=increment(state.dropped);continue;}
      try{const result=listener.sink(summary);if(result&&typeof (result as PromiseLike<unknown>).then==='function'){listener.pending=true;Promise.resolve(result).then(()=>{listener.pending=false;},()=>{listener.pending=false;state.failures=increment(state.failures);});}}
      catch{state.failures=increment(state.failures);}
    }
  }
}

const legacyText = z.string().refine(value => identityText(value));
const legacyActor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), userId: legacyText, orgRole: z.enum(['member', 'admin', 'auditor']) }),
  z.strictObject({ kind: z.literal('local-owner') }), z.strictObject({ kind: z.literal('device'), deviceId: legacyText }),
  z.strictObject({ kind: z.literal('system'), service: legacyText }),
]);
// Only the existing identity adapter can produce schema 1; it conveys no current business authority.
const legacyInput = z.strictObject({ eventId: z.string().uuid(), actor: legacyActor,
  action: z.enum(['identity.mode.activated', 'identity.bootstrap', 'identity.bootstrap.closed', 'identity.login', 'identity.logout', 'identity.user.updated', 'identity.sessions.revoked', 'identity.membership.updated', 'identity.membership.removed']),
  correlation: z.strictObject({ correlationId: z.string().uuid(), requestId: legacyText.optional() }),
  resource: z.strictObject({ type: z.enum(['identity_mode', 'human_user', 'department_membership', 'human_session']), id: legacyText, departmentIds: z.array(legacyText).max(1) }),
  outcome: z.enum(['success', 'denied', 'failure']),
  reasonCode: z.enum(['unauthenticated', 'forbidden', 'csrf-invalid', 'invalid-request', 'authority-revoked', 'conflict', 'not-found', 'storage-unavailable', 'execution-failed', 'result-unknown', 'existing-administration', 'disabled-bootstrap-identity', 'legacy-reason-unclassified']).optional(),
  changes: z.strictObject({ status: z.enum(['pending', 'active', 'disabled']).optional(), orgRole: z.enum(['member', 'admin', 'auditor']).optional(),
    sessionEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    role: z.enum(['viewer', 'operator', 'manager']).optional(), canApprove: z.boolean().optional() }),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
type ClaimedRow = { id: string; audit_event_id: string; run_id: string | null; event_type: string; payload: unknown; attempts: number; source: Record<string, any> | null; projection_id: string | null };
type FailureCode = 'AUDIT_SOURCE_INVALID' | 'AUDIT_RELATION_CONFLICT' | 'AUDIT_PROJECTION_FAILED';

function summaryFor(row: ClaimedRow) {
  const source = row.source;
  if (!source || ![1, 2].includes(source.schema_version)) throw Error('AUDIT_SOURCE_INVALID');
  let input: ReturnType<typeof normalizeAuditInput> | z.infer<typeof legacyInput>;
  try {
    if (Buffer.byteLength(JSON.stringify(source.canonical_payload), 'utf8') > 16384) throw Error();
    input = source.schema_version === 2 ? normalizeAuditInput(source.canonical_payload as AuditInput) : legacyInput.parse(source.canonical_payload);
    if (source.schema_version === 1 && input.correlation.correlationId !== input.eventId) throw Error();
    if (!isDeepStrictEqual(input, source.canonical_payload)) throw Error();
  } catch { throw Error('AUDIT_SOURCE_INVALID'); }
  const c = input.correlation as AuditInput['correlation'];
  const modern = input as ReturnType<typeof normalizeAuditInput>;
  const columns = { id: input.eventId, source_event_id: input.eventId, actor_kind: input.actor.kind,
    actor_user_id: input.actor.kind === 'human' ? input.actor.userId : null, actor_snapshot: input.actor, action: input.action,
    resource_type: input.resource.type, resource_id: input.resource.id, department_id: input.resource.departmentIds[0] ?? null,
    request_id: c.requestId ?? null, outcome: input.outcome, reason: input.reasonCode ?? null, changes: input.changes,
    correlation_id: c.correlationId, project_id: c.projectId ?? null, run_id: c.runId ?? null, task_id: c.taskId ?? null,
    attempt_id: c.attemptId ?? null, operation_id: c.operationId ?? null, parent_operation_id: c.parentOperationId ?? null,
    approval_id: c.approvalId ?? null, merge_id: c.mergeId ?? null, requested_by_audit_id: modern.requestedByAuditId ?? null,
    executed_employee: modern.executedEmployee ?? null, authority_evidence: modern.authority ?? null, resource_versions: input.resource };
  if (Object.entries(columns).some(([key, value]) => !isDeepStrictEqual(source[key], value))
    || row.id !== input.eventId || row.audit_event_id !== input.eventId || row.run_id !== (c.runId ?? null)
    || row.event_type !== input.action || !isDeepStrictEqual(row.payload, input) || row.projection_id !== null) throw Error('AUDIT_RELATION_CONFLICT');
  const occurredAt = new Date(source.occurred_at);
  if (!Number.isFinite(occurredAt.getTime())) throw Error('AUDIT_SOURCE_INVALID');
  return { sourceSchemaVersion: source.schema_version, sourceEventId: input.eventId, occurredAt: occurredAt.toISOString(),
    action: input.action, actor: input.actor, ...(modern.requestedByAuditId ? { requestedByAuditId: modern.requestedByAuditId } : {}),
    ...(modern.executedEmployee ? { executedEmployee: modern.executedEmployee } : {}), correlation: input.correlation,
    resource: input.resource, outcome: input.outcome, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), changes: input.changes,
    canonicalSha256: createHash('sha256').update(canonicalJson(input)).digest('hex') };
}

/** Canonical DB reads share the projection's strict parser without requiring an outbox delivery. */
export function summarizeAuditSource(source: Record<string, any>) {
  return summaryFor({id:source.id,audit_event_id:source.id,run_id:source.run_id,event_type:source.action,
    payload:source.canonical_payload,attempts:0,source,projection_id:null});
}

async function retry(client: pg.PoolClient, row: Pick<ClaimedRow, 'id'>, code: FailureCode, now: Date) {
  await client.query(`UPDATE audit_outbox SET attempts=LEAST(attempts::bigint+1,2147483647),
    next_attempt_at=$2::timestamptz+(ARRAY[1,2,4,8,16,30])[LEAST(attempts,5)+1]*INTERVAL '1 second',last_error_code=$3
    WHERE id=$1 AND published_at IS NULL`, [row.id, now, code]);
}

export async function projectAuditOutbox(pool: pg.Pool, options: { limit: number; now: Date }): Promise<{ projected: number; remaining: number; publishedAuditIds: string[] }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100
    || !(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) throw Error('AUDIT_PROJECTION_OPTIONS_INVALID');
  let client: pg.PoolClient | undefined;
  let claimed: ClaimedRow[] = [];
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2000ms'");
    // Shared with future safe pruning; never evict a projection while published duplicates require it.
    await client.query('SELECT pg_advisory_xact_lock(918278)');
    const result = await client.query<ClaimedRow>(`SELECT o.id,o.audit_event_id,o.run_id,o.event_type,o.payload,o.attempts,
      to_jsonb(a) AS source,p.audit_event_id AS projection_id
      FROM audit_outbox o LEFT JOIN human_audit_events a ON a.id=o.audit_event_id
      LEFT JOIN audit_run_projection p ON p.audit_event_id=o.audit_event_id
      WHERE o.published_at IS NULL AND o.next_attempt_at<=$1 ORDER BY o.next_attempt_at,o.created_at,o.id
      LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [options.now, options.limit]);
    claimed = result.rows;
    let count = Number((await client.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n);
    const publishedAuditIds: string[] = [];
    const observationSummaries:unknown[]=[];
    for (const row of claimed) {
      await client.query('SAVEPOINT audit_projection_row');
      try {
        const summary = summaryFor(row);
        if (count >= 100000) throw Error('AUDIT_PROJECTION_FAILED');
        // Copy the SQL timestamp directly: JavaScript Date would discard PostgreSQL microseconds.
        const inserted = await client.query(`INSERT INTO audit_run_projection(audit_event_id,run_id,correlation_id,occurred_at,summary)
          SELECT id,run_id,correlation_id,occurred_at,$2 FROM human_audit_events WHERE id=$1 RETURNING audit_event_id`, [row.audit_event_id, summary]);
        if (inserted.rowCount !== 1) throw Error('AUDIT_RELATION_CONFLICT');
        const marked = await client.query('UPDATE audit_outbox SET published_at=$2,last_error_code=NULL WHERE id=$1 AND published_at IS NULL RETURNING id', [row.id, options.now]);
        if (marked.rowCount !== 1) throw Error('AUDIT_RELATION_CONFLICT');
        await client.query('RELEASE SAVEPOINT audit_projection_row');
        count++; publishedAuditIds.push(row.audit_event_id);observationSummaries.push(summary);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT audit_projection_row');
        const message = error instanceof Error ? error.message : '';
        const code: FailureCode = message === 'AUDIT_SOURCE_INVALID' || message === 'AUDIT_RELATION_CONFLICT' ? message : 'AUDIT_PROJECTION_FAILED';
        await retry(client, row, code, options.now);
        await client.query('RELEASE SAVEPOINT audit_projection_row');
      }
    }
    const remaining = Number((await client.query('SELECT count(*)::int n FROM audit_outbox WHERE published_at IS NULL')).rows[0].n);
    await client.query('COMMIT');
    observeCommittedProjections(pool,observationSummaries);
    return { projected: publishedAuditIds.length, remaining, publishedAuditIds };
  } catch {
    if (client) {
      try {
        await client.query('ROLLBACK');
        // A lost COMMIT acknowledgement may already be durable; only still-pending rows get retry metadata.
        if (claimed.length) {
          await client.query('BEGIN');
          await client.query("SET LOCAL statement_timeout='2000ms'");
          await client.query('SELECT pg_advisory_xact_lock(918278)');
          for (const row of claimed) await retry(client, row, 'AUDIT_PROJECTION_FAILED', options.now);
          await client.query('COMMIT');
        }
      } catch { try { await client.query('ROLLBACK'); } catch { /* Connection outage: durable source remains pending. */ } }
    }
    throw Error('AUDIT_STORAGE_UNAVAILABLE');
  } finally { client?.release(); }
}
