import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {toolEvidence} from './model-fixture.ts';
import {bindPolicy} from '../packages/contracts/index.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='execution_policy_'+Date.now();
let pool:pg.Pool,app:any,server:any,gateway:any,url:string,dir:string,requests=0,candidate:any,lastInput:any;
async function call(path:string,method='GET',body?:any){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
const agent={id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调任务',modelId:'model',tools:[] as string[],knowledgeSpaceIds:[] as string[]};
const policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:1,deadlineSeconds:300};
async function project(agents=[agent],requirement='验证所有执行权限限制和版本记录'){
 const department=(await call('/departments','POST',{name:'权限测试',description:'',agents})).data;
 const created=await call('/projects','POST',{departmentId:department.id,requirement,policy});assert.equal(created.status,201,JSON.stringify(created.data));
 // These isolated policy fixtures need a concrete plan at v1. Placeholder
 // readiness is exercised through the public API in plan-readiness.test.ts.
 const draft=(await call('/projects')).data.find((p:any)=>p.id===created.data.id);
 const plan={...draft.plan,tasks:draft.plan.tasks.map((task:any)=>({...task,subject:'整理执行权限验收清单',objective:'列出允许的模型、工具和知识范围，提交权限验收清单。',acceptanceCriteria:['清单包含允许的模型、工具和知识范围。']}))};
 await pool.query('UPDATE projects SET plan=$1 WHERE id=$2',[plan,created.data.id]);
 await pool.query('UPDATE plan_versions SET plan=$1 WHERE project_id=$2 AND version=1',[plan,created.data.id]);
 return (await call('/projects')).data.find((p:any)=>p.id===created.data.id);
}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'execution-policy-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 gateway=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;lastInput=JSON.parse(raw);requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(candidate)}}],usage:{prompt_tokens:20,completion_tokens:20}}));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'Local fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'}]);
 for(const id of ['model','outside'])await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[id,{name:id,gatewayId:'gateway',model:id,inputRate:1,outputRate:1},toolEvidence]);
});
after(async()=>{await app?.locals.shutdown();for(const s of [server,gateway])if(s)await new Promise<void>(r=>s.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'execution-policy-'));await rm(dir,{recursive:true,force:true});}});

test('approval freezes an execution phase while preserving earlier planning dialogue as quoted background',async()=>{
 const history='先讨论一个 Todo API，只生成草案，暂不保存，等待确认。\n\n增加独立测试，并按实际终端结果验收。';
 const p=await project([agent],history),before=requests;
 const task={...p.plan.tasks[0],subject:'执行已确认的验收报告',objective:'核对实际独立测试证据并交付验收报告。',acceptanceCriteria:['使用批准的资料和真实测试记录。']};
 const plan={...p.plan,tasks:[task]};
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan})).status,200);
 const approved=await call('/projects/'+p.id+'/approve','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].snapshot;
 assert.equal(snapshot.requirement,history,'the full original dialogue remains auditable');
 assert.ok(snapshot.tasks[0].taskPrompt.startsWith('当前处于用户已批准后的正式执行阶段。'));
 assert.match(snapshot.tasks[0].taskPrompt,/当前任务目标：核对实际独立测试证据/);
 assert.ok(snapshot.tasks[0].taskPrompt.indexOf(task.objective)<snapshot.tasks[0].taskPrompt.indexOf(JSON.stringify({requirement:history})));
 assert.equal(JSON.parse(snapshot.tasks[0].taskPrompt.split('：\n').at(-1)).requirement,history);
 assert.match(snapshot.executionDescription,/已批准方案 v2/);assert.ok(snapshot.executionDescription.includes(task.objective));
 assert.ok(!snapshot.executionDescription.includes(history),'team descriptions cannot reactivate the raw historical planning request');
 assert.ok(snapshot.agents.every((a:any)=>a.rolePrompt.startsWith('当前处于用户已批准后的正式执行阶段。')));
 assert.deepEqual(snapshot.agents[0].tools,[]);assert.equal(snapshot.policy.maxBudget,policy.maxBudget);
 assert.equal(snapshot.tasks[0].maxOutputTokens,undefined,'old plans are not assigned a new per-call limit');
 assert.equal(snapshot.modelRoutes[0].maxOutputTokens,task.estimatedOutputTokens,'legacy route limits remain pinned');
 assert.equal(requests,before,'approval and context construction do not add a model call');
 assert.equal((await call('/runs/'+approved.data.id+'/cancel','POST',{})).status,202);
});

