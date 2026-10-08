import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Model} from '../packages/contracts/index.ts';
import {toolEvidence} from './model-fixture.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';

// Product HTTP, transactions, ledger and checkpoint scheduling are exercised.
// Only a loopback model and an empty file executor are fixtures; this is not
// real-provider acceptance, Docker coverage or independent PostgreSQL locking.
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const schema='carryover_'+Date.now(),admin=new pg.Pool({connectionString:base});
const fixtureKey='cost-carryover-fixture-key';
const model:Model={id:'carryover-model',gatewayId:'carryover-gateway',name:'Loopback model',model:'fixture',inputRate:0,outputRate:100,version:1,status:'available',capabilities:toolEvidence};
const employee={id:'manager',name:'本地测试经理',title:'经理',role:'manager',instructions:'Execute the two bounded text fixture tasks',modelId:model.id,tools:[]};
const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:40,maxTaskModelCalls:12,deadlineSeconds:30};
const plan={rationale:'A completed text checkpoint precedes an unfinished text task',agents:[employee],tasks:[
 {id:'prepare',subject:'Prepare bounded fixture text',objective:'Return the fixed local fixture text',assigneeId:employee.id,dependencies:[],acceptanceCriteria:['bounded text prepared'],estimatedInputTokens:10,estimatedOutputTokens:10,maxBudget:.9,maxModelCalls:10},
 {id:'finish',subject:'Finish bounded fixture text',objective:'Complete only the remaining local fixture task',assigneeId:employee.id,dependencies:['prepare'],acceptanceCriteria:['bounded text finished'],estimatedInputTokens:10,estimatedOutputTokens:10,maxBudget:.9,maxModelCalls:10},
]};
let pool:pg.Pool,app:any,server:http.Server,gateway:http.Server,url:string,dir:string,traceRoot:string;
let cost:typeof import('../apps/api/src/cost-control.ts'),coordinator:any;
let requests=0;
const modelRequests:any[]=[],steps=new Map<string,number>();
const settings=(dailyBudgetLimit=10)=>({autoBudgetLimit:.25,dailyBudgetLimit,maxActiveRuns:2,retentionDays:0});
const close=(instance?:http.Server)=>instance?new Promise<void>(resolve=>{instance.closeAllConnections();instance.close(()=>resolve());}):Promise.resolve();
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const hasCode=(code:string)=>(error:any)=>error.code===code;
async function call(path:string,method='GET',body?:unknown){
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
async function makeProject(input:{maxBudget?:number;maxModelCalls?:number}={}){
 const id=randomUUID();
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[id,'carryover-department','本地费用测试','Complete the bounded text fixture tasks',{...policy,...input},plan,'manual']);
 return id;
}
async function settleAmount(id:string,amount:number,note?:string){
 return cost.settleCall(id,0,Math.round(amount*1e6/model.outputRate),{},note);
}
async function hold(projectId:string,amount:number,options:{runId?:string;taskId?:string;pending?:boolean}={}){
 const id=await cost.reserveCall({model,amount,purpose:'Local carryover fixture',projectId,...(options.runId?{runId:options.runId}:{}),context:{...(options.taskId?{taskId:options.taskId}:{}),fixture:'synthetic'}});
 if(!options.pending)await cost.markCallUncertain(id,'Synthetic model response unavailable');
 return id;
}
async function known(projectId:string,amount:number){
 const id=await cost.reserveCall({model,amount,purpose:'Local known planning receipt',projectId});await settleAmount(id,amount);return id;
}
async function approved(projectId:string,retainUncertainCosts=false){
 const response=await call('/projects/'+projectId+'/approve','POST',{version:1,retainUncertainCosts});
 assert.equal(response.status,202,JSON.stringify(response.data));
 return (await pool.query('SELECT * FROM project_runs WHERE id=$1',[response.data.id])).rows[0];
}
async function reserveIn(run:any,amount:number){
 return cost.reserveCall({model,amount,purpose:'Local resumed execution',projectId:run.project_id,runId:run.id,context:{taskId:'finish'}});
}
async function parentRun(projectId:string,options:{pending?:boolean;completed?:boolean}={}){
 const row=await approved(projectId);
 await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[row.id]);
 const archive=createRunArchive(traceRoot,row.snapshot,{id:row.id});
 const firstAttempt=randomUUID(),secondAttempt=randomUUID();
 archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'prepare'},{task_id:'t2',seed_id:'finish'}]});
 if(options.completed){
  const billed=await hold(projectId,.02,{runId:row.id,taskId:'prepare',pending:true});await settleAmount(billed,.02);
  archive.append('model/wire-request',{id:billed,taskId:'prepare',requestId:'fixture-known',attemptId:firstAttempt});
 }
 const receipt=await hold(projectId,.2,{runId:row.id,taskId:'finish',pending:options.pending});
 archive.append('model/wire-request',{id:receipt,taskId:'finish',requestId:'fixture-unknown',attemptId:secondAttempt});
 archive.append('billing/unconfirmed',{id:receipt,taskId:'finish',code:'SYNTHETIC_LOST_RESPONSE'});
 archive.append('team/checkpoint',{tasks:[{task_id:'t1',status:options.completed?'completed':'pending',attempt_id:firstAttempt,output:'bounded fixture text prepared'},{task_id:'t2',status:'failed',attempt_id:secondAttempt}]});
 archive.append('run/finished',{status:'failed',message:'Local fixture interruption; no real provider was called'});
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[row.id]);
 return {...row,receipt,archive};
}

