import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';import {createTeamHost} from './host.mjs';import {Semaphore} from './limits.mjs';import {createRunArchive} from './trace-store.mjs';import {PRODUCT_TOOL_NAMES} from './product-tools.mjs';
class NeverModel extends LlmAdapter{providerInfo(){return{id:'fixture',name:'fixture'};}async resolveModel(){return{provider:'fixture',id:'test',name:'test'};}async *stream(){throw Error('Unexpected model call');}}

test('a queued external tool rechecks a goal pause after capacity is released',async()=>{
 const {GoalGuard}=await import('./goal-guard.mjs');const {createGoalContract}=await import('../../packages/contracts/goal-contract.mjs');
 const root=await mkdtemp(join(tmpdir(),'goal-queue-'));let host,calls=0;
 const snapshot={agents:[{id:'manager',role:'manager',tools:['browser_read'],browserOrigins:['https://approved.example']}],policy:{}};
 snapshot.goalContract=createGoalContract(snapshot);const archive=createRunArchive(root,snapshot),gate=new Semaphore(1);
 const goal=new GoalGuard({snapshot,archive});const release=await gate.acquire();
 try{
  host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,
    product:{snapshot,goal,gate,externalTool:async()=>{calls++;return{text:'fixture'};}}});
  const captain=await host.captain({cwd:root,model:'test'});
  const queued=host.call(captain,'browser_read',{url:'https://approved.example/reference'});
  await new Promise(done=>setTimeout(done,30));goal.block(Error('GOAL_BOUNDARY_VIOLATION: paused'),'tool');release();
  await assert.rejects(queued,/GOAL_BOUNDARY_VIOLATION/);assert.equal(calls,0);
 }finally{release();await host?.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('execution and summary requests cannot select a model outside the employee approval', async () => {
 const root=await mkdtemp(join(tmpdir(),'model-permission-'));let host;
 const snapshot={agents:[{id:'manager',role:'manager',modelId:'approved',tools:[]}],policy:{contextManagement:'prune'}};
 try{
  host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),product:{snapshot,gate:new Semaphore(1)}});
  const captain=await host.captain({cwd:root,model:'approved'});
  for(const purpose of ['execution','compaction']) await assert.rejects(async()=>{
   for await(const _ of host.ctx.llm.stream({provider:'fixture',model:'unapproved',sessionId:captain.id,purpose,
    messages:[{id:'forged',role:'user',source:{kind:'user'},content:[{type:'text',text:'change the model'}]}]})){}
  },/MODEL_PERMISSION_DENIED/);
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});
test('actual DSH tool pipeline enforces employee grants and waits for explicit terminal approval',async()=>{
 const root=await mkdtemp(join(tmpdir(),'permissions-'));let host,executed=0,approved=false;
 const snapshot={agents:[{id:'manager',role:'manager',tools:['knowledge_search','terminal_test']}],knowledge:{manager:[{id:'allowed',documentId:'doc',version:1,lineStart:1,lineEnd:1,content:'Deployment rollback test',title:'Manual'}]}};
 const archive=createRunArchive(root,snapshot);
 try{host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,gate:new Semaphore(1),sandbox:{revision:()=> 'fixture-revision',execute:async()=>{executed++;return{artifacts:[],output:'ok'};}},requestApproval:async()=>{if(!approved)throw Error('Approval denied');}}});const captain=await host.captain({cwd:root,model:'test'});
  await assert.rejects(host.call(captain,'artifact_write',{path:'x',content:'x'}),/UNKNOWN_TOOL/);assert.equal(executed,0);
  const denied=await host.ctx.tools.execute({callId:'coordinator-permission-fixture',name:'artifact_write',arguments:{path:'x',content:'x'},agent:captain,signal:AbortSignal.timeout(1000)});
  assert.equal(denied.isError,true);assert.match(denied.error.message,/TOOL_PERMISSION_DENIED/);assert.equal(executed,0);
  const hits=await host.call(captain,'knowledge_search',{query:'rollback'});assert.equal(hits[0].id,'allowed');
  await assert.rejects(host.call(captain,'terminal_test',{command:'npm test'}),/Approval denied/);assert.equal(executed,0);
  approved=true;await host.call(captain,'terminal_test',{command:'npm test'});assert.equal(executed,1);
  host.lockPlan();await assert.rejects(host.call(captain,'agent_teams_create',{name:'unauthorized',plan:{members:[],tasks:[]}}),/APPROVED_PLAN_IMMUTABLE/);
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});