test('manual scope expansion requires explicit policy; generated plans and planner selection cannot expand it',async()=>{
 const p=await project();assert.deepEqual(p.policy.allowedModelIds,['model']);assert.deepEqual(p.policy.allowedTools,[]);assert.deepEqual(p.policy.allowedKnowledgeSpaceIds,[]);
 for(const patch of [{modelId:'outside'},{fallbackModelId:'outside'},{tools:['terminal']},{knowledgeSpaceIds:['foreign']}]){
  const denied=await call('/projects/'+p.id+'/plan','PUT',{version:1,plan:{...p.plan,agents:[{...p.plan.agents[0],...patch}]}});assert.equal(denied.data.code,'POLICY_PERMISSION_DENIED');
 }
 assert.equal((await call('/projects/'+p.id+'/versions')).data.length,1);
 const before=requests;const denied=await call('/projects/'+p.id+'/generate','POST',{version:1,modelId:'outside',maxPlanningCost:.1});assert.equal(denied.data.code,'POLICY_MODEL_DENIED');assert.equal(requests,before);
 candidate={...p.plan,agents:[{...p.plan.agents[0],modelId:'outside'}]};
 const generated=await call('/projects/'+p.id+'/generate','POST',{version:1,modelId:'model',maxPlanningCost:.1});assert.equal(generated.data.code,'POLICY_PERMISSION_DENIED');assert.equal(requests,before+1);
 assert.deepEqual(JSON.parse(lastInput.messages[1].content).models.map((m:any)=>m.id),['model']);assert.equal((await call('/projects/'+p.id+'/versions')).data.length,1);
 const expanded={...p.policy,allowedModelIds:['model','outside'],allowedTools:['knowledge_search'],allowedKnowledgeSpaceIds:[]};
 const plan={...p.plan,agents:[{...p.plan.agents[0],fallbackModelId:'outside',tools:['knowledge_search']}]};
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan,policy:expanded})).status,200);
 const versions=(await call('/projects/'+p.id+'/versions')).data;assert.deepEqual(versions[0].policy,expanded);assert.deepEqual(versions[1].policy,p.policy);
 const empty=await call('/projects/'+p.id+'/plan','PUT',{version:2,plan,policy:{...expanded,allowedModelIds:[]}});assert.equal(empty.data.code,'POLICY_PERMISSION_DENIED');
 const selected=await call('/projects/'+p.id+'/approve','POST',{version:2});assert.equal(selected.status,202,JSON.stringify(selected.data));
 const approvedSnapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[selected.data.id])).rows[0].snapshot;
 assert.deepEqual(approvedSnapshot.policy,expanded);
 // The coordinator is disabled in this fixture. Supply its immutable archive
 // so retry reaches the version gate instead of correctly failing on a missing goal.
 createRunArchive(join(dir,'runs'),approvedSnapshot,{id:selected.data.id});
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:2,plan,policy:expanded})).data.code,'PROJECT_ACTIVE');await call('/runs/'+selected.data.id+'/cancel','POST',{});
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:2,plan,policy:expanded})).status,200);
 assert.equal((await call('/runs/'+selected.data.id+'/retry','POST',{resume:false})).data.code,'RUN_REAPPROVAL_REQUIRED');
});

