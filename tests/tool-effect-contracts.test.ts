import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import { migrateIdentity } from '../apps/api/src/identity-schema.ts';
import { effectDigest } from '../services/agent-runtime/tool-effects.mjs';
import type { EffectContract } from '../packages/contracts/tool-effects.ts';
import type { HumanPrincipal } from '../apps/api/src/identity-types.ts';
import { identityPostgresPool, identityPostgresUrl } from './fixtures/identity/postgres.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { captureToolDefinition } from '../services/agent-runtime/tool-definition-effects.mjs';

const nativeUrl = process.env.TOOL_EFFECT_POSTGRES_URL;
if (nativeUrl) identityPostgresUrl(nativeUrl);
else assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Use isolated integration runner or an owned native PostgreSQL URL');
const actor: HumanPrincipal = { kind: 'human', userId: 'admin', sessionId: 'session-admin', issuer: 'https://issuer.example', subject: 'admin', orgRole: 'admin', sessionEpoch: 0, authenticatedAt: new Date().toISOString() };
const key = { namespace: 'weiwu', toolName: 'office_read' };
const contract = (): EffectContract => ({ schema: 1, capabilityId: 'office.read', ...key,
  source: { kind: 'builtin', reference: 'weiwu:test-release', version: '1', digest: 'a'.repeat(64) }, definitionSha256: 'b'.repeat(64),
  effect: 'read', isolationProfile: 'runtime-read-v1', permissions: ['office:read'], retry: 'bounded-read', cost: { kind: 'free' },
  reconciliation: { kind: 'receipt' }, compensation: { kind: 'none', requiresApproval: true }, evidenceRefs: ['fixture:actual-source-review'] });
let db: pg.Pool, service: any, Service: any, source: EffectContract | null, failAudit = false;
let server: ReturnType<ReturnType<typeof express>['listen']>, base: string;
const request = async (method: string, path: string, body?: unknown, who = 'admin') => {
  const result = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-actor': who }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, body: await result.json() };
};
const review = () => service.review(key, effectDigest(source), actor);

before(async () => {
  db = nativeUrl ? await identityPostgresPool(nativeUrl) : new pg.Pool({ connectionString: process.env.DATABASE_URL });
  if (!nativeUrl) { await db.query('CREATE TABLE departments(id text PRIMARY KEY)'); await migrateIdentity(db); }
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.principal = req.get('x-test-actor') === 'admin' ? actor : { ...actor, userId: 'member', subject: 'member', orgRole: 'member' }; next(); });
  const faultDb = { async connect() { const client = await db.connect(); return {
    query(sql: string, params?: unknown[]) { if (failAudit && sql.includes('INSERT INTO human_audit_events')) throw Error('Audit unavailable'); return client.query(sql, params); },
    release() { client.release(); },
  }; } };
  const path = '../apps/api/src/tool-effect-contracts.ts';
  try {
    const module = await import(path); Service = module.ToolEffectContractService;
    await module.migrateToolEffectContracts(db); await module.migrateToolEffectContracts(db);
    service = new Service({ db: faultDb, resolveBinding: async (_client: unknown, wanted: typeof key) => wanted.namespace === key.namespace && wanted.toolName === key.toolName ? source : null, admissionTimeoutMs: 5000 });
    app.use('/api', module.toolEffectContractsRouter(service));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? (error.name === 'ZodError' ? 422 : 500)).json({ code: error.code ?? 'REQUEST_FAILED' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit = false; source = contract();
  await db.query('TRUNCATE human_users CASCADE');
  await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('admin','https://issuer.example','admin','active','admin'),('member','https://issuer.example','member','active','member')");
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.end(); });

