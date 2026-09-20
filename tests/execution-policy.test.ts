import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {toolEvidence} from './model-fixture.ts';
import {bindPolicy} from '../packages/contracts/index.ts';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='execution_policy_'+Date.now();
let pool:pg.Pool,app:any,server:any,gateway:any,url:string,dir:string,requests=0,candidate:any,lastInput:any;
async function call(path:string,method='GET',body?:any){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
const agent={id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调任务',modelId:'model',tools:[] as string[],knowledgeSpaceIds:[] as string[]};
const policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:1,deadlineSeconds:300};
async function project(agents=[agent]){
 const department=(await call('/departments','POST',{name:'权限测试',description:'',agents})).data;
 const created=await call('/projects','POST',{departmentId:department.id,requirement:'验证所有执行权限限制和版本记录',policy});assert.equal(created.status,201,JSON.stringify(created.data));
 return (await call('/projects')).data.find((p:any)=>p.id===created.data.id);
}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const dbURL=new URL(base);dbURL.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=dbURL.toString();
 dir=await mkdtemp(join(tmpdir(),'execution-policy-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdown();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
 gateway=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;lastInput=JSON.parse(raw);requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(candidate)}}],usage:{prompt_tokens:20,completion_tokens:20}}));});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'Local fixture',baseUrl:'http://127.0.0.1:'+gateway.address().port+'/v1'}]);
 for(const id of ['model','outside'])await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES($1,$2,'available',$3)",[id,{name:id,gatewayId:'gateway',model:id,inputRate:1,outputRate:1},toolEvidence]);
});
after(async()=>{await app?.locals.shutdown();for(const s of [server,gateway])if(s)await new Promise<void>(r=>s.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

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
 assert.deepEqual((await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[selected.data.id])).rows[0].snapshot.policy,expanded);
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:2,plan,policy:expanded})).data.code,'PROJECT_ACTIVE');await call('/runs/'+selected.data.id+'/cancel','POST',{});
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:2,plan,policy:expanded})).status,200);
 assert.equal((await call('/runs/'+selected.data.id+'/retry','POST',{resume:false})).data.code,'RUN_REAPPROVAL_REQUIRED');
});

test('archived departments and revoked private knowledge grants block approval or retry without changing old snapshots',async()=>{
 const space=(await call('/knowledge/spaces','POST',{name:'可撤回知识',scope:'company'})).data;
 const p=await project([{...agent,tools:['knowledge_search'],knowledgeSpaceIds:[space.id]}]);
 const run=await call('/projects/'+p.id+'/approve','POST',{version:1});assert.equal(run.status,202,JSON.stringify(run.data));await call('/runs/'+run.data.id+'/cancel','POST',{});
 const original=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[run.data.id])).rows[0].snapshot;
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

test('request admission fences stale lease owners and rechecks current run authorization transactionally',async()=>{
 const p=await project(),approved=await call('/projects/'+p.id+'/approve','POST',{version:1});assert.equal(approved.status,202);
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'));await worker.close();
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

test('queue skips locked projects and simultaneous retries create at most one successor',async()=>{
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'runs'));await worker.close();
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
 const oldBackup=await encryptBackup(legacy,'execution-policy-backup');assert.equal((await call('/backup/restore','POST',{password:'execution-policy-backup',backup:oldBackup,confirmation:'RESTORE'})).status,200);
 assert.deepEqual((await call('/projects')).data.find((item:any)=>item.id===p.id).policy.allowedTools,[]);
 assert.ok((await call('/projects/'+p.id+'/versions')).data.every((version:any)=>version.policy===null));
});
