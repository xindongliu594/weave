import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type pg from 'pg';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';
import { budgetHistory, callsBasis } from '../apps/api/src/budget-history.ts';
import { buildPlanningExecutionContext } from '../apps/api/src/planning-execution-context.ts';
const { inheritedBudgetEvidence } = await import(new URL('../services/agent-runtime/run-evidence.mjs', import.meta.url).href);

const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, directory: string, traceRoot: string;
const modelId = 'durable-admission-fixture-model', departmentId = 'durable-admission-fixture-department';
const originalFetch = globalThis.fetch; let fetchCalls = 0;
before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /^postgresql:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/);
  globalThis.fetch = async () => { fetchCalls++; throw Error('No network/model call in admission fixtures'); };
  directory = await mkdtemp(join(tmpdir(), 'budget-history-admission-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: 'No paid provider', agents: [] }]);
  await pool.query('INSERT INTO models(id,data) VALUES($1,$2)', [modelId, { name: 'Never called fixture' }]);
});
beforeEach(async () => {
  if (isolated) await pool.query('TRUNCATE model_reservations,usage,project_runs,projects CASCADE');
});
after(async () => {
  if (!isolated) return;
  await pool?.end(); globalThis.fetch = originalFetch; assert.equal(fetchCalls, 0);
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('budget-history-admission-'));
  await rm(directory, { recursive: true, force: true });
});
const readonlyDb = { query: (sql: string, values?: any[]) => {
  assert.match(sql, /^SELECT\b/i); return pool.query(sql, values);
} } as unknown as Pick<pg.PoolClient, 'query'>;
async function project(version = 8) {
  const id = randomUUID(), agents = [{ id: 'native', employeeId: 'manager', role: 'manager', modelId, tools: [] }];
  const tasks = ['dev', 'qa_verify', 'qa_review', 'manager_accept'].map(id => ({
    id, subject: id, objective: 'Pure fixture work', assigneeId: 'manager', assignee: 'native', dependencies: [], acceptanceCriteria: ['fixture'],
    estimatedInputTokens: 1, estimatedOutputTokens: 1, inputs: [], outputs: [], verify: [], kind: 'work' }));
  const value = { id, version, requirement: 'Admission history only', policy: { maxBudget: 4, maxModelCalls: 100 }, plan: { agents, tasks, rationale: 'No employee execution' } };
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source,version) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)',
    [id, departmentId, 'Fixture', value.requirement, value.policy, value.plan, 'manual', version]);
  return value;
}
type RunOptions = { version?: number; wires?: (string | undefined)[]; inherited?: number; status?: string; archiveVersion?: number; archiveProject?: string;
  missing?: boolean; started?: boolean; legacySession?: boolean; omitVersion?: boolean };