test('HTTP candidate review snapshot and retirement use current admin and audited immutable versions', async () => {
  const candidate = await request('GET', '/api/tool-effect-contracts/candidate?namespace=weiwu&toolName=office_read');
  assert.equal(candidate.status, 200); assert.equal(candidate.body.status, 'unreviewed');
  const approved = await request('POST', '/api/tool-effect-contracts/reviews', { ...key, expectedDigest: candidate.body.digest });
  assert.equal(approved.status, 200); assert.equal(approved.body.status, 'reviewed'); assert.equal(approved.body.version, 1);
  const snapshot = await service.snapshot([key]); assert.equal(snapshot.effectContractVersion, 1); assert.equal(snapshot.effectContracts.length, 1);
  await service.assertSnapshot(snapshot);
  assert.equal((await request('GET', '/api/tool-effect-contracts?limit=1')).body.items.length, 1);
  const retired = await request('POST', `/api/tool-effect-contracts/${candidate.body.digest}/retire`, { expectedVersion: 1 });
  assert.equal(retired.status, 200); assert.equal(retired.body.status, 'retired'); assert.equal(retired.body.version, 2);
  await assert.rejects(service.assertSnapshot(snapshot), /TOOL_EFFECT_RETIRED/);
  await assert.rejects(review(), /TOOL_EFFECT_RETIRED/);
  const audits = (await db.query("SELECT schema_version,authority_evidence,changes FROM human_audit_events WHERE action='capability.configure' ORDER BY occurred_at,id")).rows;
  assert.equal(audits.length, 2); assert.ok(audits.every(row => row.schema_version === 2 && row.authority_evidence.principalKey === 'human:admin'));
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_outbox')).rows[0].n, 2);
});

test('HTTP cannot supply source effects reviewer or actor and stale current authority is denied', async () => {
  for (const extra of [{ source: { kind: 'builtin' } }, { effect: 'read' }, { reviewedBy: 'admin' }, { annotations: { readOnlyHint: true } }])
    assert.equal((await request('POST', '/api/tool-effect-contracts/reviews', { ...key, expectedDigest: effectDigest(source), ...extra })).status, 422);
  assert.equal((await request('GET', '/api/tool-effect-contracts', undefined, 'member')).status, 403);
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='admin'");
  assert.equal((await request('POST', '/api/tool-effect-contracts/reviews', { ...key, expectedDigest: effectDigest(source) })).status, 403);
  assert.equal((await db.query('SELECT count(*)::int n FROM tool_effect_contracts')).rows[0].n, 0);
});

test('unknown source provider and unknown or priced contract semantics cannot become reviewed', async () => {
  await assert.rejects(new Service({ db }).review(key, effectDigest(source), actor), /TOOL_EFFECT_SOURCE_UNAVAILABLE/);
  source = null; await assert.rejects(service.review(key, 'b'.repeat(64), actor), /TOOL_EFFECT_SOURCE_UNAVAILABLE/);
  for (const change of [{ effect: 'unknown', retry: 'never' }, { cost: { kind: 'unknown' } }, { cost: { kind: 'metered', adapterId: 'claimed-budget' } },
    { effect: 'external', retry: 'provider-key', reconciliation: { kind: 'query', resolverId: 'claimed', version: '1' } }]) {
    source = { ...contract(), ...change } as EffectContract;
    await assert.rejects(review(), /TOOL_EFFECT_(UNKNOWN|COST_UNSUPPORTED|RETRY_UNSUPPORTED)/);
  }
});

test('source release and schema drift invalidate existing snapshots without overwriting history', async () => {
  const original = await review(), snapshot = await service.snapshot([key]);
  source = { ...source!, source: { ...source!.source, version: '2' } };
  await assert.rejects(service.assertSnapshot(snapshot), /TOOL_EFFECT_SOURCE_CHANGED/);
  await assert.rejects(service.review(key, original.digest, actor), /TOOL_EFFECT_SOURCE_CHANGED/);
  source = { ...contract(), definitionSha256: 'c'.repeat(64) };
  await assert.rejects(service.assertSnapshot(snapshot), /TOOL_EFFECT_SOURCE_CHANGED/);
  await assert.rejects(review(), /TOOL_EFFECT_ACTIVE_CONFLICT/);
  assert.equal((await db.query('SELECT count(*)::int n FROM tool_effect_contracts')).rows[0].n, 1);
});

