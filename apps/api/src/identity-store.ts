import { appendHumanAudit } from './audit-events.ts';
export { appendHumanAudit, type HumanAuditEvent } from './audit-events.ts';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { IdentityQueryExecutor } from './identity-schema.ts';
import { identityText, orgRoles, type HumanPrincipal, type HumanStatus, type HumanUser,
  type IdentityConfig, type OidcIdentityConfig, type OrgRole } from './identity-types.ts';

type IdentityPool = Pick<pg.Pool, 'connect'>;
type BootstrapRow = { expected_fingerprint: string | null; activated_at: Date | null; consumed_at: Date | null; closed_at: Date | null };
type UserRow = { id: string; issuer: string; subject: string; display_name: string | null; email: string | null;
  status: HumanStatus; org_role: OrgRole; session_epoch: string; version: number };

async function transaction<T>(pool: IdentityPool, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

function fingerprint(config: OidcIdentityConfig): string {
  return createHash('sha256').update(JSON.stringify([config.bootstrapIssuer, config.bootstrapSubject])).digest('hex');
}

// Every change to the active-administrator set takes this lock before user rows.
export async function lockIdentityAdministration(db: IdentityQueryExecutor): Promise<BootstrapRow> {
  const { rows } = await db.query<BootstrapRow>('SELECT expected_fingerprint,activated_at,consumed_at,closed_at FROM identity_bootstrap WHERE id=1 FOR UPDATE');
  if (!rows[0]) throw Error('Identity bootstrap state is missing');
  return rows[0];
}

async function closeBootstrap(db: IdentityQueryExecutor, state: BootstrapRow,
  reason: 'existing-administration' | 'disabled-bootstrap-identity'): Promise<void> {
  await db.query('UPDATE identity_bootstrap SET closed_at=now(),closed_reason=$1,version=version+1 WHERE id=1', [reason]);
  await appendHumanAudit(db, { actor: { kind: 'system', service: 'identity-bootstrap' }, action: 'identity.bootstrap.closed',
    resourceType: 'identity_mode', resourceId: 'oidc', outcome: 'success', reason });
  state.closed_at = new Date();
}

async function activateLocked(db: IdentityQueryExecutor, state: BootstrapRow, config: IdentityConfig): Promise<void> {
  if (config.mode === 'legacy-local') {
    if (state.activated_at) throw Error('OIDC activation forbids legacy-local downgrade');
    return;
  }
  if (config.issuer !== config.bootstrapIssuer || !identityText(config.bootstrapSubject)) throw Error('Invalid bootstrap identity');
  const expected = fingerprint(config);
  if (state.expected_fingerprint && state.expected_fingerprint !== expected) throw Error('Bootstrap identity configuration changed');
  if (!state.activated_at) {
    await db.query('UPDATE identity_bootstrap SET expected_fingerprint=$1,activated_at=now(),version=version+1 WHERE id=1', [expected]);
    await appendHumanAudit(db, { actor: { kind: 'system', service: 'identity' }, action: 'identity.mode.activated',
      resourceType: 'identity_mode', resourceId: 'oidc', outcome: 'success' });
  }
  if (!state.consumed_at && !state.closed_at) {
    // Any retained administrator is evidence of established administration, including a disabled one.
    const { rows } = await db.query<Pick<UserRow, 'org_role'>>(`SELECT org_role FROM human_users
      WHERE org_role='admin' OR (issuer=$1 AND subject=$2 AND status='disabled') ORDER BY id FOR UPDATE`,
    [config.bootstrapIssuer, config.bootstrapSubject]);
    if (rows.length) await closeBootstrap(db, state, rows.some(row => row.org_role === 'admin')
      ? 'existing-administration' : 'disabled-bootstrap-identity');
  }
}

export async function activateIdentityMode(pool: IdentityPool, config: IdentityConfig): Promise<void> {
  await transaction(pool, async db => activateLocked(db, await lockIdentityAdministration(db), config));
}

function humanUser(row: UserRow): HumanUser {
  return { id: row.id, issuer: row.issuer, subject: row.subject, displayName: row.display_name, email: row.email,
    status: row.status, orgRole: row.org_role, sessionEpoch: Number(row.session_epoch), version: row.version };
}

/** Trust boundary: issuer/subject must come from claims already verified by the OIDC library, never HTTP request fields. */
export async function upsertOidcIdentity(pool: IdentityPool, config: OidcIdentityConfig,
  claims: { issuer: string; subject: string; displayName?: string; email?: string }): Promise<HumanUser> {
  if (claims.issuer !== config.issuer || !identityText(claims.subject) ||
    (claims.displayName !== undefined && !identityText(claims.displayName)) ||
    (claims.email !== undefined && !identityText(claims.email))) throw Error('Invalid verified OIDC identity');
  return transaction(pool, async db => {
    const state = await lockIdentityAdministration(db);
    await activateLocked(db, state, config);
    // All bootstrap candidates use this durable singleton lock, including duplicate callbacks.
    const bootstrap = !state.consumed_at && !state.closed_at
      && claims.issuer === config.bootstrapIssuer && claims.subject === config.bootstrapSubject;
    const { rows } = await db.query<UserRow>(`
      INSERT INTO human_users(id,issuer,subject,display_name,email,status,org_role)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(issuer,subject) DO UPDATE SET
        display_name=COALESCE(EXCLUDED.display_name,human_users.display_name), email=COALESCE(EXCLUDED.email,human_users.email),
        status=CASE WHEN $8 AND human_users.status<>'disabled' THEN 'active' ELSE human_users.status END,
        org_role=CASE WHEN $8 AND human_users.status<>'disabled' THEN 'admin' ELSE human_users.org_role END,
        updated_at=now(),version=human_users.version+1
      RETURNING *`, [randomUUID(), claims.issuer, claims.subject, claims.displayName ?? null, claims.email ?? null,
      bootstrap ? 'active' : 'pending', bootstrap ? 'admin' : 'member', bootstrap]);
    const user = humanUser(rows[0]);
    if (bootstrap && user.status === 'disabled') {
      // Preserve a disabled identity even if it appeared after the initial bootstrap-state check.
      await closeBootstrap(db, state, 'disabled-bootstrap-identity');
    } else if (bootstrap) {
      await db.query('UPDATE identity_bootstrap SET consumed_at=now(),consumed_by=$1,version=version+1 WHERE id=1', [user.id]);
      await appendHumanAudit(db, { actor: { kind: 'system', service: 'identity-bootstrap' }, action: 'identity.bootstrap',
        resourceType: 'human_user', resourceId: user.id, outcome: 'success', changes: { status: 'active', orgRole: 'admin' } });
    }
    await appendHumanAudit(db, { actor: { kind: 'system', service: 'oidc' }, action: 'identity.login',
      resourceType: 'human_user', resourceId: user.id, outcome: 'success' });
    return user;
  });
}

export type HumanSessionReference = { userId: string; sessionId: string; sessionEpoch: number;
  authenticatedAt: string; createdAt: string; lastSeenAt: string };
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 8 * 60 * 60_000;

export async function loadHumanPrincipal(db: IdentityQueryExecutor, session: HumanSessionReference,
  now = new Date()): Promise<HumanPrincipal | null> {
  if (!session || !identityText(session.userId) || !identityText(session.sessionId)
    || !Number.isSafeInteger(session.sessionEpoch) || session.sessionEpoch < 0) return null;
  const current = now.getTime();
  const times = [session.authenticatedAt, session.createdAt, session.lastSeenAt].map(value =>
    typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(current) || times.some(value => !Number.isFinite(value) || value > current)
    || current - times[0] >= ABSOLUTE_MS || current - times[1] >= ABSOLUTE_MS || current - times[2] >= IDLE_MS) return null;
  const { rows } = await db.query<UserRow>('SELECT * FROM human_users WHERE id=$1', [session.userId]);
  const user = rows[0];
  if (!user || user.status !== 'active' || !orgRoles.includes(user.org_role)
    || Number(user.session_epoch) !== session.sessionEpoch) return null;
  return { kind: 'human', userId: user.id, sessionId: session.sessionId, issuer: user.issuer, subject: user.subject,
    orgRole: user.org_role, sessionEpoch: session.sessionEpoch, authenticatedAt: session.authenticatedAt };
}
