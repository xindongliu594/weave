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
 const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 gateway=http.createServer(async(req:any,res:any)=>{for await(const _ of req){}requests++;if(mode==='drop'){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:mode==='bad-message'?[]:[{message:{content:'OK'}}],...(mode==='missing'?{}:{usage:{prompt_tokens:0,completion_tokens:mode==='overrun'?200:25}})}));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query('INSERT INTO gateways(id,data) VALUES($1,$2)',['gateway',{name:'Fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'}]);await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[model.id,model,toolEvidence]);
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'测试部门',description:'',agents:[agent]}]);
 await pool.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES('project','department',1,'测试部门','核对所有模型调用的预算上限',$1,$2,'manual')",[policy,plan]);
});
beforeEach(async()=>{await pool.query('TRUNCATE model_reservations,usage,project_runs,request_keys CASCADE');await pool.query('UPDATE product_settings SET data=$1 WHERE id=1',[settings()]);await pool.query("UPDATE departments SET data=data-'dailyBudget'");requests=0;mode='ok';});
after(async()=>{await app?.locals.shutdown();for(const s of [server,gateway])if(s)await new Promise<void>(r=>s.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

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
 const runId=randomUUID(),snapshot={projectId:'project',departmentId:'department',planVersion:1,policy,executionBudget:10,tasks:[{id:'task',subject:'任务',maxBudget:2}]};
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot) VALUES($1,'project',1,'running',$2)",[runId,snapshot]);
 const input={model,amount:1,purpose:'项目执行',projectId:'project',runId,context:{taskId:'task'}};
 const first=await cost.reserveCall(input);assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:10});
 await cost.settleCall(first,0,25);assert.deepEqual(await cost.dailyTotals(pool),{spent:.25,reserved:9.75});
 const second=await cost.reserveCall(input);await cost.markCallUncertain(second,'connection lost');
 await assert.rejects(cost.reserveCall(input),e=>(e as any).code==='TASK_BUDGET_EXCEEDED');
 await pool.query("UPDATE project_runs SET status='failed' WHERE id=$1",[runId]);
 assert.deepEqual(await cost.dailyTotals(pool),{spent:.25,reserved:1});
 assert.equal((await call('/runs/'+runId+'/retry','POST',{resume:true})).data.code,'COST_PENDING');
 await pool.query("UPDATE usage SET created_at=now()-interval '2 days'");assert.deepEqual(await cost.dailyTotals(pool),{spent:0,reserved:1});
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

test('backup refuses live calls and restores unresolved reservations without inventing a zero charge',async()=>{
 const id=await cost.reserveCall({model,amount:1,purpose:'连接测试'}),password='cost-backup-fixture';
 assert.equal((await call('/backup/export','POST',{password})).status,409);
 await cost.markCallUncertain(id,'missing receipt');const exported=await call('/backup/export','POST',{password});assert.equal(exported.status,200);
 await cost.settleCall(id,0,0,{},'Fixture confirms no provider charge');
 const restored=await call('/backup/restore','POST',{password,backup:exported.data,confirmation:'RESTORE'});assert.equal(restored.status,200,JSON.stringify(restored.data));
 const status=(await call('/costs')).data;assert.equal(status.calls[0].id,id);assert.equal(status.calls[0].status,'uncertain');assert.equal(status.reserved,1);assert.equal(status.spent,0);
});
