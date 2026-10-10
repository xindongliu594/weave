import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import { createRunArchive } from '../services/agent-runtime/trace-store.mjs';
import { toolEvidence } from './model-fixture.ts';
import { createGoalContract } from '../packages/contracts/goal-contract.mjs';

// This test can open only the integration runner's fresh in-memory database.
// No product data, live service or external model endpoint is contacted.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, server: http.Server, gateway: http.Server, directory: string, traceRoot: string, url: string;
let providerRequests = 0;
const modelId = 'recovery-check-model', gatewayId = 'recovery-check-gateway', departmentId = 'recovery-check-department';
const employee = { id: 'manager', name: '隔离测试经理', title: '经理', role: 'manager', instructions: 'Read only fixture checks', modelId, tools: [] };
const tasks = [
  { id: 'prepare', subject: '已完成的准备任务', objective: 'Return fixture text', assigneeId: employee.id, assignee: employee.id, dependencies: [],
    acceptanceCriteria: ['fixture text'], estimatedInputTokens: 10, estimatedOutputTokens: 10, maxBudget: .1, maxModelCalls: 3, taskPrompt: 'Return fixture text' },
  { id: 'finish', subject: '未完成的验收任务', objective: 'Finish fixture text', assigneeId: employee.id, assignee: employee.id, dependencies: ['prepare'],
    acceptanceCriteria: ['fixture finished'], estimatedInputTokens: 10, estimatedOutputTokens: 10, maxBudget: .5, maxModelCalls: 3, taskPrompt: 'Finish fixture text' },
];
const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, maxModelCalls: 5, maxTaskModelCalls: 3, deadlineSeconds: 60 };
const close = (instance?: http.Server) => instance ? new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }) : Promise.resolve();

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'recovery-conditions-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer((_req, res) => { providerRequests++; res.writeHead(500); res.end('NO_MODEL_CALL_EXPECTED'); });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const model = { id: modelId, gatewayId, name: 'No inference fixture', model: 'fixture', inputRate: 2, outputRate: 10 };
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', [gatewayId, { name: 'Local sentinel', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1' }]);
  await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [modelId, model, toolEvidence]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: '恢复检查隔离部门', agents: [employee] }]);
  const { runManagementRouter } = await import('../apps/api/src/run-management.ts');
  const app = express(); app.use(express.json()); app.use('/api', runManagementRouter(traceRoot));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message, code: error.code }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE model_reservations,usage,project_runs,projects,request_keys CASCADE');
  await pool.query('UPDATE product_settings SET data=$1 WHERE id=1', [{ autoBudgetLimit: .25, dailyBudgetLimit: 20, maxActiveRuns: 2, retentionDays: 0 }]);
  await pool.query('UPDATE gateways SET version=1 WHERE id=$1', [gatewayId]);
  providerRequests = 0;
});
after(async () => {
  if (!isolated) return;
  await close(server); await close(gateway); await pool?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seed(sealGoal=false) {
  const projectId = randomUUID(), runId = randomUUID(), receiptId = randomUUID();
  const { routeFingerprint } = await import('../apps/api/src/model-capabilities.ts');
  const model = (await pool.query('SELECT data FROM models WHERE id=$1', [modelId])).rows[0].data;
  const snapshot:any = { projectId, planVersion: 1, departmentId, departmentIds: [departmentId], requirement: 'Read-only recovery budget fixture',
    title: 'Recovery fixture', templateVersion: 'fixture', policy, tasks, approvedTasks: tasks,
    agents: [{ ...employee, model: model.name, rolePrompt: employee.instructions, roleVersion: 1 }],
    modelRoutes: [{ id: modelId, configurationHash: routeFingerprint(model, 1) }],
    departmentBudgets: { [departmentId]: .99 }, executionBudget: .99, budgetVersion: 1, budgetHistory: { calls: 0, tasks: {} } };
  if(sealGoal)snapshot.goalContract=createGoalContract(snapshot);
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [projectId, departmentId, '恢复检查隔离部门', snapshot.requirement, { ...policy, maxBudget: 2 }, { rationale: 'Concrete bounded text work', agents: [employee], tasks }, 'manual']);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,$2,1,'failed',$3,now())", [runId, projectId, snapshot]);
  for (const taskId of ['prepare', 'finish']) await pool.query('INSERT INTO usage(id,model_id,project_id,run_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,$4,$5,1,1,.1,$6)',
    [randomUUID(), modelId, projectId, runId, taskId, 'isolated budget fixture']);
  await pool.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history,expires_at) VALUES($1,$2,$3,$4,$5,.1,2,10,'uncertain',$6,$7,now()-interval '1 day')",
    [receiptId, modelId, projectId, runId, 'isolated unknown fixture', { taskId: 'finish' }, JSON.stringify([{ source: 'fixture', note: 'preserve original' }])]);
  const archive = createRunArchive(traceRoot, snapshot, { id: runId });
  archive.append('run/task-mapping', { tasks: [{ task_id: 't1', seed_id: 'prepare' }, { task_id: 't2', seed_id: 'finish' }] });
  archive.append('model/wire-request', { taskId: 'prepare' }); archive.append('model/wire-request', { taskId: 'finish' });
  archive.append('team/checkpoint', { tasks: [{ task_id: 't1', status: 'completed' }, { task_id: 't2', status: 'failed' }] });
  archive.append('run/finished', { status: 'failed', message: 'Historical fixture stop is not a current precheck' });
  return { projectId, runId, receiptId, archive };
}
async function check(runId: string, choices = '') {
  const response = await fetch(url + '/runs/' + runId + '/recovery-check' + choices);
  const body = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get('cache-control'), 'no-store'); return body;
}
async function state() {
  const names = ['projects', 'project_runs', 'model_reservations', 'usage', 'request_keys', 'tool_approvals', 'local_operations'];
  return Promise.all(names.map(async name => ({ name, rows: (await pool.query('SELECT row_to_json(t) AS data FROM ' + name + ' t ORDER BY row_to_json(t)::text')).rows })));
}

