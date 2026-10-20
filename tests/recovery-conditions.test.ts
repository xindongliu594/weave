import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import type pg from 'pg';
import { createRunArchive, openRunArchive, readRun } from '../services/agent-runtime/trace-store.mjs';
import { toolEvidence } from './model-fixture.ts';
import { createGoalContract } from '../packages/contracts/goal-contract.mjs';
import {commitStepCheckpoint,checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';

// This test can open only the integration runner's fresh in-memory database.
// No product data, live service or external model endpoint is contacted.
const isolated = process.env.SIMULATED_INTEGRATION === 'pglite';
let pool: pg.Pool, server: http.Server, gateway: http.Server, directory: string, traceRoot: string, url: string;
let providerRequests = 0;
let resourcePlanningReply:object|undefined;
let resourcePlanningMessages:any[]=[];
let resourcePlanningRequest:any;
let resourcePlanningStatus=200;
const modelId = 'recovery-check-model', gatewayId = 'recovery-check-gateway', departmentId = 'recovery-check-department';
const employee = { id: 'manager', name: '隔离测试经理', title: '经理', role: 'manager', instructions: 'Read only fixture checks', modelId, tools: [] };
const tasks = [
  { id: 'prepare', subject: '已完成的准备任务', objective: 'Return fixture text', assigneeId: employee.id, assignee: employee.id, dependencies: [],
    acceptanceCriteria: ['fixture text'], estimatedInputTokens: 10, estimatedOutputTokens: 10, maxBudget: .1, maxModelCalls: 3, taskPrompt: 'Return fixture text' },
  { id: 'finish', subject: '未完成的验收任务', objective: 'Finish fixture text', assigneeId: employee.id, assignee: employee.id, dependencies: ['prepare'],
    acceptanceCriteria: ['fixture finished'], estimatedInputTokens: 10, estimatedOutputTokens: 10, maxBudget: .5, maxModelCalls: 3, taskPrompt: 'Finish fixture text' },
];
const policy = { maxBudget: 1, maxAgents: 1, maxConcurrentAgents: 1, maxModelCalls: 5, maxTaskModelCalls: 3, deadlineSeconds: 60, allowedModelIds:[modelId] };
const close = (instance?: http.Server) => instance ? new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()); }) : Promise.resolve();