before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);
 const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'cost-carryover-'));traceRoot=join(dir,'runs');
 process.env.DATA_DIR=dir;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();cost=await import('../apps/api/src/cost-control.ts');
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdown();
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+((server.address() as any).port)+'/api';
 gateway=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests++;modelRequests.push(body);
  assert.equal(req.headers.authorization,'Bearer '+fixtureKey);
  const messages=body.messages??[];
  const pinned=messages.filter((message:any)=>message.role==='system').flatMap((message:any)=>String(message.content).split('\n')).map((line:string)=>{try{return JSON.parse(line);}catch{return undefined;}}).find((value:any)=>value?.runtimeTaskId);
  const assignment=messages.filter((message:any)=>message.role==='user'&&typeof message.content==='string').reverse().find((message:any)=>message.content.includes('AgentTeams automatic task assignment'))?.content??(pinned?`Task: ${pinned.runtimeTaskId} Attempt id: ${pinned.attemptId}`:'');
  const nativeTask=/Task: (t\d+)/.exec(assignment)?.[1],attempt=/Attempt id: ([a-f0-9-]+)/.exec(assignment)?.[1];
  let message:any={content:'Local bounded text fixture complete'};
  if(nativeTask&&attempt){
   const key=nativeTask+':'+attempt,index=steps.get(key)??0;steps.set(key,index+1);
   const actions:any[]=[['agent_teams_claim_task',{task_id:nativeTask}],['agent_teams_update_task',{task_id:nativeTask,attempt_id:attempt,status:'in_progress'}],['agent_teams_update_task',{task_id:nativeTask,attempt_id:attempt,status:'completed',output:'Local bounded text fixture complete'}]];
   if(index<actions.length)message={content:null,tool_calls:[{id:key+':'+index,type:'function',function:{name:actions[index][0],arguments:JSON.stringify(actions[index][1])}}]};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
 });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const {seal}=await import('../apps/api/src/vault.ts');
 await pool.query('INSERT INTO gateways(id,data,credential) VALUES($1,$2,$3)',[model.gatewayId,{name:'Loopback only',baseUrl:'http://127.0.0.1:'+((gateway.address() as any).port)+'/v1'},seal(fixtureKey)]);
 await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[model.id,model,toolEvidence]);
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['carryover-department',{name:'本地费用测试',agents:[employee]}]);
});
beforeEach(async()=>{
 await coordinator?.close();coordinator=undefined;
 await pool.query('TRUNCATE model_reservations,usage,project_runs,projects,request_keys CASCADE');
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings()]);
 await pool.query("UPDATE departments SET data=data-'dailyBudget'");
 requests=0;modelRequests.length=0;steps.clear();
});
after(async()=>{
 await coordinator?.close();await app?.locals.shutdown();await close(server);await close(gateway);
 await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 if(dir)await rm(dir,{recursive:true,force:true});
});