async function run(value: any, { version: runVersion = Number(value.version), wires = [], inherited = 0, status = 'failed', archiveVersion = runVersion, archiveProject = value.id,
  missing = false, started = true, legacySession = false, omitVersion = false }: RunOptions = {}) {
  const id = randomUUID(), attempt = Number((await pool.query('SELECT COALESCE(max(attempt),0)+1 AS n FROM project_runs WHERE project_id=$1 AND project_version=$2', [value.id, runVersion])).rows[0].n);
  const snapshot: any = { projectId: archiveProject, ...(!omitVersion ? { planVersion: archiveVersion } : {}), requirement: value.requirement, policy: value.policy,
    tasks: value.plan.tasks, agents: value.plan.agents, budgetHistory: { calls: inherited, tasks: { qa_review: { cost: 99, calls: inherited } } },
    knowledge: { format: 'document-versions-v2', documents: [], agentDocuments: { native: [] } } };
  await pool.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, value.id, runVersion, status, snapshot, attempt, started ? new Date() : null]);
  await mkdir(join(traceRoot, id, 'artifacts'), { recursive: true });
  const usageIds: string[] = [];
  if (!missing) {
    const archive = createRunArchive(traceRoot, snapshot, { id });
    archive.append('run/task-mapping', { tasks: value.plan.tasks.map((task: any) => ({ task_id: 'native-' + task.id, seed_id: task.id })) });
    for (const target of wires) {
      const usageId = randomUUID(); usageIds.push(usageId);
      if (legacySession && target) {
        archive.append('model/request', {}, { sessionId: usageId, taskId: 'native-' + target });
        archive.append('model/wire-request', {}, { sessionId: usageId });
      } else archive.append('model/wire-request', { usageId, ...(target ? { taskId: target } : {}) });
    }
    archive.append('run/finished', { status });
  }
  return { id, usageIds, snapshot };
}
async function admission(value: any, runId: string, taskId?: string, status = 'released', amount = .01, id: string = randomUUID()) {
  await pool.query('INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history,expires_at) VALUES($1,$2,$3,$4,$5,$6,.3,1.2,$7,$8,$9,now()-interval \'1 day\')',
    [id, modelId, value.id, runId, 'registered fixture attempt', amount, status, { ...(taskId ? { taskId } : {}), dispatched: false }, JSON.stringify([{ source: 'fixture', note: 'Do not mutate this old receipt' }])]);
  return id;
}
async function state() {
  return Promise.all(['projects', 'project_runs', 'usage', 'model_reservations'].map(async table => ({ table,
    rows: (await pool.query('SELECT row_to_json(t) AS data FROM ' + table + ' t ORDER BY id')).rows })));
}
async function both(value: any) {
  const before = await state(), history = await budgetHistory(readonlyDb, traceRoot, value.id, value.version);
  const planning = await buildPlanningExecutionContext(readonlyDb, traceRoot, value);
  assert.equal(planning.budget.available, true, JSON.stringify(planning.issues));
  assert.equal(planning.budget.calls, history.calls); assert.equal(history.callsBasis, callsBasis); assert.equal(planning.budget.callsBasis, callsBasis);
  for (const [id, usage] of Object.entries(history.tasks)) assert.equal(planning.budget.tasks?.[id]?.calls, usage.calls);
  assert.deepEqual(await state(), before, 'Calls inspection must not release/settle or rewrite any amount/history');
  return { history, planning };
}