before(async () => {
  if (!isolated) return;
  assert.match(process.env.DATABASE_URL ?? '', /@127\.0\.0\.1:\d+\/postgres$/);
  directory = await mkdtemp(join(tmpdir(), 'recovery-conditions-')); traceRoot = join(directory, 'runs');
  process.env.DATA_DIR = directory; process.env.TRACE_ROOT = traceRoot; process.env.OBSIDIAN_VAULT = join(directory, 'vault');
  const db = await import('../apps/api/src/db.ts'); pool = db.pool; await db.migrate();
  gateway = http.createServer(async(req, res) => { providerRequests++;const chunks=[];for await(const chunk of req)chunks.push(chunk);
    resourcePlanningRequest=JSON.parse(Buffer.concat(chunks).toString());
    resourcePlanningMessages=resourcePlanningRequest.messages??[];
    if(resourcePlanningStatus!==200){res.writeHead(resourcePlanningStatus);res.end('UNSUPPORTED_FORMAT_FIXTURE');return;}
    if(resourcePlanningReply){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(resourcePlanningReply)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}));}
    else{res.writeHead(500);res.end('NO_MODEL_CALL_EXPECTED');} });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const model = { id: modelId, gatewayId, name: 'No inference fixture', model: 'fixture', inputRate: 2, outputRate: 10 };
  await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)', [gatewayId, { name: 'Local sentinel', baseUrl: 'http://127.0.0.1:' + (gateway.address() as any).port + '/v1' }]);
  await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)", [modelId, model, toolEvidence]);
  await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)', [departmentId, { name: '恢复检查隔离部门', agents: [employee] }]);
  const { runManagementRouter } = await import('../apps/api/src/run-management.ts');
  const app = express(); app.use(express.json()); app.use('/api', runManagementRouter(traceRoot));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ message: error.message, code: error.code, ...(error.outputDiagnostic?{diagnostic:error.outputDiagnostic}:{}) }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); url = 'http://127.0.0.1:' + (server.address() as any).port + '/api';
});
beforeEach(async () => {
  if (!isolated) return;
  await pool.query('TRUNCATE model_reservations,usage,project_runs,projects,request_keys CASCADE');
  await pool.query('UPDATE product_settings SET data=$1 WHERE id=1', [{ autoBudgetLimit: .25, dailyBudgetLimit: 20, maxActiveRuns: 2, retentionDays: 0 }]);
  await pool.query('UPDATE gateways SET version=1 WHERE id=$1', [gatewayId]);
  providerRequests = 0;
  resourcePlanningReply=undefined;
  resourcePlanningMessages=[];
  resourcePlanningStatus=200;
});
after(async () => {
  if (!isolated) return;
  await close(server); await close(gateway); await pool?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seed(sealGoal=false,declaredReads=false,pricedRoutes=false,originalBudget=1,detailed=false,wideCalls=false,context?:{bytes:number;route:Record<string,any>},stepFiles=false,coordinatorEvidence=false) {
  const projectId = randomUUID(), runId = randomUUID(), receiptId = randomUUID();
  const { routeFingerprint } = await import('../apps/api/src/model-capabilities.ts');
  const model = (await pool.query('SELECT data FROM models WHERE id=$1', [modelId])).rows[0].data;
  const planTasks=tasks.map(task=>({...task,...(wideCalls&&task.id==='finish'?{maxModelCalls:10}:{}),...(declaredReads?{inputs:[]}:{}),...(pricedRoutes?{maxOutputTokens:512}:{}),
    ...(detailed?{objective:'只读核算输入、输出、边界值和错误结果，并引用固定版本资料。'.repeat(17)}:{})}));
  const snapshot:any = { projectId, planVersion: 1, departmentId, departmentIds: [departmentId], requirement: detailed?'库存 API 验收资料。'.repeat(50):'Read-only recovery budget fixture',
    title: 'Recovery fixture', templateVersion: 'fixture', policy:{...policy,maxBudget:originalBudget,...(coordinatorEvidence?{maxModelCalls:6}:{}),...(wideCalls?{maxModelCalls:20,maxTaskModelCalls:10}:{})}, tasks:planTasks, approvedTasks:planTasks,approval:{kind:'project',approvedAt:new Date().toISOString()},
    agents: [{ ...employee, model: model.name, rolePrompt: employee.instructions, roleVersion: 1 }],
    modelRoutes: [{ id: modelId, configurationHash: routeFingerprint(model, 1),...(pricedRoutes||coordinatorEvidence?{inputRate:2,outputRate:10,maxOutputTokens:512}:{}) }],
    departmentBudgets: { [departmentId]: .99 }, executionBudget: .99, budgetVersion: 1, budgetHistory: { calls: 0, tasks: {} } };
  if(context){snapshot.policy.contextBytes=context.bytes;Object.assign(snapshot.modelRoutes[0],context.route);}
  if(stepFiles){snapshot.executionTarget={backend:{kind:'openshell'}};snapshot.agents[0].tools=['filesystem'];snapshot.tasks[1].inputs=[{path:'input.txt',sha256:createHash('sha256').update('saved').digest('hex')}];}
  if(sealGoal)snapshot.goalContract=createGoalContract(snapshot);
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [projectId, departmentId, '恢复检查隔离部门', snapshot.requirement, { ...policy, maxBudget: 2 }, { rationale: 'Concrete bounded text work', agents: [employee], tasks:planTasks }, 'manual']);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,$2,1,'failed',$3,now())", [runId, projectId, snapshot]);
  for (const taskId of ['prepare', 'finish']) await pool.query('INSERT INTO usage(id,model_id,project_id,run_id,task_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,$4,$5,1,1,.1,$6)',
    [randomUUID(), modelId, projectId, runId, taskId, 'isolated budget fixture']);
  await pool.query("INSERT INTO model_reservations(id,model_id,project_id,run_id,purpose,amount,input_rate,output_rate,status,context,history,expires_at) VALUES($1,$2,$3,$4,$5,.1,2,10,'uncertain',$6,$7,now()-interval '1 day')",
    [receiptId, modelId, projectId, runId, 'isolated unknown fixture', { taskId: 'finish' }, JSON.stringify([{ source: 'fixture', note: 'preserve original' }])]);
  const archive = createRunArchive(traceRoot, snapshot, { id: runId });
  archive.append('run/task-mapping', { tasks: [{ task_id: 't1', seed_id: 'prepare' }, { task_id: 't2', seed_id: 'finish' }] });
  if(coordinatorEvidence)archive.append('model/wire-request',{body:coordinatorBody});
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

test('selected checkpoint preflight validates saved files instead of changed latest files without mutating data', {skip:!isolated},async()=>{
 const {runId,archive}=await seed(false,false,false,1,false,false,undefined,true);
 const workspace=join(archive.dir,'artifacts');mkdirSync(workspace);writeFileSync(join(workspace,'input.txt'),'saved');
 const snapshot=readRun(traceRoot,runId)!.snapshot;
 const checkpoint=commitStepCheckpoint({archive,workspace,boundary:{taskId:'finish',attemptId:'attempt',sessionId:'session',trigger:'cycle-complete',eventCursor:1,contractHash:checkpointContract(snapshot,snapshot.tasks[1])}});
 writeFileSync(join(workspace,'input.txt'),'changed');const before=await state();
 const latest=await check(runId,'?retainUncertainCosts=true');
 assert.ok(latest.resume.reasons.some((reason:any)=>reason.code==='HANDOFF_CHECKPOINT_INVALID'));
 const selected=await check(runId,'?retainUncertainCosts=true&checkpointId='+checkpoint.id);
 assert.ok(!selected.resume.reasons.some((reason:any)=>reason.code==='HANDOFF_CHECKPOINT_INVALID'),JSON.stringify(selected.resume.reasons));
 assert.equal(selected.costReadiness.availableBudget,latest.costReadiness.availableBudget);
 assert.deepEqual(await state(),before);assert.equal(providerRequests,0);
});

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

const coordinatorBody={model:'fixture',messages:[{role:'user',content:'Fixed coordinator fixture'}],max_tokens:512,tools:[{type:'function',function:{name:'agent_teams_status',parameters:{type:'object'}}}]};
const coordinatorOverhead=Buffer.byteLength(JSON.stringify({...coordinatorBody,messages:[]}))-2;
async function resourceSeed(...args:Parameters<typeof seed>){args[8]=true;return seed(...args);}
async function resourcePreview(runId:string,changes:any={}) {
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[runId])).rows[0];
  const previewId=randomUUID(),usageId=randomUUID();
  const data={kind:'run-resource-proposal',sourceRunId:runId,projectId:row.project_id,projectVersion:row.project_version,
    sourceGoalContract:row.snapshot.goalContract,sourceResourceRevision:0,ceiling:1.5,modelId,usageId,callRequirementVersion:'handoff-coordination-v2',coordinatorContinuationLimit:1,coordinatorHistory:{calls:1,requestOverheadBytes:coordinatorOverhead},
    proposal:{maxBudget:1.5,taskCallLimits:{finish:3},rationale:'Fund only unfinished work without resetting original counts'},...changes};
  await pool.query('INSERT INTO organization_previews(id,data,project_id) VALUES($1,$2,$3)',[previewId,data,row.project_id]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose,planning_preview_id) VALUES($1,$2,$3,1,1,.001,'预算补充规划',$4)",[usageId,modelId,row.project_id,previewId]);
  return {previewId,data};
}
const resourceRetry=(id:string,body:any)=>fetch(url+'/runs/'+id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('resource coordination count is explicit and invalid or absent grants cannot trigger a provider request',{skip:!isolated},async()=>{
 const {runId}=await resourceSeed(true),before=await state();
 for(const coordinatorContinuationLimit of [undefined,0,-1,1.5,null]){
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({modelId,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,...(coordinatorContinuationLimit===undefined?{}:{coordinatorContinuationLimit})})});
  assert.ok(response.status>=400);if(coordinatorContinuationLimit===undefined)assert.equal((await response.json() as any).code,'RESOURCE_COORDINATOR_LIMIT_REQUIRED');
 }
 assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
});

