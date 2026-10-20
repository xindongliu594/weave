import { before,after,test,mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp,rm } from 'node:fs/promises';
import { existsSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import pg from 'pg';

// The API, approval contracts, knowledge grants and initial filesystem copy are real.
// Model replies and the runtime after initial copying are deterministic test boundaries.
const base=process.env.DATABASE_URL??'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department';
const admin=new pg.Pool({connectionString:base}),schema='work_file_project_'+Date.now();
let pool:pg.Pool,app:any,server:http.Server,gateway:http.Server,worker:InstanceType<typeof import('../apps/api/src/run-coordinator.ts').RunCoordinator>;
let directory:string,traceRoot:string,url:string,modelId:string,departmentId:string,plannedResponse:any,plannedRequest:any,runtimeStarts=0;
const providerRequests:any[]=[];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const upload=(path:string,text:string)=>({path,base64:Buffer.from(text).toString('base64')});
async function call(path:string,method='GET',body?:unknown){const response=await fetch(url+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
async function project(id:string){return (await call('/projects')).data.find((p:any)=>p.id===id);}
async function createProject(){const result=await call('/projects','POST',{departmentId,requirement:'读取选定已有项目代码和经理专用参考资料，保留来源并提交核验报告。',policy:{maxBudget:1,maxAgents:2,maxConcurrentAgents:1,deadlineSeconds:300}});assert.equal(result.status,201,JSON.stringify(result.data));const current=await project(result.data.id); current.plan.tasks=current.plan.tasks.map((task:any)=>({...task,subject:'核对选定代码与资料来源',objective:'读取获授权的导入文件与参考资料，提交包含路径及来源版本的核验结论。',acceptanceCriteria:['核验结论列出选定路径与资料版本']})); return current;}
async function savePlan(current:any,plan:any){const response=await call('/projects/'+current.id+'/plan','PUT',{version:current.version,plan});assert.equal(response.status,200,JSON.stringify(response.data));return project(current.id);}
before(async()=>{
  await admin.query('CREATE SCHEMA '+schema);const connection=new URL(base);connection.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=connection.toString();
  directory=await mkdtemp(join(tmpdir(),'work-file-project-'));traceRoot=join(directory,'runs');process.env.DATA_DIR=directory;process.env.TRACE_ROOT=traceRoot;process.env.OBSIDIAN_VAULT=join(directory,'vault');
  const db=await import('../apps/api/src/db.ts');pool=db.pool;await db.migrate();
  const {createApp}=await import('../apps/api/src/app.ts');app=createApp({assertExecutorReady:async()=>{}});await app.locals.shutdownBackground();server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api';
  const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');worker=new RunCoordinator(traceRoot);await worker.close();
  mock.method(worker.runtime,'start',async({runId}:any)=>{runtimeStarts++;return {runtimeRunId:runId,completion:Promise.resolve({status:'completed' as const,usages:[]})};});
  gateway=http.createServer(async(req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);providerRequests.push(body);let message:any={content:'OK'};
    if(body.tools?.[0]?.function?.name==='capability_probe')message={tool_calls:[{id:'probe',type:'function',function:{name:'capability_probe',arguments:JSON.stringify({nonce:body.tools[0].function.parameters.properties.nonce.enum[0]})}}]};
    else if(body.messages.some((m:any)=>m.role==='tool'))message={content:JSON.parse(body.messages.find((m:any)=>m.role==='tool').content).result};
    else if(body.messages.some((m:any)=>m.role==='system'&&m.content.includes('组织规划器'))){plannedRequest=body;message={content:JSON.stringify(plannedResponse)};}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:30,completion_tokens:10}}));
  });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const connectionResult=await call('/gateways','POST',{name:'Work file fixture',baseUrl:'http://127.0.0.1:'+(gateway.address() as AddressInfo).port+'/v1'});assert.equal(connectionResult.status,201);
  const modelResult=await call('/models','POST',{gatewayId:connectionResult.data.id,name:'Fixture model',model:'fixture',inputRate:1,outputRate:2});assert.equal(modelResult.status,201);modelId=modelResult.data.id;
  assert.equal((await call('/models/'+modelId+'/test','POST',{})).status,200);assert.equal((await call('/models/'+modelId+'/test-tools','POST',{})).status,200);
  const department=await call('/departments','POST',{name:'导入合同团队',description:'固定响应测试',agents:[{id:'manager',role:'manager',name:'经理',title:'经理',instructions:'依据选定资料协调与验收',modelId,tools:['knowledge_search','knowledge_read','filesystem']},{id:'developer',role:'member',name:'开发',title:'开发工程师',instructions:'在授权目录中实现代码',modelId,tools:['knowledge_search','knowledge_read','filesystem','artifact_write']}]});assert.equal(department.status,201);departmentId=department.data.id;
});
after(async()=>{
  await app?.locals.shutdown();await worker?.close();for(const current of [server,gateway])if(current){current.closeAllConnections();await new Promise<void>(r=>current.close(()=>r()));}
  await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();mock.restoreAll();
  if(directory){assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep+'work-file-project-'));await rm(directory,{recursive:true,force:true});}
});

