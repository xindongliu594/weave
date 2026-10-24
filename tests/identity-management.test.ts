import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';
import { loadHumanPrincipal } from '../apps/api/src/identity-store.ts';
import type { HumanPrincipal, Principal } from '../apps/api/src/identity-types.ts';
import { identityPostgresPool, identityPostgresUrl } from './fixtures/identity/postgres.ts';

const nativeUrl = process.env.IDENTITY_MANAGEMENT_POSTGRES_URL;
if (nativeUrl) identityPostgresUrl(nativeUrl);
else {
  assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Run with scripts/test-integration.mjs or an explicit owned identity PostgreSQL URL');
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}
let pool: pg.Pool, server: ReturnType<ReturnType<typeof express>['listen']>, base: string;
let failAudit = false;
const principal = (id: string, overrides: Partial<HumanPrincipal> = {}): HumanPrincipal => ({ kind: 'human', userId: id, sessionId: `session-${id}`,
  issuer: 'https://issuer.example', subject: id, orgRole: 'admin', sessionEpoch: 0, authenticatedAt: new Date().toISOString(), ...overrides });
const actors = new Map<string, Principal>();
const request = async (method: string, path: string, body?: unknown, actor = 'admin', extraHeaders: Record<string,string> = {}) => {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-actor': actor, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const user = async (id: string) => (await pool.query('SELECT * FROM human_users WHERE id=$1', [id])).rows[0];

before(async () => {
  pool = nativeUrl ? await identityPostgresPool(nativeUrl) : new pg.Pool({ connectionString: process.env.DATABASE_URL });
  if (!nativeUrl) { await pool.query('CREATE TABLE departments(id text PRIMARY KEY, deleted_at timestamptz)'); await migrateIdentity(pool); }
  else await pool.query('ALTER TABLE departments ADD COLUMN deleted_at timestamptz');
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.principal = actors.get(req.get('x-test-actor') ?? ''); next(); });
  // Only the audit storage fault is injected; HTTP, row locks, changes and rollback use the real database.
  const faultPool = { async connect() { const client = await pool.connect(); return {
    query: (sql: string, values?: unknown[]) => {
      if (failAudit && sql.includes('INSERT INTO human_audit_events')) throw Error('Injected audit storage outage');
      return client.query(sql, values);
    }, release: () => client.release(),
  }; } } as Pick<pg.Pool, 'connect'>;
  const modulePath = '../apps/api/src/identity-management.ts';
  try { const { identityManagementRouter } = await import(modulePath); app.use('/api', identityManagementRouter(faultPool)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.status ?? (error.name === 'ZodError' ? 422 : 500)).json({ code: error.code ?? 'REQUEST_FAILED' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit = false; actors.clear();
  await pool.query('TRUNCATE human_users,departments CASCADE');
  await pool.query('INSERT INTO identity_bootstrap(id) VALUES(1)');
  await pool.query("INSERT INTO departments(id) VALUES('dept-a'),('dept-b')");
  await pool.query(`INSERT INTO human_users(id,issuer,subject,display_name,email,status,org_role) VALUES
    ('admin','https://issuer.example','admin','Administrator','admin@example.test','active','admin'),
    ('second','https://issuer.example','second','Second','second@example.test','active','admin'),
    ('pending','https://issuer.example','pending','Pending','pending@example.test','pending','member'),
    ('member','https://issuer.example','member','Member','member@example.test','active','member'),
    ('disabled','https://issuer.example','disabled','Disabled','disabled@example.test','disabled','member')`);
  for (const id of ['admin','second','pending','member','disabled']) actors.set(id, principal(id));
  actors.set('local', { kind: 'local-owner' }); actors.set('device', { kind: 'device', deviceId: 'device' });
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await pool?.end(); });

test('administrator can paginate safe user profiles without exposing identity or session secrets', async () => {
  const first = await request('GET', '/api/identity/users?limit=2');
  assert.equal(first.status, 200); assert.equal(first.body.items.length, 2); assert.ok(first.body.nextCursor);
  assert.deepEqual(Object.keys(first.body.items[0]).sort(), ['displayName','email','id','orgRole','status','version']);
  const second = await request('GET', `/api/identity/users?limit=2&cursor=${first.body.nextCursor}`);
  assert.equal(second.status, 200); assert.equal(second.body.items.some((item: any) => first.body.items.some((old: any) => old.id === item.id)), false);
  const pending = await request('GET', '/api/identity/users?status=pending');
  assert.deepEqual(pending.body.items.map((item: any) => item.id), ['pending']);
});

test('current database status, role and epoch override a stale trusted HTTP principal', async () => {
  for (const actor of ['pending','disabled','member','local','device','missing']) assert.equal((await request('GET', '/api/identity/users', undefined, actor)).status, 403);
  await pool.query("UPDATE human_users SET session_epoch=1 WHERE id='admin'");
  assert.equal((await request('PATCH', '/api/identity/users/pending', { version: 1, status: 'active' })).status, 403);
  assert.equal((await user('pending')).status, 'pending');
});

test('request body and headers cannot choose the actor and malformed mutations leave no changes', async () => {
  for (const extra of [{ actorId: 'second' }, { sessionEpoch: 99 }, { role: 'admin' }, { version: 0 }, { status: 'unknown' }, {}]) {
    const input = Object.keys(extra).length ? { version: 1, status: 'active', ...extra } : { version: 1 };
    assert.equal((await request('PATCH', '/api/identity/users/pending', input)).status, 422);
  }
  const changed = await request('PATCH', '/api/identity/users/pending', { version: 1, status: 'active' }, 'admin', { 'x-user-id': 'second', 'x-org-role': 'admin' });
  assert.equal(changed.status, 200); assert.equal(changed.body.status, 'active'); assert.equal(changed.body.version, 2);
  const rows = (await pool.query("SELECT * FROM human_audit_events WHERE action='identity.user.updated'")).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].actor_user_id, 'admin'); assert.equal(rows[0].schema_version, 2);
  assert.equal(rows[0].authority_evidence.principalKey, 'human:admin'); assert.equal(rows[0].authority_evidence.policyVersion, 'identity-management-v1');
  assert.ok(rows[0].request_id); assert.equal((await pool.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 1);
});

test('stale user versions cannot overwrite a newer administrator decision', async () => {
  assert.equal((await request('PATCH', '/api/identity/users/pending', { version: 1, status: 'active' })).status, 200);
  assert.equal((await request('PATCH', '/api/identity/users/pending', { version: 1, orgRole: 'admin' })).status, 409);
  assert.equal((await user('pending')).org_role, 'member');
});

test('disabling and explicit session revocation invalidate the next authenticated request', async () => {
  const session = { userId: 'second', sessionId: 'session-second', sessionEpoch: 0, authenticatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
  assert.ok(await loadHumanPrincipal(pool, session));
  assert.equal((await request('POST', '/api/identity/users/second/revoke-sessions', { version: 1 })).status, 200);
  assert.equal(Number((await user('second')).session_epoch), 1); assert.equal(await loadHumanPrincipal(pool, session), null);
  assert.equal((await request('GET', '/api/identity/users', undefined, 'second')).status, 403);
  assert.equal((await request('PATCH', '/api/identity/users/second', { version: 2, status: 'disabled' })).status, 200);
  assert.equal(Number((await user('second')).session_epoch), 2);
  assert.equal((await request('POST', '/api/identity/users/second/revoke-sessions', { version: 2 })).status, 409);
});

test('the last active administrator cannot be disabled or demoted', async () => {
  await pool.query("UPDATE human_users SET status='disabled' WHERE id='second'");
  for (const change of [{ status: 'disabled' }, { status: 'pending' }, { orgRole: 'member' }, { orgRole: 'auditor' }]) {
    assert.equal((await request('PATCH', '/api/identity/users/admin', { version: 1, ...change })).status, 409);
  }
  const row = await user('admin'); assert.equal(row.status, 'active'); assert.equal(row.org_role, 'admin'); assert.equal(row.version, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
});

test('memberships use version CAS and preserve current grants and administrator attribution', async () => {
  const path = '/api/identity/departments/dept-a/members/member';
  assert.equal((await request('PUT', path, { version: 0, role: 'operator', canApprove: true })).status, 200);
  let row = (await pool.query("SELECT * FROM department_memberships WHERE user_id='member'")).rows[0];
  assert.equal(row.role, 'operator'); assert.equal(row.can_approve, true); assert.equal(row.version, 1); assert.equal(row.granted_by, 'admin');
  assert.equal((await request('PUT', path, { version: 0, role: 'manager', canApprove: true })).status, 409);
  assert.equal((await request('PUT', path, { version: 1, role: 'viewer', canApprove: false })).status, 200);
  row = (await pool.query("SELECT * FROM department_memberships WHERE user_id='member'")).rows[0];
  assert.equal(row.role, 'viewer'); assert.equal(row.can_approve, false); assert.equal(row.version, 2);
  const listed = await request('GET', '/api/identity/departments/dept-a/members');
  assert.equal(listed.status, 200); assert.equal(listed.body.items[0].userId, 'member'); assert.equal(listed.body.items[0].version, 2);
  assert.equal((await request('DELETE', path, { version: 1 })).status, 409);
  assert.equal((await request('DELETE', path, { version: 2 })).status, 200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM department_memberships')).rows[0].n, 0);
  const audit = (await pool.query("SELECT actor_user_id,schema_version,resource_versions FROM human_audit_events WHERE action='identity.membership.removed'")).rows[0];
  assert.equal(audit.actor_user_id, 'admin'); assert.equal(audit.schema_version, 2); assert.equal(audit.resource_versions.id, 'member'); assert.deepEqual(audit.resource_versions.departmentIds, ['dept-a']);
});

test('invalid, missing and unauthorized membership targets cannot acquire grants', async () => {
  for (const [path, body, actor, status] of [
    ['/api/identity/departments/dept-a/members/member', { version: 0, role: 'owner', canApprove: true }, 'admin', 422],
    ['/api/identity/departments/dept-a/members/member', { version: 0, role: 'viewer', canApprove: true }, 'admin', 422],
    ['/api/identity/departments/dept-a/members/member', { version: 0, role: 'operator', canApprove: false, actorId: 'second' }, 'admin', 422],
    ['/api/identity/departments/missing/members/member', { version: 0, role: 'operator', canApprove: false }, 'admin', 404],
    ['/api/identity/departments/dept-a/members/missing', { version: 0, role: 'operator', canApprove: false }, 'admin', 404],
    ['/api/identity/departments/dept-a/members/disabled', { version: 0, role: 'operator', canApprove: false }, 'admin', 422],
    ['/api/identity/departments/dept-a/members/member', { version: 0, role: 'operator', canApprove: false }, 'member', 403],
  ] as const) assert.equal((await request('PUT', path, body, actor)).status, status);
  assert.equal((await pool.query('SELECT count(*)::int n FROM department_memberships')).rows[0].n, 0);
});

test('a deleted and recreated membership cannot reuse a stale version', async () => {
  const path = '/api/identity/departments/dept-a/members/member';
  const created = await request('PUT', path, { version: 0, role: 'operator', canApprove: true });
  assert.equal(created.status, 200);
  assert.equal((await request('DELETE', path, { version: created.body.version })).status, 200);
  const recreated = await request('PUT', path, { version: 0, role: 'viewer', canApprove: false });
  assert.equal(recreated.status, 200);
  assert.equal((await request('PUT', path, { version: created.body.version, role: 'manager', canApprove: true })).status, 409);
  assert.equal((await pool.query("SELECT role FROM department_memberships WHERE user_id='member'")).rows[0].role, 'viewer');
});

test('audit storage failure rolls back user, epoch and membership mutations', async () => {
  failAudit = true;
  assert.equal((await request('PATCH', '/api/identity/users/pending', { version: 1, status: 'active' })).status, 500);
  assert.equal((await user('pending')).status, 'pending'); assert.equal((await user('pending')).version, 1);
  assert.equal((await request('POST', '/api/identity/users/second/revoke-sessions', { version: 1 })).status, 500);
  assert.equal(Number((await user('second')).session_epoch), 0);
  assert.equal((await request('PUT', '/api/identity/departments/dept-a/members/member', { version: 0, role: 'operator', canApprove: false })).status, 500);
  assert.equal((await pool.query('SELECT count(*)::int n FROM department_memberships')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 0);
});

for (const [name, change] of [['demotion', { orgRole: 'member' }], ['disable', { status: 'disabled' }]] as const) {
  test(`two independent PostgreSQL backends cannot remove the last administrator by simultaneous ${name}`, { skip: !nativeUrl }, async () => {
    const held = await pool.connect();
    let pending: Array<ReturnType<typeof request>> = [];
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM identity_bootstrap WHERE id=1 FOR UPDATE');
      const first = request('PATCH', '/api/identity/users/admin', { version: 1, ...change }, 'admin');
      const second = request('PATCH', '/api/identity/users/second', { version: 1, ...change }, 'second');
      pending = [first, second];
      const deadline = Date.now() + 5000; let blocked = 0;
      while (Date.now() < deadline) {
        await held.query('SELECT pg_stat_clear_snapshot()');
        blocked = Number((await held.query("SELECT count(*) AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock' AND query LIKE '%identity_bootstrap%'")).rows[0].n);
        if (blocked >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, 2, 'both independent mutation transactions must wait on the shared administration lock');
      await held.query('COMMIT');
      const responses = await Promise.all([first, second]); assert.deepEqual(responses.map(row => row.status).sort(), [200,409]);
      assert.equal((await pool.query("SELECT count(*)::int n FROM human_users WHERE status='active' AND org_role='admin'")).rows[0].n, 1);
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.allSettled(pending); }
  });
}

async function waitingBackend(blockerPid: number, query: string, settled: () => boolean): Promise<number | undefined> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`, [blockerPid, `%${query}%`]);
    if (rows[0]) return rows[0].pid;
    if (settled()) return undefined;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return undefined;
}

test('a concurrent PostgreSQL department archive rejects a waiting membership grant without side effects', { skip: !nativeUrl }, async () => {
  const archiver = await pool.connect();
  let pending: ReturnType<typeof request> | undefined, settled = false;
  try {
    const archivePid = Number((await archiver.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await archiver.query('BEGIN');
    // The real archive/restore routes update non-key department columns without taking user locks.
    await archiver.query("UPDATE departments SET deleted_at=now() WHERE id='dept-a' AND deleted_at IS NULL");
    pending = request('PUT', '/api/identity/departments/dept-a/members/member', { version: 0, role: 'operator', canApprove: true })
      .finally(() => { settled = true; });
    const waiter = await waitingBackend(archivePid, 'FROM departments', () => settled);
    await archiver.query('COMMIT');
    const response = await pending;
    assert.equal(response.status, 404, 'a grant must recheck live department state after the archive commits');
    assert.equal(response.body.code, 'IDENTITY_DEPARTMENT_NOT_FOUND');
    assert.ok(waiter, 'the grant must wait on the actual department row lock');
    assert.equal((await user('member')).version, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM department_memberships')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 0);
  } finally {
    await archiver.query('ROLLBACK'); archiver.release();
    if (pending) await Promise.allSettled([pending]);
  }
});

test('a PostgreSQL membership mutation holds its department lock through commit before archive', { skip: !nativeUrl }, async () => {
  const path = '/api/identity/departments/dept-a/members/member';
  const created = await request('PUT', path, { version: 0, role: 'operator', canApprove: true });
  assert.equal(created.status, 200);
  const holder = await pool.connect(), archiver = await pool.connect();
  let mutation: ReturnType<typeof request> | undefined, archive: Promise<pg.QueryResult> | undefined;
  let mutationSettled = false, archiveSettled = false;
  try {
    const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await holder.query('BEGIN');
    await holder.query("SELECT version FROM department_memberships WHERE department_id='dept-a' AND user_id='member' FOR UPDATE");
    mutation = request('PUT', path, { version: created.body.version, role: 'viewer', canApprove: false })
      .finally(() => { mutationSettled = true; });
    const mutationPid = await waitingBackend(holderPid, 'FROM department_memberships', () => mutationSettled);
    assert.ok(mutationPid, 'hold the membership mutation after its department check');
    archive = archiver.query("UPDATE departments SET deleted_at=now() WHERE id='dept-a' AND deleted_at IS NULL")
      .finally(() => { archiveSettled = true; });
    const archiveWaiter = await waitingBackend(mutationPid, 'UPDATE departments', () => archiveSettled);
    await holder.query('COMMIT');
    assert.equal((await mutation).status, 200);
    assert.equal((await archive).rowCount, 1);
    assert.ok(archiveWaiter, 'archive must wait until the membership transaction releases the live department');
    assert.equal((await pool.query("SELECT role FROM department_memberships WHERE user_id='member'")).rows[0].role, 'viewer');
    assert.ok((await pool.query("SELECT deleted_at FROM departments WHERE id='dept-a'")).rows[0].deleted_at);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    await Promise.allSettled([...(mutation ? [mutation] : []), ...(archive ? [archive] : [])]);
    archiver.release();
  }
});
