import {toolEvidence} from './model-fixture.ts';
import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Model} from '../packages/contracts/index.ts';
import {createRunArchive,openRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createGoalContract} from '../packages/contracts/goal-contract.mjs';
import {applyRecoveryResources} from '../apps/api/src/recovery-resource-plan.ts';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='cost_'+Date.now();
let pool:pg.Pool,app:any,server:any,gateway:any,url:string,dir:string,cost:typeof import('../apps/api/src/cost-control.ts');
let requests=0,mode='ok';
const model:Model={id:'model',gatewayId:'gateway',name:'Local fixture',model:'fixture',inputRate:0,outputRate:10000,version:1,status:'available',capabilities:toolEvidence};
const policy={maxBudget:10,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300};
const agent={id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调任务',modelId:model.id,tools:[]};
const plan={rationale:'费用测试',agents:[agent],tasks:[{id:'task',subject:'任务',objective:'验证费用',assigneeId:agent.id,dependencies:[],acceptanceCriteria:['通过'],estimatedInputTokens:10,estimatedOutputTokens:10,maxBudget:2}]};
const settings=(dailyBudgetLimit=20)=>({autoBudgetLimit:.25,dailyBudgetLimit,maxActiveRuns:2,retentionDays:0});
async function call(path:string,method='GET',body?:any){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbUrl=new URL(base);dbUrl.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbUrl.toString();
 dir=await mkdtemp(join(tmpdir(),'cost-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();cost=await import('../apps/api/src/cost-control.ts');
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 gateway=http.createServer(async(req:any,res:any)=>{for await(const _ of req){}requests++;if(mode==='drop'){req.socket.destroy();return;}res.setHeader('content-type','application/json');if(mode==='denied'){res.setHeader('x-oneapi-request-id','relay-forbidden-403');res.setHeader('x-upstream-request-id','upstream-forbidden-403');res.setHeader('x-request-id','response-forbidden-403');res.writeHead(403);res.end(JSON.stringify({error:'Synthetic access denied'}));return;}res.end(JSON.stringify({choices:mode==='bad-message'?[]:[{message:{content:'OK'}}],...(mode==='missing'?{}:{usage:{prompt_tokens:0,completion_tokens:mode==='overrun'?200:25}})}));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['gateway',{name:'Fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'}]);await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[model.id,model,toolEvidence]);
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'测试部门',description:'',agents:[agent]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'测试部门','核对所有模型调用的预算上限',$1,$2,'manual')",[policy,plan]);
});
beforeEach(async()=>{await pool.query('TRUNCATE model_reservations,usage,project_runs,request_keys CASCADE');await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings()]);await pool.query("UPDATE departments SET data=data-'dailyBudget'");requests=0;mode='ok';});
after(async()=>{await app?.locals.shutdown();for(const s of [server,gateway])if(s)await new Promise<void>(r=>s.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

test('demand discussion records actual usage without estimating or reserving an execution budget',async()=>{
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(.01)]);
 mode='overrun';
 const result=await cost.completeOrganizationConversation(model,[{role:'user',content:'先聊需求，不执行项目'}],100,{sessionId:'organization:fixture'});
 assert.equal(requests,1);
 const receipt=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[result.usageId])).rows[0];
 assert.equal(Number(receipt.amount),0);assert.equal(receipt.status,'settled');assert.equal(receipt.context.accountingMode,'conversation');
 assert.equal(Number((await pool.query('SELECT cost FROM usage WHERE id=$1',[result.usageId])).rows[0].cost),2);
 assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:0});
 const totals=(await call('/costs')).data;
 assert.equal(totals.conversationSpent,2);assert.equal(totals.recordedSpent,2);assert.equal(totals.spent,0);
 await assert.rejects(cost.reserveCall({model,amount:.02,purpose:'执行测试',context:{accountingMode:'conversation'}}),e=>(e as any).code==='DAILY_BUDGET_EXCEEDED');
 await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'执行预算仍有效'}],100,{purpose:'连接测试',maxCost:.1}),e=>(e as any).code==='CALL_BUDGET_EXCEEDED');
 assert.equal(requests,1,'budgeted failures cannot dispatch another wire');
});

