import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {toolEvidence} from './model-fixture.ts';

const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='collaboration_'+Date.now();
let pool:pg.Pool,app:any,server:any,url:string,dir:string;
async function call(path:string,method='GET',body?:any){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json() as any};}
const policy={maxBudget:5,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:300};
const employee=(name:string)=>({id:'manager',name,role:'manager',title:name+'负责人',instructions:'完成本部门职责并提供可核验结果',modelId:'model',tools:['knowledge_search'],knowledgeSpaceIds:[] as string[]});
async function department(name:string){const created=await call('/departments','POST',{name,description:name+'说明',agents:[employee(name)]});assert.equal(created.status,201);return (await call('/departments')).data.find((d:any)=>d.id===created.data.id);}
async function project(primary:any,collaborator:any){const created=await call('/projects','POST',{departmentId:primary.id,collaboratingAgents:[{departmentId:collaborator.id,agentId:'manager'}],requirement:'由两个部门协作完成调研、实现和最终验收交付',policy});assert.equal(created.status,201,JSON.stringify(created.data));return (await call('/projects')).data.find((p:any)=>p.id===created.data.id);}

before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const database=new URL(base);database.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=database.toString();
 dir=await mkdtemp(join(tmpdir(),'collaboration-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');process.env.OBSIDIAN_VAULT=join(dir,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
 await pool.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'Fixture',baseUrl:'http://127.0.0.1:1/v1'}]);
 await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[{name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1},toolEvidence]);
 const module=await import('../apps/api/src/app.ts');app=module.createApp();await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';
});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});

test('cross-department plans pin employee identity, knowledge scope, approval versions and billing ownership',async()=>{
 const primary=await department('产品部'),collaborator=await department('研发部');
 const space=(await call('/knowledge/spaces','POST',{name:'研发私有规范',scope:'employee',departmentId:collaborator.id,agentIds:['manager']})).data;
 const doc=(await call('/knowledge/documents','POST',{spaceId:space.id,title:'研发规范.md',content:'协作交付必须附带验证记录。'})).data;
 collaborator.agents[0].knowledgeSpaceIds=[space.id];assert.equal((await call('/departments/'+collaborator.id,'PUT',collaborator)).status,200);collaborator.version++;
 const p=await project(primary,collaborator);
 assert.deepEqual(p.policy.allowedDepartmentIds,[primary.id,collaborator.id]);assert.equal(p.plan.agents.length,2);assert.equal(new Set(p.plan.agents.map((a:any)=>a.id)).size,2);
 const collaborating=p.plan.agents.find((a:any)=>a.sourceDepartmentId===collaborator.id);assert.equal(collaborating.sourceAgentId,'manager');assert.equal(collaborating.role,'member');
 const tasks=[{...p.plan.tasks[0],id:'research',assigneeId:collaborating.id,subject:'研发调研'},{...p.plan.tasks[0],id:'accept',assigneeId:p.plan.agents.find((a:any)=>a.role==='manager').id,subject:'产品验收',dependencies:['research']}];
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan:{...p.plan,tasks},policy:p.policy})).status,200);
 const updated=(await call('/projects')).data.find((item:any)=>item.id===p.id);
 const forged={...updated.plan,agents:updated.plan.agents.map((a:any)=>a.id===collaborating.id?Object.fromEntries(Object.entries(a).filter(([key])=>!['sourceDepartmentId','sourceAgentId'].includes(key))):a)};
 assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:2,plan:forged,policy:p.policy})).data.code,'COLLABORATOR_PROVENANCE_CHANGED');
 const approved=await call('/projects/'+p.id+'/approve','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];assert.deepEqual(new Set(run.department_ids),new Set([primary.id,collaborator.id]));assert.equal(run.snapshot.departments.find((d:any)=>d.id===collaborator.id).version,2);
 assert.ok(run.snapshot.departmentBudgets[primary.id]>0);assert.ok(run.snapshot.departmentBudgets[collaborator.id]>0);assert.equal(Object.values(run.snapshot.departmentBudgets).reduce((n:any,value:any)=>n+value,0),5);
 const runtimeCollaborator=run.snapshot.agents.find((a:any)=>a.sourceDepartmentId===collaborator.id);assert.ok(run.snapshot.knowledge.agentDocuments[runtimeCollaborator.id].includes(doc.id));
 await pool.query("UPDATE project_runs SET status='running',lease_owner='fixture',lease_until=now()+interval '1 minute' WHERE id=$1",[run.id]);
 const cost=await import('../apps/api/src/cost-control.ts');const reservation=await cost.reserveCall({model:{id:'model',inputRate:1,outputRate:1},amount:.1,purpose:'项目执行',projectId:p.id,runId:run.id,billingDepartmentId:collaborator.id,context:{agentId:runtimeCollaborator.id}});await cost.settleCall(reservation,100,100);
 assert.equal((await pool.query('SELECT department_id FROM usage WHERE id=$1',[reservation])).rows[0].department_id,collaborator.id);
 assert.equal((await cost.dailyTotals(pool,collaborator.id)).spent,.0002);assert.equal((await cost.dailyTotals(pool,primary.id)).spent,0);
 await pool.query("UPDATE project_runs SET status='failed',lease_owner=NULL,lease_until=NULL WHERE id=$1",[run.id]);
 assert.equal((await call('/departments/'+collaborator.id,'DELETE',{version:collaborator.version})).status,200);
 // This fixture has no durable runtime archive, so goal provenance is checked first.
 assert.equal((await call('/runs/'+run.id+'/retry','POST',{resume:false})).data.code,'GOAL_CONTRACT_CHANGED');
 const {validateProjectTeam}=await import('../apps/api/src/collaboration.ts');
 await assert.rejects(validateProjectTeam(updated.plan.agents,primary.id,updated.policy,pool),{code:'DEPARTMENT_ARCHIVED'});
});