test('HTTP check reads the original cap and current ledger, separates full retry, and performs no mutations or provider calls', { skip: !isolated }, async () => {
  const { runId, archive } = await seed(); const before = await state();
  const journal = createHash('sha256').update(readFileSync(join(archive.dir, 'events.jsonl'))).digest('hex');
  const result = await check(runId, '?retainUncertainCosts=true');
  assert.equal(result.originalBudget, 1); assert.ok(Math.abs(result.costReadiness.availableBudget - .7) < 1e-10);
  assert.equal(result.calls.used, 2); assert.equal(result.calls.remaining, 3); assert.equal(result.planVersion, 1);
  assert.ok(Date.parse(result.checkedAt)); assert.equal(result.nativeRequestChecked, false);
  assert.equal(result.resume.allowed, true); assert.deepEqual(result.resume.completedTaskIds, ['prepare']);
  assert.equal(result.retry.allowed, false); assert.equal(result.retry.reasons[0].code, 'TASK_BUDGET_EXHAUSTED');
  assert.equal(result.retry.reasons[0].taskId, 'prepare');
  const task = result.tasks.find((item: any) => item.id === 'finish'); assert.equal(task.reserved, .1); assert.equal(task.calls, 1);
  assert.ok(Math.abs(task.availableBudget - .3) < 1e-10);
  assert.deepEqual(await state(), before); assert.equal(providerRequests, 0);
  assert.equal(createHash('sha256').update(readFileSync(join(archive.dir, 'events.jsonl'))).digest('hex'), journal);
});

test('sealed goal mutation blocks both preflight and actual resume without a child or model call', {skip:!isolated},async()=>{
 const {runId}=await seed(true);
 await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{requirement}','\"changed goal\"'::jsonb) WHERE id=$1",[runId]);
 const before=await state();const result=await check(runId,'?retainUncertainCosts=true');
 assert.equal(result.resume.allowed,false);assert.equal(result.retry.allowed,false);
 assert.ok(result.resume.reasons.some((r:any)=>r.code==='GOAL_CONTRACT_CHANGED'));
 const response=await fetch(url+'/runs/'+runId+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resume:true,retainUncertainCosts:true})});
 assert.equal(response.status,409);assert.equal((await response.json() as any).code,'GOAL_CONTRACT_CHANGED');
 assert.deepEqual(await state(),before);assert.equal(providerRequests,0);
});
test('a recorded goal boundary pause requires reapproval rather than repeating the same invalid run', {skip:!isolated},async()=>{
 const {runId,archive}=await seed(true);archive.append('goal/blocked',{message:'file outside approved scope',point:'file-scope'});
 const result=await check(runId,'?retainUncertainCosts=true');
 assert.equal(result.resume.allowed,false);assert.ok(result.resume.reasons.some((r:any)=>r.code==='GOAL_REPLAN_REQUIRED'));
 const response=await fetch(url+'/runs/'+runId+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({resume:true,retainUncertainCosts:true})});
 assert.equal(response.status,409);assert.equal((await response.json() as any).code,'GOAL_REPLAN_REQUIRED');assert.equal(providerRequests,0);
});

