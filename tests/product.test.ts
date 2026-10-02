import {recoveryModel} from './model-fixture.ts';
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm,readFile,writeFile,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='product_'+Date.now();
let app:any,server:any,pool:any,url:string,dir:string;
before(async()=>{await admin.query('CREATE SCHEMA '+schema);const database=new URL(base);database.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=database.toString();dir=await mkdtemp(join(tmpdir(),'product-'));process.env.DATA_DIR=dir;process.env.TRACE_ROOT=join(dir,'runs');const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();const {createApp}=await import('../apps/api/src/app.ts');app=createApp();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port+'/api';});
after(async()=>{await app?.locals.shutdown();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();if(dir)await rm(dir,{recursive:true,force:true});});
async function call(path:string,method='GET',body?:unknown,headers:Record<string,string>={}){const r=await fetch(url+path,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};}
test('organization templates, prompt versions, archive and restore remain durable',async()=>{
 const t=await call('/templates');assert.equal(t.status,200);assert.ok(t.data.roles.length>=4);
 const preview=await call('/organizations/preview','POST',{templateId:'research',requirement:'整理现有产品资料并形成可验证的研究报告',policy:{maxBudget:1,maxAgents:3,maxConcurrentAgents:1,deadlineSeconds:300}});assert.equal(preview.status,200);assert.equal(preview.data.department.agents.length,3);
 const created=await call('/organizations','POST',preview.data);assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(preview.data.plan.tasks.length,3);assert.deepEqual((await call('/projects')).data[0].plan.tasks,preview.data.plan.tasks);
 const duplicate=await call('/organizations','POST',preview.data);assert.equal(duplicate.data.projectId,created.data.projectId);assert.equal((await call('/departments')).data.length,1);
 assert.equal((await call('/organizations','POST',{...preview.data,requirement:'修改成不同的新需求，必须显式创建预览'})).status,409);
 const d=(await call('/departments')).data[0];d.agents[0].instructions='更新后的协调职责，与当前任务指令独立。';assert.equal((await call('/departments/'+d.id,'PUT',d)).status,200);
 const current=(await call('/departments')).data[0];assert.equal(current.agents[0].roleVersion,2);assert.equal((await call('/departments/'+d.id+'/versions')).data.length,2);
 assert.equal((await call('/departments/'+d.id,'DELETE',{version:current.version})).status,200);const archived=(await call('/departments/archived')).data[0];assert.equal((await call('/departments/'+d.id+'/restore','POST',{version:archived.version})).status,200);assert.equal((await call('/projects')).data.length,1);
});
test('knowledge permissions filter before retrieval and revisions keep stable source references',async()=>{
 let department=(await call('/departments')).data[0],agent=department.agents[0],other=department.agents[1];
 const space=await call('/knowledge/spaces','POST',{name:'私有研发规范',scope:'employee',departmentId:department.id,agentIds:[agent.id]});assert.equal(space.status,201);
 const doc=await call('/knowledge/documents','POST',{spaceId:space.data.id,title:'上线规范.md',content:'部署检查\n每次部署必须执行自动化测试和回滚验证。\n保留完整执行记录。'});assert.equal(doc.status,201);
 const query={query:'部署测试',departmentId:department.id,agentId:agent.id};assert.equal((await call('/knowledge/search','POST',query)).data.length,0);
 department.agents=department.agents.map((a:any)=>({...a,knowledgeSpaceIds:[space.data.id]}));assert.equal((await call('/departments/'+department.id,'PUT',department)).status,200);
 const found=await call('/knowledge/search','POST',query);assert.ok(found.data.length>0);assert.equal(found.data[0].version,1);assert.equal(found.data[0].lineStart,7);
 assert.equal((await call('/knowledge/search','POST',{...query,agentId:other.id})).data.length,0);
 assert.equal((await call('/knowledge/documents/'+doc.data.id,'PUT',{spaceId:space.data.id,title:'上线规范.md',content:'新规范：先完成部署测试，再执行回滚验证。',version:1})).status,200);
 assert.equal((await call('/knowledge/documents/'+doc.data.id+'/versions')).data.length,2);
 assert.equal((await call('/knowledge/search','POST',query)).data[0].version,2);
});
test('Obsidian edits, wiki links and deletion preserve immutable versions and permissions',async()=>{
 const vault=await call('/knowledge/vault');assert.equal(vault.data.mode,'obsidian-markdown');
 const docs=(await call('/knowledge/documents')).data,doc=docs[0],file=join(vault.data.root,doc.vaultPath);
 const original=await readFile(file,'utf8');assert.match(original,/ad_document_id:/);
 await writeFile(file,original.replace('title:','tags: [deployment]\naliases: [ops]\ntitle:').replace('新规范：先完成部署测试，再执行回滚验证。','Obsidian 新规范：部署测试须人工复核。[[团队手册]] #部署'));
 const sync=await call('/knowledge/vault/sync','POST',{});assert.equal(sync.status,200);assert.deepEqual(sync.data.errors,[]);assert.equal(sync.data.indexed,1);
 const revisions=(await call('/knowledge/documents/'+doc.id+'/versions')).data;
 assert.equal(revisions[0].version,3);assert.match(revisions[0].content,/人工复核/);assert.deepEqual(revisions[0].source.links,['团队手册']);assert.match(revisions[1].content,/回滚验证/);
 const forbidden=await call('/knowledge/spaces','POST',{name:'其他空间',scope:'company'});
 const spaces=(await call('/knowledge/spaces')).data;
 const badFile=join(vault.data.root,spaces.find((s:any)=>s.id===forbidden.data.id).vaultFolder,'复制.md');await writeFile(badFile,original);
 assert.match((await call('/knowledge/vault/sync','POST',{})).data.errors.join(' '),/其他知识空间/);
 await unlink(badFile);
 const edited=await call('/knowledge/documents/'+doc.id,'PUT',{spaceId:doc.spaceId,title:doc.title,content:revisions[0].content+'\n工作台编辑',version:3});assert.equal(edited.status,200);assert.match(await readFile(file,'utf8'),/tags: \[deployment\]/);assert.match(await readFile(file,'utf8'),/aliases: \[ops\]/);
 await unlink(file);await call('/knowledge/vault/sync','POST',{});
 assert.ok(!(await call('/knowledge/documents')).data.some((d:any)=>d.id===doc.id));assert.equal((await call('/knowledge/documents/'+doc.id+'/versions')).data.length,4);
 await writeFile(file,original);await call('/knowledge/vault/sync','POST',{});
 assert.equal((await call('/knowledge/documents')).data.find((d:any)=>d.id===doc.id).version,5);
});
test('idempotency rejects mismatched content and encrypted backup restores data',async()=>{
 const input={name:'公司知识',scope:'company'},headers={'Idempotency-Key':'knowledge-create-one'};
 const first=await call('/knowledge/spaces','POST',input,headers),again=await call('/knowledge/spaces','POST',input,headers);assert.equal(first.status,201);assert.deepEqual(again,first);
 assert.equal((await call('/knowledge/spaces','POST',{...input,name:'不同请求'},headers)).status,409);
 const pass='test-password-long-enough';const backup=await call('/backup/export','POST',{password:pass});assert.equal(backup.status,200,JSON.stringify(backup.data));assert.ok(!JSON.stringify(backup.data).includes('部署测试'));
 const vault=(await call('/knowledge/vault')).data,doc=(await call('/knowledge/documents')).data[0],file=join(vault.root,doc.vaultPath),saved=await readFile(file,'utf8');await writeFile(file,saved+'\n恢复前修改');
 const before=(await call('/departments')).data;await call('/departments/'+before[0].id,'DELETE',{version:before[0].version});assert.equal((await call('/departments')).data.length,0);
 assert.equal((await call('/backup/restore','POST',{password:'wrong-password-long',backup:backup.data,confirmation:'RESTORE'})).status,422);
 const restored=await call('/backup/restore','POST',{password:pass,backup:backup.data,confirmation:'RESTORE'});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.deepEqual((await call('/departments')).data,before);assert.equal(await readFile(file,'utf8'),saved);
});
test('approval knowledge grants reject missing, archived and foreign employee spaces',async()=>{
 const {validateKnowledgeGrants,knowledgeSnapshot}=await import('../apps/api/src/knowledge.ts');
 const department=(await call('/departments')).data[0],agent=department.agents[0],other=department.agents[1];
 const spaces=(await call('/knowledge/spaces')).data,privateSpace=spaces.find((s:any)=>s.scope==='employee');
 await validateKnowledgeGrants([{...agent,knowledgeSpaceIds:[privateSpace.id]}],department.id);
 await assert.rejects(knowledgeSnapshot([{...other,knowledgeSpaceIds:[privateSpace.id]}],department.id),e=>(e as any).code==='KNOWLEDGE_GRANT_INVALID');
 await assert.rejects(validateKnowledgeGrants([{...agent,knowledgeSpaceIds:['missing']}],department.id),/知识授权已失效/);
 const archived=await call('/knowledge/spaces','POST',{name:'待归档资料',scope:'company'});await call('/knowledge/spaces/'+archived.data.id,'DELETE',{version:1});
 await assert.rejects(validateKnowledgeGrants([{...agent,knowledgeSpaceIds:[archived.data.id]}],department.id),/知识授权已失效/);
});
test('expired runs require explicit checkpoint resume and cancelled queue entries stay visible',async()=>{
 await app.locals.shutdown();
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');const coordinator=new RunCoordinator(join(dir,'runs'));await coordinator.close();
 const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
 const project=(await call('/projects')).data[0];
 const snapshot={title:'Recovery fixture',projectId:project.id,departmentId:project.departmentId,policy:{maxBudget:1},executionBudget:1,tasks:[{id:'first',dependencies:[],taskPrompt:'first'},{id:'second',dependencies:['first'],taskPrompt:'second'}],...await recoveryModel(pool)};
 const archive=createRunArchive(join(dir,'runs'),snapshot);
 archive.append('run/task-mapping',{tasks:[{task_id:'runtime-first',seed_id:'first'}]});archive.append('team/snapshot',{tasks:[{id:'runtime-first',status:'completed',output:'verified checkpoint output'}]});
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_until) VALUES($1,$2,$3,'running',$4,now()-interval '1 minute')",[archive.id,project.id,project.version,snapshot]);
 await coordinator.recover();assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[archive.id])).rows[0].status,'interrupted');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_runs WHERE status='queued'")).rows[0].n,0);
 const resumed=await call('/runs/'+archive.id+'/retry','POST',{resume:true});assert.equal(resumed.status,202,JSON.stringify(resumed.data));assert.deepEqual(resumed.data.completedCheckpoints,['first']);
 const next=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[resumed.data.id])).rows[0].snapshot;
 assert.equal(next.tasks.length,2);assert.deepEqual(next.tasks[1].dependencies,['first']);assert.match(next.recovery.nodes.first.output,/verified checkpoint output/);
 await coordinator.cancel(resumed.data.id);
 assert.equal((await call('/runs')).data.find((r:any)=>r.id===resumed.data.id).status,'cancelled');
 assert.equal((await call('/runs/'+resumed.data.id)).data.status,'cancelled');
});