test('semantic SQL updates and deletes are refused and retirement uses CAS', async () => {
  const row = await review();
  await assert.rejects(db.query("UPDATE tool_effect_contracts SET contract='{}' WHERE digest=$1", [row.digest]), /immutable/i);
  await assert.rejects(db.query('DELETE FROM tool_effect_contracts WHERE digest=$1', [row.digest]), /immutable/i);
  await assert.rejects(service.retire(row.digest, 2, actor), /TOOL_EFFECT_VERSION_CONFLICT/);
  await service.retire(row.digest, 1, actor);
  await assert.rejects(service.retire(row.digest, 1, actor), /TOOL_EFFECT_VERSION_CONFLICT/);
});

test('review and retire roll back when audit v2 cannot commit', async () => {
  failAudit = true; await assert.rejects(review(), /Audit unavailable/);
  assert.equal((await db.query('SELECT count(*)::int n FROM tool_effect_contracts')).rows[0].n, 0);
  failAudit = false; const row = await review(); failAudit = true;
  await assert.rejects(service.retire(row.digest, 1, actor), /Audit unavailable/);
  failAudit = false; await service.assertSnapshot(await service.snapshot([key]));
  assert.equal((await db.query('SELECT count(*)::int n FROM human_audit_events')).rows[0].n, 1);
});

test('snapshots reject duplicate tools and tampered contracts; free read admission executes once', async () => {
  const row = await review(); await assert.rejects(service.snapshot([key, key]), /TOOL_EFFECT_DUPLICATE/);
  const snapshot = await service.snapshot([key]); let calls = 0;
  assert.equal(await service.withAdmission(snapshot.effectContracts[0], async () => { calls++; return 17; }), 17);
  const altered = structuredClone(snapshot); altered.effectContracts[0].permissions = [];
  await assert.rejects(service.assertSnapshot(altered), /TOOL_EFFECT_UNREVIEWED/);
  await service.retire(row.digest, 1, actor);
  await assert.rejects(service.withAdmission(snapshot.effectContracts[0], async () => { calls++; }), /TOOL_EFFECT_RETIRED/);
  assert.equal(calls, 1);
});

test('reviewed workspace contract still requires the later durable intent path', async () => {
  source = { ...contract(), effect: 'workspace', retry: 'never' }; await review();
  const snapshot = await service.snapshot([key]); let calls = 0;
  await assert.rejects(service.withAdmission(snapshot.effectContracts[0], async () => { calls++; }), /TOOL_EFFECT_INTENT_REQUIRED/);
  assert.equal(calls, 0);
});

test('transaction cleanup preserves the primary failure and discards uncertain connections', async () => {
  const original = Error('original transaction failure'), rollback = Error('rollback transport failure');
  for (const method of ['list', 'admission'] as const) for (const failure of ['commit', 'work'] as const) {
    const released: unknown[] = [];
    const fakeDb = { async connect() { return {
      async query(sql: string) {
        if (sql === 'ROLLBACK') throw rollback;
        if (sql === 'COMMIT' && failure === 'commit') throw original;
        if (sql.includes('FROM human_users')) return { rows: [{ id: 'admin', issuer: actor.issuer, subject: actor.subject, org_role: 'admin', status: 'active', session_epoch: 0, version: 1 }] };
        if (sql.includes('FROM tool_effect_contracts')) {
          if (method === 'list' && failure === 'work') throw original;
          return { rows: method === 'list' ? [] : [{ digest: effectDigest(source), contract: source, retired_at: null, version: 1 }] };
        }
        return { rows: [] };
      }, release(discard?: boolean) { released.push(discard); },
    }; } };
    const isolated = new Service({ db: fakeDb, resolveBinding: async () => source });
    const outcome = method === 'list' ? isolated.list({}, actor) : isolated.withAdmission(source, async () => { if (failure === 'work') throw original; return 1; });
    await assert.rejects(outcome, error => error === original, `${method}/${failure} must retain the original failure`);
    assert.deepEqual(released, [true], `${method}/${failure} must discard, never return uncertain transaction state to the pool`);
  }
});