test('planner receives the project net budget and generated validation deducts the newly billed planning call',async()=>{
 const p=await project(),before=requests;
 await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,0,0,$4,$5)',[randomUUID(),'model',p.id,.9,'prior-execution-fixture']);
 candidate={...p.plan,tasks:p.plan.tasks.map((task:any)=>({...task,estimatedInputTokens:1500000,estimatedOutputTokens:200}))};
 const generated=await call('/projects/'+p.id+'/generate','POST',{version:1,modelId:'model',maxPlanningCost:.1});
 assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(requests,before+1,'budget feedback requires no extra provider call');
 const budgets=lastInput.messages[0].content.split('\n').flatMap((line:string)=>{
  try{const value=JSON.parse(line);return value?.kind==='planning_budget'?[value]:[];}catch{return [];}
 });
 assert.equal(budgets.length,1,'there is exactly one structured planning budget, independent of later instructions');
 const budget=budgets[0];
 assert.equal(budget.kind,'planning_budget');assert.equal(budget.totalLimit,1);assert.equal(budget.recordedCost,.9);
 assert.equal(budget.retainedReservations,0);assert.ok(Math.abs(budget.availableForPlanningAndExecution-.1)<1e-8);
 const actual=Number((await pool.query('SELECT sum(cost) AS cost FROM usage WHERE project_id=$1',[p.id])).rows[0].cost);
 assert.ok(actual>.9,'the actual planning receipt is retained');
 assert.equal(generated.data.validation.valid,false,'a candidate fitting the original total but exceeding the net cannot appear affordable');
 assert.ok(generated.data.validation.errors.some((message:string)=>message.includes('剩余预算')));
 const unchanged=(await call('/projects')).data.find((item:any)=>item.id===p.id);
 assert.equal(unchanged.version,1);assert.deepEqual(unchanged.plan,p.plan,'a generated candidate cannot replace the saved plan before confirmation');
 assert.equal((await call('/projects/'+p.id+'/generated-plan/confirm','POST',{version:1,previewId:generated.data.previewId})).status,200);
 const current=(await call('/projects')).data.find((item:any)=>item.id===p.id);
 assert.equal(current.policy.maxBudget,1,'the AI candidate cannot raise the user cap');assert.equal(current.validation.valid,false);
});

test('project list validation includes open cost holds without modifying the ledger or starting execution',async()=>{
 const before=requests;
 for(const status of ['pending','uncertain']){
  const p=await project();
  const plan={...p.plan,tasks:p.plan.tasks.map((task:any)=>({...task,estimatedInputTokens:500000,estimatedOutputTokens:1000}))};
  assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan})).status,200);
  await pool.query('INSERT INTO usage(id,model_id,project_id,input_tokens,output_tokens,cost,purpose) VALUES($1,$2,$3,0,0,.2,$4)',[randomUUID(),'model',p.id,'recorded-cost-fixture']);
  const receiptId=randomUUID();
  await pool.query(`INSERT INTO model_reservations(id,model_id,project_id,purpose,amount,input_rate,output_rate,status,history,expires_at)
   VALUES($1,'model',$2,'open-cost-fixture',.4,1,1,$3,$4,now()-interval '1 hour')`,[receiptId,p.id,status,JSON.stringify([{source:'local-fixture',note:'No provider request was dispatched'}])]);
  const ledgerBefore=(await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receiptId])).rows[0];
  const readiness=(await call('/projects/'+p.id+'/cost-readiness')).data;
  const listed=(await call('/projects')).data.find((item:any)=>item.id===p.id);
  assert.equal(listed.planningCost,.2,'the existing field remains the full recorded cost');
  assert.ok(Math.abs(readiness.availableBudget-.4)<1e-8);assert.equal(readiness.reserved,.4);
  assert.equal(listed.validation.estimate,.6012);assert.equal(listed.validation.valid,false);
  assert.ok(listed.validation.errors.some((message:string)=>message.includes('剩余预算')));
  assert.equal(listed.policy.maxBudget,1);
  assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receiptId])).rows[0],ledgerBefore,'read-only validation cannot expire or settle a receipt');
  const approved=await call('/projects/'+p.id+'/approve','POST',{version:2,retainUncertainCosts:true});
  assert.equal(approved.data.code,status==='pending'?'COST_PENDING':'PLAN_NOT_READY');
  assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[p.id])).rowCount,0);
  assert.deepEqual((await pool.query('SELECT * FROM model_reservations WHERE id=$1',[receiptId])).rows[0],ledgerBefore);
  // This isolated fixture created no external request. Close only its test
  // receipt so subsequent backup tests do not inherit a live fixture hold.
  await pool.query("UPDATE model_reservations SET status='released' WHERE id=$1",[receiptId]);
 }
 assert.equal(requests,before,'budget validation and rejected approval add no model call');
});

