import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendAudit, appendHumanAudit } from '../apps/api/src/audit-events.ts';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';
import { createRunArchive, readRun } from '../services/agent-runtime/trace-store.mjs';

const modulePath = '../apps/api/src/audit-outbox.ts';
async function project(pool: pg.Pool, limit = 100, now = new Date(Date.now() + 60000)) {
  const api = await import(modulePath);
  assert.equal(typeof api.projectAuditOutbox, 'function');
  return api.projectAuditOutbox(pool, { limit, now });
}
const hash = 'a'.repeat(64);
function event(id = randomUUID()) { return { eventId: id, action: 'tool.dispatch' as const, actor: { kind: 'system' as const, service: 'coordinator' },
  authority: { decisionId: 'decision-1', checkedAt: '2026-10-20T00:00:00.000Z', policyVersion: 'resource-v1', principalKey: 'system:coordinator',
    departmentIds: ['dept-1'], membershipVersions: [{ departmentId: 'dept-1', version: 1 }], grantVersions: [], permissionSha256: hash },
  correlation: { correlationId: 'correlation-1', runId: 'run-1', operationId: 'operation-1' },
  resource: { type: 'tool_operation' as const, id: 'operation-1', departmentIds: ['dept-1'] }, outcome: 'success' as const,
  changes: { state: 'dispatched' as const, capabilityId: 'shell', capabilityVersion: '1', capabilitySha256: hash } }; }

async function fixture(work: (pool: pg.Pool) => Promise<void>) {
  let pool: pg.Pool;
  if (process.env.OBSERVABILITY_TEST_RUNNER === 'postgresql') {
    const { validateObservabilityTestConfig } = await import('../scripts/test-observability-postgres.mjs');
    const config = validateObservabilityTestConfig(process.env.OBSERVABILITY_TEST_DATABASE_URL, ['tests/audit-outbox.test.ts']);
    const schema = process.env.OBSERVABILITY_TEST_SCHEMA;
    assert.match(schema ?? '', /^weiwu_observation_[a-f0-9]{32}$/);
    const { default: postgres } = await import('pg');
    pool = new postgres.Pool({ connectionString: config.connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 3000 });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    assert.equal((await pool.query('SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0]?.owned, true);
    await pool.query(`DROP SCHEMA "${schema}" CASCADE; CREATE SCHEMA "${schema}"`);
  } else {
    const { PGlite } = await import('@electric-sql/pglite'); const db = await PGlite.create();
    let pending = Promise.resolve();
    const checkout = async () => { const before = pending; let release!: () => void; pending = new Promise<void>(resolve => { release = resolve; }); await before; return release; };
    const query = async (sql: string, params?: unknown[]) => { const result = params?.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1)!;
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; };
    pool = { async query(sql: string, params?: unknown[]) { const release = await checkout(); try { return await query(sql, params); } finally { release(); } },
      async connect() { const release = await checkout(); return { query, release }; }, async end() { await db.close(); } } as unknown as pg.Pool;
  }
  try {
    await pool.query("CREATE TABLE departments(id text PRIMARY KEY); INSERT INTO departments VALUES('dept-1'); CREATE TABLE business(id integer PRIMARY KEY,value integer); INSERT INTO business VALUES(1,0)");
    await migrateIdentity(pool); await work(pool);
  } finally { await pool.end(); }
}

test('invalid limit and time are refused before database checkout', async () => {
  const pool = { connect() { assert.fail('invalid options reached database'); } } as unknown as pg.Pool;
  for (const limit of [0, 101, -1, 1.5, Infinity, NaN]) await assert.rejects(project(pool, limit), /AUDIT_PROJECTION_OPTIONS_INVALID/);
  await assert.rejects(project(pool, 1, new Date(NaN)), /AUDIT_PROJECTION_OPTIONS_INVALID/);
});

test('bounded selection atomically publishes only committed local projections and survives repeated restarts', async () => fixture(async pool => {
  const ids = []; for (let i = 0; i < 3; i++) ids.push(await appendAudit(pool, event()));
  const first = await project(pool, 2); assert.equal(first.projected, 2); assert.equal(first.remaining, 1); assert.equal(first.publishedAuditIds.length, 2);
  const next = await project(pool, 2); assert.equal(next.projected, 1); assert.equal(next.remaining, 0);
  for (let i = 0; i < 3; i++) assert.deepEqual(await project(pool, 2), { projected: 0, remaining: 0, publishedAuditIds: [] });
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 3);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_outbox WHERE published_at IS NOT NULL')).rows[0].n, 3);
  assert.deepEqual(new Set([...first.publishedAuditIds, ...next.publishedAuditIds]), new Set(ids));
}));

test('full source and outbox linkage mismatch stays pending with fixed retry metadata', async () => fixture(async pool => {
  for (const mutation of ["run_id='forged'", "event_type='tool.result'", "payload=jsonb_set(payload,'{outcome}','\"unknown\"')", "id='different-outbox-id'"]) {
    const id = await appendAudit(pool, event()); await pool.query(`UPDATE audit_outbox SET ${mutation} WHERE audit_event_id=$1`, [id]);
  }
  const result = await project(pool); assert.equal(result.projected, 0); assert.equal(result.remaining, 4);
  const { rows } = await pool.query('SELECT published_at,last_error_code,attempts FROM audit_outbox');
  for (const row of rows) { assert.equal(row.published_at, null); assert.equal(row.last_error_code, 'AUDIT_RELATION_CONFLICT'); assert.equal(row.attempts, 1); }
}));

test('canonical source columns and strict normalized payload are verified before publication', async () => fixture(async pool => {
  const input = event(); await appendAudit(pool, input);
  await pool.query('ALTER TABLE human_audit_events DISABLE TRIGGER human_audit_append_only');
  await pool.query("UPDATE human_audit_events SET resource_id='forged' WHERE id=$1", [input.eventId]);
  await pool.query('ALTER TABLE human_audit_events ENABLE TRIGGER human_audit_append_only');
  assert.equal((await project(pool)).projected, 0);
  assert.equal((await pool.query('SELECT last_error_code FROM audit_outbox')).rows[0].last_error_code, 'AUDIT_RELATION_CONFLICT');
  const invalid = event(); await appendAudit(pool, invalid);
  await pool.query('ALTER TABLE human_audit_events DISABLE TRIGGER human_audit_append_only');
  await pool.query("UPDATE human_audit_events SET canonical_payload=canonical_payload || '{\"rawBody\":\"fixture-secret\"}'::jsonb WHERE id=$1", [invalid.eventId]);
  await pool.query('ALTER TABLE human_audit_events ENABLE TRIGGER human_audit_append_only');
  await project(pool);
  assert.equal((await pool.query('SELECT last_error_code FROM audit_outbox WHERE audit_event_id=$1', [invalid.eventId])).rows[0].last_error_code, 'AUDIT_SOURCE_INVALID');
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 0);
}));

