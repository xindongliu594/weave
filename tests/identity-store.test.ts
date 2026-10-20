import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { loadIdentityConfig } from '../apps/api/src/identity-config.ts';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';
import { activateIdentityMode, upsertOidcIdentity, loadHumanPrincipal, appendHumanAudit } from '../apps/api/src/identity-store.ts';

const config = loadIdentityConfig({ WEIWU_AUTH_MODE: 'oidc', WEIWU_PUBLIC_ORIGIN: 'https://weiwu.example',
  WEIWU_OIDC_ISSUER: 'https://id.example/tenant/', WEIWU_OIDC_CLIENT_ID: 'weiwu', WEIWU_OIDC_CLIENT_SECRET: 'fixture-client-credential',
  WEIWU_SESSION_SECRETS: '["R5fKs9vX2aQ7wZ4nE8cJ6tH3yU0pL1dB"]',
  WEIWU_BOOTSTRAP_ISSUER: 'https://id.example/tenant/', WEIWU_BOOTSTRAP_SUBJECT: 'owner-sub' });
if (config.mode !== 'oidc') throw Error('test config');
const oidc = config;

async function testPool(schema: string): Promise<pg.Pool> {
  if (process.env.IDENTITY_TEST_DIRECT_PGLITE !== '1') return new pg.Pool({
    connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema},public`,
  });
  // Test-only SQL adapter: the socket bridge loses sync after a trigger raises inside a transaction.
  // Serialize checkouts as the normal PGlite preload does; this does not prove independent backend locks.
  const db = await PGlite.create();
  let pending = Promise.resolve();
  async function checkout() {
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(sql: string, params?: unknown[]) {
    const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows, rowCount: /^\s*SELECT\b/iu.test(sql) ? result.rows.length : result.affectedRows };
  }
  return {
    async query(sql: string, params?: unknown[]) { const release = await checkout(); try { return await query(sql,params); } finally { release(); } },
    async connect() { const release = await checkout(); return { query, release }; },
    async end() { await db.close(); },
  } as unknown as pg.Pool;
}

async function isolatedIdentitySchema(pool: pg.Pool, schema: string, work: (pinned: pg.Pool) => Promise<void>) {
  const client = await pool.connect();
  const pinned = { query: client.query.bind(client), connect: async () => ({ query: client.query.bind(client), release() {} }) } as unknown as pg.Pool;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema},public`);
    await client.query('CREATE TABLE departments (id text PRIMARY KEY)');
    await migrateIdentity(client);
    await work(pinned);
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { client.release(); }
  }
}