test('resource coordination refuses missing authentic envelope and insufficient shared calls or money before dispatch',{skip:!isolated},async()=>{
 const legacy=await seed(true,false,true);
 const request=(id:string,coordinatorContinuationLimit:number,maxBudget=1.5)=>fetch(url+'/runs/'+id+'/resource-proposal',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({modelId,maxBudget,maxPlanningCost:.1,retainUncertainCosts:true,coordinatorContinuationLimit})});
 const missing=await request(legacy.runId,1);assert.equal(missing.status,422);assert.equal((await missing.json() as any).code,'RESOURCE_COORDINATOR_HISTORY_MISSING');
 const bounded=await resourceSeed(true);
 const calls=await request(bounded.runId,2);assert.equal(calls.status,422);assert.equal((await calls.json() as any).code,'RESOURCE_CALLS_INSUFFICIENT');
 const priced=await resourceSeed(true,false,true);
 await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,.7,$4)',
  [randomUUID(),modelId,priced.projectId,'Coordination reserve fixture']);
 const money=await request(priced.runId,1,1.4);assert.equal(money.status,422);assert.equal((await money.json() as any).code,'RESOURCE_BUDGET_INSUFFICIENT');
 assert.equal(providerRequests,0);
});

test('coordination confirmation detects late admissions and normal resume keeps an exhausted absolute seal',{skip:!isolated},async()=>{
 const {runId}=await resourceSeed(true),{previewId}=await resourcePreview(runId);
 const body={resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'};
 const first=await resourceRetry(runId,body),child=await first.json() as any;assert.equal(first.status,202,JSON.stringify(child));
 const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[child.id])).rows[0].snapshot;
 assert.equal(snapshot.resourceApproval.coordinatorCallCeiling,2);assert.equal(snapshot.budgetHistory.coordinatorCalls,1);
 const archive=createRunArchive(traceRoot,snapshot,{id:child.id});archive.append('model/wire-request',{body:coordinatorBody});archive.append('run/finished',{status:'failed'});
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[child.id]);
 const inspection=await check(child.id,'?retainUncertainCosts=true');
 assert.deepEqual(inspection.coordinatorCalls,{used:2,limit:2,remaining:0});
 assert.ok(inspection.resume.reasons.some((r:any)=>r.code==='COORDINATOR_TURN_LIMIT'));
 const blocked=await resourceRetry(child.id,{resume:true,retainUncertainCosts:true});assert.equal(blocked.status,422);assert.equal((await blocked.json() as any).code,'COORDINATOR_TURN_LIMIT');
 const stale=await resourceSeed(true),draft=await resourcePreview(stale.runId);
 openRunArchive(traceRoot,stale.runId).append('model/wire-request',{body:coordinatorBody});
 const before=await state(),rejected=await resourceRetry(stale.runId,{...body,budgetPreviewId:draft.previewId});
 assert.equal(rejected.status,409);assert.equal((await rejected.json() as any).code,'RESOURCE_PREVIEW_STALE');
 assert.deepEqual(await state(),before);assert.equal(providerRequests,0);
});

test('resource candidate needs explicit approval and cannot silently launch ordinary resume', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true),{previewId}=await resourcePreview(runId),before=await state();
  const result=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:previewId});
  assert.equal(result.status,400);assert.equal((await result.json() as any).code,'RESOURCE_CONFIRMATION_REQUIRED');
  assert.deepEqual(await state(),before);assert.equal(providerRequests,0);
});
test('confirmed resource resume retains completed nodes, old counts and holds, and is idempotent', {skip:!isolated},async()=>{
  const {runId,receiptId}=await resourceSeed(true),{previewId}=await resourcePreview(runId);
  const original=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
  const body={resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'};
  const response=await resourceRetry(runId,body);assert.equal(response.status,202);
  const child=await response.json() as any;
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[child.id])).rows[0];
  assert.equal(row.project_version,1);assert.equal(row.snapshot.resourceRevision,1);assert.equal(row.snapshot.policy.maxBudget,1.5);
  assert.equal(row.snapshot.resourceApproval.sourceRunId,runId);assert.equal(row.snapshot.resourceApproval.previewId,previewId);
  assert.deepEqual(row.snapshot.completedCheckpoints,['prepare']);assert.equal(row.snapshot.budgetHistory.calls,3);
  assert.equal(row.snapshot.costCarryover.reserved,.1);assert.equal(row.snapshot.costCarryover.retained,true);
  assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot,original);
  assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[receiptId])).rows[0].status,'uncertain');
  const repeated=await resourceRetry(runId,body);assert.equal((await repeated.json() as any).id,child.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,2);
  const alternative=await resourcePreview(runId);
  const different=await resourceRetry(runId,{...body,budgetPreviewId:alternative.previewId});
  assert.equal(different.status,409);assert.equal((await different.json() as any).code,'RESOURCE_PREVIEW_STALE');
  await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[child.id]);
  const archive=createRunArchive(traceRoot,row.snapshot,{id:child.id});
  archive.append('run/task-mapping',{tasks:[{task_id:'t2',seed_id:'finish'}]});
  archive.append('model/wire-request',{taskId:'finish'});archive.append('model/wire-request',{taskId:'finish'});
  archive.append('team/checkpoint',{tasks:[{task_id:'t2',status:'failed'}]});
  const inspected=await check(child.id,'?retainUncertainCosts=true');
  assert.equal(inspected.calls.used,5);assert.equal(inspected.tasks.find((t:any)=>t.id==='finish').calls,3);
  assert.ok(inspected.retry.reasons.some((r:any)=>r.code==='RESOURCE_RESUME_ONLY'));
  const full=await resourceRetry(child.id,{resume:false,retainUncertainCosts:true});
  assert.equal(full.status,409);assert.equal((await full.json() as any).code,'RESOURCE_RESUME_ONLY');assert.equal(providerRequests,0);
});

