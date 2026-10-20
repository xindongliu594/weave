import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {toolEvidence} from './model-fixture.ts';

const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const schema='plan_readiness_'+Date.now(),admin=new pg.Pool({connectionString:base});
let pool:pg.Pool,app:any,server:http.Server,url:string,directory:string,modelId:string;
async function call(path:string,method='GET',body?:unknown){
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any};
}
const getProject=async(id:string)=>(await call('/projects')).data.find((project:any)=>project.id===id);
async function draft(){
 const department=await call('/departments','POST',{name:'方案校验测试',description:'明确开发和验收分工',agents:[
  {id:'manager',role:'manager',name:'经理',title:'协调经理',instructions:'汇总验收',modelId,tools:[]},
  {id:'developer',role:'member',name:'开发',title:'工程师',instructions:'实现与自测',modelId,tools:['filesystem','artifact_write','terminal_test']},
 ]});assert.equal(department.status,201);
 const project=await call('/projects','POST',{departmentId:department.data.id,requirement:'开发本地 Todo API，并进行独立测试验收',policy:{maxBudget:10,maxAgents:2,maxConcurrentAgents:2,deadlineSeconds:300}});
 assert.equal(project.status,201);return getProject(project.data.id);
}
before(async()=>{
 await admin.query('CREATE SCHEMA '+schema);const connection=new URL(base);connection.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=connection.toString();
 directory=await mkdtemp(join(tmpdir(),'plan-readiness-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=join(directory,'runs');process.env.OBSIDIAN_VAULT=join(directory,'vault');
 const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();await app.locals.shutdownBackground();
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as any).port+'/api';
 const gateway=await call('/gateways','POST',{name:'No inference',baseUrl:'http://127.0.0.1:45999/v1'});
 const model=await call('/models','POST',{name:'Fixture',model:'fixture',gatewayId:gateway.data.id,inputRate:1,outputRate:1});modelId=model.data.id;
 await pool.query("UPDATE models SET status='available',capabilities=$2 WHERE id=$1",[modelId,toolEvidence]);
});
after(async()=>{
 await app?.locals.shutdown();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 if(directory){assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'plan-readiness-'));await rm(directory,{recursive:true,force:true});}
});
test('new and configuration-only placeholder drafts are blocked before enqueue or billing',async()=>{
 let project=await draft();assert.equal(project.validation.valid,false);
 assert.equal((await call('/projects/'+project.id+'/approve','POST',{version:1})).data.code,'PLAN_NOT_READY');
 const saved=await call('/projects/'+project.id+'/plan','PUT',{version:1,plan:{...project.plan,rationale:'只改了预算和模型范围'},policy:{...project.policy,maxBudget:20}});assert.equal(saved.status,200);
 project=await getProject(project.id);assert.equal(project.version,2);assert.equal(project.validation.valid,false);
 const blocked=await call('/projects/'+project.id+'/approve','POST',{version:2});assert.equal(blocked.status,422);assert.equal(blocked.data.code,'PLAN_NOT_READY');
 for(const table of ['project_runs','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);
});
test('resume and full retry of a legacy placeholder run cannot enqueue another attempt',async()=>{
 const project=await draft(),runId=randomUUID();
 const snapshot={projectId:project.id,policy:project.policy,agents:project.plan.agents,tasks:project.plan.tasks,approvedTasks:project.plan.tasks};
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,error) VALUES($1,$2,1,'failed',$3,'TOOL_PERMISSION_DENIED')",[runId,project.id,snapshot]);
 for(const resume of [true,false]){
  const result=await call('/runs/'+runId+'/retry','POST',{resume});assert.equal(result.status,422);assert.equal(result.data.code,'PLAN_NOT_READY');
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_runs WHERE project_id=$1',[project.id])).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage WHERE project_id=$1',[project.id])).rows[0].n,0);
});
test('concrete implementation assigned to an employee without tools is rejected',async()=>{
 const project=await draft();
 const plan={...project.plan,tasks:[{...project.plan.tasks[0],subject:'实现 Todo API',acceptanceCriteria:['接口测试通过'],kind:'implementation',inScope:['server.mjs'],outputs:[{path:'server.mjs'}],verify:['node --check server.mjs']}]};
 assert.equal((await call('/projects/'+project.id+'/plan','PUT',{version:1,plan})).status,200);
 const invalid=await getProject(project.id);assert.equal(invalid.validation.valid,false);assert.ok(invalid.validation.errors.some((message:string)=>message.includes('权限')));
 const result=await call('/projects/'+project.id+'/approve','POST',{version:2});assert.equal(result.status,422);assert.equal(result.data.code,'PLAN_NOT_READY');
});
test('a deliberately edited single-person text plan can still be approved',async()=>{
 const project=await draft();
 const plan={...project.plan,agents:[project.plan.agents[0]],tasks:[{...project.plan.tasks[0],subject:'整理 Todo API 的需求',objective:'整理接口清单和验收用例',kind:'requirements',acceptanceCriteria:['列出每个接口及成功和失败用例']}]};
 assert.equal((await call('/projects/'+project.id+'/plan','PUT',{version:1,plan})).status,200);
 const ready=await getProject(project.id);assert.equal(ready.validation.valid,true,JSON.stringify(ready.validation));
 const approved=await call('/projects/'+project.id+'/approve','POST',{version:2});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const run=(await pool.query('SELECT status,snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];assert.equal(run.status,'queued');assert.equal(run.snapshot.tasks[0].subject,'整理 Todo API 的需求');
});
