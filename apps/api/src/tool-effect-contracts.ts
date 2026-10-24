import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from './provider.ts';
import { appendAudit, auditActor } from './audit-events.ts';
import { principalKey, identityText, type HumanPrincipal } from './identity-types.ts';
import type { IdentityQueryExecutor } from './identity-schema.ts';
import type { EffectContract } from '../../../packages/contracts/tool-effects.ts';
import { effectDigest, validateEffectContract } from '../../../services/agent-runtime/tool-effects.mjs';

export const toolEffectContractTables = ['tool_effect_contracts'] as const;
type ContractPool = Pick<pg.Pool, 'connect'>;
type Client = Pick<pg.PoolClient, 'query' | 'release'>;
const text = z.string().refine(value => identityText(value, 128));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const keySchema = z.strictObject({ namespace: text, toolName: text });
export type ToolEffectKey = z.infer<typeof keySchema>;
export type EffectContractSnapshot = { effectContractVersion: 1; effectContracts: EffectContract[] };
/** Trusted server registry. Resolve the actual installed/released source independently of HTTP declarations. */
export type ToolEffectBindingResolver = (db: Pick<pg.PoolClient, 'query'>, key: ToolEffectKey) => Promise<unknown>;
type Row = { digest: string; contract: EffectContract; reviewed_by: string; reviewed_at: Date; retired_at: Date | null; version: number };
const fail = (code: string, status = 409) => new AppError(status, code, code);
const publicRow = (row: Row) => ({ digest: row.digest, contract: row.contract, status: row.retired_at ? 'retired' : 'reviewed',
  version: row.version, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, retiredAt: row.retired_at });

