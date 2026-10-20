import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {createRequire} from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import type { IdentityQueryExecutor } from '../apps/api/src/identity-schema.ts';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';

import * as audit from '../apps/api/src/audit-events.ts';
const hash = 'a'.repeat(64);
const {revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
function authority() { return { decisionId: 'decision-1', checkedAt: '2026-10-20T00:00:00.000Z', policyVersion: 'resource-v1',
  principalKey: 'system:coordinator', departmentIds: ['dept-1'], membershipVersions: [{ departmentId: 'dept-1', version: 1 }],
  grantVersions: [], permissionSha256: hash }; }
function event(id = randomUUID()) { return { eventId: id, action: 'tool.dispatch' as const, actor: { kind: 'system' as const, service: 'coordinator' },
  authority: authority(), correlation: { correlationId: 'correlation-1', runId: 'run-1', operationId: 'operation-1' },
  resource: { type: 'tool_operation' as const, id: 'operation-1', departmentIds: ['dept-1'] }, outcome: 'success' as const,
  changes: { state: 'dispatched' as const, capabilityId: 'shell', capabilityVersion: '1', capabilitySha256: hash } }; }
async function fixture(work: (db: IdentityQueryExecutor, raw: PGlite) => Promise<void>) {
  assert.equal(typeof audit.appendAudit, 'function', 'shared appendAudit interface must exist');
  const raw = await PGlite.create();
  const db = { async query(sql: string, values?: unknown[]) { const result = values ? await raw.query(sql, values) : (await raw.exec(sql)).at(-1)!;
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } } as IdentityQueryExecutor;
  try { await db.query('CREATE TABLE departments(id text PRIMARY KEY); INSERT INTO departments VALUES (\'dept-1\'); CREATE TABLE business(id integer PRIMARY KEY, value integer); INSERT INTO business VALUES(1,0)');
    await migrateIdentity(db); await work(db, raw); } finally { await raw.close(); }
}

test('task_merge_accepts_actual_canonical_sha_revisions_and_rejects_numeric_versions',async()=>fixture(async db=>{
 const beforeRevision=revision([]),afterRevision=revision([{path:'result.txt',content:Buffer.from('result').toString('base64')}]);
 const input={...event(),action:'task.merge' as const,resource:{type:'task' as const,id:'task-1',departmentIds:['dept-1']},changes:{beforeRevision,afterRevision,scopeSha256:hash,state:'committed' as const}};
 const id=await audit.appendAudit(db,input);const row=(await db.query('SELECT changes FROM human_audit_events WHERE id=$1',[id])).rows[0];
 assert.equal(row.changes.beforeRevision,beforeRevision);assert.equal(row.changes.afterRevision,afterRevision);
 await assert.rejects(audit.appendAudit(db,{...input,eventId:randomUUID(),changes:{...input.changes,beforeRevision:1,afterRevision:2}} as never));
}));

test('successful_change_and_audit_rollback_together', async () => fixture(async db => {
  await db.query('BEGIN'); await db.query('UPDATE business SET value=1'); await audit.appendAudit(db, event()); await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT value FROM business')).rows[0].value, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 0);
  await db.query("CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON human_audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit()");
  await db.query('BEGIN'); await db.query('UPDATE business SET value=2'); await assert.rejects(audit.appendAudit(db, event())); await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT value FROM business')).rows[0].value, 0);
}));

test('outbox_failure_is_atomic_without_caller_transaction', async () => fixture(async db => {
  await db.query("CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$; CREATE TRIGGER reject_outbox BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()");
  await assert.rejects(audit.appendAudit(db, event()));
  assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 0);
}));

test('unknown_fields_raw_body_and_nonfinite_rejected', async () => fixture(async db => {
  const base = event(); let getterCalled = false;
  const getter = { ...base }; Object.defineProperty(getter, 'action', { enumerable: true, get() { getterCalled = true; return 'tool.dispatch'; } });
  const cycle = { ...base, changes: {} }; (cycle.changes as any).self = cycle;
  for (const bad of [ { ...base, body: 'secret' }, { ...base, changes: { arguments: 'secret' } },
    { ...base, changes: { state: 'dispatched', durationMs: Infinity } }, getter, cycle, Object.assign(Object.create({}), base),
    { ...base, authority: { ...authority(), checkedAt: '2026-02-30T00:00:00Z' } },
    { ...base, resource: { ...base.resource, id: 'x'.repeat(129) } }, { ...base, reasonCode: 'secret error' },
    { ...base, changes: { state: 'dispatched', capabilitySha256: 'not-a-hash' } },
    { ...base, changes: { state: 'dispatched', reason: 'secret' } }, { ...base, authority: undefined } ]) {
    await assert.rejects(audit.appendAudit(db, bad as never));
  }
  assert.equal(getterCalled, false); assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
}));