test('approval freezes per-call output limits separately from the cumulative task estimates',async()=>{
 const p=await project(),before=requests;
 const plan={...p.plan,tasks:[
  {...p.plan.tasks[0],id:'first',estimatedOutputTokens:9000,maxOutputTokens:128},
  {...p.plan.tasks[0],id:'second',dependencies:['first'],estimatedOutputTokens:16000,maxOutputTokens:1024}
 ]};
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan})).status,200);
 const approved=await call('/projects/'+p.id+'/approve','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].snapshot;
 assert.deepEqual(snapshot.tasks.map((task:any)=>[task.estimatedOutputTokens,task.maxOutputTokens]),[[9000,128],[16000,1024]]);
 assert.equal(snapshot.modelRoutes[0].maxOutputTokens,1024,'a route cannot inherit an entire multi-round estimate when explicit limits exist');
 assert.deepEqual((await call('/projects/'+p.id+'/versions')).data[0].plan.tasks,plan.tasks);assert.equal(snapshot.policy.maxBudget,1);
 assert.equal(requests,before,'freezing output limits is local and does not probe a real model');
 assert.equal((await call('/runs/'+approved.data.id+'/cancel','POST',{})).status,202);
});

test('archived departments and revoked private knowledge grants block approval or retry without changing old snapshots',async()=>{
 const space=(await call('/knowledge/spaces','POST',{name:'可撤回知识',scope:'company'})).data;
 const p=await project([{...agent,tools:['knowledge_search'],knowledgeSpaceIds:[space.id]}]);
 const run=await call('/projects/'+p.id+'/approve','POST',{version:1});assert.equal(run.status,202,JSON.stringify(run.data));await call('/runs/'+run.data.id+'/cancel','POST',{});
 const original=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[run.data.id])).rows[0].snapshot;
 const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
 // The coordinator is stopped in this fixture, so record its zero-call archive
 // before exercising resume. Missing archive admission has separate coverage.
 createRunArchive(join(dir,'runs'),original,{id:run.data.id}).append('run/finished',{status:'cancelled'});
 await call('/knowledge/spaces/'+space.id,'DELETE',{version:1});
 assert.equal((await call('/runs/'+run.data.id+'/retry','POST',{resume:true})).data.code,'KNOWLEDGE_GRANT_INVALID');
 assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[run.data.id])).rows[0].snapshot,original);
 const fresh=await project();await call('/departments/'+fresh.departmentId,'DELETE',{version:1});
 assert.equal((await call('/projects/'+fresh.id+'/approve','POST',{version:1})).data.code,'DEPARTMENT_ARCHIVED');
 const privateDept=await project();
 const privateSpace=(await call('/knowledge/spaces','POST',{name:'员工私有',scope:'employee',departmentId:privateDept.departmentId,agentIds:['manager']})).data;
 const forged={...p.plan,agents:[{...p.plan.agents[0],knowledgeSpaceIds:[privateSpace.id]}]};
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan:forged,policy:{...p.policy,allowedKnowledgeSpaceIds:[privateSpace.id]}})).status,200);
 assert.equal((await call('/projects/'+p.id+'/approve','POST',{version:2})).data.code,'KNOWLEDGE_GRANT_INVALID','project allowlist never grants access to another department');
});

test('request admission fences stale lease owners and rechecks current run authorization transactionally',{skip:process.env.SIMULATED_INTEGRATION==='pglite'?'requires independent PostgreSQL backends and row locks':false},async()=>{
 const p=await project(),approved=await call('/projects/'+p.id+'/approve','POST',{version:1});assert.equal(approved.status,202);
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'),createArchiveWriterManager({traceRoot:join(dir,'runs')}));await worker.close();
 await pool.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[worker.owner,approved.data.id]);
 const before=requests,gate=await pool.connect();const gatePid=(await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await gate.query('BEGIN');await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[p.id]);
 let pending:Promise<any>|undefined;
 try{
  // The outer worker check can pass, then it waits on the project lock inside reserveCall.
  pending=worker.reserve(approved.data.id,{id:randomUUID(),modelId:'model',reservation:.001}).then(()=>({ok:true}),error=>({error}));
  let waiting=false;for(let i=0;i<200;i++){
   const r=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND a.query='SELECT * FROM projects WHERE id=$1 FOR UPDATE' AND $1=ANY(pg_blocking_pids(a.pid))",[gatePid]);
   if(r.rows[0].n){waiting=true;break;}await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(waiting,'the request must have passed the outer check and reached locked admission');
  await gate.query("UPDATE project_runs SET lease_owner='replacement' WHERE id=$1",[approved.data.id]);await gate.query('COMMIT');
  const result=await pending;assert.equal(result.error?.code,'LEASE_LOST');assert.equal((await pool.query('SELECT id FROM model_reservations WHERE run_id=$1',[approved.data.id])).rowCount,0);
 }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;}
 await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2',[worker.owner,approved.data.id]);
 await call('/departments/'+p.departmentId,'DELETE',{version:1});
 await assert.rejects(worker.reserve(approved.data.id,{id:randomUUID(),modelId:'model',reservation:.001}),e=>(e as any).code==='DEPARTMENT_ARCHIVED');
 assert.equal(requests,before,'a stopped worker and rejected reservations cannot call the provider');
 await pool.query("UPDATE project_runs SET status='failed',lease_owner=NULL,lease_until=NULL WHERE id=$1",[approved.data.id]);
});

