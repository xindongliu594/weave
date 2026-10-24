import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {once} from 'node:events';
import http from 'node:http';
import type pg from 'pg';
import {toolEvidence,fixtureTaskContext} from './model-fixture.ts';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {RunSandbox} from '../services/agent-runtime/sandbox.mjs';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
let db:pg.Pool,app:any,server:any,gateway:http.Server,url:string,root:string;
let modelRequests=0,forbiddenTransports=0;const steps=new Map<string,number>();
const departmentId=randomUUID(),employee={id:'reader',name:'Reader',title:'资料核对员',role:'manager',instructions:'读取指定资料并说明核对结论',modelId:'model',tools:['knowledge_search','knowledge_read'],knowledgeSpaceIds:[] as string[]};
const principal=(id:string)=>({kind:'human',userId:id,sessionId:id+'-session',issuer:'https://fixture.example',subject:id,orgRole:id==='admin'?'admin':'member',sessionEpoch:0,authenticatedAt:new Date().toISOString()});
async function call(path:string,method='GET',body?:unknown,actor='admin'){
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-fixture-actor':actor},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}return {status:response.status,data};
}
before(async()=>{
 root=await mkdtemp(join(tmpdir(),'effect-approval-'));Object.assign(process.env,{DATA_DIR:root,TRACE_ROOT:join(root,'runs'),OBSIDIAN_VAULT:join(root,'vault'),WEIWU_AUTH_MODE:'legacy-local',WEIWU_EXECUTION_MODE:'legacy'});
 const product=await import('../apps/api/src/db.ts');db=product.pool;await product.migrate();
 const {createApp}=await import('../apps/api/src/app.ts'),{apiAccess}=await import('../apps/api/src/api-access.ts'),{idempotency}=await import('../apps/api/src/idempotency.ts');
 app=createApp({assertExecutorReady:async()=>{}});await app.locals.ready;await app.locals.shutdownBackground();
 const slot=app.router.stack.findIndex((layer:any)=>layer.handle===idempotency);assert.ok(slot>0);
 // Only identity transport is synthetic. Original access, review, approval,
 // snapshots and transactions execute against the isolated product schema.
 app.router.stack[slot-1].handle=apiAccess({authenticate:async(req:any)=>principal(req.get('x-fixture-actor')??'member'),csrf:(_req:any,_res:any,next:any)=>next()} as any,{mode:'legacy-local'});
 await db.query("INSERT INTO human_users(id,issuer,subject,status,org_role) VALUES('admin','https://fixture.example','admin','active','admin'),('member','https://fixture.example','member','active','member')");
 gateway=http.createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString()),messages=body.messages??[],context=fixtureTaskContext(messages);modelRequests++;
  let message:any={content:'fixture finished'};
  if(context){
   const key=context.runtimeTaskId+':'+context.attemptId,step=steps.get(key)??0;steps.set(key,step+1);
   const results=messages.filter((item:any)=>item.role==='tool').map((item:any)=>{try{return JSON.parse(item.content);}catch{return {};}});
   const found=results.findLast((item:any)=>item.knowledge?.length&&item.skills?.length);
   const actions=[['agent_teams_claim_task',{task_id:context.runtimeTaskId}],['agent_teams_update_task',{task_id:context.runtimeTaskId,attempt_id:context.attemptId,status:'in_progress'}],
    ['capability_search',{query:'frozen-check'}],['knowledge_read',{chunkId:found?.knowledge[0].id??'missing-search-proof'}],['skill',{name:found?.skills[0].name??'missing-search-proof'}],
    ['capability_use',{kind:'skill',id:found?.skills[0].name??'missing-search-proof',note:'按照固定方法核对事实并保留引用'}],
    ['agent_teams_update_task',{task_id:context.runtimeTaskId,attempt_id:context.attemptId,status:'completed',output:'已读取固定版本资料，按方法核对事实：答案为42。',acceptanceResults:[{criterion:'给出有依据的核对结论',status:'passed',evidence:'已读取固定版本资料并登记采用'}],commandsRun:[],changedPaths:[]}]];
   if(step<actions.length){const [name,args]=actions[step];message={content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]};}
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:50,completion_tokens:10}}));
 });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 await db.query("INSERT INTO gateways(id,data) VALUES('gateway',$1)",[{name:'Loopback deterministic protocol fixture',baseUrl:`http://127.0.0.1:${(gateway.address() as any).port}/v1`}]);
 await db.query("INSERT INTO models(id,data,status,capabilities) VALUES('model',$1,'available',$2)",[{name:'Fixture',gatewayId:'gateway',model:'fixture',inputRate:1,outputRate:1},toolEvidence]);
 await db.query('INSERT INTO departments(id,data) VALUES($1,$2)',[departmentId,{name:'固定资料核对部门',dailyBudget:5,agents:[employee]}]);
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url=`http://127.0.0.1:${server.address().port}/api`;
});
after(async()=>{await app?.locals.shutdown();for(const instance of [server,gateway])if(instance){instance.closeAllConnections();await new Promise<void>(done=>instance.close(()=>done()));}await db?.end();if(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(root,/effect-approval-/);await rm(root,{recursive:true,force:true});}});
async function project(tools=employee.tools){
 const id=randomUUID(),agents=[{...employee,tools}],tasks=[{id:'read',subject:'核对指定资料中的事实',objective:'只读取固定资料并说明结论',assigneeId:'reader',dependencies:[],acceptanceCriteria:['给出有依据的核对结论'],estimatedInputTokens:100,estimatedOutputTokens:100,inputs:[],outputs:[],inScope:['只读核对'],outOfScope:['外部写入'],verify:[]}];
 const {bindPolicy}=await import('../apps/api/src/execution-policy.ts');
 const policy=bindPolicy({maxBudget:1,maxAgents:1,maxConcurrentAgents:1,deadlineSeconds:300,allowedDepartmentIds:[departmentId]},agents as any,departmentId),plan={rationale:'隔离测试只核对固定资料',agents,tasks};
 await db.query("INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,'固定资料核对部门','只读核对固定资料并说明结果',$3,$4,'manual')",[id,departmentId,policy,plan]);return id;
}
test('review-required approval cannot relabel an existing legacy run',async()=>{
 const id=await project();
 const original=await call(`/projects/${id}/approve`,'POST',{version:1});assert.equal(original.status,202,JSON.stringify(original.data));
 const before=(await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[original.data.id])).rows[0].snapshot;
 assert.equal(before.effectContractVersion,undefined);
 const strict=await call(`/projects/${id}/approve`,'POST',{version:1,requireReviewedTools:true});
 assert.equal(strict.status,409,JSON.stringify(strict.data));assert.equal(strict.data.code,'TOOL_EFFECT_REAPPROVAL_REQUIRED');
 assert.deepEqual((await db.query('SELECT snapshot FROM project_runs WHERE id=$1',[original.data.id])).rows[0].snapshot,before);
 assert.equal((await db.query('SELECT id FROM project_runs WHERE project_id=$1',[id])).rowCount,1);
 // This fixture run must not be picked up by the coordinator in the next test.
 await db.query("UPDATE project_runs SET status='cancelled' WHERE id=$1",[original.data.id]);
});