test('unidentified_cannot_claim_human', async () => fixture(async db => {
  assert.deepEqual(audit.auditActor(null), { kind: 'unidentified' });
  assert.throws(() => audit.auditActor({ kind: 'employee', employeeId: 'person' } as never));
  await assert.rejects(audit.appendAudit(db, { ...event(), actor: { kind: 'unidentified', userId: 'claimed' } } as never));
  await assert.rejects(audit.appendAudit(db, { ...event(), actor: { kind: 'unidentified' } }));
  await assert.rejects(audit.appendAudit(db, { ...event(), actor: { kind: 'human', userId: 'missing', orgRole: 'admin' } }));
}));

test('employee_is_execution_attribution', async () => fixture(async db => {
  const input = { ...event(), executedEmployee: { employeeId: 'employee-1', agentId: 'agent-1', sessionId: 'employee-session-1' } };
  const id = await audit.appendAudit(db, input);
  const row = (await db.query('SELECT * FROM human_audit_events WHERE id=$1', [id])).rows[0];
  assert.equal(row.actor_kind, 'system'); assert.equal(row.actor_user_id, null);
  assert.deepEqual(row.executed_employee, input.executedEmployee); assert.equal(row.schema_version, 2);
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_outbox WHERE audit_event_id=$1', [id])).rows[0].n, 1);
}));

test('legacy_event_stays_schema1', async () => fixture(async db => {
  await db.query("INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome) VALUES ('old','system','{\"kind\":\"system\",\"service\":\"legacy\"}','identity.login','human_user','historical','success')");
  await migrateIdentity(db); await migrateIdentity(db);
  const row = (await db.query("SELECT * FROM human_audit_events WHERE id='old'")).rows[0];
  assert.equal(row.schema_version, 1); assert.equal(row.source_event_id, null); assert.equal(row.authority_evidence, null);
  assert.equal(row.actor_user_id, null); assert.deepEqual(row.actor_snapshot, { kind: 'system', service: 'legacy' });
  await assert.rejects(db.query("UPDATE human_audit_events SET outcome='failure' WHERE id='old'"));
  await assert.rejects(db.query("DELETE FROM human_audit_events WHERE id='old'"));
}));

test('source_event_id_collision_checks_identical_payload', async () => fixture(async db => {
  const input = event(); const id = await audit.appendAudit(db, input);
  assert.equal(await audit.appendAudit(db, input), id);
  for (const bad of [{ ...input, outcome: 'unknown' }, { ...input, authority: { ...authority(), decisionId: 'different' } },
    { ...input, changes: { ...input.changes, capabilityVersion: '2' } }, { ...input, executedEmployee: { employeeId: 'e', agentId: 'a', sessionId: 's' } }]) {
    await assert.rejects(audit.appendAudit(db, bad as never), /AUDIT_SOURCE_CONFLICT/);
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 1);
  await db.query('DELETE FROM audit_outbox WHERE audit_event_id=$1', [id]);
  await assert.rejects(audit.appendAudit(db, input), /AUDIT_RELATION_CONFLICT/);
}));

test('published_duplicate_requires_matching_local_projection', async () => fixture(async db => {
  const input = event(); const id = await audit.appendAudit(db, input);
  await db.query('UPDATE audit_outbox SET published_at=now() WHERE audit_event_id=$1', [id]);
  await assert.rejects(audit.appendAudit(db, input), /AUDIT_RELATION_CONFLICT/);
  await db.query('INSERT INTO audit_run_projection(audit_event_id,run_id,correlation_id,occurred_at,summary) SELECT $1,$2,$3,occurred_at,$4 FROM human_audit_events WHERE id=$1', [id, 'run-1', 'correlation-1', {}]);
  assert.equal(await audit.appendAudit(db, input), id);
  await db.query("UPDATE audit_run_projection SET correlation_id='forged' WHERE audit_event_id=$1", [id]);
  await assert.rejects(audit.appendAudit(db, input), /AUDIT_RELATION_CONFLICT/);
}));

