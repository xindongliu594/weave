import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
const base=process.env.DATABASE_URL!,admin=new pg.Pool({connectionString:base}),schema='organization_confirm_'+Date.now();
let pool:pg.Pool,app:any,server:any,url:string,dir:string;
const agent=(id:string,role='member')=>({id,role,name:id,title:id,instructions:'完成本职工作',modelId:'m',tools:[]});
const task=(id:string,assigneeId:string,dependencies:string[]=[])=>({id,assigneeId,dependencies,subject:id,objective:'整理业务需求',acceptanceCriteria:['核对完整内容'],handoff:{sections:[{key:'evidence',requirement:'逐项说明依据'}]},estimatedInputTokens:100,estimatedOutputTokens:100});
const policy={maxBudget:1,maxAgents:3,maxConcurrentAgents:2,deadlineSeconds:600,allowedModelIds:['m'],allowedTools:[],allowedKnowledgeSpaceIds:[]};
async function call(path:string,body:any){const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const connection=new URL(base);connection.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=connection.toString();
 dir=await mkdtemp(join(tmpdir(),'organization-confirm-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query("INSERT INTO gateways(id,data) VALUES('g',$1)",[{name:'Local fixture',baseUrl:'http://127.0.0.1:1/v1'}]);
 await pool.query("INSERT INTO models(id,data,status) VALUES('m',$1,'available')",[{name:'fixture',model:'fixture',gatewayId:'g',inputRate:1,outputRate:1}]);
 app=(await import('../apps/api/src/app.ts')).createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
async function fixture(kind:'existing'|'new'='existing'){
 const departmentId=randomUUID(),borrowedId=randomUUID(),previewId=randomUUID();
 const department={name:'研究部',description:'原人员保持',agents:[agent('manager','manager'),agent('writer'),agent('unused')]};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2),($3,$4)',[departmentId,department,borrowedId,{name:'复核部',description:'独立复核',agents:[agent('qa','manager')]}]);
 const candidate={schemaVersion:2,target:kind==='existing'?{kind,departmentId,departmentVersion:1,primaryAgentIds:['manager','writer'],collaboratingAgents:[{departmentId:borrowedId,departmentVersion:1,agentId:'qa'}]}:{kind,department:{...department,agents:department.agents.slice(0,2)}},rationale:'按实际工作安排',orchestration:{pattern:'pipeline',rationale:'先写后验'},tasks:[task('write','writer'),task('check',kind==='existing'?borrowedId+'::qa':'manager',['write'])],deliveryCriteria:[{id:'content',description:'内容完整',producerTaskIds:['write'],checkTaskId:'check',checkCriteriaIndexes:[0],independent:true}]};
 if(kind==='existing')candidate.tasks.push(task('deliver','manager',['check']));
 const scoped={...policy,allowedDepartmentIds:[departmentId,borrowedId]},resolved=await (await import('../apps/api/src/organization-routing.ts')).resolveOrganizationCandidate(candidate as any,scoped,pool);
 const draft={...resolved,previewVersion:1,requirement:'整理一份需求说明并独立核对其中的业务范围',policy:scoped,source:'model',costAccounting:'conversation'};
 await pool.query('INSERT INTO organization_previews(id,data) VALUES($1,$2)',[previewId,draft]);return {departmentId,borrowedId,previewId,draft,department};
}
test('confirmation creates a project only, freezes selected sources, and duplicate requests are idempotent',async()=>{
 const f=await fixture(),endpoint='/organizations/previews/'+f.previewId+'/confirm';
 const [a,b]=await Promise.all([call(endpoint,{previewVersion:1}),call(endpoint,{previewVersion:1})]);
 assert.ok([200,201].includes(a.status),JSON.stringify(a));assert.ok([200,201].includes(b.status),JSON.stringify(b));assert.equal(a.data.projectId,b.data.projectId);
 const row=(await pool.query('SELECT * FROM projects WHERE id=$1',[a.data.projectId])).rows[0];
 assert.equal(row.plan.agents.length,3);assert.deepEqual(row.plan.deliveryCriteria,f.draft.plan.deliveryCriteria);assert.equal(row.status,'DRAFT');
 const department=(await pool.query('SELECT * FROM departments WHERE id=$1',[f.departmentId])).rows[0];assert.deepEqual(department.data,f.department);assert.equal(department.version,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs')).rows[0].n,0);
});
test('superseded, edited or archived source drafts cannot create a project',async()=>{
 for(const change of ['superseded','edited','archived']){
  const f=await fixture();
  if(change==='superseded')await pool.query("UPDATE organization_previews SET data=data||'{\"supersededBy\":\"new-turn\"}'::jsonb WHERE id=$1",[f.previewId]);
  else await pool.query(change==='edited'?'UPDATE departments SET version=version+1 WHERE id=$1':'UPDATE departments SET deleted_at=now() WHERE id=$1',[f.borrowedId]);
  const r=await call('/organizations/previews/'+f.previewId+'/confirm',{previewVersion:1});assert.equal(r.status,409,JSON.stringify(r));
  assert.equal((await pool.query('SELECT project_id FROM organization_previews WHERE id=$1',[f.previewId])).rows[0].project_id,null);
 }
});
test('new team uses the same explicit confirmation and V2 cannot enter the legacy department-update endpoint',async()=>{
 const f=await fixture('new');
 assert.equal((await call('/organizations',{...f.draft,previewId:f.previewId})).status,409);
 const r=await call('/organizations/previews/'+f.previewId+'/confirm',{previewVersion:1});assert.equal(r.status,201,JSON.stringify(r));assert.notEqual(r.data.departmentId,f.departmentId);
 const p=(await pool.query('SELECT plan,policy FROM projects WHERE id=$1',[r.data.projectId])).rows[0];assert.ok(p.policy.allowedDepartmentIds.includes(r.data.departmentId));assert.equal(p.plan.agents.length,2);
});

test('confirmed verification reuse choices survive the formal execution snapshot', {timeout:10000}, async()=>{
 const f=await fixture();
 Object.assign(f.draft.plan.tasks[0],{verificationReuse:'never'});
 Object.assign(f.draft.plan.tasks[1],{verificationReuse:'same-workspace'});
 await pool.query('UPDATE organization_previews SET data=$2 WHERE id=$1',[f.previewId,f.draft]);
 // The coordinator is closed by this API fixture; no model or command executes.
 await pool.query('UPDATE models SET capabilities=$1 WHERE id=$2',[{tools:{status:'supported',checkedAt:new Date().toISOString(),testId:'confirmation-fixture',probeVersion:'fixture'}},'m']);
 const confirmed=await call('/organizations/previews/'+f.previewId+'/confirm',{previewVersion:1});assert.equal(confirmed.status,201,JSON.stringify(confirmed));
 const project=(await pool.query('SELECT plan,version FROM projects WHERE id=$1',[confirmed.data.projectId])).rows[0];
 assert.equal(project.plan.tasks.find((task:any)=>task.id==='check').verificationReuse,'same-workspace');
 const started=await call('/projects/'+confirmed.data.projectId+'/approve',{version:project.version});assert.equal(started.status,202,JSON.stringify(started));
 const run=(await pool.query('SELECT snapshot,status FROM project_runs WHERE id=$1',[started.data.id])).rows[0];
 assert.equal(run.status,'queued');
 assert.equal(run.snapshot.tasks.find((task:any)=>task.id==='check').verificationReuse,'same-workspace');
 assert.equal(run.snapshot.tasks.find((task:any)=>task.id==='write').verificationReuse,'never');
 assert.equal(Object.hasOwn(run.snapshot.tasks.find((task:any)=>task.id==='deliver'),'verificationReuse'),false);
});