test('DSH knowledge tools bind manifest queries to the executing employee and fail closed without a version service',async()=>{
 const root=await mkdtemp(join(tmpdir(),'knowledge-tools-'));let host;const calls=[];
 const snapshot={agents:[{id:'manager',role:'manager',tools:['knowledge_search','knowledge_read']}],knowledge:{format:'document-versions-v2',documents:[],agentDocuments:{manager:[]}}};
 const archive=createRunArchive(root,snapshot);
 const chunk={id:'chunk',documentId:'doc',version:4,lineStart:7,lineEnd:8,content:'Frozen reference',sha256:'frozen-hash',source:{vaultPath:'company/manual.md'}};
 try{
  host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,gate:new Semaphore(1),queryKnowledge:async(manifest,agentId,operation,value)=>{
   calls.push({manifest,agentId,operation,value});return operation==='search'?[chunk]:value===chunk.id?chunk:undefined;
  }}});
  const captain=await host.captain({cwd:root,model:'test'});
  assert.equal((await host.call(captain,'knowledge_search',{query:'reference'}))[0].version,4);
  assert.equal((await host.call(captain,'knowledge_read',{chunkId:'chunk'})).content,'Frozen reference');
  await assert.rejects(host.call(captain,'knowledge_read',{chunkId:'foreign'}),/不存在或未授权/);
  assert.ok(calls.every(call=>call.agentId==='manager'&&call.manifest===snapshot.knowledge));
  assert.deepEqual(calls.map(({operation,value})=>({operation,value})),[{operation:'search',value:'reference'},{operation:'read',value:'chunk'},{operation:'read',value:'foreign'}]);
  await host.close();host=undefined;
  host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'no-service'),archive,product:{snapshot,gate:new Semaphore(1)}});
  const unavailable=await host.captain({cwd:root,model:'test'});
  await assert.rejects(host.call(unavailable,'knowledge_search',{query:'reference'}),/KNOWLEDGE_SERVICE_UNAVAILABLE/);
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});

test('product schema restrictions retain recovery and native collaboration while the coordinator registry remains unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'schema-recovery-'));let host;
 const snapshot={agents:[{id:'manager',role:'manager',modelId:'test',tools:['filesystem','terminal_test','knowledge_search','knowledge_read']}],policy:{contextManagement:'prune'},recovery:{sourceRunId:'fixture'}};
 const archive=createRunArchive(root,snapshot);
 try{
  host=await createTeamHost({adapter:new NeverModel(),provider:'fixture',sessionRoot:join(root,'sessions'),archive,product:{snapshot,gate:new Semaphore(1)}});
  let captain=await host.captain({cwd:root,model:'test'});
  const check=()=>{
   const names=captain.ctx.tools.schemas(captain).map(tool=>tool.name);
   assert.deepEqual(names.filter(name=>PRODUCT_TOOL_NAMES.includes(name)).sort(),[...snapshot.agents[0].tools].sort());
   assert.ok(names.includes('recovery_read'));for(const name of ['agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message','agent_teams_status'])assert.ok(names.includes(name));
   assert.deepEqual(host.ctx.tools.schemas().filter(tool=>PRODUCT_TOOL_NAMES.includes(tool.name)).map(tool=>tool.name).sort(),[...PRODUCT_TOOL_NAMES].sort());
  };
  check();const id=captain.id;
  captain.session.append('user/message',createUserMessage({content:[{type:'text',text:'Persist an authorized local checkpoint'}],source:{kind:'user'}}),{surfaceOp:'append'});
  await host.employeeHosts().find(slot=>slot.sessionId===id).close();
  captain=await host.resumeCaptain({id,model:'test'});check();
 }finally{await host?.close();await rm(root,{recursive:true,force:true});}
});