test('projection hash uses complete deterministic canonical content and legacy attribution is preserved', async () => fixture(async pool => {
  const input = { eventId: 'event-hash', action: 'identity.login' as const, actor: { kind: 'unidentified' as const }, correlation: { correlationId: 'correlation-1' },
    resource: { type: 'human_user' as const, id: 'unknown', departmentIds: [] }, outcome: 'denied' as const, changes: {} };
  await appendAudit(pool, input);
  const legacy = await appendHumanAudit(pool, { actor: { kind: 'system', service: 's'.repeat(129) }, action: 'identity.user.updated', resourceType: 'human_user', resourceId: 'old', outcome: 'success', reason: 'private old reason' });
  assert.equal((await project(pool)).projected, 2);
  const row = (await pool.query('SELECT summary FROM audit_run_projection WHERE audit_event_id=$1', [input.eventId])).rows[0];
  const canonical = '{"action":"identity.login","actor":{"kind":"unidentified"},"changes":{},"correlation":{"correlationId":"correlation-1"},"eventId":"event-hash","outcome":"denied","resource":{"departmentIds":[],"id":"unknown","type":"human_user"}}';
  assert.equal(row.summary.canonicalSha256, createHash('sha256').update(canonical).digest('hex'));
  const old = (await pool.query('SELECT summary FROM audit_run_projection WHERE audit_event_id=$1', [legacy])).rows[0].summary;
  assert.equal(old.sourceSchemaVersion, 1); assert.deepEqual(old.actor, { kind: 'system', service: 's'.repeat(129) });
  assert.equal(old.reasonCode, 'legacy-reason-unclassified'); assert.equal(old.authority, undefined); assert.doesNotMatch(JSON.stringify(old), /private old reason/);
}));

test('projection preserves the source PostgreSQL microsecond timestamp for an identical published retry', async () => fixture(async pool => {
  await pool.query("ALTER TABLE human_audit_events ALTER COLUMN occurred_at SET DEFAULT '2026-10-20T00:00:00.123456Z'::timestamptz");
  const input = event(); await appendAudit(pool, input); assert.equal((await project(pool)).projected, 1);
  assert.equal((await pool.query('SELECT p.occurred_at=a.occurred_at AS same FROM audit_run_projection p JOIN human_audit_events a ON a.id=p.audit_event_id')).rows[0].same, true);
  assert.equal(await appendAudit(pool, input), input.eventId);
}));