test('approval blocks uncertain fees by default and an in-flight call still blocks explicit carryover',async()=>{
 const projectId=await makeProject(),receipt=await hold(projectId,.3,{pending:true});
 const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[receipt])).rows[0];
 for(const body of [{version:1},{version:1,retainUncertainCosts:false},{version:1,retainUncertainCosts:true}]){
  const response=await call('/projects/'+projectId+'/approve','POST',body);assert.equal(response.status,409);assert.equal(response.data.code,'COST_PENDING');
 }
 const pending=(await call('/projects/'+projectId+'/cost-readiness')).data;
 assert.equal(pending.pendingCount,1);assert.equal(pending.uncertainCount,0);near(pending.reserved,.3);near(pending.availableBudget,.7);
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[receipt])).rows[0],original);
 await cost.markCallUncertain(receipt,'Synthetic completed transport without usage');
 for(const body of [{version:1},{version:1,retainUncertainCosts:false}]){
  const response=await call('/projects/'+projectId+'/approve','POST',body);assert.equal(response.status,409);assert.equal(response.data.code,'COST_PENDING');
 }
 const invalid=await call('/projects/'+projectId+'/approve','POST',{version:1,retainUncertainCosts:'true'});assert.equal(invalid.status,422);assert.equal(invalid.data.code,'VALIDATION_ERROR');
 assert.equal((await pool.query('SELECT id FROM project_runs')).rowCount,0);assert.equal((await pool.query('SELECT id FROM usage')).rowCount,0);assert.equal(requests,0);
});

test('opt-in approval freezes net budget while old unknown plus live reservation cover exact global and departmental daily caps once',async()=>{
 const projectId=await makeProject();await known(projectId,.2);const receipt=await hold(projectId,.3);
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(1)]);
 await pool.query("UPDATE departments SET data=data||'{\"dailyBudget\":1}'::jsonb");
 const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[receipt])).rows[0];
 const run=await approved(projectId,true);near(run.snapshot.executionBudget,.5);
 assert.equal(run.snapshot.costCarryover.retained,true);near(run.snapshot.costCarryover.reserved,.3);near(run.snapshot.costCarryover.recordedCost,.2);near(run.snapshot.costCarryover.availableBudget,.5);
 assert.deepEqual(run.snapshot.costCarryover.receipts,[{id:receipt,amount:.3}]);assert.equal(run.snapshot.approval.retainUncertainCosts,true);near(run.snapshot.departmentBudgets['carryover-department'],.5);
 for(const department of [null,'carryover-department']){const total=await cost.dailyTotals(pool,department);near(total.spent,.2);near(total.reserved,.8);near(total.spent+total.reserved,1);}
 await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[run.id]);
 const current=await reserveIn(run,.1);
 for(const department of [null,'carryover-department']){const total=await cost.dailyTotals(pool,department);near(total.spent,.2);near(total.reserved,.8);}
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[receipt])).rows[0],original);
 assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[current])).rows[0].status,'pending');assert.equal(requests,0);
});