test('an ordinary existing child cannot silently satisfy a different resource approval or incur new planning fees', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true);
  const normal=await resourceRetry(runId,{resume:true,retainUncertainCosts:true});assert.equal(normal.status,202);
  const normalId=(await normal.json() as any).id;
  await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[normalId]);
  const {previewId}=await resourcePreview(runId);
  const changed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  assert.equal(changed.status,409);assert.equal((await changed.json() as any).code,'RESOURCE_PREVIEW_STALE');
  const planning=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  assert.equal(planning.status,409);assert.equal((await planning.json() as any).code,'RESOURCE_SOURCE_SUPERSEDED');assert.equal(providerRequests,0);
});
test('resource approval refuses stale goal, different source and completed-node changes', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true),before=await state();
  for(const changes of [{sourceRunId:randomUUID()},{sourceGoalContract:{format:'approved-goal-v1',sha256:'a'.repeat(64)}},
    {proposal:{maxBudget:1.5,taskCallLimits:{prepare:3},rationale:'Invalid completed node adjustment'}}]){
    const {previewId}=await resourcePreview(runId,changes);
    const response=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
    assert.ok([409,422].includes(response.status));
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
  assert.equal(providerRequests,0);
  assert.deepEqual((await state()).find(entry=>entry.name==='model_reservations'),before.find(entry=>entry.name==='model_reservations'));
});

test('AI resource planning keeps the original project admission cap and only stores a receipt-backed candidate', {skip:!isolated},async()=>{
  const {runId,projectId}=await resourceSeed(true),original=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Local planner fixture, never employee acceptance'};
  const body={modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true};
  await pool.query("UPDATE projects SET policy=jsonb_set(policy,'{maxBudget}','0.301'::jsonb) WHERE id=$1",[projectId]);
  const blocked=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(blocked.status,422);assert.equal((await blocked.json() as any).code,'BUDGET_EXCEEDED');assert.equal(providerRequests,0);
  await pool.query("UPDATE projects SET policy=jsonb_set(policy,'{maxBudget}','1'::jsonb) WHERE id=$1",[projectId]);
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  assert.equal(candidate.kind,'run-resource-proposal');assert.deepEqual(candidate.completedTaskIds,['prepare']);
  const prompt=resourcePlanningMessages[0].content;
  assert.match(prompt,/"minimum":1/);assert.match(prompt,/"maximum":1.5/);
  const schema=JSON.parse(prompt.slice(prompt.indexOf('{'),prompt.indexOf('\n')));
  assert.equal(schema.properties.taskCallLimits.properties.finish.minimum,3);
  assert.equal(schema.properties.taskBudgetLimits.properties.finish.maximum,1.5);
  assert.deepEqual(candidate.proposal.taskBudgetLimits,{finish:1.2});
  const context=JSON.parse(resourcePlanningMessages[1].content);
  assert.equal(context.tasks.find((task:any)=>task.id==='finish').minimumCallLimit,3);
  assert.equal(context.tasks.find((task:any)=>task.id==='finish').handoffCorrectionRequests,1);
  assert.equal(context.tasks.find((task:any)=>task.id==='finish').workRequests,1);
  assert.equal(candidate.callRequirementVersion,'handoff-coordination-v2');
  assert.equal(context.costs.reserved,.1);assert.ok(context.costs.recordedCost>0);
  assert.ok(context.costs.availableAtCeiling>context.costs.availableAtOriginal);
  assert.equal(providerRequests,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot,original);
  const usage=(await pool.query('SELECT purpose,input_tokens,output_tokens,planning_preview_id FROM usage WHERE id=$1',[candidate.usageId])).rows[0];
  assert.equal(usage.purpose,'预算补充规划');assert.equal(usage.input_tokens,10);assert.equal(usage.planning_preview_id,candidate.previewId);
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  assert.equal(confirmed.status,202);assert.equal(providerRequests,1);
  const resumed=(await confirmed.json() as any).id;
  const resumedSnapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[resumed])).rows[0].snapshot;
  assert.equal(resumedSnapshot.tasks.find((task:any)=>task.id==='finish').maxBudget,1.2);
  assert.equal(resumedSnapshot.resourceApproval.callRequirementVersion,'handoff-coordination-v2');
  assert.equal(resumedSnapshot.budgetHistory.tasks.finish.cost,context.tasks.find((task:any)=>task.id==='finish').usedCost);
});