test('one successful wire and matching persisted receipt consume one call, without a second fee or hold', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p, { wires: ['dev'] });
  const rid = await admission(p, r.id, 'dev', 'settled', .02, r.usageIds[0]);
  await pool.query('INSERT INTO usage(id,model_id,project_id,run_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,$4,$5,1,1,.003,$6)',
    [rid, modelId, p.id, r.id, 'dev', 'settled fixture']);
  const { history, planning } = await both(p);
  assert.equal(history.calls, 1); assert.deepEqual(history.tasks.dev, { cost: .003, calls: 1 }); assert.equal(planning.budget.reserved, 0);
});
test('registered undispatched released attempt retains its global and qa_review call with no fee', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p); await admission(p, r.id, 'qa_review');
  const { history, planning } = await both(p);
  assert.equal(history.calls, 1); assert.deepEqual(history.tasks.qa_review, { cost: 0, calls: 1 }); assert.equal(planning.budget.reserved, 0);
});
test('23 wires plus the registered review abort restore and planning-feedback as 24, including qa_review=1', { skip: !isolated }, async () => {
  const p = await project(), targets = [...Array(10).fill('dev'), ...Array(8).fill('qa_verify'), ...Array(5).fill(undefined)] as (string | undefined)[];
  const r = await run(p, { wires: targets });
  for (let n = 0; n < targets.length; n++) await admission(p, r.id, targets[n], 'settled', .01, r.usageIds[n]);
  await admission(p, r.id, 'qa_review', 'released');
  const { history, planning } = await both(p);
  assert.equal(history.calls, 24); assert.equal(history.tasks.dev.calls, 10); assert.equal(history.tasks.qa_verify.calls, 8); assert.equal(history.tasks.qa_review.calls, 1);
  assert.equal(planning.budget.unattributedCalls, 5);
});
test('other project/version registration cannot leak into this exact version', { skip: !isolated }, async () => {
  const p = await project(), current = await run(p, { wires: ['dev'] }); await admission(p, current.id, 'dev');
  const old = await run(p, { version: 7, wires: ['qa_review', 'qa_review'] }); await admission(p, old.id, 'qa_review'); await admission(p, old.id, 'qa_review');
  const other = await project(), outside = await run(other); await admission(other, outside.id, 'qa_review');
  const { history } = await both(p); assert.equal(history.calls, 1); assert.equal(history.tasks.qa_review, undefined);
});
test('multiple resumes sum only each run own attempts and never duplicate admission snapshot histories', { skip: !isolated }, async () => {
  const p = await project();
  for (const inherited of [0, 2, 900]) {
    const r = await run(p, { wires: ['dev'], inherited }); await admission(p, r.id, 'dev', 'settled', .01, r.usageIds[0]); await admission(p, r.id, 'qa_review');
  }
  const { history } = await both(p); assert.equal(history.calls, 6); assert.equal(history.tasks.dev.calls, 3); assert.equal(history.tasks.qa_review.calls, 3);
});
test('legacy wire-only without usage IDs or receipts preserves native-session mapping and authoritative row version', { skip: !isolated }, async () => {
  const p = await project(); await run(p, { wires: ['dev', 'qa_verify', undefined], inherited: 900, legacySession: true, omitVersion: true });
  const history = await budgetHistory(readonlyDb, traceRoot, p.id, p.version);
  assert.equal(history.calls, 3); assert.equal(history.tasks.dev.calls, 1); assert.equal(history.tasks.qa_verify.calls, 1);
});
test('old unknown task hold amounts/history remain intact while their registered call is inherited', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p, { wires: ['qa_review'] }); await admission(p, r.id, 'qa_review', 'uncertain', .096526);
  const { history, planning } = await both(p);
  assert.deepEqual(history.tasks.qa_review, { cost: 0, calls: 1, reserved: .096526 });
  assert.equal(planning.budget.reserved, .096526); assert.equal(planning.budget.tasks?.qa_review.reserved, .096526);
});
test('cancelled-before-start missing archive is zero only when no registration exists', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p, { missing: true, started: false, status: 'cancelled' });
  const empty = await budgetHistory(readonlyDb, traceRoot, p.id, p.version); assert.equal(empty.calls, 0);
  await admission(p, r.id, 'qa_review', 'released');
  await assert.rejects(budgetHistory(readonlyDb, traceRoot, p.id, p.version), { code: 'BUDGET_HISTORY_MISSING' });
  const planning = await buildPlanningExecutionContext(readonlyDb, traceRoot, p);
  assert.equal(planning.budget.available, false); assert.equal(planning.budget.calls, undefined);
});
test('receipt project mismatch and explicit archived owner/version mismatches fail instead of returning zero', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p), other = await project(), rid = await admission(p, r.id, 'qa_review');
  await pool.query('UPDATE model_reservations SET project_id=$1 WHERE id=$2', [other.id, rid]);
  await assert.rejects(budgetHistory(readonlyDb, traceRoot, p.id, p.version), { code: 'BUDGET_HISTORY_MISSING' });
  assert.equal((await buildPlanningExecutionContext(readonlyDb, traceRoot, p)).budget.available, false);
  for (const patch of [{ archiveVersion: 7 }, { archiveProject: other.id }]) {
    await pool.query('TRUNCATE model_reservations,usage,project_runs CASCADE'); await run(p, { wires: ['dev'], ...patch });
    await assert.rejects(budgetHistory(readonlyDb, traceRoot, p.id, p.version), { code: 'BUDGET_HISTORY_MISSING' });
  }
});
test('contradictory partial legacy task attribution fails closed rather than creating negative unattributed calls', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p, { wires: ['dev'] }); await admission(p, r.id, 'qa_review');
  await assert.rejects(budgetHistory(readonlyDb, traceRoot, p.id, p.version), { code: 'BUDGET_HISTORY_MISSING' });
  const planning = await buildPlanningExecutionContext(readonlyDb, traceRoot, p); assert.equal(planning.budget.available, false);
});
test('same-task maximum preserves more legacy wires than available receipts without adding them', { skip: !isolated }, async () => {
  const p = await project(), r = await run(p, { wires: ['qa_verify', 'qa_verify', 'qa_verify'], inherited: 3 }); await admission(p, r.id, 'qa_verify');
  const { history } = await both(p); assert.equal(history.calls, 3); assert.equal(history.tasks.qa_verify.calls, 3);
});
test('inherited evidence propagates the durable basis and preserves old snapshot fallback without fabricating missing calls', () => {
  const fresh = inheritedBudgetEvidence({ budgetHistory: { calls: 24, callsBasis } });
  assert.equal(fresh.callsUsed, 24); assert.equal(fresh.callsBasis, callsBasis);
  assert.equal(inheritedBudgetEvidence({ budgetHistory: { calls: 23 } }).callsBasis, 'archived-model-wire-request-count');
  assert.equal(inheritedBudgetEvidence({ budgetHistory: { callsBasis: 'untrusted' } }).callsBasis, 'archived-model-wire-request-count');
  assert.equal(inheritedBudgetEvidence({}).callsUsed, null);
});