test('usage-only accounting cannot be applied to execution or project identities',async()=>{
 for(const patch of [{purpose:'项目执行'},{projectId:'project'},{runId:'run'},{billingDepartmentId:'department'},{maxCost:1},{amount:1}]){
  await assert.rejects(cost.reserveCall({model,amount:0,purpose:'组织需求对话',accountingMode:'conversation',...patch}),e=>(e as any).code==='INVALID_CONVERSATION_ACCOUNTING');
 }
 assert.equal(requests,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_reservations')).rows[0].n,0);
});

test('missing conversation usage stays unknown without claiming zero supplier charge',async()=>{
 mode='missing';
 await assert.rejects(cost.completeOrganizationConversation(model,[{role:'user',content:'需求讨论'}],100,{sessionId:'organization:missing'}),e=>(e as any).code==='USAGE_MISSING');
 const data=(await call('/costs')).data;
 assert.equal(data.calls.length,1);assert.equal(data.calls[0].status,'uncertain');assert.equal(data.calls[0].accountingMode,'conversation');assert.equal(data.calls[0].amount,0);
 assert.equal(data.spent,0);assert.equal(data.conversationSpent,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage')).rows[0].n,0);
 assert.equal(requests,1);
});

test('parallel direct calls reserve globally before fetch and departmental caps cover planning and execution admission',async()=>{
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(1.5)]);
 const results=await Promise.allSettled([1,2].map(()=>cost.reserveCall({model,amount:1,purpose:'连接测试'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&(r.reason as any).code==='DAILY_BUDGET_EXCEEDED').length,1);
 assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:1});
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings()]);
 await pool.query("UPDATE departments SET data=data||'{\"dailyBudget\":0.5}'::jsonb");
 await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'test'}],100,{purpose:'组织规划',projectId:'project'}),e=>(e as any).code==='DEPARTMENT_DAILY_BUDGET_EXCEEDED');assert.equal(requests,0);
 const approved=await call('/projects/project/approve','POST',{version:1});assert.equal(approved.data.code,'DEPARTMENT_DAILY_BUDGET_EXCEEDED');
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(.01)]);
 const tested=await call('/models/model/test','POST',{});assert.equal(tested.data.code,'DAILY_BUDGET_EXCEEDED');assert.equal(requests,0);
 assert.equal((await pool.query('SELECT status FROM models WHERE id=$1',[model.id])).rows[0].status,'available');
});

test('runtime requests share the run reservation and uncertain costs survive completion and block retry',async()=>{
 const runId=randomUUID(),snapshot={projectId:'project',departmentId:'department',planVersion:1,policy,executionBudget:10,agents:[agent],tasks:[{id:'task',subject:'任务',maxBudget:2,assignee:'manager',dependencies:[]}]};
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'project',1,'running',$2)",[runId,snapshot]);
 const traceRoot=join(dir,'runs'),writers=createArchiveWriterManager({traceRoot});
 await writers.withWriter([runId],async()=>{createRunArchive(traceRoot,snapshot,{id:runId});});
 const input={model,amount:1,purpose:'项目执行',projectId:'project',runId,context:{taskId:'task'}};
 const first=await cost.reserveCall(input);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:10});
 await cost.settleCall(first,0,25);assert.deepEqual(await cost.dailyTotals(pool),{spent:.25,reserved:9.75});
 const second=await cost.reserveCall(input);await cost.markCallUncertain(second,'connection lost');
 await assert.rejects(cost.reserveCall(input),e=>(e as any).code==='TASK_BUDGET_EXCEEDED');
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[runId]);
 await writers.withWriter([runId],async()=>{openRunArchive(traceRoot,runId).append('run/finished',{status:'failed',message:'Synthetic missing-receipt scenario; no real model execution.'});});
 assert.deepEqual(await cost.dailyTotals(pool),{spent:.25,reserved:1});
 assert.equal((await call('/runs/'+runId+'/retry','POST',{resume:true})).data.code,'COST_PENDING');
 assert.match((await call('/runs/'+runId)).data.recovery.costBlocked,/核对供应方账单/);
 await pool.query("UPDATE usage SET created_at=now()-interval '2 days'");assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:1});
});