test('selected imports reach planning and approval with exact path/SHA while unselected and private references stay isolated',async()=>{
  const source='export const importedValue = 42;',reference='manager-only-reference: 用户指定的验收依据。',unselected='NEVER_SEND_THIS_UNSELECTED_CONTENT';
  const code=await call('/work-files','POST',{name:'既有项目',files:[upload('todo/src/index.ts',source),upload('todo/omitted.txt',unselected)]});assert.equal(code.status,201);
  const brief=await call('/work-files','POST',{name:'经理简报',files:[upload('brief.md',reference),upload('unselected.md',unselected)]});assert.equal(brief.status,201);
  let current=await createProject();const selections=[{snapshotId:code.data.id,paths:['todo/src/index.ts'],agentIds:['manager','developer'],mode:'workspace'},{snapshotId:brief.data.id,paths:['brief.md'],agentIds:['manager'],mode:'reference'}];
  current=await savePlan(current,{...current.plan,workFileSelections:selections,tasks:current.plan.tasks.map((task:any)=>({...task,inputs:[{path:'todo/src/index.ts',sha256:hash(source)}],outputs:[]}))});
  plannedResponse={...current.plan,rationale:'固定规划回复',workFileSelections:[]};
  const generated=await call('/projects/'+current.id+'/generate','POST',{version:current.version,modelId,maxPlanningCost:.1});assert.equal(generated.status,200,JSON.stringify(generated.data));
  assert.equal((await project(current.id)).version,current.version,'only an explicit confirmation saves the generated plan');
  assert.deepEqual(generated.data.plan.workFileSelections,selections,'the unconfirmed candidate must retain user-owned grants too');
  assert.equal((await call('/projects/'+current.id+'/generated-plan/confirm','POST',{version:current.version,previewId:generated.data.previewId})).status,200);
  const planning=JSON.parse(plannedRequest.messages.find((message:any)=>message.role==='user').content);assert.deepEqual(planning.importedMaterials.workspaceFiles,[{path:'todo/src/index.ts',sha256:hash(source),agentIds:['manager','developer']}]);assert.ok(planning.importedMaterials.references.some((entry:any)=>entry.excerpt===reference&&entry.agentIds.join()==='manager'));assert.ok(!JSON.stringify(planning).includes(unselected));assert.ok(!JSON.stringify(planning).includes('omitted.txt'));
  current=await project(current.id);assert.deepEqual(current.plan.workFileSelections,selections,'planner cannot remove user-owned grants');
  const approved=await call('/projects/'+current.id+'/approve','POST',{version:current.version});assert.equal(approved.status,202,JSON.stringify(approved.data));
  let row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];const snapshot=row.snapshot;
  assert.deepEqual(snapshot.importedFiles.map((file:any)=>({path:file.path,content:file.content,sha256:file.sha256})),[{path:'todo/src/index.ts',content:source,sha256:hash(source)}]);assert.ok(!JSON.stringify(snapshot).includes(unselected));
  const manager=snapshot.agents.find((agent:any)=>agent.employeeId==='manager'),developer=snapshot.agents.find((agent:any)=>agent.employeeId==='developer');const privateInput=snapshot.knowledge.runInputs.find((input:any)=>input.title.endsWith('brief.md'));assert.deepEqual(privateInput.agentIds,[manager.id]);
  const {queryKnowledge}=await import('../apps/api/src/knowledge-store.ts');assert.equal((await queryKnowledge(snapshot.knowledge,manager.id,'read',privateInput.chunks[0].id)).content.trimEnd(),reference);assert.equal(await queryKnowledge(snapshot.knowledge,developer.id,'read',privateInput.chunks[0].id),undefined);
  // Approval owns an independent copy: later source-storage changes do not alter this Run.
  const stored=(await pool.query('SELECT files FROM work_file_snapshots WHERE id=$1',[code.data.id])).rows[0].files;stored[0].text='later source edit';stored[0].base64=Buffer.from('later source edit').toString('base64');stored[0].sha256=hash('later source edit');await pool.query('UPDATE work_file_snapshots SET files=$1 WHERE id=$2',[JSON.stringify(stored),code.data.id]);
  await pool.query("UPDATE project_runs SET status='running',lease_owner=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[worker.owner,approved.data.id]);row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];const beforeCalls=providerRequests.length;worker.stopped=false;await worker.launch(row);worker.stopped=true;
  assert.equal(runtimeStarts,1);assert.equal(providerRequests.length,beforeCalls,'runtime boundary does not invoke a real model');assert.equal((await pool.query('SELECT status FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].status,'completed');
  const root=join(traceRoot,approved.data.id,'artifacts');assert.equal(readFileSync(join(root,'todo/src/index.ts'),'utf8'),source);assert.equal(existsSync(join(root,'brief.md')),false);assert.equal(existsSync(join(root,'todo/omitted.txt')),false);
});

test('approval rejects a shared workspace import missing any file-tool employee grant',async()=>{
  const imported=await call('/work-files','POST',{name:'权限检查',files:[upload('source.ts','export const value=1;')]});assert.equal(imported.status,201);
  let current=await createProject();current=await savePlan(current,{...current.plan,workFileSelections:[{snapshotId:imported.data.id,paths:['source.ts'],agentIds:['manager'],mode:'workspace'}]});
  const beforeCalls=providerRequests.length,result=await call('/projects/'+current.id+'/approve','POST',{version:current.version});assert.equal(result.status,422,JSON.stringify(result.data));assert.match(result.data.message,/所有文件和终端员工/);assert.equal(providerRequests.length,beforeCalls);assert.equal((await pool.query('SELECT id FROM project_runs WHERE project_id=$1',[current.id])).rowCount,0);
});

test('workspace files can be approved by file workers without granting knowledge tools',async()=>{
  const imported=await call('/work-files','POST',{name:'仅工作区资料',files:[upload('source.ts','export const value=1;')]});assert.equal(imported.status,201);
  let current=await createProject();
  const agents=current.plan.agents.map((agent:any)=>({...agent,tools:agent.tools.filter((tool:string)=>!tool.startsWith('knowledge_'))}));
  current=await savePlan(current,{...current.plan,agents,workFileSelections:[{snapshotId:imported.data.id,paths:['source.ts'],agentIds:agents.map((a:any)=>a.id),mode:'workspace'}]});
  assert.equal(current.validation.valid,true,JSON.stringify(current.validation));
  const approved=await call('/projects/'+current.id+'/approve','POST',{version:current.version});assert.equal(approved.status,202,JSON.stringify(approved.data));
  const snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0].snapshot;
  assert.equal(snapshot.importedFiles[0].sha256,hash('export const value=1;'));
  assert.ok(snapshot.agents.every((a:any)=>a.tools.every((tool:string)=>!tool.startsWith('knowledge_'))));
  const reference=await createProject();
  const denied=await savePlan(reference,{...reference.plan,agents,workFileSelections:[{snapshotId:imported.data.id,paths:['source.ts'],agentIds:agents.map((a:any)=>a.id),mode:'reference'}]});
  assert.equal(denied.validation.valid,false);assert.match(denied.validation.errors.join('；'),/参考资料/);
});