test('global live-run coverage still charges uncovered holds to the actual participating department',async()=>{
 const secondaryId='carryover-secondary',secondaryEmployee={...employee,id:'secondary-worker',role:'member'};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',[secondaryId,{name:'第二测试部门',agents:[secondaryEmployee],dailyBudget:.8}]);
 const colleague={...secondaryEmployee,id:secondaryId+'::'+secondaryEmployee.id,sourceDepartmentId:secondaryId,sourceAgentId:secondaryEmployee.id};
 const crossPlan={...plan,agents:[employee,colleague],tasks:[{...plan.tasks[0],estimatedOutputTokens:1},{...plan.tasks[1],estimatedOutputTokens:4,assigneeId:colleague.id}]};
 const projectId=await makeProject();await pool.query('UPDATE projects SET policy=$2,plan=$3 WHERE id=$1',[projectId,{...policy,maxAgents:2},crossPlan]);
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(1)]);
 await pool.query("UPDATE departments SET data=data||'{\"dailyBudget\":0.25}'::jsonb WHERE id='carryover-department'");
 const run=await approved(projectId);near(run.snapshot.executionBudget,1);near(run.snapshot.departmentBudgets['carryover-department'],.2);near(run.snapshot.departmentBudgets[secondaryId],.8);
 await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[run.id]);
 const reservePrimary=(amount:number)=>cost.reserveCall({model,amount,purpose:'Local cross-department admission',projectId,runId:run.id,billingDepartmentId:'carryover-department',context:{taskId:'prepare'}});
 await assert.rejects(reservePrimary(.3),hasCode('DEPARTMENT_DAILY_BUDGET_EXCEEDED'));
 assert.equal((await pool.query('SELECT id FROM model_reservations WHERE run_id=$1',[run.id])).rowCount,0);
 await pool.query("UPDATE departments SET data=data||'{\"dailyBudget\":0.4}'::jsonb WHERE id='carryover-department'");
 const receipt=await reservePrimary(.3);near((await cost.dailyTotals(pool,'carryover-department')).reserved,.3);near((await cost.dailyTotals(pool,secondaryId)).reserved,.8);near((await cost.dailyTotals(pool)).reserved,1);
 await assert.rejects(reservePrimary(.11),hasCode('DEPARTMENT_DAILY_BUDGET_EXCEEDED'));
 assert.equal((await pool.query('SELECT id FROM model_reservations WHERE run_id=$1',[run.id])).rowCount,1);assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[receipt])).rows[0].status,'pending');assert.equal(requests,0);
});

test('insufficient original or daily budget rejects opt-in approval without changing unknown receipts',async()=>{
 for(const overrun of [false,true]){
  const projectId=await makeProject({maxBudget:.3});
  const prior=overrun?await known(projectId,.05):undefined,receipt=await hold(projectId,overrun ? .25 : .3);
  // A valid initial reservation can become over-budget after an authoritative
  // old bill increases. Do not bypass reserveCall to fabricate admission.
  if(prior)await settleAmount(prior,.1);
  const readiness=(await call('/projects/'+projectId+'/cost-readiness')).data;
  near(readiness.availableBudget,overrun?-.05:0);
  const before=(await pool.query('SELECT status,amount,history FROM model_reservations WHERE id=$1',[receipt])).rows[0];
  const result=await call('/projects/'+projectId+'/approve','POST',{version:1,retainUncertainCosts:true});assert.equal(result.status,422);
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[projectId])).rowCount,0);
  assert.deepEqual((await pool.query('SELECT status,amount,history FROM model_reservations WHERE id=$1',[receipt])).rows[0],before);
 }
 await pool.query('TRUNCATE model_reservations,usage,projects CASCADE');
 const projectId=await makeProject();await known(projectId,.2);await hold(projectId,.3);
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(.999)]);
 const global=await call('/projects/'+projectId+'/approve','POST',{version:1,retainUncertainCosts:true});assert.equal(global.status,422);assert.equal(global.data.code,'DAILY_BUDGET_EXCEEDED');
 await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings(1)]);
 await pool.query("UPDATE departments SET data=data||'{\"dailyBudget\":0.999}'::jsonb");
 const local=await call('/projects/'+projectId+'/approve','POST',{version:1,retainUncertainCosts:true});assert.equal(local.status,422);assert.equal(local.data.code,'DEPARTMENT_DAILY_BUDGET_EXCEEDED');
 assert.equal((await pool.query('SELECT id FROM project_runs')).rowCount,0);assert.equal(requests,0);
});