test('unused bootstrap closes permanently when prior administration or disabled identity is recognized',
  { skip: !process.env.DATABASE_URL && process.env.IDENTITY_TEST_DIRECT_PGLITE !== '1' }, async t => {
  const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;
  const pool = await testPool(schema);
  try {
    await t.test('prior administrators close bootstrap without a fictitious grant, even after they are disabled', async () => {
      await isolatedIdentitySchema(pool, `${schema}_admin`, async pinned => {
        await pinned.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES ('existing-admin',$1,'prior-admin','active','admin')", [oidc.issuer]);
        await activateIdentityMode(pinned, oidc);
        let state = (await pinned.query('SELECT * FROM identity_bootstrap')).rows[0];
        assert.ok(state.closed_at, 'recognizing existing administration must durably close bootstrap');
        assert.equal(state.closed_reason, 'existing-administration');
        assert.equal(state.consumed_at, null); assert.equal(state.consumed_by, null);
        await activateIdentityMode(pinned, oidc);
        const first = await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
        assert.equal(first.status, 'pending'); assert.equal(first.orgRole, 'member');
        await pinned.query("UPDATE human_users SET status='disabled' WHERE id='existing-admin'");
        const afterDisable = await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
        assert.equal(afterDisable.status, 'pending'); assert.equal(afterDisable.orgRole, 'member');
        await pinned.query("DELETE FROM human_users WHERE id='existing-admin'");
        const afterRemoval = await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
        assert.equal(afterRemoval.status, 'pending'); assert.equal(afterRemoval.orgRole, 'member');
        await pinned.query("UPDATE human_users SET status='disabled' WHERE id=$1", [first.id]);
        const later = await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
        assert.equal(later.status, 'disabled'); assert.equal(later.orgRole, 'member');
        state = (await pinned.query('SELECT * FROM identity_bootstrap')).rows[0];
        assert.ok(state.closed_at); assert.equal(state.consumed_at, null);
        assert.equal((await pinned.query("SELECT * FROM human_audit_events WHERE action='identity.bootstrap'")).rows.length, 0);
        assert.equal((await pinned.query("SELECT * FROM human_audit_events WHERE action='identity.bootstrap.closed'")).rows.length, 1);
        await assert.rejects(pinned.query("UPDATE identity_bootstrap SET consumed_at=now(),consumed_by=$1 WHERE id=1", [first.id]));
      });
    });
    await t.test('an existing disabled bootstrap identity cannot be reactivated by verified login', async () => {
      await isolatedIdentitySchema(pool, `${schema}_disabled`, async pinned => {
        await pinned.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES ('disabled-owner',$1,$2,'disabled','member')", [oidc.issuer, oidc.bootstrapSubject]);
        const user = await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
        assert.equal(user.status, 'disabled'); assert.equal(user.orgRole, 'member');
        const state = (await pinned.query('SELECT * FROM identity_bootstrap')).rows[0];
        assert.ok(state.closed_at); assert.equal(state.closed_reason, 'disabled-bootstrap-identity');
        assert.equal(state.consumed_at, null); assert.equal(state.consumed_by, null);
        assert.equal((await pinned.query("SELECT * FROM human_audit_events WHERE action='identity.bootstrap'")).rows.length, 0);
      });
    });
    await t.test('closure audit failure rolls back closure and identity creation together', async () => {
      await isolatedIdentitySchema(pool, `${schema}_audit`, async pinned => {
        await activateIdentityMode(pinned, oidc);
        await pinned.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES ('existing-admin',$1,'prior-admin','active','admin')", [oidc.issuer]);
        await pinned.query("CREATE FUNCTION reject_closure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity.bootstrap.closed' THEN RAISE EXCEPTION 'closure audit unavailable'; END IF; RETURN NEW; END $$");
        await pinned.query('CREATE TRIGGER reject_closure_audit BEFORE INSERT ON human_audit_events FOR EACH ROW EXECUTE FUNCTION reject_closure_audit()');
        await assert.rejects(upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: 'new-member' }));
        const state = (await pinned.query('SELECT * FROM identity_bootstrap')).rows[0];
        assert.equal(state.closed_at, null); assert.equal(state.consumed_at, null);
        assert.equal((await pinned.query("SELECT * FROM human_users WHERE subject='new-member'")).rows.length, 0);
        assert.equal((await pinned.query("SELECT status,org_role FROM human_users WHERE id='existing-admin'")).rows[0].org_role, 'admin');
        await pinned.query('DROP TRIGGER reject_closure_audit ON human_audit_events');
        await upsertOidcIdentity(pinned, oidc, { issuer: oidc.issuer, subject: 'new-member' });
        assert.ok((await pinned.query('SELECT closed_at FROM identity_bootstrap')).rows[0].closed_at);
        assert.equal((await pinned.query("SELECT * FROM human_audit_events WHERE action='identity.bootstrap.closed'")).rows.length, 1);
      });
    });
  } finally { await pool.end(); }
});