test('retry follows bounded 1 2 4 8 16 30 second schedule without copying raw database errors', async () => fixture(async pool => {
  await appendAudit(pool, event());
  await pool.query("CREATE FUNCTION reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-secret database detail'; END $$; CREATE TRIGGER reject_projection BEFORE INSERT ON audit_run_projection FOR EACH ROW EXECUTE FUNCTION reject_projection()");
  let now = new Date(Date.now() + 60000);
  for (const [index, seconds] of [1, 2, 4, 8, 16, 30, 30].entries()) {
    assert.equal((await project(pool, 1, now)).projected, 0);
    const row = (await pool.query('SELECT * FROM audit_outbox')).rows[0];
    assert.equal(row.attempts, index + 1); assert.equal(row.last_error_code, 'AUDIT_PROJECTION_FAILED'); assert.equal(row.published_at, null);
    assert.equal(new Date(row.next_attempt_at).getTime() - now.getTime(), seconds * 1000); assert.doesNotMatch(JSON.stringify(row), /fixture-secret/);
    assert.equal((await project(pool, 1, new Date(now.getTime() + seconds * 1000 - 1))).projected, 0);
    assert.equal((await pool.query('SELECT attempts FROM audit_outbox')).rows[0].attempts, index + 1);
    now = new Date(now.getTime() + seconds * 1000);
  }
  await pool.query('DROP TRIGGER reject_projection ON audit_run_projection');
  assert.equal((await project(pool, 1, now)).projected, 1);
  assert.equal((await pool.query('SELECT last_error_code FROM audit_outbox')).rows[0].last_error_code, null);
}));