test('retry retains the default gate and pending calls cannot be carried over even with explicit opt-in',async()=>{
 const projectId=await makeProject(),parent=await parentRun(projectId,{pending:true});
 for(const body of [{resume:true},{resume:false,retainUncertainCosts:true},{resume:true,retainUncertainCosts:true}]){
  const response=await call('/runs/'+parent.id+'/retry','POST',body);assert.equal(response.status,409);assert.equal(response.data.code,'COST_PENDING');
 }
 const recovery=(await call('/runs/'+parent.id)).data.recovery;assert.equal(recovery.costReadiness.pendingCount,1);assert.match(recovery.costBlocked,/核对供应方账单/);
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[parent.id])).rowCount,0);
 await cost.markCallUncertain(parent.receipt,'Synthetic in-flight request ended without receipt');
 const defaultBlocked=await call('/runs/'+parent.id+'/retry','POST',{resume:true});assert.equal(defaultBlocked.status,409);assert.equal(defaultBlocked.data.code,'COST_PENDING');
 assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0].status,'uncertain');assert.equal(requests,0);
});

test('opt-in checkpoint resume inherits unknown wire calls and dispatches only the unfinished task through the local model', {timeout:40000},async()=>{
 const projectId=await makeProject(),parent=await parentRun(projectId,{completed:true});
 const priorArchive=readRun(traceRoot,parent.id);assert.ok(priorArchive);assert.equal(priorArchive.integrity,'ok');
 const originalReceipt=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
 const blocked=await call('/runs/'+parent.id+'/retry','POST',{resume:true});assert.equal(blocked.data.code,'COST_PENDING');
 const response=await call('/runs/'+parent.id+'/retry','POST',{resume:true,retainUncertainCosts:true});assert.equal(response.status,202,JSON.stringify(response.data));assert.deepEqual(response.data.completedCheckpoints,['prepare']);
 const child=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[response.data.id])).rows[0];
 near(child.snapshot.executionBudget,.78);near(child.snapshot.costCarryover.reserved,.2);assert.deepEqual(child.snapshot.costCarryover.receipts,[{id:parent.receipt,amount:.2,runId:parent.id}]);
 assert.equal(child.snapshot.budgetHistory.calls,2);assert.deepEqual(child.snapshot.budgetHistory.tasks,{prepare:{cost:.02,calls:1},finish:{cost:0,calls:1,reserved:.2}});
 assert.deepEqual(child.snapshot.tasks.map((task:any)=>({id:task.id,dependencies:task.dependencies})),[{id:'prepare',dependencies:[]},{id:'finish',dependencies:['prepare']}]);
 assert.deepEqual(child.snapshot.completedCheckpoints,['prepare']);assert.equal(child.snapshot.recovery.completed[0].taskId,'prepare');
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');
 coordinator=new RunCoordinator(traceRoot,(archive:any)=>({root:join(archive.dir,'artifacts'),prepare:async()=>mkdir(join(archive.dir,'artifacts'),{recursive:true}),close:async()=>{},execute:async()=>{throw Error('FIXTURE_HAS_NO_FILE_OR_COMMAND_GRANT');}}) as any);
 let result:any;const deadline=Date.now()+30000;
 while(Date.now()<deadline){result=(await pool.query('SELECT status,error,snapshot FROM project_runs WHERE id=$1',[child.id])).rows[0];if(!['queued','running'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,50));}
 await coordinator.close();coordinator=undefined;
 assert.equal(result.status,'completed',JSON.stringify({status:result.status,error:result.error}));assert.ok(requests>0,'the local fixture model was actually queried');
 const restored=readRun(traceRoot,child.id);assert.ok(restored);const wire=restored.events.filter((event:any)=>event.type==='model/wire-request');
 assert.ok(wire.some((event:any)=>event.data.taskId==='finish'));assert.ok(wire.every((event:any)=>event.data.taskId!=='prepare'),'completed checkpoint never dispatches a new request');
 assert.equal((await pool.query("SELECT id FROM usage WHERE run_id=$1 AND task_id='prepare'",[child.id])).rowCount,0);
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],originalReceipt);
 const unchangedParent=readRun(traceRoot,parent.id);assert.ok(unchangedParent);assert.equal(unchangedParent.eventCount,priorArchive.eventCount);near(result.snapshot.executionBudget,.78);
 const rowsBefore=(await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[projectId])).rowCount,requestsBefore=requests;
 const repeated=await call('/runs/'+parent.id+'/retry','POST',{resume:true,retainUncertainCosts:true});assert.deepEqual(repeated.data,{id:child.id,existing:true});assert.equal(requests,requestsBefore);assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[projectId])).rowCount,rowsBefore);
});