test('unknown fees require explicit carryover; in-flight fees always block and do not expire during GET', { skip: !isolated }, async () => {
  const { runId, receiptId } = await seed();
  assert.ok((await check(runId)).resume.reasons.some((reason: any) => reason.code === 'COST_PENDING'));
  assert.equal((await check(runId, '?retainUncertainCosts=true')).resume.allowed, true);
  await pool.query("UPDATE model_reservations SET status='pending' WHERE id=$1", [receiptId]);
  const before = await state(); const result = await check(runId, '?retainUncertainCosts=true');
  assert.equal(result.costReadiness.pendingCount, 1); assert.equal(result.resume.allowed, false);
  assert.ok(result.resume.reasons.some((reason: any) => reason.code === 'COST_PENDING'));
  assert.deepEqual(await state(), before); assert.equal(providerRequests, 0);
});

test('a task hold rejects before retry even with positive project money, and GET agrees with POST', { skip: !isolated }, async () => {
  const { runId } = await seed();
  await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{approvedTasks,1,maxBudget}','0.2'::jsonb) WHERE id=$1", [runId]);
  const before = await state(); const result = await check(runId, '?retainUncertainCosts=true');
  assert.ok(result.costReadiness.availableBudget > 0); assert.equal(result.resume.allowed, false);
  assert.ok(result.resume.reasons.some((reason: any) => reason.code === 'TASK_BUDGET_EXHAUSTED' && reason.taskId === 'finish'));
  const response = await fetch(url + '/runs/' + runId + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resume: true, retainUncertainCosts: true }) });
  assert.equal(response.status, 422); assert.equal((await response.json() as any).code, 'TASK_BUDGET_EXHAUSTED');
  assert.deepEqual(await state(), before); assert.equal(providerRequests, 0);
});

test('current history and version produce explicit refusals instead of trusting the snapshot or old failure', { skip: !isolated }, async () => {
  const { runId, projectId, archive } = await seed();
  for (let i = 0; i < 3; i++) archive.append('model/wire-request', { taskId: 'finish' });
  const result = await check(runId, '?retainUncertainCosts=true');
  assert.equal(result.calls.used, 5); assert.equal(result.calls.remaining, 0);
  assert.ok(result.resume.reasons.some((reason: any) => reason.code === 'TURN_LIMIT'));
  await pool.query('UPDATE projects SET version=2 WHERE id=$1', [projectId]);
  const changed = await check(runId, '?retainUncertainCosts=true');
  assert.ok(changed.resume.reasons.some((reason: any) => reason.code === 'RUN_REAPPROVAL_REQUIRED'));
  assert.equal(changed.planVersion, 1); assert.equal(providerRequests, 0);
});

test('external operation acknowledgement remains separate from unknown fee carryover', { skip: !isolated }, async () => {
  const { runId, archive } = await seed();
  archive.append('tool/start', { name: 'artifact_write', arguments: { path: 'fixture-only.txt' } }, { callId: 'unknown-fixture-operation' });
  const result = await check(runId, '?retainUncertainCosts=true'); assert.equal(result.unknownOperationCount, 1);
  assert.deepEqual(result.unknownOperationIds, ['unknown-fixture-operation']);
  assert.ok(result.resume.reasons.some((reason: any) => reason.code === 'OPERATION_RECONCILIATION_REQUIRED'));
  assert.equal((await check(runId, '?retainUncertainCosts=true&acknowledgeUnknownOperations=true')).resume.allowed, true);
  assert.equal(providerRequests, 0);
});

test('the original 90% retry guard and daily admission stay visible without changing the cap or ledger', { skip: !isolated }, async () => {
  const { runId, receiptId } = await seed();
  await pool.query("UPDATE usage SET cost=.8 WHERE run_id=$1 AND task_id='prepare'", [runId]);
  await pool.query('UPDATE model_reservations SET amount=.01 WHERE id=$1', [receiptId]);
  const before = await state(); const stopped = await check(runId, '?retainUncertainCosts=true');
  assert.ok(stopped.costReadiness.availableBudget > 0);
  assert.ok(stopped.resume.reasons.some((reason: any) => reason.code === 'BUDGET_RETRY_DISABLED'));
  assert.deepEqual(await state(), before);
  await pool.query('UPDATE product_settings SET data=jsonb_set(data,\'{dailyBudgetLimit}\',\'0.5\'::jsonb) WHERE id=1');
  const daily = await check(runId, '?retainUncertainCosts=true');
  assert.ok(daily.resume.reasons.some((reason: any) => reason.code === 'DAILY_BUDGET_EXCEEDED'));
  assert.equal(providerRequests, 0);
});

test('model configuration changes are reported by read-only inspection without running a capability probe', { skip: !isolated }, async () => {
  const { runId } = await seed(); await pool.query('UPDATE gateways SET version=2 WHERE id=$1', [gatewayId]);
  const before = await state(); const result = await check(runId, '?retainUncertainCosts=true');
  assert.ok(result.resume.reasons.some((reason: any) => reason.code === 'MODEL_REAPPROVAL_REQUIRED'));
  assert.equal(result.nativeRequestChecked, false); assert.equal(providerRequests, 0); assert.deepEqual(await state(), before);
});