test('resource planning uses only the latest stopped same-version sealed approval, never an arbitrary new ceiling',async()=>{
  const parentId=randomUUID(),sourceId=randomUUID();
  const old:any={projectId:'project',departmentId:'department',planVersion:1,policy:{...policy,maxModelCalls:32,maxTaskModelCalls:16},
    requirement:'Original task',agents:[agent],tasks:[{id:'task',subject:'Original task',assignee:'manager',maxBudget:2,maxModelCalls:6}]};
  old.goalContract=createGoalContract(old);
  const proposal={maxBudget:18,taskCallLimits:{task:8},rationale:'Explicit budget approval fixture'};
  const snapshot=applyRecoveryResources(old,proposal,{newRevision:1,completedTaskIds:[],history:{calls:3,tasks:{task:{calls:3}}},ceiling:18});
  snapshot.resourceApproval={format:'run-resource-approval-v1',revision:1,sourceRunId:parentId,sourceGoalContract:old.goalContract,
    ceiling:18,proposal,previewId:randomUUID(),usageId:randomUUID()};
  snapshot.approval={kind:'resume-resources'};snapshot.goalContract=createGoalContract(snapshot);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'project',1,'failed',$2)",[parentId,old]);
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,parent_run_id,attempt,status,snapshot) VALUES($1,'project',1,$2,2,'failed',$3)",[sourceId,parentId,snapshot]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,'model','project',0,990,9.9,'Synthetic prior cost')",[randomUUID()]);
  const input={model,amount:.2,purpose:'预算补充规划',projectId:'project',projectVersion:1,resourcePlanningRunId:sourceId};
  await assert.rejects(cost.reserveCall({...input,resourcePlanningRunId:undefined}),e=>(e as any).code==='BUDGET_EXCEEDED');
  const id=await cost.reserveCall(input);assert.equal(Number((await pool.query('SELECT amount FROM model_reservations WHERE id=$1',[id])).rows[0].amount),.2);
  await cost.settleCall(id,0,20);assert.equal(requests,0);
  for(const patch of [{purpose:'Other planning'},{projectVersion:2},{resourcePlanningRunId:parentId},{resourcePlanningRunId:randomUUID()},
    {runId:sourceId}])await assert.rejects(cost.reserveCall({...input,...patch}));
  await assert.rejects(cost.reserveCall({...input,amount:8.1}),e=>(e as any).code==='BUDGET_EXCEEDED');
  await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[sourceId]);
  await assert.rejects(cost.reserveCall(input),e=>(e as any).code==='RESOURCE_PLANNING_SOURCE_INVALID');
  await pool.query("UPDATE project_runs SET status='failed',snapshot=$1 WHERE id=$2",[{...snapshot,policy:{...snapshot.policy,maxBudget:19}},sourceId]);
  await assert.rejects(cost.reserveCall(input),e=>(e as any).code==='RESOURCE_PLANNING_SOURCE_INVALID');
});

test('missing usage and network failures retain a lease until explicit reconciliation using pinned prices',async()=>{
 for(const failure of ['missing','drop']){
  mode=failure;await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'test'}],100,{purpose:'组织规划',projectId:'project'}));
  const pending=(await call('/costs')).data.calls;assert.equal(pending.length,1);assert.equal(pending[0].status,'uncertain');
  await assert.rejects(cost.reserveCall({model,amount:1,purpose:'组织规划',projectId:'project'}),e=>(e as any).code==='COST_PENDING');
  const id=pending[0].id;
  const reconciled=await call('/costs/'+id+'/reconcile','POST',{inputTokens:0,outputTokens:10,note:'Fixture receipt confirms ten output tokens',confirmation:'RECONCILE'});
  assert.equal(reconciled.status,200);assert.equal(reconciled.data.cost,.1);assert.equal((await call('/costs')).data.calls.length,0);
  assert.equal((await call('/costs/'+id+'/reconcile','POST',{inputTokens:0,outputTokens:0,note:'Repeated reconciliation is rejected',confirmation:'RECONCILE'})).status,409);
 }
 assert.equal(requests,2);assert.equal(Number((await pool.query('SELECT sum(cost) AS n FROM usage')).rows[0].n),.2);
 const stale=await cost.reserveCall({model,amount:1,purpose:'连接测试'});await pool.query("UPDATE model_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[stale]);
 assert.equal((await call('/costs')).data.calls[0].status,'uncertain');
});