test('an unknown task hold exhausts its original cap before retry even when the project still has funds',async()=>{
 const projectId=await makeProject();
 const capped=structuredClone(plan);capped.tasks[1].maxBudget=.2;
 await pool.query('UPDATE projects SET plan=$1 WHERE id=$2',[capped,projectId]);
 const parent=await parentRun(projectId,{completed:true});
 const receiptBefore=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
 const readiness=await cost.projectCostReadiness(pool,projectId);near(readiness.availableBudget,.78);
 const response=await call('/runs/'+parent.id+'/retry','POST',{resume:true,retainUncertainCosts:true});
 assert.equal(response.status,422);assert.equal(response.data.code,'TASK_BUDGET_EXHAUSTED');
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[parent.id])).rowCount,0);
 assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],receiptBefore);
 assert.equal(requests,0,'a capped unknown task cannot cause a new model request after restart');
});

test('an unknown wire attempt still exhausts the original retry call cap rather than resetting on carryover',async()=>{
 const projectId=await makeProject({maxModelCalls:2}),parent=await parentRun(projectId,{completed:true});
 const response=await call('/runs/'+parent.id+'/retry','POST',{resume:true,retainUncertainCosts:true});assert.equal(response.status,422);assert.equal(response.data.code,'TURN_LIMIT');
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[parent.id])).rowCount,0);assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0].status,'uncertain');assert.equal(requests,0);
});

test('a late bill above its old hold fences every new reservation by total project cost, including parallel admission',async()=>{
 const projectId=await makeProject();await known(projectId,.2);const old=await hold(projectId,.3),run=await approved(projectId,true);
 await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[run.id]);
 const already=await reserveIn(run,.1);
 await settleAmount(old,.6);near((await cost.projectCostReadiness(pool,projectId)).recordedCost,.8);
 const ids=[randomUUID(),randomUUID()];
 const parallel=await Promise.allSettled(ids.map(id=>cost.reserveCall({id,model,amount:.06,purpose:'Local parallel reservation after late bill',projectId,runId:run.id,context:{taskId:'finish'}})));
 assert.equal(parallel.filter(result=>result.status==='fulfilled').length,1);assert.equal(parallel.filter(result=>result.status==='rejected'&&(result.reason as any).code==='BUDGET_EXCEEDED').length,1);
 await assert.rejects(reserveIn(run,.041),hasCode('BUDGET_EXCEEDED'));
 const held=(await pool.query("SELECT sum(amount)::float AS n FROM model_reservations WHERE project_id=$1 AND status IN ('pending','uncertain')",[projectId])).rows[0].n;near(held,.16);
 const readiness=await cost.projectCostReadiness(pool,projectId);near(readiness.recordedCost+readiness.reserved,.96);
 await settleAmount(already,.2);near((await cost.projectCostReadiness(pool,projectId)).availableBudget,-.06);
 await assert.rejects(reserveIn(run,.00001),hasCode('BUDGET_EXCEEDED'));
 assert.equal((await pool.query('SELECT id FROM model_reservations WHERE run_id=$1',[run.id])).rowCount,2);near((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[run.id])).rows[0].snapshot.executionBudget,.5);assert.equal(requests,0);
});