test('per_action_state_and_scoped_identity_authority_cannot_be_repurposed', async () => fixture(async db => {
  const input = event();
  await assert.rejects(audit.appendAudit(db, { ...input, changes: { ...input.changes, state: 'confirmed' } } as never));
  await assert.rejects(audit.appendAudit(db, { ...input, authority: { ...authority(), policyVersion: 'identity-bootstrap-v1', departmentIds: [], membershipVersions: [] } }));
  for (const action of ['identity.user.updated','identity.membership.updated'] as const) {
    await assert.rejects(audit.appendAudit(db, { ...input, action, resource: { type: action === 'identity.user.updated' ? 'human_user' : 'department_membership', id: 'target', departmentIds: [] },
      actor: { kind: 'system', service: 'identity-bootstrap' }, authority: { ...authority(), principalKey: 'system:identity-bootstrap', policyVersion: 'identity-bootstrap-v1', departmentIds: [], membershipVersions: [] }, changes: {} } as never));
  }
}));

test('canonical_department_and_authority_sets_are_sorted_without_mutating_input', async () => fixture(async db => {
  await db.query("INSERT INTO departments VALUES ('dept-2')");
  const input = event(); input.resource.departmentIds = ['dept-2','dept-1','dept-2']; input.authority.departmentIds = ['dept-2','dept-1'];
  input.authority.membershipVersions = [{ departmentId: 'dept-2', version: 2 }, { departmentId: 'dept-1', version: 1 }];
  const id = await audit.appendAudit(db, input);
  const row = (await db.query('SELECT canonical_payload FROM human_audit_events WHERE id=$1',[id])).rows[0];
  assert.deepEqual(row.canonical_payload.resource.departmentIds, ['dept-1','dept-2']);
  assert.deepEqual(row.canonical_payload.authority.membershipVersions, [{ departmentId: 'dept-1', version: 1 }, { departmentId: 'dept-2', version: 2 }]);
  assert.deepEqual(input.resource.departmentIds, ['dept-2','dept-1','dept-2']);
  assert.equal(await audit.appendAudit(db, { ...input, resource: { ...input.resource, departmentIds: ['dept-1','dept-2'] } }), id);
}));

test('pre_extension_history_is_preserved_by_two_migrations', async () => {
  const raw = await PGlite.create();
  const db = { async query(sql: string, values?: unknown[]) { const result = values ? await raw.query(sql, values) : (await raw.exec(sql)).at(-1)!;
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } } as IdentityQueryExecutor;
  try {
    await db.query(`CREATE TABLE departments(id text PRIMARY KEY);
      CREATE TABLE human_audit_events(id text PRIMARY KEY,occurred_at timestamptz DEFAULT now(),actor_kind text,actor_user_id text,
        actor_snapshot jsonb,action text,resource_type text,resource_id text,department_id text,request_id text,outcome text,reason text,changes jsonb DEFAULT '{}');
      CREATE TABLE audit_outbox(id text PRIMARY KEY,audit_event_id text UNIQUE REFERENCES human_audit_events(id),run_id text,event_type text,payload jsonb,created_at timestamptz DEFAULT now(),published_at timestamptz);
      INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome,reason) VALUES('history','system','{"kind":"system","service":"old"}','identity.login','human_user','unknown-user','success','retained historical reason');`);
    await migrateIdentity(db); await migrateIdentity(db);
    const row = (await db.query("SELECT * FROM human_audit_events WHERE id='history'")).rows[0];
    assert.equal(row.schema_version,1); assert.equal(row.actor_user_id,null); assert.equal(row.authority_evidence,null); assert.equal(row.source_event_id,null);
    assert.equal(row.reason,'retained historical reason'); assert.deepEqual(row.actor_snapshot,{kind:'system',service:'old'});
  } finally { await raw.close(); }
});



test('tool_effect_contract_reuses_workspace_classification', async () => fixture(async db => {
  const input = event();
  const id = await audit.appendAudit(db, { ...input, changes: { ...input.changes, effect: 'workspace' } });
  assert.equal((await db.query('SELECT changes FROM human_audit_events WHERE id=$1',[id])).rows[0].changes.effect,'workspace');
  await assert.rejects(audit.appendAudit(db, { ...event(), changes: { state: 'dispatched', effect: 'side-effect' } } as never));
}));


test('legacy actor identifiers keep their existing range without widening schema2', async () => fixture(async db => {
  const actor = { kind: 'system' as const, service: 's'.repeat(129) };
  const id = await audit.appendHumanAudit(db, { actor, action: 'identity.user.updated', resourceType: 'human_user', resourceId: 'old-id', outcome: 'success' });
  assert.equal((await db.query('SELECT actor_snapshot,schema_version,authority_evidence FROM human_audit_events WHERE id=$1',[id])).rows[0].actor_snapshot.service, actor.service);
  await assert.rejects(audit.appendAudit(db, { ...event(), actor }));
}));