function crashPool(pool: pg.Pool, after: boolean): pg.Pool {
  let crashed = false;
  return { async connect() { const client = await pool.connect(); return { async query(sql: string, params?: unknown[]) {
    if (sql === 'COMMIT' && !crashed) { crashed = true; if (after) await client.query(sql); throw Error('fixture-secret connection lost'); }
    return client.query(sql, params);
  }, release: () => client.release() }; } } as unknown as pg.Pool;
}
test('crash before projection commit replays once without false publication', async () => fixture(async pool => {
  await appendAudit(pool, event());
  await assert.rejects(project(crashPool(pool, false)), /^Error: AUDIT_STORAGE_UNAVAILABLE$/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT published_at FROM audit_outbox')).rows[0].published_at, null);
  assert.equal((await project(pool, 1, new Date(Date.now() + 180000))).projected, 1);
}));
test('crash after projection commit does not duplicate after restart or invalidate source retry', async () => fixture(async pool => {
  const input = event(); await appendAudit(pool, input);
  await assert.rejects(project(crashPool(pool, true)), /^Error: AUDIT_STORAGE_UNAVAILABLE$/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 1);
  assert.deepEqual(await project(pool), { projected: 0, remaining: 0, publishedAuditIds: [] });
  assert.equal(await appendAudit(pool, input), input.eventId);
}));

test('commit failure recovery derives retry delay from the current persisted attempt count', async () => fixture(async pool => {
  const input = event(); await appendAudit(pool, input); let commitFailed = false, injected = false;
  const racing = { async connect() { const client = await pool.connect(); return { async query(sql: string, params?: unknown[]) {
    if (sql === 'COMMIT' && !commitFailed) { commitFailed = true; throw Error('lost commit'); }
    const result = await client.query(sql, params);
    if (sql === 'ROLLBACK' && commitFailed && !injected) {
      injected = true; await client.query('UPDATE audit_outbox SET attempts=5 WHERE audit_event_id=$1', [input.eventId]);
    }
    return result;
  }, release: () => client.release() }; } } as unknown as pg.Pool;
  const now = new Date(Date.now() + 60000);
  await assert.rejects(project(racing, 1, now), /AUDIT_STORAGE_UNAVAILABLE/);
  const row = (await pool.query('SELECT attempts,next_attempt_at FROM audit_outbox')).rows[0];
  assert.equal(row.attempts, 6); assert.equal(new Date(row.next_attempt_at).getTime() - now.getTime(), 30000);
}));

test('incomplete or archived JSONL cannot block local publication and active appender remains its only writer', async () => fixture(async pool => {
  const dir = await mkdtemp(join(tmpdir(), 'weiwu-outbox-'));
  try {
    const archive = createRunArchive(dir, { requirement: 'fixture', agents: [], tasks: [] }); const path = join(archive.dir, 'events.jsonl');
    const input = event(); input.correlation.runId = archive.id; await appendAudit(pool, input);
    const beforeActive = await readFile(path);
    const projected = project(pool); archive.append('runtime/status', { phase: 'running' });
    assert.equal((await projected).projected, 1);
    const detail = readRun(dir, archive.id)!;
    assert.equal(detail.integrity, 'ok'); assert.deepEqual(detail.events.map(event => event.type), ['run/created', 'runtime/status']);
    assert.equal((await readFile(path)).subarray(0, beforeActive.length).equals(beforeActive), true);
    await writeFile(path, '{"type":"incomplete'); const before = await readFile(path);
    await appendAudit(pool, event()); assert.equal((await project(pool)).projected, 1); assert.deepEqual(await readFile(path), before);
    await rm(path); await appendAudit(pool, event()); assert.equal((await project(pool)).projected, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('projection cap is serialized and never evicts evidence needed by published duplicates', async () => fixture(async pool => {
  await pool.query(`INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome)
    SELECT 'cap-'||n,'system','{"kind":"system","service":"historical"}','identity.login','human_user','old','success' FROM generate_series(1,100000) n;
    INSERT INTO audit_run_projection(audit_event_id,correlation_id,occurred_at,summary) SELECT id,id,occurred_at,'{}' FROM human_audit_events`);
  const input = event(); await appendAudit(pool, input); assert.equal((await project(pool)).projected, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 100000);
  const row = (await pool.query('SELECT published_at,last_error_code FROM audit_outbox')).rows[0];
  assert.equal(row.published_at, null); assert.equal(row.last_error_code, 'AUDIT_PROJECTION_FAILED'); assert.equal(await appendAudit(pool, input), input.eventId);
}));

test('two native publishers produce one projection using independent backends', { skip: process.env.OBSERVABILITY_TEST_RUNNER !== 'postgresql' }, async () => fixture(async pool => {
  const ids = []; for (let i = 0; i < 12; i++) ids.push(await appendAudit(pool, event()));
  const results = await Promise.all([project(pool, 8), project(pool, 8)]);
  assert.equal(results.reduce((sum, result) => sum + result.projected, 0), 12);
  assert.equal(new Set(results.flatMap(result => result.publishedAuditIds)).size, 12);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 12);
}));

test('native publisher skips a source row locked by another backend', { skip: process.env.OBSERVABILITY_TEST_RUNNER !== 'postgresql' }, async () => fixture(async pool => {
  const first = await appendAudit(pool, event()); const second = await appendAudit(pool, event());
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM audit_outbox WHERE audit_event_id=$1 FOR UPDATE', [first]);
    const result = await project(pool, 1); assert.deepEqual(result.publishedAuditIds, [second]); assert.equal(result.remaining, 1);
    await blocker.query('COMMIT'); assert.deepEqual((await project(pool, 1)).publishedAuditIds, [first]);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
}));

test('native competing publishers serialize the last projection capacity slot', { skip: process.env.OBSERVABILITY_TEST_RUNNER !== 'postgresql' }, async () => fixture(async pool => {
  await pool.query(`INSERT INTO human_audit_events(id,actor_kind,actor_snapshot,action,resource_type,resource_id,outcome)
    SELECT 'cap-'||n,'system','{"kind":"system","service":"historical"}','identity.login','human_user','old','success' FROM generate_series(1,99999) n;
    INSERT INTO audit_run_projection(audit_event_id,correlation_id,occurred_at,summary) SELECT id,id,occurred_at,'{}' FROM human_audit_events`);
  await appendAudit(pool, event()); await appendAudit(pool, event());
  const result = await Promise.all([project(pool, 1), project(pool, 1)]);
  assert.equal(result.reduce((sum, value) => sum + value.projected, 0), 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 100000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_outbox WHERE published_at IS NULL')).rows[0].n, 1);
}));

test('native worker process restart retains publication and source deduplication', { skip: process.env.OBSERVABILITY_TEST_RUNNER !== 'postgresql' }, async () => fixture(async pool => {
  const input = event(); await appendAudit(pool, input);
  async function worker() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/observability/project-once.ts'], { env: process.env });
    let output = '', errors = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => errors += value);
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0, errors); return JSON.parse(output);
  }
  assert.equal((await worker()).projected, 1);
  for (let i = 0; i < 2; i++) assert.deepEqual(await worker(), { projected: 0, remaining: 0, publishedAuditIds: [] });
  assert.equal(await appendAudit(pool, input), input.eventId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_run_projection')).rows[0].n, 1);
}));