test('ordinary late settlement preserves history and never enlarges an already approved run allocation',async()=>{
 const projectId=await makeProject();await known(projectId,.2);const old=await hold(projectId,.3),run=await approved(projectId,true);
 await pool.query("UPDATE project_runs SET status='running' WHERE id=$1",[run.id]);
 await settleAmount(old,.1,'Synthetic independently confirmed manual receipt');await settleAmount(old,.15);await settleAmount(old,.15);
 const receipt=(await pool.query('SELECT status,history FROM model_reservations WHERE id=$1',[old])).rows[0];assert.equal(receipt.status,'settled');assert.deepEqual(receipt.history.map((entry:any)=>entry.source),['runtime','manual','provider']);
 near((await cost.projectCostReadiness(pool,projectId)).availableBudget,.65);
 const frozen=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[run.id])).rows[0].snapshot;near(frozen.executionBudget,.5);near(frozen.costCarryover.reserved,.3);assert.equal(frozen.costCarryover.retained,true);
 await assert.rejects(reserveIn(run,.50001),hasCode('BUDGET_EXCEEDED'));
 const newCall=await reserveIn(run,.5);assert.equal((await pool.query('SELECT status FROM model_reservations WHERE id=$1',[newCall])).rows[0].status,'pending');
 const total=await cost.dailyTotals(pool);near(total.spent,.35);near(total.reserved,.5);assert.equal((await pool.query('SELECT id FROM usage WHERE id=$1',[old])).rowCount,1);assert.equal(requests,0);
});

test('readiness and approved carryover expose only bounded receipt identities and amounts, never credentials or original context',async()=>{
 const projectId=await makeProject(),parent=await parentRun(projectId);
 const secrets={apiKey:'SYNTHETIC-CONTEXT-KEY',route:'SYNTHETIC-PRIVATE-ROUTE',nested:{secret:'SYNTHETIC-NESTED-CONTEXT'},billingAutoQueryPause:{code:'SYNTHETIC-PRIVATE-PAUSE'}};
 await pool.query('UPDATE model_reservations SET context=context||$2::jsonb WHERE id=$1',[parent.receipt,JSON.stringify(secrets)]);
 const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
 const projected=(await call('/projects/'+projectId+'/cost-readiness')).data,recovery=(await call('/runs/'+parent.id)).data.recovery;
 assert.deepEqual(recovery.costReadiness,projected);assert.deepEqual(Object.keys(projected).sort(),['availableBudget','pendingCount','receipts','recordedCost','reserved','uncertainCount']);assert.deepEqual(projected.receipts,[{id:parent.receipt,amount:.2,status:'uncertain',runId:parent.id}]);
 const response=await call('/runs/'+parent.id+'/retry','POST',{resume:true,retainUncertainCosts:true});assert.equal(response.status,202,JSON.stringify(response.data));
 const child=(await call('/runs/'+response.data.id)).data,carryover=child.snapshot.costCarryover;
 assert.deepEqual(Object.keys(carryover).sort(),['availableBudget','receipts','recordedCost','reserved','retained']);assert.deepEqual(Object.keys(carryover.receipts[0]).sort(),['amount','id','runId']);
 for(const value of [fixtureKey,'SYNTHETIC-CONTEXT-KEY','SYNTHETIC-PRIVATE-ROUTE','SYNTHETIC-NESTED-CONTEXT','SYNTHETIC-PRIVATE-PAUSE','billingRoute','billingAutoQueryPause','context','credential'])assert.equal(JSON.stringify({projected,recovery,carryover}).includes(value),false,value);
 assert.equal(JSON.stringify(child).includes(fixtureKey),false);assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],original);assert.equal(requests,0);
 const missing=await call('/projects/'+randomUUID()+'/cost-readiness');assert.equal(missing.status,404);
});