test('known receipts are recorded despite malformed output or excessive usage; late receipts correct a manual entry once',async()=>{
 mode='bad-message';await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'test'}],100,{purpose:'连接测试'}));
 assert.equal((await call('/costs')).data.calls.length,0);assert.equal(Number((await pool.query('SELECT sum(cost) AS n FROM usage')).rows[0].n),.25);
 mode='overrun';await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'test'}],100,{purpose:'连接测试'}),e=>(e as any).code==='CALL_BUDGET_EXCEEDED');
 assert.equal(Number((await pool.query('SELECT sum(cost) AS n FROM usage')).rows[0].n),2.25);
 const id=await cost.reserveCall({model,amount:1,purpose:'连接测试'});await cost.markCallUncertain(id,'timed out');
 const resolved=await Promise.allSettled([1,2].map(tokens=>cost.settleCall(id,0,tokens,{},'Fixture manual receipt')));assert.equal(resolved.filter(r=>r.status==='fulfilled').length,1);
 await cost.settleCall(id,0,10);await cost.settleCall(id,0,10);
 const row=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[id])).rows[0];assert.equal(row.history.filter((h:any)=>h.source==='provider').length,1);
 assert.equal((await pool.query('SELECT output_tokens FROM usage WHERE id=$1',[id])).rows[0].output_tokens,10);
});

test('403 response identifiers remain public after a failed bill query without releasing fees or replaying the model',async()=>{
 mode='denied';await assert.rejects(cost.completeBudgeted(model,[{role:'user',content:'Synthetic response evidence'}],100,{purpose:'连接测试'}),(error:any)=>error.code==='GATEWAY_REJECTED'&&error.upstreamStatus===403);
 assert.equal(requests,1);
 const response=(await call('/costs')).data,receipt=response.calls[0],id=receipt.id;
 const metadata={providerRequestId:'relay-forbidden-403',upstreamRequestId:'upstream-forbidden-403',responseRequestId:'response-forbidden-403',providerStatus:403};
 for(const [key,value] of Object.entries(metadata))assert.equal(receipt[key],value);
 assert.equal(receipt.status,'uncertain');assert.equal(response.reserved,1);assert.equal(response.spent,0);assert.equal(requests,1);
 const query=await call('/costs/'+id+'/query-provider','POST',{});assert.equal(query.data.status,'failed');assert.equal(query.data.requestId,undefined);assert.equal(requests,4);
 const beforeRead=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[id])).rows[0];
 for(let read=0;read<2;read++){
  const costs=(await call('/costs')).data;
  assert.equal(costs.calls[0].status,'uncertain');assert.equal(costs.reserved,1);assert.equal(costs.spent,0);
  for(const [key,value] of Object.entries(metadata))assert.equal(costs.calls[0][key],value);
 }
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[id])).rows[0],beforeRead);
 assert.equal(requests,4);assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
 await cost.settleCall(id,0,10,{},'Synthetic independently confirmed receipt');
 const recent=(await call('/costs')).data.recent.find((item:any)=>item.id===id);
 assert.equal(recent.status,'settled');for(const [key,value] of Object.entries(metadata))assert.equal(recent[key],value);
 assert.equal(requests,4);
});

