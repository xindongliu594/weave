import { createHash, randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { auditActor, appendAudit, type AuditInput } from './audit-events.ts';
import { lockIdentityAdministration } from './identity-store.ts';
import { identityText, principalKey, type HumanPrincipal, type HumanStatus, type OrgRole } from './identity-types.ts';

type IdentityPool = Pick<pg.Pool, 'connect'>;
type UserRow = { id: string; issuer: string; subject: string; display_name: string | null; email: string | null;
  status: HumanStatus; org_role: OrgRole; session_epoch: string; version: number };
const identifier = z.string().refine(value => identityText(value, 128), 'Invalid identity identifier');
const version = z.number().int().min(1).max(2147483646);
const pagination = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: identifier.optional() });
const usersQuery = pagination.extend({ status: z.enum(['pending', 'active', 'disabled']).optional() });
const userChange = z.strictObject({ version, status: z.enum(['pending', 'active', 'disabled']).optional(), orgRole: z.enum(['member', 'admin', 'auditor']).optional() })
  .refine(value => value.status !== undefined || value.orgRole !== undefined, 'A status or role change is required');
const membershipChange = z.strictObject({ version: version.or(z.literal(0)), role: z.enum(['viewer', 'operator', 'manager']), canApprove: z.boolean() })
  .refine(value => value.role !== 'viewer' || !value.canApprove, 'Viewers cannot approve tools');
const expectedVersion = z.strictObject({ version });
const safeUser = (row: UserRow) => ({ id: row.id, displayName: row.display_name, email: row.email, status: row.status, orgRole: row.org_role, version: row.version });
const forbidden = () => new AppError(403, '仅当前有效的企业管理员可管理人员', 'IDENTITY_ADMIN_REQUIRED');
const conflict = () => new AppError(409, '资料已变化，请刷新后重试', 'IDENTITY_VERSION_CONFLICT');

/** HTTP identity is supplied only by the authenticated API gate. Request fields never select an actor. */
export function requireHttpHuman(res: Response): HumanPrincipal {
  const value = res.locals.principal;
  try { if (value?.kind !== 'human') throw forbidden(); principalKey(value); }
  catch { throw forbidden(); }
  return value;
}