test('explicit continuation grant is previewed, sealed and exhausted across ordinary resume',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,false,1,false,true);
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:10},taskBudgetLimits:{finish:1.2},rationale:'Preserve the original cap and apply the smaller explicit continuation grant'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,taskContinuationLimits:{finish:2}})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  assert.deepEqual(candidate.taskContinuationLimits,{finish:2});assert.equal(providerRequests,1);
  assert.equal(JSON.parse(resourcePlanningMessages[1].content).tasks.find((t:any)=>t.id==='finish').nextRequestCount,2);
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  const child=await confirmed.json() as any;assert.equal(confirmed.status,202,JSON.stringify(child));
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[child.id])).rows[0].snapshot;
  assert.equal(snapshot.tasks.find((t:any)=>t.id==='finish').maxModelCalls,10);
  assert.deepEqual(snapshot.resourceApproval.taskCallCeilings,{finish:3});
  const archive=createRunArchive(traceRoot,snapshot,{id:child.id});
  archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'prepare'},{task_id:'t2',seed_id:'finish'}]});
  archive.append('model/wire-request',{taskId:'finish'});archive.append('model/wire-request',{taskId:'finish'});
  archive.append('run/finished',{status:'failed'});
  await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[child.id]);
  const result=await check(child.id,'?retainUncertainCosts=true'),task=result.tasks.find((t:any)=>t.id==='finish');
  assert.equal(task.callLimit,3);assert.equal(task.calls,3);assert.equal(task.remainingCalls,0);
  assert.ok(result.resume.reasons.some((r:any)=>r.code==='TASK_BUDGET_EXHAUSTED'));
  const before=await state(),blocked=await resourceRetry(child.id,{resume:true,retainUncertainCosts:true});
  assert.equal(blocked.status,422);assert.equal((await blocked.json() as any).code,'TASK_BUDGET_EXHAUSTED');
  assert.deepEqual(await state(),before);assert.equal(providerRequests,1);
});

test('invalid continuation grants are rejected before any paid planning request',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,false,1,false,true),before=await state();
  for(const taskContinuationLimits of [{},{prepare:2},{finish:2,other:2},{finish:100},{finish:0}]){
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,taskContinuationLimits})});
    assert.ok(response.status>=400);assert.equal(providerRequests,0);
  }
  assert.deepEqual(await state(),before);
});

test('resource planning without an output grant omits output adjustments from its schema and preserves the pinned limits',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,true),old=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Continue the unfinished task with its existing output limits'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  const prompt=resourcePlanningMessages[0].content,schema=JSON.parse(prompt.slice(prompt.indexOf('{'),prompt.indexOf('\n')));
  assert.equal(Object.hasOwn(schema.properties,'taskOutputLimits'),false);
  assert.equal(schema.additionalProperties,false);assert.equal(Object.hasOwn(candidate.proposal,'taskOutputLimits'),false);
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  assert.equal(confirmed.status,202);const child=(await confirmed.json() as any).id;
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[child])).rows[0].snapshot;
  assert.deepEqual(snapshot.modelRoutes,old.modelRoutes);
  assert.deepEqual(snapshot.tasks.map((t:any)=>t.maxOutputTokens),old.tasks.map((t:any)=>t.maxOutputTokens));
  assert.equal(providerRequests,1);
});

test('resource planning without an output grant rejects unsolicited output fields without storing a candidate',{skip:!isolated},async()=>{
  for(const taskOutputLimits of [{},{finish:8192}]){
    const {runId}=await resourceSeed(true,false,true),old=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
    resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},taskOutputLimits,rationale:'Unsolicited output adjustment fixture'};
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
    const result=await response.json() as any;assert.equal(response.status,422,JSON.stringify(result));
    assert.equal(result.code,'RESOURCE_PROPOSAL_INVALID');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organization_previews WHERE data->>'sourceRunId'=$1",[runId])).rows[0].n,0);
    assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot,old);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM usage WHERE project_id=(SELECT project_id FROM project_runs WHERE id=$1) AND purpose='预算补充规划'",[runId])).rows[0].n,1);
  }
  assert.equal(providerRequests,2);
});

test('context resource planning advertises only the exact authorized limit and applies it to a new snapshot',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,true,1,false,false,{bytes:48000,route:{contextWindowTokens:131072}});
  const original=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},contextBytes:64000,rationale:'Retain full review evidence within the approved expanded input limit'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,contextBytes:64000})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  assert.equal(candidate.contextBytes,64000);assert.equal(candidate.proposal.contextBytes,64000);
  const prompt=resourcePlanningMessages[0].content,schema=JSON.parse(prompt.slice(prompt.indexOf('{'),prompt.indexOf('\n')));
  assert.equal(schema.properties.contextBytes.const,64000);assert.ok(schema.required.includes('contextBytes'));
  const context=JSON.parse(resourcePlanningMessages[1].content);assert.equal(context.originalContextBytes,48000);assert.equal(context.contextBytes,64000);
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  const child=await confirmed.json() as any;assert.equal(confirmed.status,202,JSON.stringify(child));
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[child.id])).rows[0].snapshot;
  assert.equal(snapshot.policy.contextBytes,64000);assert.equal(snapshot.resourceApproval.contextBytes,64000);
  assert.deepEqual(snapshot.modelRoutes,original.modelRoutes);assert.deepEqual(snapshot.agents,original.agents);assert.deepEqual(snapshot.completedCheckpoints,['prepare']);
  assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot,original);assert.equal(providerRequests,1);
});

test('context resource planning rejects unsupported capacity reductions and insufficient full request money before calling a model',{skip:!isolated},async()=>{
  for(const fixture of [
    {bytes:47999,route:{contextWindowTokens:131072}},
    {bytes:64000,route:{contextWindowTokens:undefined}},
    {bytes:64000,route:{contextWindowTokens:65535}},
    {bytes:64000,route:{contextWindowTokens:131072,contextBytes:63999}},
    {bytes:500000,route:{contextWindowTokens:2000000}},
  ]){
    const {runId}=await resourceSeed(true,false,true,1,false,false,{bytes:48000,route:fixture.route}),before=await state();
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,contextBytes:fixture.bytes})});
    const result=await response.json() as any;assert.equal(response.status,422,JSON.stringify(result));
    assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
  }
});