test('cost response selects only safe response fields and preserves absent IDs without exposing reservation context',async()=>{
 const id=await cost.reserveCall({model,amount:1,purpose:'Synthetic metadata boundary'});
 await cost.recordProviderResponse(id,{providerRequestId:'sk-synthetic-rejected-key',upstreamRequestId:'contains whitespace',responseRequestId:'x'.repeat(129),providerStatus:999});
 await cost.markCallUncertain(id,'Synthetic missing identifiers');
 const secrets={apiKey:'SYNTHETIC-CONTEXT-KEY',billingRoute:{baseUrl:'https://synthetic-private-route.invalid/v1',secret:'SYNTHETIC-ROUTE-SECRET'},unrelated:{private:'SYNTHETIC-PRIVATE-CONTEXT'}};
 await pool.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[id,JSON.stringify(secrets)]);
 const beforeRead=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[id])).rows[0];
 const response=(await call('/costs')).data,receipt=response.calls[0],serialized=JSON.stringify(response);
 for(const key of ['providerRequestId','upstreamRequestId','responseRequestId','providerStatus'])assert.equal(Object.hasOwn(receipt,key),false);
 assert.equal(receipt.status,'uncertain');assert.equal(response.reserved,1);assert.equal(response.spent,0);
 for(const value of ['context','apiKey','billingRoute','SYNTHETIC-CONTEXT-KEY','synthetic-private-route','SYNTHETIC-ROUTE-SECRET','SYNTHETIC-PRIVATE-CONTEXT'])assert.equal(serialized.includes(value),false,value);
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[id])).rows[0],beforeRead);
 // Defend the response boundary even if an older or malformed record bypassed
 // today's recordProviderResponse validation.
 await pool.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[id,JSON.stringify({providerRequestId:{secret:'SYNTHETIC-NESTED-KEY'},upstreamRequestId:'sk-INVALID',responseRequestId:'bad\nidentifier',providerStatus:'403'})]);
 const malformed=(await call('/costs')).data.calls[0];
 for(const key of ['providerRequestId','upstreamRequestId','responseRequestId','providerStatus'])assert.equal(Object.hasOwn(malformed,key),false);
 assert.equal(JSON.stringify(malformed).includes('SYNTHETIC-NESTED-KEY'),false);assert.equal(requests,0);assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);
});

test('backup refuses live calls and restores unresolved reservations without inventing a zero charge',async()=>{
 const id=await cost.reserveCall({model,amount:1,purpose:'连接测试'}),password='cost-backup-fixture';
 assert.equal((await call('/backup/export','POST',{password})).status,409);
 await cost.markCallUncertain(id,'missing receipt');const exported=await call('/backup/export','POST',{password});assert.equal(exported.status,200);
 await cost.settleCall(id,0,0,{},'Fixture confirms no provider charge');
 const restored=await call('/backup/restore','POST',{password,backup:exported.data,confirmation:'RESTORE'});assert.equal(restored.status,200,JSON.stringify(restored.data));
 const status=(await call('/costs')).data;assert.equal(status.calls[0].id,id);assert.equal(status.calls[0].status,'uncertain');assert.equal(status.reserved,1);assert.equal(status.spent,0);
});

test('standalone expiry rolls back probe interruption when its reservation UPDATE fails',async()=>{
 const id=await cost.reserveCall({model,amount:.17,purpose:'Synthetic expiry rollback'});
 await pool.query("UPDATE model_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
 await pool.query("INSERT INTO model_capability_tests(id,model_id,model_version,probe_version,status,created_at) VALUES('expiry-rollback-probe','model',1,'fixture','running',now()-interval '7 minutes')");
 await pool.query(`CREATE FUNCTION reject_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'EXPIRY_UPDATE_REJECTED'; END $$;
  CREATE TRIGGER reject_expiry AFTER UPDATE ON model_reservations FOR EACH STATEMENT EXECUTE FUNCTION reject_expiry()`);
 try{
  await assert.rejects(cost.expireReservations(),/EXPIRY_UPDATE_REJECTED/);
  const probe=(await pool.query("SELECT status,code,finished_at FROM model_capability_tests WHERE id='expiry-rollback-probe'")).rows[0];
  assert.deepEqual(probe,{status:'running',code:null,finished_at:null});
  const reservation=(await pool.query('SELECT status,amount,history FROM model_reservations WHERE id=$1',[id])).rows[0];
  assert.equal(reservation.status,'pending');assert.equal(Number(reservation.amount),.17);assert.deepEqual(reservation.history,[]);
 }finally{
  await pool.query('DROP TRIGGER reject_expiry ON model_reservations;DROP FUNCTION reject_expiry()');
  await pool.query("DELETE FROM model_capability_tests WHERE id='expiry-rollback-probe'");
 }
});