test('new-plan carryover approval cannot silently replay a prior native operation with an unknown outcome',async()=>{
 const projectId=await makeProject(),parent=await parentRun(projectId);
 parent.archive.append('runtime/operation-start',{name:'terminal',arguments:{command:'synthetic native command; not executed'}},{callId:'fixture-native-unknown'});
 parent.archive.append('runtime/outcome-unknown',{name:'terminal',callId:'fixture-native-unknown',message:'Synthetic operation receipt lost'},{callId:'fixture-native-unknown'});
 const edited=await call('/projects/'+projectId+'/plan','PUT',{version:1,plan:{...plan,rationale:'Version two retains the same bounded task scope'}});assert.equal(edited.status,200,JSON.stringify(edited.data));
 const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
 const response=await call('/projects/'+projectId+'/approve','POST',{version:2,retainUncertainCosts:true});assert.equal(response.status,409);assert.equal(response.data.code,'OPERATION_RECONCILIATION_REQUIRED');
 assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1 AND project_version=2',[projectId])).rowCount,0);
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],original);assert.equal(requests,0);
});

test('a model-only 403 with a confirmed native operation can retain its hold when a new plan is explicitly approved',async()=>{
 const projectId=await makeProject(),parent=await parentRun(projectId);
 parent.archive.append('billing/unconfirmed',{id:parent.receipt,taskId:'finish',code:'AUTH',upstreamStatus:403,providerRequestId:'local-fixture-403'});
 parent.archive.append('runtime/operation-start',{name:'local_workspace',arguments:{fixture:true}},{callId:'fixture-native-confirmed'});
 parent.archive.append('runtime/operation-finished',{name:'local_workspace'},{callId:'fixture-native-confirmed'});
 const edited=await call('/projects/'+projectId+'/plan','PUT',{version:1,plan:{...plan,rationale:'New version after a model-only transport failure'}});assert.equal(edited.status,200,JSON.stringify(edited.data));
 const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
 const response=await call('/projects/'+projectId+'/approve','POST',{version:2,retainUncertainCosts:true});assert.equal(response.status,202,JSON.stringify(response.data));
 const successor=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[response.data.id])).rows[0];near(successor.snapshot.executionBudget,.8);assert.equal(successor.project_version,2);assert.deepEqual(successor.snapshot.costCarryover.receipts,[{id:parent.receipt,amount:.2,runId:parent.id}]);
 assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],original);assert.equal(requests,0);
});

test('new-plan carryover refuses missing or incomplete original run evidence instead of treating it as a known operation outcome',async()=>{
 for(const incomplete of [false,true]){
  const projectId=await makeProject(),parent=await parentRun(projectId);
  const edited=await call('/projects/'+projectId+'/plan','PUT',{version:1,plan:{...plan,rationale:'New version requires original interrupted operation evidence'}});assert.equal(edited.status,200,JSON.stringify(edited.data));
  if(incomplete){
   const {appendFile}=await import('node:fs/promises');await appendFile(join(parent.archive.dir,'events.jsonl'),'{"synthetic":"partial event');
  }else await rm(parent.archive.dir,{recursive:true,force:true});
  const original=(await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0];
  const response=await call('/projects/'+projectId+'/approve','POST',{version:2,retainUncertainCosts:true});assert.equal(response.status,409);assert.equal(response.data.code,'BUDGET_HISTORY_MISSING');
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1 AND project_version=2',[projectId])).rowCount,0);assert.deepEqual((await pool.query('SELECT status,amount,context,history FROM model_reservations WHERE id=$1',[parent.receipt])).rows[0],original);
 }
 assert.equal(requests,0);
});