test('unrequested context fields are absent from the planning schema and cannot produce a candidate',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,true);
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},contextBytes:64000,rationale:'Unrequested context expansion must not be authorized'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  assert.equal(response.status,422);assert.equal((await response.json() as any).code,'RESOURCE_PROPOSAL_INVALID');
  const prompt=resourcePlanningMessages[0].content,schema=JSON.parse(prompt.slice(prompt.indexOf('{'),prompt.indexOf('\n')));
  assert.equal(Object.hasOwn(schema.properties,'contextBytes'),false);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM organization_previews WHERE data->>'sourceRunId'=$1",[runId])).rows[0].n,0);assert.equal(providerRequests,1);
});

test('output resource candidate is explicit, persisted and applied only to a new recovery snapshot',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,true),old=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},taskOutputLimits:{finish:8192},rationale:'Allow the unfinished report to fit without repeating completed work'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,maxTaskOutputTokens:16384})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  assert.equal(candidate.maxTaskOutputTokens,16384);assert.equal(candidate.proposal.taskOutputLimits.finish,8192);
  assert.equal(providerRequests,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
  const schema=JSON.parse(resourcePlanningMessages[0].content.slice(resourcePlanningMessages[0].content.indexOf('{'),resourcePlanningMessages[0].content.indexOf('\n')));
  assert.equal(schema.properties.taskOutputLimits.properties.finish.maximum,16384);
  const quoted=JSON.parse(resourcePlanningMessages[1].content).tasks.find((t:any)=>t.id==='finish').outputBudgetOptions;
  assert.deepEqual(quoted.map((q:any)=>q.maxOutputTokens),[512,8192,16384]);
  assert.ok(quoted[1].minimumBudget>=quoted[0].minimumBudget);
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  const result=await confirmed.json() as any;assert.equal(confirmed.status,202,JSON.stringify(result));
  const child=(await pool.query('SELECT snapshot FROM project_runs WHERE parent_run_id=$1',[runId])).rows[0].snapshot;
  assert.equal(child.tasks.find((t:any)=>t.id==='finish').maxOutputTokens,8192);assert.equal(child.modelRoutes[0].maxOutputTokens,8192);
  assert.equal(child.resourceApproval.maxTaskOutputTokens,16384);
  assert.deepEqual(child.tasks.find((t:any)=>t.id==='prepare'),old.tasks.find((t:any)=>t.id==='prepare'));
  assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot,old);
});

test('detailed output recovery planning fits the approved small planning request without dropping task context',{skip:!isolated},async()=>{
  const prior=(await pool.query('SELECT data FROM models WHERE id=$1',[modelId])).rows[0].data;
  try{
    await pool.query('UPDATE models SET data=$1 WHERE id=$2',[{...prior,inputRate:.3,outputRate:1.2},modelId]);
    const {runId}=await resourceSeed(true,false,true,1,true);
    resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},taskOutputLimits:{finish:8192},rationale:'Use the approved output space within the same planning fee'};
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.003,retainUncertainCosts:true,maxTaskOutputTokens:8192})});
    const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
    const context=JSON.parse(resourcePlanningMessages[1].content);
    assert.equal(context.requirement,'库存 API 验收资料。'.repeat(50));
    assert.equal(context.tasks.find((task:any)=>task.id==='finish').objective,'只读核算输入、输出、边界值和错误结果，并引用固定版本资料。'.repeat(17));
    assert.equal(providerRequests,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
  }finally{await pool.query('UPDATE models SET data=$1 WHERE id=$2',[prior,modelId]);}
});

test('output planning cannot store a candidate funded only for the old output limit',{skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true,false,true);
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:.55},taskOutputLimits:{finish:8192},rationale:'Insufficient new output reserve fixture'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,maxTaskOutputTokens:16384})});
  const value=await response.json() as any;assert.equal(response.status,422,JSON.stringify(value));
  assert.match(value.message,/完整请求/);assert.equal(providerRequests,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
});

test('one remaining node call is rejected before paid resource planning or any data changes', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true);
  openRunArchive(traceRoot,runId).append('model/wire-request',{taskId:'finish'});
  const before=await state();
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Insufficient one-call fixture'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  assert.equal(response.status,422);assert.equal((await response.json() as any).code,'RESOURCE_CALLS_INSUFFICIENT');
  assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
});

test('confirmation rechecks consumed calls and rejects pre-upgrade drafts without creating employees', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true),{previewId}=await resourcePreview(runId),before=await state();
  openRunArchive(traceRoot,runId).append('model/wire-request',{taskId:'finish'});
  const body={resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'};
  const exhausted=await resourceRetry(runId,body);
  assert.equal(exhausted.status,422);assert.equal((await exhausted.json() as any).code,'RESOURCE_CALLS_INSUFFICIENT');
  for(const callRequirementVersion of [undefined,'handoff-correction-v1']){
    const oldDraft=await resourcePreview(runId,{callRequirementVersion});
    const outdated=await resourceRetry(runId,{...body,budgetPreviewId:oldDraft.previewId});
    assert.equal(outdated.status,409);assert.equal((await outdated.json() as any).code,'RESOURCE_PREVIEW_STALE');
  }
  assert.equal(providerRequests,0);
  assert.deepEqual((await state()).find(entry=>entry.name==='model_reservations'),before.find(entry=>entry.name==='model_reservations'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
});

test('shared project money rejects a full correction tranche before planning despite sufficient node money', {skip:!isolated},async()=>{
  const {runId,projectId}=await resourceSeed(true,false,true);
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,1.1,$4)',
    [randomUUID(),modelId,projectId,'isolated historical project expense']);
  const before=await state();
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  assert.equal(response.status,422);assert.equal((await response.json() as any).code,'RESOURCE_BUDGET_INSUFFICIENT');
  assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
});