test('timeout releases SQL while retaining and observing the original late invocation', async () => {
  const row = await review(), snapshot = await service.snapshot([key]);
  const short = new Service({ db, resolveBinding: async () => source, admissionTimeoutMs: 30 });
  let release!: () => void, entered!: () => void, settled = false, observedAbort = false;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const invocation = short.withAdmission(snapshot.effectContracts[0], async (signal: AbortSignal) => {
    entered(); await new Promise<void>(resolve => { release = resolve; }); observedAbort = signal.aborted; return 'late result';
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(invocation, /TOOL_EFFECT_ADMISSION_TIMEOUT/);
  await enteredPromise; await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(settled, false, 'DSH must continue tracking the actual invocation until it settles');
  try { await service.retire(row.digest, 1, actor); assert.equal(settled, false, 'SQL lock was released independently of the late invocation'); }
  finally { release(); }
  await rejected; assert.equal(observedAbort, true);
});

test('cancellation during transaction close cannot turn an admitted call into success', async () => {
  const controller = new AbortController(), reason = Error('caller cancelled during close');
  let completeCommit!: () => void, commitStarted!: () => void;
  const committing = new Promise<void>(resolve => { commitStarted = resolve; });
  const released: unknown[] = [];
  const fakeDb = { async connect() { return {
    async query(sql: string) {
      if (sql === 'COMMIT') { commitStarted(); await new Promise<void>(resolve => { completeCommit = resolve; }); }
      return { rows: sql.includes('FROM tool_effect_contracts') ? [{ digest: effectDigest(source), contract: source, retired_at: null, version: 1 }] : [] };
    }, release(discard?: boolean) { released.push(discard); },
  }; } };
  const isolated = new Service({ db: fakeDb, resolveBinding: async () => source });
  const invocation = isolated.withAdmission(source, async () => 'body finished', controller.signal);
  const rejected = assert.rejects(invocation, error => error === reason);
  await committing; controller.abort(reason); completeCommit();
  await rejected; assert.deepEqual(released, [false], 'completed read-only transaction returns a known-state connection');
});

test('retirement waits for an already admitted read, then rejects new calls', { skip: !nativeUrl, timeout: 10000 }, async () => {
  const row = await review(), snapshot = await service.snapshot([key]);
  let release!: () => void, entered!: () => void, retired = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const invocation = service.withAdmission(snapshot.effectContracts[0], async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return 'read'; });
  await started;
  const retirement = service.retire(row.digest, 1, actor).then(() => { retired = true; });
  try {
    const deadline = Date.now() + 3000; let blocked = false;
    do { const rows = (await db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%tool_effect_contracts%' ")).rows; blocked = rows.length > 0; if (!blocked) await new Promise(resolve => setTimeout(resolve, 10)); } while (!blocked && Date.now() < deadline);
    assert.equal(blocked, true, 'native independent backend must wait on contract SHARE lock'); assert.equal(retired, false);
  } finally { release(); }
  assert.equal(await invocation, 'read'); await retirement;
  await assert.rejects(service.withAdmission(snapshot.effectContracts[0], async () => 'unexpected'), /TOOL_EFFECT_RETIRED/);
});

test('real employee Host checks persistent contract before actual body and coordinator cannot bypass admission', { timeout: 15000 }, async () => {
  const hostUrl = new URL('../services/agent-runtime/host.mjs', import.meta.url).href;
  const employeeUrl = new URL('../services/agent-runtime/employee-hosts.mjs', import.meta.url).href;
  const { createTeamHost } = await import(hostUrl), { EmployeeHostFactory } = await import(employeeUrl);
  const req = createRequire(new URL('../services/agent-runtime/package.json', import.meta.url));
  const baseRequire = createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
  const { defineTool } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href);
  const { LlmAdapter } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
  const root = await mkdtemp(join(tmpdir(), 'contract-host-'));
  const host = await createTeamHost({ adapter: new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }(), provider: 'fixture', sessionRoot: join(root, 'sessions') });
  let calls = 0;
  const definition = defineTool({ name: key.toolName, description: 'Approved fixture read', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, async execute() { calls++; return 7; } });
  host.ctx.tools.register(definition);
  source = { ...contract(), definitionSha256: captureToolDefinition(host.ctx.tools.get(key.toolName), 'weiwu-coordinator-registry-v1').definitionSha256 };
  let factory;
  try {
    const row = await review(), snapshot = await service.snapshot([key]);
    factory = new EmployeeHostFactory({ coordinator: host.ctx, provider: 'fixture', sessionRoot: join(root, 'sessions'),
      identify: () => ({ id: 'reader', tools: [key.toolName] }), loadPlugin: (name: string) => import(pathToFileURL(baseRequire.resolve(name)).href),
      effectSnapshot: snapshot, effectAuthority: service });
    const handle = await factory.createAgent(host.ctx, { sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'reader' } });
    const ctx = factory.list()[0].ctx;
    const call = () => ctx.tools.execute({ name: key.toolName, arguments: {}, agent: handle.agent, callId: randomUUID(), signal: AbortSignal.timeout(2000) });
    assert.equal((await call()).isError, false); assert.equal(calls, 1);
    const bypass = await host.ctx.tools.execute({ name: key.toolName, arguments: {}, agent: handle.agent, callId: randomUUID(), signal: AbortSignal.timeout(2000) });
    assert.equal(bypass.isError, true, 'coordinator needs the actual employee forwarding admission'); assert.equal(calls, 1);
    await service.retire(row.digest, 1, actor);
    assert.equal((await call()).isError, true, 'retired contract is checked at the real call boundary'); assert.equal(calls, 1);
  } finally { await factory?.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('product Host uses the persistent contract gate for its original registered read tool', { timeout: 15000 }, async () => {
  const hostUrl = new URL('../services/agent-runtime/host.mjs', import.meta.url).href;
  const limitsUrl = new URL('../services/agent-runtime/limits.mjs', import.meta.url).href;
  const traceUrl = new URL('../services/agent-runtime/trace-store.mjs', import.meta.url).href;
  const { createTeamHost } = await import(hostUrl), { Semaphore } = await import(limitsUrl), { createRunArchive } = await import(traceUrl);
  const req = createRequire(new URL('../services/agent-runtime/package.json', import.meta.url));
  const { LlmAdapter } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
  const root = await mkdtemp(join(tmpdir(), 'contract-product-'));
  const baseline = { agents: [{ id: 'manager', role: 'manager', tools: ['knowledge_search'] }], knowledge: { manager: [] } };
  const archive = createRunArchive(join(root, 'runs'), baseline);
  const adapter = new class extends LlmAdapter { async *stream() { throw Error('NO_MODEL_CALL'); } }();
  let host, calls = 0;
  try {
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'inventory'), archive, product: { snapshot: baseline, gate: new Semaphore(1) } });
    const definitionSha256 = captureToolDefinition(host.ctx.tools.get('knowledge_search'), 'weiwu-coordinator-registry-v1').definitionSha256;
    await host.close(); host = undefined;
    const candidate = { ...contract(), capabilityId: 'knowledge.search', toolName: 'knowledge_search', definitionSha256 };
    const actualService = new Service({ db, resolveBinding: async (_client: unknown, wanted: typeof key) => wanted.toolName === candidate.toolName && wanted.namespace === candidate.namespace ? candidate : null });
    const key = { namespace: candidate.namespace, toolName: candidate.toolName };
    const reviewed = await actualService.review(key, effectDigest(candidate), actor);
    const snapshot = { ...baseline, ...await actualService.snapshot([key]) };
    host = await createTeamHost({ adapter, provider: 'fixture', sessionRoot: join(root, 'execution'), archive,
      product: { snapshot, effectAuthority: actualService, gate: new Semaphore(1), queryKnowledge: async () => { calls++; return []; } } });
    const captain = await host.captain({ cwd: root, model: 'test' });
    assert.deepEqual(await host.call(captain, 'knowledge_search', { query: 'approved' }), []); assert.equal(calls, 1);
    assert.equal(Object.isFrozen(host.ctx.tools.get('knowledge_search')), true, 'contract mode reuses the original final body boundary');
    assert.equal(captain.ctx.tools.schemas(captain).some((tool: { name: string }) => tool.name === 'terminal_test'), false);
    await actualService.retire(reviewed.digest, 1, actor);
    await assert.rejects(host.call(captain, 'knowledge_search', { query: 'after retirement' }), /TOOL_EFFECT_RETIRED/); assert.equal(calls, 1);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