test('identity persistence, bootstrap, lifecycle and audit stay fail closed', { skip: !process.env.DATABASE_URL && process.env.IDENTITY_TEST_DIRECT_PGLITE !== '1' }, async t => {
  const schema = `identity_test_${randomUUID().replaceAll('-', '')}`;
  const rollbackSchema = `${schema}_rollback`;
  const pool = await testPool(schema);
  try {
    // Real PostgreSQL gets a private schema on every pool connection; the simulated runner
    // also needs SET because its single backend does not honor startup search_path options.
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema},public`);
    // Never connect to an implicit product URL or create tables in the default schema.
    await pool.query('CREATE TABLE departments (id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query("INSERT INTO departments VALUES ('old-dept', '{\"name\":\"preserved\"}')");
    await t.test('additive repeatable migration preserves old data and enforces constraints', async () => {
      await migrateIdentity(pool); await migrateIdentity(pool);
      assert.equal((await pool.query('SELECT * FROM departments')).rows[0].id, 'old-dept');
      for (const table of ['human_users', 'department_memberships', 'human_sessions', 'oidc_login_transactions', 'identity_bootstrap', 'human_audit_events', 'audit_outbox']) {
        await pool.query(`SELECT * FROM ${table} LIMIT 0`);
      }
      await assert.rejects(pool.query("INSERT INTO human_users (id,issuer,subject,status,org_role) VALUES ('bad','i','s','active','root')"));
      await assert.rejects(pool.query("INSERT INTO human_users (id,issuer,subject,session_epoch) VALUES ('bad','i','s',-1)"));
      await assert.rejects(pool.query("INSERT INTO department_memberships (department_id,user_id,role) VALUES ('missing','missing','manager')"));
    });
    await t.test('OIDC activation persists and forbids local downgrade', async () => {
      await activateIdentityMode(pool, { mode: 'legacy-local' });
      await activateIdentityMode(pool, oidc); await activateIdentityMode(pool, oidc);
      await assert.rejects(activateIdentityMode(pool, { mode: 'legacy-local' }));
    });
    let adminId = '';
    await t.test('exact issuer/subject only, same email never links, bootstrap consumes once', async () => {
      const other = await upsertOidcIdentity(pool, oidc, { issuer: oidc.issuer, subject: 'other', email: 'same@example.com' });
      assert.equal(other.status, 'pending'); assert.equal(other.orgRole, 'member');
      await assert.rejects(upsertOidcIdentity(pool, oidc, { issuer: oidc.issuer.slice(0, -1), subject: oidc.bootstrapSubject }));
      const [a, b] = await Promise.all([1, 2].map(() => upsertOidcIdentity(pool, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject, email: 'same@example.com' })));
      adminId = a.id;
      assert.equal(a.id, b.id); assert.notEqual(a.id, other.id); assert.equal(a.orgRole, 'admin'); assert.equal(a.status, 'active');
      assert.equal((await pool.query("SELECT * FROM human_audit_events WHERE action='identity.bootstrap'" )).rowCount, 1);
      await assert.rejects(pool.query('INSERT INTO human_users (id,issuer,subject) VALUES ($1,$2,$3)', ['duplicate', oidc.issuer, oidc.bootstrapSubject]));
      await pool.query("UPDATE human_users SET status='disabled',org_role='member' WHERE id=$1", [adminId]);
      const later = await upsertOidcIdentity(pool, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject });
      assert.equal(later.orgRole, 'member'); assert.equal(later.status, 'disabled');
      await pool.query("UPDATE human_users SET status='active',org_role='admin' WHERE id=$1", [adminId]);
    });
    await t.test('current user role, status and epoch control session with strict time boundaries', async () => {
      const now = new Date('2026-10-20T12:00:00.000Z');
      const session = { userId: adminId, sessionId: 's1', sessionEpoch: 0, authenticatedAt: new Date(now.getTime() - 1000).toISOString(), createdAt: new Date(now.getTime() - 1000).toISOString(), lastSeenAt: new Date(now.getTime() - 1000).toISOString() };
      assert.equal((await loadHumanPrincipal(pool, session, now))?.orgRole, 'admin');
      for (const [key, delta] of [['lastSeenAt', 30 * 60_000], ['createdAt', 8 * 60 * 60_000], ['authenticatedAt', 8 * 60 * 60_000]] as const) {
        const atBoundary = { ...session, [key]: new Date(now.getTime() - delta).toISOString() };
        assert.equal(await loadHumanPrincipal(pool, atBoundary, now), null, key);
        assert.ok(await loadHumanPrincipal(pool, { ...session, [key]: new Date(now.getTime() - delta + 1).toISOString() }, now), key);
      }
      for (const key of ['authenticatedAt','createdAt','lastSeenAt'] as const) {
        for (const value of ['invalid', new Date(now.getTime() + 1).toISOString()]) assert.equal(await loadHumanPrincipal(pool, { ...session, [key]: value }, now), null);
      }
      assert.equal(await loadHumanPrincipal(pool, session, new Date(NaN)), null);
      assert.equal(await loadHumanPrincipal(pool, { ...session, sessionEpoch: 1 }, now), null);
      await pool.query("UPDATE human_users SET status='disabled' WHERE id=$1", [adminId]);
      assert.equal(await loadHumanPrincipal(pool, session, now), null);
      await pool.query("UPDATE human_users SET status='active',org_role='auditor',session_epoch=1 WHERE id=$1", [adminId]);
      assert.equal(await loadHumanPrincipal(pool, session, now), null);
      assert.equal((await loadHumanPrincipal(pool, { ...session, sessionEpoch: 1 }, now))?.orgRole, 'auditor');
      assert.equal(await loadHumanPrincipal(pool, { ...session, userId: 'missing' }, now), null);
    });
    await t.test('audit is constrained, append only and stores no arbitrary payload', async () => {
      const event = { actor: { kind: 'system' as const, service: 'identity' }, action: 'identity.user.updated' as const, resourceType: 'human_user' as const, resourceId: adminId, outcome: 'success' as const, changes: { status: 'active' as const } };
      const id = await appendHumanAudit(pool, event);
      assert.ok((await pool.query('SELECT * FROM human_audit_events WHERE id=$1', [id])).rows[0]);
      await assert.rejects(appendHumanAudit(pool, { ...event, token: 'secret' } as never));
      await assert.rejects(appendHumanAudit(pool, { ...event, changes: { password: 'secret' } } as never));
      await assert.rejects(appendHumanAudit(pool, { ...event, actor: { ...event.actor, accessToken: 'secret' } } as never));
      const changes = { status: 'active' as const };
      Object.defineProperty(changes, 'toJSON', { value: () => ({ accessToken: 'secret' }), enumerable: false });
      await assert.rejects(appendHumanAudit(pool, { ...event, changes }));
      await assert.rejects(appendHumanAudit(pool, { ...event, changes: Object.create({ accessToken: 'secret' }) }));
      await assert.rejects(pool.query('UPDATE human_audit_events SET action=action WHERE id=$1', [id]));
      await assert.rejects(pool.query('DELETE FROM human_audit_events WHERE id=$1', [id]));
    });
    await t.test('audit failure rolls back a new identity and bootstrap grant', async () => {
      await pool.query("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$");
      await pool.query('CREATE TRIGGER reject_test_audit BEFORE INSERT ON human_audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit()');
      await assert.rejects(upsertOidcIdentity(pool, oidc, { issuer: oidc.issuer, subject: 'rollback-user' }));
      assert.equal((await pool.query("SELECT * FROM human_users WHERE subject='rollback-user'")).rowCount, 0);
      await pool.query('DROP TRIGGER reject_test_audit ON human_audit_events');
      // A separate schema represents a fresh installation with an unused bootstrap.
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA ${rollbackSchema}`); await client.query(`SET search_path TO ${rollbackSchema},public`);
        await client.query('CREATE TABLE departments (id text PRIMARY KEY)'); await migrateIdentity(client);
        await client.query(`CREATE TRIGGER reject_test_audit BEFORE INSERT ON human_audit_events FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_test_audit()`);
        // Pin this entire fresh-bootstrap check to the schema-configured connection.
        const pinnedPool = { connect: async () => ({ query: client.query.bind(client), release() {} }) } as unknown as pg.Pool;
        await assert.rejects(upsertOidcIdentity(pinnedPool, oidc, { issuer: oidc.issuer, subject: oidc.bootstrapSubject }));
        assert.equal((await client.query('SELECT * FROM human_users')).rowCount, 0);
        assert.equal((await client.query('SELECT consumed_at FROM identity_bootstrap')).rows[0].consumed_at, null);
      } finally { await client.query(`SET search_path TO ${schema},public`); client.release(); }
    });
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${rollbackSchema} CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally { await pool.end(); }
  }
});