test('late project expenses prevent confirming a previously valid correction candidate', {skip:!isolated},async()=>{
  const {runId,projectId}=await resourceSeed(true,false,true),{previewId}=await resourcePreview(runId);
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,1.1,$4)',
    [randomUUID(),modelId,projectId,'isolated late confirmed expense']);
  const before=await state();
  const response=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  assert.equal(response.status,422);assert.equal((await response.json() as any).code,'RESOURCE_BUDGET_INSUFFICIENT');
  assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
});

test('next-tranche floor also reserves the bounded planning request before paid admission', {skip:!isolated},async()=>{
  const {runId,projectId}=await resourceSeed(true,false,true,1.3);
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,1,1,.75,$4)',
    [randomUUID(),modelId,projectId,'isolated project history']);
  const before=await state();
  resourcePlanningReply={maxBudget:1.42,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Tranche fits but full allowed planning amount does not'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.42,maxPlanningCost:.1,retainUncertainCosts:true})});
  assert.equal(response.status,422);assert.equal((await response.json() as any).code,'RESOURCE_BUDGET_INSUFFICIENT');
  assert.equal(providerRequests,0);assert.deepEqual(await state(),before);
});

test('invalid resource proposals expose bounded diagnostics, preserve settled usage and never start employees', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true);
  const privateText='private-model-content-must-not-leak';
  resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:0},taskBudgetLimits:{finish:1.2},rationale:privateText};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
  const result=await response.json() as any;
  assert.equal(response.status,422);assert.equal(result.code,'RESOURCE_PROPOSAL_INVALID');
  assert.equal(result.diagnostic.reason,'PLAN_SCHEMA_INVALID');
  assert.equal(result.diagnostic.finishReason,'stop');
  assert.equal(result.diagnostic.schemaIssues[0].expected.minimum,3);
  assert.equal(JSON.stringify(result).includes(privateText),false);
  assert.match(result.diagnostic.originalOutputSHA,/^[a-f0-9]{64}$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM usage WHERE purpose='预算补充规划'")).rows[0].n,1);
});

test('DeepSeek resource planning sends JSON mode through the actual budgeted request', {skip:!isolated},async()=>{
  const prior=(await pool.query('SELECT data FROM models WHERE id=$1',[modelId])).rows[0].data;
  try {
    await pool.query('UPDATE models SET data=$1 WHERE id=$2',[{...prior,model:'deepseek-v4.1-flash'},modelId]);
    const {runId}=await resourceSeed(true);
    resourcePlanningReply={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Reserve work and formal handoff within the approved cap'};
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    assert.deepEqual(resourcePlanningRequest.response_format,{type:'json_object'});
    assert.equal(providerRequests,1);
  } finally {await pool.query('UPDATE models SET data=$1 WHERE id=$2',[prior,modelId]);}
});

test('missing fields, wrapped plans and schema echoes remain paid failures with no automatic retry', {skip:!isolated},async()=>{
  const valid={maxBudget:1.5,taskCallLimits:{finish:3},taskBudgetLimits:{finish:1.2},rationale:'Private bounded proposal text'};
  for (const reply of [{rationale:valid.rationale},{proposal:valid},{type:'object',properties:{maxBudget:{type:'number'}}}]) {
    const {runId}=await resourceSeed(true),before=await state(),requests=providerRequests;
    resourcePlanningReply=reply;
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
    const result=await response.json() as any;
    assert.equal(response.status,422);assert.equal(result.diagnostic.reason,'PLAN_SCHEMA_INVALID');
    assert.ok(result.diagnostic.schemaIssues.some((issue:any)=>issue.path[0]==='taskCallLimits'));
    assert.equal(JSON.stringify(result).includes(valid.rationale),false);assert.equal(providerRequests,requests+1);
    assert.deepEqual((await state()).find(row=>row.name==='project_runs'),before.find(row=>row.name==='project_runs'));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM usage WHERE run_id IS NULL AND purpose='预算补充规划'")).rows[0].n,requests+1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM organization_previews WHERE data->>'sourceRunId'=$1",[runId])).rows[0].n,0);
  }
});

test('JSON mode rejection makes no paid fallback and preserves unknown cost plus the source run', {skip:!isolated},async()=>{
  const prior=(await pool.query('SELECT data FROM models WHERE id=$1',[modelId])).rows[0].data;
  try {
    await pool.query('UPDATE models SET data=$1 WHERE id=$2',[{...prior,model:'deepseek-v4.1-flash'},modelId]);
    const {runId}=await resourceSeed(true),before=await state();resourcePlanningStatus=400;
    const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true})});
    assert.equal(response.status,502);assert.equal((await response.json() as any).code,'GATEWAY_REJECTED');
    assert.equal(providerRequests,1);
    assert.deepEqual((await state()).find(row=>row.name==='project_runs'),before.find(row=>row.name==='project_runs'));
    const receipt=(await pool.query("SELECT status,amount FROM model_reservations WHERE purpose='预算补充规划'")).rows[0];
    assert.equal(receipt.status,'uncertain');assert.ok(Number(receipt.amount)>0);
  } finally {await pool.query('UPDATE models SET data=$1 WHERE id=$2',[prior,modelId]);}
});

test('explicit larger call ceilings travel from planning through confirmation without resetting archived calls', {skip:!isolated},async()=>{
  const {runId}=await resourceSeed(true);
  resourcePlanningReply={maxBudget:1.5,maxModelCalls:12,taskCallLimits:{finish:8},taskBudgetLimits:{finish:1.2},rationale:'Explicit cumulative call allowance fixture'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1,retainUncertainCosts:true,maxModelCalls:12,maxTaskModelCalls:8})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  assert.deepEqual(candidate.callCeilings,{maxModelCalls:12,maxTaskModelCalls:8});
  const confirmed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true,budgetPreviewId:candidate.previewId,confirmation:'APPROVE_RESOURCES_AND_RESUME'});
  assert.equal(confirmed.status,202);const child=(await confirmed.json() as any).id;
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[child])).rows[0].snapshot;
  assert.equal(snapshot.policy.maxModelCalls,12);assert.equal(snapshot.policy.maxTaskModelCalls,8);
  assert.equal(snapshot.tasks.find((t:any)=>t.id==='finish').maxModelCalls,8);
  assert.equal(snapshot.budgetHistory.calls,3);assert.equal(snapshot.budgetHistory.tasks.finish.calls,1);
  assert.deepEqual(snapshot.completedCheckpoints,['prepare']);assert.equal(providerRequests,1);
});