test('actual createApp review and approval freeze only selected tools and keep unreviewed requests out of the queue',async()=>{
 const list=await call('/tool-effect-contracts/sources');assert.equal(list.status,200,JSON.stringify(list.data));
 assert.equal((await call('/tool-effect-contracts/sources','GET',undefined,'member')).status,403);
 const space=await call('/knowledge/spaces','POST',{name:'Fixed protocol reference',scope:'company'});assert.equal(space.status,201,JSON.stringify(space.data));
 assert.equal((await call('/knowledge/documents','POST',{spaceId:space.data.id,title:'frozen-check',content:'frozen-check: 读取原资料，核对答案42，记录依据。',source:{skillName:'frozen-check'}})).status,201);
 employee.knowledgeSpaceIds=[space.data.id];await db.query('UPDATE departments SET data=$1 WHERE id=$2',[{name:'固定资料核对部门',dailyBudget:5,agents:[employee]},departmentId]);
 const id=await project();
 const denied=await call(`/projects/${id}/approve`,'POST',{version:1,requireReviewedTools:true});assert.equal(denied.status,409,JSON.stringify(denied.data));assert.equal(denied.data.code,'TOOL_EFFECT_UNREVIEWED');
 assert.equal((await db.query('SELECT id FROM project_runs WHERE project_id=$1',[id])).rowCount,0);
 const candidates=list.data.filter((item:any)=>item.namespace==='weiwu:production:container:keyword'&&item.effect!=='unknown');
 for(const candidate of candidates){const reviewed=await call('/tool-effect-contracts/reviews','POST',{namespace:candidate.namespace,toolName:candidate.toolName,expectedDigest:effectDigest(candidate)});assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));}
 const approved=await call(`/projects/${id}/approve`,'POST',{version:1,requireReviewedTools:true});assert.equal(approved.status,202,JSON.stringify(approved.data));
 const row=(await db.query('SELECT status,snapshot FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];assert.equal(row.status,'queued');assert.equal(row.snapshot.effectContractVersion,1);
 assert.ok(row.snapshot.effectContracts.some((item:any)=>item.toolName==='knowledge_read'));
 assert.ok(!row.snapshot.effectContracts.some((item:any)=>['terminal','filesystem','browser_read'].includes(item.toolName)));
 assert.equal((await db.query('SELECT count(*)::int AS count FROM model_reservations')).rows[0].count,0);
 // Run the approved record through the original coordinator, DSH, AgentTeams,
 // knowledge/Skill and budget paths. Only model replies and unused transport
 // are synthetic; this is protocol evidence, not real-model acceptance.
 const {RunCoordinator}=await import('../apps/api/src/run-coordinator.ts');
 const coordinator=new RunCoordinator(join(root,'runs'),createArchiveWriterManager({traceRoot:join(root,'runs')}),(archive:any)=>{
  const sandbox=new RunSandbox(archive.id,join(archive.dir,'artifacts'));sandbox.execute=async()=>{forbiddenTransports++;throw Error('NO_SANDBOX_TRANSPORT_EXPECTED');};sandbox.close=async()=>{};return sandbox;
 });
 try{
  const deadline=Date.now()+90000;let state:any;
  do{state=(await db.query('SELECT status,error FROM project_runs WHERE id=$1',[approved.data.id])).rows[0];if(['completed','failed','cancelled','interrupted'].includes(state.status))break;await new Promise(done=>setTimeout(done,100));}while(Date.now()<deadline);
  const archive=readRun(join(root,'runs'),approved.data.id);assert.equal(state.status,'completed',JSON.stringify({state,tail:archive?.events.slice(-8)}));
  assert.equal(forbiddenTransports,0);assert.ok(modelRequests>0);
  for(const name of ['knowledge/citation','skill/loaded','capability/adopted','handoff/accepted'])assert.ok(archive?.events.some(event=>event.type===name),name);
  const operations=(await db.query("SELECT id,effect_state,payload->'contract'->>'toolName' AS tool FROM local_operations WHERE run_id=$1 AND executor_kind='runtime'",[approved.data.id])).rows;
  assert.ok(operations.length>=9);assert.ok(operations.every(operation=>operation.effect_state==='confirmed'),JSON.stringify(operations));
  assert.equal(new Set(operations.map(operation=>operation.id)).size,operations.length);
  const receipts=(await db.query('SELECT status FROM model_reservations WHERE run_id=$1',[approved.data.id])).rows;assert.equal(receipts.length,modelRequests);assert.ok(receipts.every(receipt=>receipt.status==='settled'));
 }finally{await coordinator.close();}
 const unknownId=await project(['filesystem']);const unknown=await call(`/projects/${unknownId}/approve`,'POST',{version:1,requireReviewedTools:true});assert.equal(unknown.status,409);assert.match(unknown.data.code,/TOOL_EFFECT_/);
 assert.equal((await db.query('SELECT id FROM project_runs WHERE project_id=$1',[unknownId])).rowCount,0);
 const original=row.snapshot.effectContracts.find((item:any)=>item.toolName==='knowledge_read');
 assert.equal((await call(`/tool-effect-contracts/${effectDigest(original)}/retire`,'POST',{expectedVersion:1})).status,200);
 const later=await project();const retired=await call(`/projects/${later}/approve`,'POST',{version:1,requireReviewedTools:true});assert.equal(retired.status,409);assert.equal(retired.data.code,'TOOL_EFFECT_RETIRED');
});