test('shared collaborator departments serialize runs and team limits fail before project creation',async()=>{
 const shared=await department('共享设计部'),first=await department('业务一部'),second=await department('业务二部');
 const p1=await project(first,shared),p2=await project(second,shared);
 for(const p of [p1,p2]){const plan={...p.plan,tasks:p.plan.tasks.map((t:any)=>({...t,subject:'完成协作资料核对',acceptanceCriteria:['说明来源和核对结论']}))};assert.equal((await call('/projects/'+p.id+'/plan','PUT',{version:1,plan})).status,200);}
 const r1=await call('/projects/'+p1.id+'/approve','POST',{version:2}),r2=await call('/projects/'+p2.id+'/approve','POST',{version:2});assert.equal(r1.status,202,JSON.stringify(r1.data));assert.equal(r2.status,202,JSON.stringify(r2.data));
 await pool.query("UPDATE project_runs SET status='running',lease_owner='fixture',lease_until=now()+interval '1 minute' WHERE id=$1",[r1.data.id]);
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const worker=new RunCoordinator(join(dir,'queue-runs'));await worker.close();worker.stopped=false;await worker.tick();worker.stopped=true;
 assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[r2.data.id])).rows[0].status,'queued');
 await pool.query("UPDATE project_runs SET status='failed',lease_owner=NULL,lease_until=NULL WHERE id=$1",[r1.data.id]);await call('/runs/'+r2.data.id+'/cancel','POST',{});await worker.close();
 const crowded={name:'满员部门',description:'',agents:Array.from({length:6},(_,i)=>({...employee('员工'+i),id:'employee-'+i,role:i===0?'manager':'member'}))};const full=(await call('/departments','POST',crowded)).data;
 const rejected=await call('/projects','POST',{departmentId:full.id,collaboratingAgents:[{departmentId:shared.id,agentId:'manager'}],requirement:'这个需求用于确认跨部门总人数限制会在保存前生效',policy:{...policy,maxAgents:6}});assert.equal(rejected.data.code,'COLLABORATOR_LIMIT');
});