export async function migrateToolEffectContracts(db: IdentityQueryExecutor): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS tool_effect_contracts (
    digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'), namespace text NOT NULL, tool_name text NOT NULL,
    contract jsonb NOT NULL, reviewed_by text NOT NULL REFERENCES human_users(id), reviewed_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz, version integer NOT NULL DEFAULT 1,
    CHECK ((retired_at IS NULL AND version=1) OR (retired_at IS NOT NULL AND version=2))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tool_effect_contracts_active ON tool_effect_contracts(namespace,tool_name) WHERE retired_at IS NULL;
  CREATE OR REPLACE FUNCTION protect_tool_effect_contract() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'tool effect contract immutable'; END IF;
    IF ROW(NEW.digest,NEW.namespace,NEW.tool_name,NEW.contract,NEW.reviewed_by,NEW.reviewed_at)
        IS DISTINCT FROM ROW(OLD.digest,OLD.namespace,OLD.tool_name,OLD.contract,OLD.reviewed_by,OLD.reviewed_at)
      OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'tool effect contract immutable';
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS tool_effect_contract_immutable ON tool_effect_contracts;
  CREATE TRIGGER tool_effect_contract_immutable BEFORE UPDATE OR DELETE ON tool_effect_contracts
    FOR EACH ROW EXECUTE FUNCTION protect_tool_effect_contract();`);
}

function checkedContract(value: unknown): EffectContract {
  try {
    const result = validateEffectContract(value);
    for (const name of [result.namespace, result.toolName, result.capabilityId]) text.parse(name);
    return result;
  } catch { throw fail('TOOL_EFFECT_CONTRACT_INVALID', 422); }
}
function supported(contract: EffectContract) {
  if (contract.effect === 'unknown') throw fail('TOOL_EFFECT_UNKNOWN', 422);
  if (contract.cost.kind !== 'free') throw fail('TOOL_EFFECT_COST_UNSUPPORTED', 422);
  if (contract.retry === 'provider-key') throw fail('TOOL_EFFECT_RETRY_UNSUPPORTED', 422);
}
function snapshotContracts(snapshot: EffectContractSnapshot): EffectContract[] {
  if (snapshot?.effectContractVersion !== 1 || !Array.isArray(snapshot.effectContracts) || snapshot.effectContracts.length > 256)
    throw fail('TOOL_EFFECT_SNAPSHOT_INVALID', 422);
  const contracts = snapshot.effectContracts.map(checkedContract);
  if (new Set(contracts.map(item => item.toolName)).size !== contracts.length || new Set(contracts.map(item => item.capabilityId)).size !== contracts.length)
    throw fail('TOOL_EFFECT_DUPLICATE', 422);
  return contracts;
}

export class ToolEffectContractService {
  private readonly db: ContractPool;
  private readonly resolveBinding?: ToolEffectBindingResolver;
  private readonly timeout: number;
  constructor({ db, resolveBinding, admissionTimeoutMs = 30000 }: { db: ContractPool; resolveBinding?: ToolEffectBindingResolver; admissionTimeoutMs?: number }) {
    if (!Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs < 10 || admissionTimeoutMs > 30000) throw fail('TOOL_EFFECT_TIMEOUT_INVALID', 422);
    this.db = db; this.resolveBinding = resolveBinding; this.timeout = admissionTimeoutMs;
  }
  private async transaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    let discard = false, primary: unknown;
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('statement_timeout','30000',true)"); const value = await work(client);
      try { await client.query('COMMIT'); } catch (error) { discard = true; throw error; }
      return value;
    } catch (error) {
      primary = error;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { try { client.release(discard); } catch (error) { if (primary === undefined) throw error; } }
  }
  private async admin(client: Client, principal: HumanPrincipal) {
    try { if (principal.kind !== 'human') throw Error(); principalKey(principal); } catch { throw fail('TOOL_EFFECT_ADMIN_REQUIRED', 403); }
    const actor = (await client.query('SELECT * FROM human_users WHERE id=$1 FOR SHARE', [principal.userId])).rows[0];
    if (!actor || actor.status !== 'active' || actor.org_role !== 'admin' || actor.issuer !== principal.issuer || actor.subject !== principal.subject || Number(actor.session_epoch) !== principal.sessionEpoch)
      throw fail('TOOL_EFFECT_ADMIN_REQUIRED', 403);
    return actor;
  }
  private async candidateFor(client: Pick<pg.PoolClient, 'query'>, key: ToolEffectKey) {
    if (!this.resolveBinding) throw fail('TOOL_EFFECT_SOURCE_UNAVAILABLE', 503);
    const value = await this.resolveBinding(client, key);
    if (!value) throw fail('TOOL_EFFECT_SOURCE_UNAVAILABLE', 409);
    const contract = checkedContract(value);
    if (contract.namespace !== key.namespace || contract.toolName !== key.toolName) throw fail('TOOL_EFFECT_SOURCE_CHANGED');
    return contract;
  }
  private async audit(client: Client, actor: Record<string, unknown>, principal: HumanPrincipal, row: Row) {
    const eventId = randomUUID();
    await appendAudit(client, { eventId, actor: auditActor(principal), action: 'capability.configure',
      correlation: { correlationId: eventId, requestId: eventId }, outcome: 'success',
      authority: { decisionId: eventId, checkedAt: new Date().toISOString(), policyVersion: 'tool-effect-contracts-v1', principalKey: principalKey(principal),
        departmentIds: [], membershipVersions: [], grantVersions: [], permissionSha256: effectDigest({ userId: actor.id, status: actor.status, orgRole: actor.org_role, epoch: Number(actor.session_epoch), version: actor.version }) },
      resource: { type: 'capability', id: row.digest, departmentIds: [], version: String(row.version) },
      changes: { version: String(row.version), sha256: row.digest, enabled: row.retired_at === null },
    });
  }
  async candidate(key: ToolEffectKey, principal: HumanPrincipal) {
    key = keySchema.parse(key);
    return this.transaction(async client => {
      await this.admin(client, principal); const contract = await this.candidateFor(client, key), digest = effectDigest(contract);
      const row = (await client.query<Row>('SELECT * FROM tool_effect_contracts WHERE digest=$1', [digest])).rows[0];
      return row ? publicRow(row) : { digest, contract, status: 'unreviewed' };
    });
  }
  async review(key: ToolEffectKey, expectedDigest: string, principal: HumanPrincipal) {
    key = keySchema.parse(key); hash.parse(expectedDigest);
    return this.transaction(async client => {
      const actor = await this.admin(client, principal), contract = await this.candidateFor(client, key), digest = effectDigest(contract);
      if (digest !== expectedDigest) throw fail('TOOL_EFFECT_SOURCE_CHANGED');
      supported(contract);
      const old = (await client.query<Row>('SELECT * FROM tool_effect_contracts WHERE digest=$1 FOR UPDATE', [digest])).rows[0];
      if (old?.retired_at) throw fail('TOOL_EFFECT_RETIRED');
      if (old) return publicRow(old);
      const inserted = (await client.query<Row>(`INSERT INTO tool_effect_contracts(digest,namespace,tool_name,contract,reviewed_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`, [digest, contract.namespace, contract.toolName, contract, principal.userId])).rows[0];
      if (!inserted) throw fail('TOOL_EFFECT_ACTIVE_CONFLICT');
      await this.audit(client, actor, principal, inserted); return publicRow(inserted);
    });
  }
  async retire(digest: string, expectedVersion: number, principal: HumanPrincipal) {
    hash.parse(digest); z.number().int().min(1).max(2).parse(expectedVersion);
    return this.transaction(async client => {
      const actor = await this.admin(client, principal);
      const row = (await client.query<Row>('SELECT * FROM tool_effect_contracts WHERE digest=$1 FOR UPDATE', [digest])).rows[0];
      if (!row || row.version !== expectedVersion || row.retired_at) throw fail('TOOL_EFFECT_VERSION_CONFLICT');
      const updated = (await client.query<Row>('UPDATE tool_effect_contracts SET retired_at=now(),version=version+1 WHERE digest=$1 RETURNING *', [digest])).rows[0];
      await this.audit(client, actor, principal, updated); return publicRow(updated);
    });
  }
  async list(query: { limit?: number; cursor?: string }, principal: HumanPrincipal) {
    const input = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: hash.optional() }).parse(query);
    return this.transaction(async client => {
      await this.admin(client, principal);
      const rows = (await client.query<Row>('SELECT * FROM tool_effect_contracts WHERE ($1::text IS NULL OR digest>$1) ORDER BY digest LIMIT $2', [input.cursor ?? null, input.limit + 1])).rows;
      const items = rows.slice(0, input.limit).map(publicRow); return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.digest : null };
    });
  }
  async assertContractIn(client: Pick<pg.PoolClient, 'query'>, input: EffectContract) {
    const contract = checkedContract(input), digest = effectDigest(contract);
    const current = await this.candidateFor(client, { namespace: contract.namespace, toolName: contract.toolName });
    const row = (await client.query<Row>('SELECT * FROM tool_effect_contracts WHERE digest=$1 FOR SHARE', [digest])).rows[0];
    if (!row || effectDigest(checkedContract(row.contract)) !== digest) throw fail('TOOL_EFFECT_UNREVIEWED');
    if (row.retired_at) throw fail('TOOL_EFFECT_RETIRED');
    supported(contract);
    if (effectDigest(current) !== digest) throw fail('TOOL_EFFECT_SOURCE_CHANGED');
    return contract;
  }
  async snapshot(keys: ToolEffectKey[]): Promise<EffectContractSnapshot> {
    return this.transaction(client => this.snapshotIn(client, keys));
  }
  async snapshotIn(client: Pick<pg.PoolClient, 'query'>, keys: ToolEffectKey[]): Promise<EffectContractSnapshot> {
    if (!Array.isArray(keys) || keys.length > 256) throw fail('TOOL_EFFECT_SNAPSHOT_INVALID', 422);
    const checked = keys.map(value => keySchema.parse(value));
    if (new Set(checked.map(value => value.toolName)).size !== checked.length) throw fail('TOOL_EFFECT_DUPLICATE', 422);
    checked.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.toolName.localeCompare(b.toolName));
      const contracts: EffectContract[] = [];
      for (const key of checked) contracts.push(await this.assertContractIn(client, await this.candidateFor(client, key)));
      return { effectContractVersion: 1, effectContracts: contracts };
  }
  async assertSnapshot(snapshot: EffectContractSnapshot, signal?: AbortSignal): Promise<void> {
    const contracts = snapshotContracts(snapshot).sort((a, b) => effectDigest(a).localeCompare(effectDigest(b)));
    await this.transaction(async client => { for (const contract of contracts) { signal?.throwIfAborted(); await this.assertContractIn(client, contract); } signal?.throwIfAborted(); });
  }
  async withAdmission<T>(input: EffectContract, invoke: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(fail('TOOL_EFFECT_ADMISSION_TIMEOUT')), this.timeout);
    const signal = AbortSignal.any([deadline.signal, ...(callerSignal ? [callerSignal] : [])]);
    let client: Client | undefined, closing: Promise<void> | undefined;
    const close = (commit: boolean) => closing ??= (async () => {
      if (!client) return;
      let failed = false;
      try { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); }
      catch (error) { failed = true; throw error; }
      finally { try { client.release(failed); } catch (error) { if (!failed) throw error; } }
    })();
    const onAbort = () => { void close(false).catch(() => {}); };
    try {
      signal.throwIfAborted(); client = await this.db.connect(); signal.throwIfAborted();
      await client.query('BEGIN'); await client.query("SELECT set_config('statement_timeout',$1,true)", [String(this.timeout)]);
      signal.addEventListener('abort', onAbort, { once: true }); signal.throwIfAborted();
      const guarded: Client = { query: ((...args: Parameters<Client['query']>) => {
        if (closing) throw fail('TOOL_EFFECT_ADMISSION_CLOSED');
        return client!.query(...args);
      }) as Client['query'], release: () => { throw fail('TOOL_EFFECT_ADMISSION_CLOSED'); } };
      const contract = await this.assertContractIn(guarded, input); signal.throwIfAborted();
      if (contract.effect !== 'read') throw fail('TOOL_EFFECT_INTENT_REQUIRED');
      // Keep awaiting the real invoke after cancellation: DSH close/drain must retain it.
      // Only the SQL transaction is released early. Rollback says nothing about execution.
      const value = await invoke(signal); signal.throwIfAborted(); await close(true); signal.throwIfAborted(); return value;
    } catch (error) { try { await close(false); } catch { /* Preserve the original admission/invoke/commit error. */ } if (signal.aborted) throw signal.reason; throw error; }
    finally { signal.removeEventListener('abort', onAbort); clearTimeout(timer); }
  }
}

export function toolEffectContractsRouter(service: ToolEffectContractService | (()=>Promise<ToolEffectContractService>), sources?:()=>Promise<readonly EffectContract[]>): Router {
  const router = Router();
  const current=()=>typeof service==='function'?service():Promise.resolve(service);
  const principal = (value: unknown) => { try { const human = value as HumanPrincipal; if (human?.kind !== 'human') throw Error(); principalKey(human); return human; } catch { throw fail('TOOL_EFFECT_ADMIN_REQUIRED', 403); } };
  router.get('/tool-effect-contracts', async (req, res) => { const actor=principal(res.locals.principal);res.set('Cache-Control', 'no-store').json(await (await current()).list(req.query,actor)); });
  router.get('/tool-effect-contracts/sources',async (_req,res)=>{
    const actor=principal(res.locals.principal);
    await (await current()).list({limit:1},actor);
    if(!sources)throw fail('TOOL_EFFECT_SOURCE_UNAVAILABLE',503);
    const items=await sources();if(items.length>256)throw fail('TOOL_EFFECT_SOURCE_UNAVAILABLE',503);
    res.set('Cache-Control','no-store').json(items);
  });
  router.get('/tool-effect-contracts/candidate', async (req, res) => { const actor=principal(res.locals.principal);res.set('Cache-Control', 'no-store').json(await (await current()).candidate(keySchema.parse(req.query),actor)); });
  router.post('/tool-effect-contracts/reviews', async (req, res) => {
    const actor=principal(res.locals.principal);
    const input = keySchema.extend({ expectedDigest: hash }).parse(req.body);
    res.json(await (await current()).review({ namespace: input.namespace, toolName: input.toolName }, input.expectedDigest,actor));
  });
  router.post('/tool-effect-contracts/:digest/retire', async (req, res) => {
    const actor=principal(res.locals.principal);
    const input = z.strictObject({ expectedVersion: z.number().int().min(1).max(2) }).parse(req.body);
    res.json(await (await current()).retire(hash.parse(req.params.digest), input.expectedVersion,actor));
  });
  return router;
}