test('retry admission preserves billed task cost and all wire calls, and refuses exhausted allowances',async()=>{
 await app.locals.shutdown();
 const {createRunArchive}=await import('../services/agent-runtime/trace-store.mjs');
 const source=(await pool.query('SELECT * FROM projects LIMIT 1')).rows[0];
 await pool.query("INSERT INTO models(id,data) VALUES('budget-fixture','{}')");
 async function attempt({cost=.1,calls=1,maxCalls=10,maxTaskCalls=3,missing=false}={}) {
  const projectId=randomUUID(),id=randomUUID();
  await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[projectId,source.department_id,source.department_version,source.department_name,source.requirement,source.policy,source.plan,'manual']);
  const snapshot={projectId,departmentId:source.department_id,...await recoveryModel(pool),policy:{maxBudget:1,maxModelCalls:maxCalls,maxTaskModelCalls:maxTaskCalls},executionBudget:1,tasks:[{id:'task',subject:'Budget task',assigneeId:'employee',taskPrompt:'Work',dependencies:[],maxBudget:.4}]};
  if(!missing){
   const archive=createRunArchive(join(dir,'runs'),snapshot,{id});
   archive.append('run/task-mapping',{tasks:[{task_id:'t1',seed_id:'task'}]});
   // Old archives put task references on model/request; new archives repeat them on wire-request.
   archive.append('model/request',{}, {sessionId:'session',taskId:'t1'});
   for(let n=0;n<calls;n++)archive.append('model/wire-request',n?{taskId:'task'}:{}, {sessionId:'session'});
   archive.append('run/finished',{status:'failed'});
  }
  await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,started_at) VALUES($1,$2,1,'failed',$3,now())",[id,projectId,snapshot]);
  await pool.query("INSERT INTO usage(id,model_id,project_id,run_id,input_tokens,output_tokens,cost,purpose,task_id) VALUES($1,'budget-fixture',$2,$3,1,1,$4,'fixture','task')",[randomUUID(),projectId,id,cost]);
  const response=await call('/runs/'+id+'/retry','POST',{resume:true});
  if(response.status===202){
   const next=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[response.data.id])).rows[0].snapshot;
   assert.equal(next.executionBudget,1-cost);assert.equal(next.budgetHistory.calls,calls);assert.deepEqual(next.budgetHistory.tasks.task,{cost,calls});
   await pool.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[response.data.id]);
  }
  return response;
 }
 assert.equal((await attempt()).status,202);
 assert.equal((await attempt({calls:3})).data.code,'TASK_BUDGET_EXHAUSTED');
 assert.equal((await attempt({cost:.4})).data.code,'TASK_BUDGET_EXHAUSTED');
 assert.equal((await attempt({maxCalls:1})).data.code,'TURN_LIMIT');
 assert.equal((await attempt({cost:.95})).data.code,'BUDGET_RETRY_DISABLED');
 assert.equal((await attempt({missing:true})).data.code,'BUDGET_HISTORY_MISSING');
});