test('queue skips locked projects and simultaneous retries create at most one successor',{skip:process.env.SIMULATED_INTEGRATION==='pglite'?'requires independent PostgreSQL backends and row locks':false},async()=>{
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'),createArchiveWriterManager({traceRoot:join(dir,'runs')}));await worker.close();
 const p=await project(),approved=await call('/projects/'+p.id+'/approve','POST',{version:1});assert.equal(approved.status,202);
 const gate=await pool.connect();await gate.query('BEGIN');await gate.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[p.id]);
 try{worker.stopped=false;await worker.tick();assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].status,'queued');}
 finally{worker.stopped=true;await gate.query('ROLLBACK');gate.release();await worker.close();}
 assert.equal((await call('/runs/'+approved.data.id+'/cancel','POST',{})).status,202);
 const results=await Promise.all([1,2].map(()=>call('/runs/'+approved.data.id+'/retry','POST',{resume:false})));
 assert.equal(results.filter(r=>r.status===202).length,1);assert.ok(results.every(r=>[202,409].includes(r.status)),JSON.stringify(results));
 const children=(await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[approved.data.id])).rows;assert.equal(children.length,1);
 await call('/runs/'+children[0].id+'/cancel','POST',{});
});

test('legacy projects inherit only their existing scope; backup restores policy and historical policy versions',async()=>{
 const p=await project();
 await pool.query('UPDATE projects SET policy=$1,version=2 WHERE id=$2',[policy,p.id]);
 await pool.query('UPDATE plan_versions SET policy=NULL WHERE project_id=$1',[p.id]);
 await pool.query('INSERT INTO plan_versions(project_id,version,plan) VALUES($1,2,$2)',[p.id,p.plan]);
 const {migrateProduct}=await import('../apps/api/src/product-schema.ts');await migrateProduct(pool);
 const versions=(await call('/projects/'+p.id+'/versions')).data;assert.equal(versions[0].policy,null);assert.equal(versions[1].policy,null,'unknown historical policies are not invented');assert.deepEqual((await call('/projects')).data.find((item:any)=>item.id===p.id).policy,bindPolicy(policy,p.plan.agents));
 const backup=await call('/backup/export','POST',{password:'execution-policy-backup'});assert.equal(backup.status,200,JSON.stringify(backup.data));
 await pool.query("UPDATE projects SET policy=policy||'{\"allowedTools\":[\"terminal\"]}'::jsonb WHERE id=$1",[p.id]);
 assert.equal((await call('/backup/restore','POST',{password:'execution-policy-backup',backup:backup.data,confirmation:'RESTORE'})).status,200);
 assert.deepEqual((await call('/projects/'+p.id+'/versions')).data,versions);
 assert.deepEqual((await call('/projects')).data.find((item:any)=>item.id===p.id).policy.allowedTools,[]);
 const {encryptBackup,decryptBackup}=await import('../apps/api/src/backup.ts');const legacy=await decryptBackup(backup.data,'execution-policy-backup');
 for(const item of legacy.tables.projects)for(const key of ['allowedModelIds','allowedTools','allowedKnowledgeSpaceIds'])delete item.policy[key];
 for(const version of legacy.tables.plan_versions)delete version.policy;
  for(const run of legacy.tables.project_runs)delete run.department_ids;
  for(const usage of legacy.tables.usage)delete usage.department_id;
 const oldBackup=await encryptBackup(legacy,'execution-policy-backup');assert.equal((await call('/backup/restore','POST',{password:'execution-policy-backup',backup:oldBackup,confirmation:'RESTORE'})).status,200);
 assert.deepEqual((await call('/projects')).data.find((item:any)=>item.id===p.id).policy.allowedTools,[]);
 assert.ok((await call('/projects/'+p.id+'/versions')).data.every((version:any)=>version.policy===null));
});