test('overlapping task lifetime ceilings need only their next bounded tranches inside the shared project ceiling', {skip:!isolated},async()=>{
  const seeded=await resourceSeed(true),base=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[seeded.runId])).rows[0].snapshot;
  const projectId=randomUUID(),runId=randomUUID(),unfinished=['first','second','third'].map(id=>({...tasks[1],id,dependencies:[],maxModelCalls:40}));
  const snapshot={...base,projectId,policy:{...base.policy,contextBytes:4000,maxModelCalls:100,maxTaskModelCalls:40},tasks:unfinished,approvedTasks:unfinished};
  snapshot.goalContract=createGoalContract(snapshot);
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',
    [projectId,departmentId,'Fixture',snapshot.requirement,snapshot.policy,{agents:[employee],tasks:unfinished,rationale:'Shared project cap'},'manual']);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,$2,1,'failed',$3,now())",[runId,projectId,snapshot]);
  const archive=createRunArchive(traceRoot,snapshot,{id:runId});archive.append('model/wire-request',{body:coordinatorBody});archive.append('run/finished',{status:'failed'});
  resourcePlanningReply={maxBudget:1.5,maxModelCalls:100,taskCallLimits:{first:40,second:40,third:40},
    taskBudgetLimits:{first:.5,second:.5,third:.5},rationale:'Overlapping lifetime allowances share one project gate'};
  const response=await fetch(url+'/runs/'+runId+'/resource-proposal',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({modelId,coordinatorContinuationLimit:1,maxBudget:1.5,maxPlanningCost:.1})});
  const candidate=await response.json() as any;assert.equal(response.status,200,JSON.stringify(candidate));
  const context=JSON.parse(resourcePlanningMessages[1].content);
  assert.equal(context.tasks.reduce((sum:number,task:any)=>sum+task.nextRequestCount,0),21);
  assert.ok(context.tasks.every((task:any)=>task.minimumCallLimit===40&&task.usedCalls===0));
  assert.equal(candidate.proposal.maxModelCalls,100);assert.equal(providerRequests,1);
});

test('legacy pre-execution read denials resume only with complete matching host evidence; other goal blocks remain fatal', {skip:!isolated},async()=>{
  async function blockedRead(change:Record<string,any>={}){
    const seeded=await resourceSeed(true,true),row=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[seeded.runId])).rows[0];
    const archive=openRunArchive(traceRoot,seeded.runId),callId='denied-read-'+randomUUID(),sessionId=randomUUID();
    const path='.agent-teams/run-test/inbox/private.jsonl',message='UNDECLARED_INPUT: '+path;
    archive.append('tool/start',{name:'filesystem',arguments:{path}},{sessionId,callId});
    archive.append('goal/blocked',{point:'file-scope',taskId:'finish',sha256:row.snapshot.goalContract.sha256,message,...change.block});
    if(change.brokenSequence)archive.append('fixture/interleaved',{});
    archive.append('runtime/operation-failed',{name:'filesystem',classification:'blocked',code:'Error',message,...change.failure},{sessionId,callId});
    archive.append('handoff/blocked',{taskId:'finish',attemptId:'attempt',message});
    if(!change.missingResult)archive.append('tool/result',{name:'filesystem',result:{isError:true,error:{message:'HANDOFF_BLOCKED: finish: '+message},...change.result}},{sessionId,callId:change.foreignCall?'other-call':callId,taskId:change.foreignTask?'t1':'t2',attemptId:change.foreignAttempt?'foreign':'attempt'});
    if(change.extraGoalBlock)archive.append('goal/blocked',{point:'tool-dispatch',message:'GOAL_CONTRACT_CHANGED: real violation'});
    return seeded.runId;
  }
  const runId=await blockedRead(),beforeUsage=(await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n;
  const {assertGoalRecovery}=await import('../apps/api/src/goal-recovery.ts'),run=readRun(traceRoot,runId);
  assert.throws(()=>assertGoalRecovery(run!.snapshot,{...run,integrity:'incomplete'}),{code:'GOAL_REPLAN_REQUIRED'});
  const result=await check(runId,'?retainUncertainCosts=true');assert.equal(result.resume.allowed,true,JSON.stringify(result.resume.reasons));
  const resumed=await resourceRetry(runId,{resume:true,retainUncertainCosts:true});assert.equal(resumed.status,202);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n,beforeUsage);assert.equal(providerRequests,0);
  for(const change of [{missingResult:true},{brokenSequence:true},{extraGoalBlock:true},{foreignCall:true},{foreignTask:true},{foreignAttempt:true},{result:{error:{message:'unrelated'}}},{failure:{name:'artifact_write'}},{failure:{classification:'outcome_unknown'}},
    {result:{isError:false,value:{content:'read data'}}},{block:{point:'tool-dispatch'}},{block:{sha256:'0'.repeat(64)}},{block:{message:'VERSION_MISMATCH: protected.txt'}}]){
    const denied=await check(await blockedRead(change),'?retainUncertainCosts=true');
    assert.equal(denied.resume.allowed,false);assert.ok(denied.resume.reasons.some((r:any)=>r.code==='GOAL_REPLAN_REQUIRED'));
  }
});