async function transaction<T>(db: IdentityPool, principal: HumanPrincipal, targetId: string | undefined, administration: boolean,
  work: (client: pg.PoolClient, actor: UserRow, target: UserRow | undefined) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (administration) await lockIdentityAdministration(client);
    const ids = [...new Set([principal.userId, ...(targetId ? [targetId] : [])])].sort();
    const rows = (await client.query<UserRow>('SELECT * FROM human_users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [ids])).rows;
    const actor = rows.find(row => row.id === principal.userId);
    if (!actor || actor.status !== 'active' || actor.org_role !== 'admin' || actor.issuer !== principal.issuer || actor.subject !== principal.subject
      || !Number.isSafeInteger(Number(actor.session_epoch)) || Number(actor.session_epoch) !== principal.sessionEpoch) throw forbidden();
    const target = targetId ? rows.find(row => row.id === targetId) : undefined;
    if (targetId && !target) throw new AppError(404, '账号不存在', 'IDENTITY_USER_NOT_FOUND');
    const result = await work(client, actor, target);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function writeAudit(client: pg.PoolClient, principal: HumanPrincipal, actor: UserRow, action: 'identity.user.updated' | 'identity.sessions.revoked' | 'identity.membership.updated' | 'identity.membership.removed',
  targetId: string, changes: Record<string, unknown>, departmentId?: string) {
  const eventId = randomUUID(), requestId = randomUUID(), departmentIds = departmentId ? [departmentId] : [];
  const permission = { policy: 'identity-management-v1', userId: actor.id, status: actor.status, orgRole: actor.org_role,
    sessionEpoch: Number(actor.session_epoch), userVersion: actor.version, departmentIds };
  await appendAudit(client, { eventId, actor: auditActor({ ...principal, orgRole: actor.org_role }), action,
    correlation: { correlationId: requestId, requestId },
    authority: { decisionId: eventId, checkedAt: new Date().toISOString(), policyVersion: permission.policy, principalKey: principalKey(principal),
      departmentIds, membershipVersions: [], grantVersions: [], permissionSha256: createHash('sha256').update(JSON.stringify(permission)).digest('hex') },
    resource: { type: departmentId ? 'department_membership' : 'human_user', id: targetId, departmentIds, version: String(changes.version) },
    outcome: 'success', changes,
  } as AuditInput);
}

async function requireDepartment(client: pg.PoolClient, departmentId: string) {
  // Archive/restore only lock this department; hold its live state until the membership transaction commits.
  if (!(await client.query('SELECT id FROM departments WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [departmentId])).rowCount)
    throw new AppError(404, '部门不存在', 'IDENTITY_DEPARTMENT_NOT_FOUND');
}

export function identityManagementRouter(db: IdentityPool = pool): Router {
  const router = Router();
  router.get('/identity/users', async (req, res) => {
    const principal = requireHttpHuman(res), input = usersQuery.parse(req.query);
    const result = await transaction(db, principal, undefined, false, async client => {
      const rows = (await client.query<UserRow>(`SELECT id,display_name,email,status,org_role,version FROM human_users
        WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`, [input.status ?? null, input.cursor ?? null, input.limit + 1])).rows;
      const items = rows.slice(0, input.limit).map(safeUser);
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
    });
    res.json(result);
  });
  router.patch('/identity/users/:id', async (req, res) => {
    const principal = requireHttpHuman(res), id = identifier.parse(req.params.id), input = userChange.parse(req.body);
    const result = await transaction(db, principal, id, true, async (client, actor, target) => {
      if (target!.version !== input.version) throw conflict();
      const status = input.status ?? target!.status, orgRole = input.orgRole ?? target!.org_role;
      if (target!.status === 'active' && target!.org_role === 'admin' && (status !== 'active' || orgRole !== 'admin')) {
        const count = (await client.query("SELECT count(*)::int AS count FROM human_users WHERE status='active' AND org_role='admin'")).rows[0].count;
        if (count <= 1) throw new AppError(409, '必须保留至少一位有效管理员', 'IDENTITY_LAST_ADMIN');
      }
      // Activating a pending account preserves its waiting login; withdrawing authority revokes old sessions.
      const revoke = target!.status === 'active' && status !== 'active' || target!.org_role !== orgRole;
      const epoch = Number(target!.session_epoch) + (revoke ? 1 : 0);
      if (!Number.isSafeInteger(epoch)) throw conflict();
      const updated = (await client.query<UserRow>(`UPDATE human_users SET status=$1,org_role=$2,session_epoch=$3,version=version+1,updated_at=now()
        WHERE id=$4 AND version=$5 RETURNING *`, [status, orgRole, epoch, id, input.version])).rows[0];
      if (!updated) throw conflict();
      await writeAudit(client, principal, actor, 'identity.user.updated', id, { status, orgRole, sessionEpoch: epoch, version: updated.version });
      return safeUser(updated);
    });
    res.json(result);
  });
  router.post('/identity/users/:id/revoke-sessions', async (req, res) => {
    const principal = requireHttpHuman(res), id = identifier.parse(req.params.id), input = expectedVersion.parse(req.body);
    const result = await transaction(db, principal, id, false, async (client, actor, target) => {
      if (target!.version !== input.version || !Number.isSafeInteger(Number(target!.session_epoch) + 1)) throw conflict();
      const updated = (await client.query<UserRow>('UPDATE human_users SET session_epoch=session_epoch+1,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *', [id, input.version])).rows[0];
      if (!updated) throw conflict();
      await writeAudit(client, principal, actor, 'identity.sessions.revoked', id, { sessionEpoch: Number(updated.session_epoch), version: updated.version });
      return safeUser(updated);
    });
    res.json(result);
  });
  router.get('/identity/departments/:id/members', async (req, res) => {
    const principal = requireHttpHuman(res), departmentId = identifier.parse(req.params.id), input = pagination.parse(req.query);
    const result = await transaction(db, principal, undefined, false, async client => {
      await requireDepartment(client, departmentId);
      const rows = (await client.query(`SELECT m.user_id AS "userId",u.display_name AS "displayName",u.email,u.status,u.org_role AS "orgRole",
        m.role,m.can_approve AS "canApprove",m.version FROM department_memberships m JOIN human_users u ON u.id=m.user_id
        WHERE m.department_id=$1 AND ($2::text IS NULL OR m.user_id>$2) ORDER BY m.user_id LIMIT $3`, [departmentId, input.cursor ?? null, input.limit + 1])).rows;
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.userId : null };
    });
    res.json(result);
  });
  router.put('/identity/departments/:id/members/:userId', async (req, res) => {
    const principal = requireHttpHuman(res), departmentId = identifier.parse(req.params.id), userId = identifier.parse(req.params.userId), input = membershipChange.parse(req.body);
    const result = await transaction(db, principal, userId, false, async (client, actor, target) => {
      await requireDepartment(client, departmentId);
      if (target!.status !== 'active') throw new AppError(422, '请先开通账号再授予部门权限', 'IDENTITY_USER_INACTIVE');
      const existing = (await client.query('SELECT version FROM department_memberships WHERE department_id=$1 AND user_id=$2 FOR UPDATE', [departmentId, userId])).rows[0];
      if ((existing?.version ?? 0) !== input.version) throw conflict();
      // The retained user version prevents deleted/recreated grants from reusing an old CAS version.
      const nextVersion = Math.max(target!.version, (existing?.version ?? 0) + 1);
      if (nextVersion >= 2147483647) throw conflict();
      await client.query('UPDATE human_users SET version=$1,updated_at=now() WHERE id=$2', [nextVersion + 1, userId]);
      const row = (await client.query(`INSERT INTO department_memberships(department_id,user_id,role,can_approve,granted_by,version) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(department_id,user_id) DO UPDATE SET role=EXCLUDED.role,can_approve=EXCLUDED.can_approve,granted_by=EXCLUDED.granted_by,
          version=EXCLUDED.version,updated_at=now() RETURNING version`, [departmentId, userId, input.role, input.canApprove, actor.id, nextVersion])).rows[0];
      await writeAudit(client, principal, actor, 'identity.membership.updated', userId, { role: input.role, canApprove: input.canApprove, version: row.version }, departmentId);
      return { userId, departmentId, role: input.role, canApprove: input.canApprove, version: row.version };
    });
    res.json(result);
  });
  router.delete('/identity/departments/:id/members/:userId', async (req, res) => {
    const principal = requireHttpHuman(res), departmentId = identifier.parse(req.params.id), userId = identifier.parse(req.params.userId), input = expectedVersion.parse(req.body);
    await transaction(db, principal, userId, false, async (client, actor, target) => {
      await requireDepartment(client, departmentId);
      const existing = (await client.query('SELECT version FROM department_memberships WHERE department_id=$1 AND user_id=$2 FOR UPDATE', [departmentId, userId])).rows[0];
      if (!existing || existing.version !== input.version) throw conflict();
      const nextVersion = Math.max(target!.version, existing.version) + 1;
      if (nextVersion >= 2147483647) throw conflict();
      await client.query('UPDATE human_users SET version=$1,updated_at=now() WHERE id=$2', [nextVersion, userId]);
      await client.query('DELETE FROM department_memberships WHERE department_id=$1 AND user_id=$2 AND version=$3', [departmentId, userId, input.version]);
      await writeAudit(client, principal, actor, 'identity.membership.removed', userId, { version: existing.version }, departmentId);
    });
    res.json({ ok: true });
  });
  return router;
}
