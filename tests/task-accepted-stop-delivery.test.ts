import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {assertOriginalTaskCommit} from '../apps/api/src/task-original-commit.ts';
import {storeArchiveObjects} from '../services/agent-runtime/archive-objects.mjs';
import {pool,migrate} from '../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite';let integrationRoot:string;
before(async()=>{if(!isolated)return;integrationRoot=mkdtempSync(join(tmpdir(),'accepted-stop-delivery-'));process.env.DATA_DIR=integrationRoot;process.env.TRACE_ROOT=integrationRoot;await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(isolated){await pool.end();rmSync(integrationRoot,{recursive:true,force:true});}});

const {createTaskWorkspace}=createRequire(import.meta.url)('../apps/desktop/task-workspace.cjs');
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>sha(JSON.stringify(ordered(v)));

// Synthetic provenance tests exercise the pure verifier, not product acceptance.
function originalCommit(){
 const root=mkdtempSync(join(tmpdir(),'accepted-stop-original-')),id=randomUUID(),operationId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID();
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const key={runId:id,taskId:'a',attemptId:'attempt-a',generation:1},run={id,project_id:'project',project_version:1};
 const binding={projectId:'project',planVersion:1,...key,assigneeId:'employee',contractHash:sha('contract'),permissionHash:sha('permission'),backend:{kind:'openshell',version:backend.version,image:backend.image,policyHash:backend.policySha256}};
 const workspace=createTaskWorkspace({binding,readPaths:[],writePaths:['a.txt'],canonicalFiles:[],origins:[]});
 const scope={profile:'task-attempt-openshell-v1',key,workspace,workRevision:revision([]),capabilityHash:sha('capability'),inputOrigins:[]};
 const files=[{path:'a.txt',content:Buffer.from('A').toString('base64')}],context={agentId:'employee',sessionId:'session',taskId:'a',attemptId:'attempt-a',generation:1};
 const result={localWorkspace:'/sandbox',path:'a.txt',bytes:1,sha256:sha('A'),files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...backend,sandboxId:randomUUID(),sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId,beforeWorkRevision:revision([]),afterWorkRevision:revision(files)}};
 const claimToken=randomUUID();
 const row:any={id:operationId,run_id:id,device_id:deviceId,grant_id:grantId,lease_owner:'original-owner',status:'completed',started:true,claim_token:claimToken,merge_state:'committed',payload:{runId:id,deviceId,grantId,name:'artifact_write',arguments:{path:'a.txt',content:'A'},context,taskScope:scope,executionScope:{profile:scope.profile,key,binding,scopeHash:workspace.scopeHash,readPaths:workspace.readPaths,writePaths:workspace.writePaths,inputManifest:workspace.inputManifest,expectedWorkRevision:revision([])}},result:{claimToken,ok:true,result}};
 const receipt={mergeId:operationId,operationId,key,scopeHash:workspace.scopeHash,beforeRevision:revision([]),afterRevision:revision(files),workRevision:revision(files),status:'committed'};
 const record:any={version:1,operationId,resultDigest:digest(row.result),scopeDigest:digest(scope),before:{revision:revision([]),manifest:[],mergeId:null},after:{revision:revision(files),manifest:manifest(files),mergeId:operationId},receipt,delta:[{path:'a.txt',sha256:sha('A')}]};record.digest=digest(record);row.merge_record=record;
 const task:any={run_id:id,task_id:'a',attempt_id:'attempt-a',generation:1,principal:'employee',session_id:'session',contract_hash:binding.contractHash,permission_hash:binding.permissionHash,capability_hash:scope.capabilityHash,input_origins:[],sandbox_identity:{sandboxId:result.execution.sandboxId,localWorkspace:'/sandbox'},committed_outputs:[{scope,receipt:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId,beforeWorkRevision:record.before.revision,afterWorkRevision:record.after.revision},files:record.delta}]};
 mkdirSync(join(root,id));storeArchiveObjects(join(root,id),[{sha256:sha('A'),size:1,content:Buffer.from('A')}]);
 return {root,run,task,row,backend,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('task preparation fails closed before SQL when trusted stop maintenance is missing',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'accepted-stop-provider-'));
 try{
  const executor=new LocalRunExecutor({id:'unused',dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'unused'} as any);
  await assert.rejects(()=>executor.prepareTask({agentId:'employee',sessionId:'session',taskId:'task',attemptId:'attempt',generation:1},new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('original commit verifies raw result and historical objects independently of a current lease owner',()=>{
 const f=originalCommit();try{assert.equal(assertOriginalTaskCommit(f.root,{...f.run,lease_owner:'new-owner'},f.task,f.row,f.backend).receipt.operationId,f.row.id);}finally{f.close();}
});

test('original commit rejects a separately valid workspace binding for another task key',()=>{
 const f=originalCommit();try{
  const scope=f.row.payload.taskScope;
  const workspace=createTaskWorkspace({binding:{...scope.workspace.binding,taskId:'other'},readPaths:[],writePaths:['a.txt'],canonicalFiles:[],origins:[]});
  scope.workspace=workspace;f.row.payload.executionScope={...f.row.payload.executionScope,binding:workspace.binding,scopeHash:workspace.scopeHash};f.row.result.result.taskExecution.scopeHash=workspace.scopeHash;
  const record=f.row.merge_record;record.scopeDigest=digest(scope);record.resultDigest=digest(f.row.result);record.receipt.scopeHash=workspace.scopeHash;
  const {digest:old,...base}=record;record.digest=digest(base);f.task.committed_outputs[0].receipt.scopeHash=workspace.scopeHash;
  assert.throws(()=>assertOriginalTaskCommit(f.root,f.run,f.task,f.row,f.backend),{message:'原操作来源与准确任务绑定不符'});
 }finally{f.close();}
});

for(const corrupt of ['raw-result','merge-digest','committed-output','claim-token'])test('original commit rejects damaged '+corrupt,()=>{
 const f=originalCommit();try{
  if(corrupt==='raw-result')f.row.result.untrusted='changed';
  if(corrupt==='merge-digest')f.row.merge_record.digest=sha('tampered');
  if(corrupt==='committed-output')f.task.committed_outputs[0].files=[];
  if(corrupt==='claim-token')f.row.claim_token=null;
  assert.throws(()=>assertOriginalTaskCommit(f.root,f.run,f.task,f.row,f.backend));
 }finally{f.close();}
});

test('original commit refuses a self-consistent raw result from a different claim',()=>{
 const f=originalCommit();try{
  f.row.result.claimToken=randomUUID();const record=f.row.merge_record;record.resultDigest=digest(f.row.result);const {digest:old,...base}=record;record.digest=digest(base);
  assert.throws(()=>assertOriginalTaskCommit(f.root,f.run,f.task,f.row,f.backend),{message:'原操作来源与准确任务绑定不符'});
 }finally{f.close();}
});

async function ready(){const f=await acceptedStopApiFixture(integrationRoot);try{await f.acceptA();const context=await f.bind('b');return {f,context};}catch(error){await f.close();throw error;}}
const marker=async(runId:string)=>(await pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='a'",[runId])).rows[0].accepted_stop;

test('API prepares target only after original accepted checkpoint stop commits',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  await f.drive(f.executor.prepareTask(context,new AbortController().signal));assert.equal(f.control.effects,1);assert.equal(f.control.calls,1);assert.equal((await marker(f.runId)).state,'stopped');
  const events=readRun(integrationRoot,f.runId)!.events;assert.equal(events.filter(event=>event.type==='handoff/accepted').length,1);assert.ok(events.some(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted'));
  await f.executor.prepareTask(context,new AbortController().signal);assert.equal(f.control.calls,1,'existing target prepare does not trigger another stop');
 }finally{await f.close();}
});

for(const change of ['provider','method','permission','lease','target'])test('beforeDispatch refuses fresh '+change+' changes without a device effect',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  f.control.beforeCallback=async()=>{
   if(change==='provider')f.swapProvider();
   if(change==='method')f.swapMethod();
   if(change==='permission')await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);
   if(change==='lease')await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2',['new-owner',f.runId]);
   if(change==='target'){f.state.tasks[1].attemptId='changed';f.archive.append('team/checkpoint',f.state);}
  };
  await assert.rejects(()=>f.drive(f.executor.prepareTask(context,new AbortController().signal)));assert.equal(f.control.effects,0);assert.equal((await marker(f.runId)).state,'prepared');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1 AND payload->'taskScope'->'key'->>'taskId'='b'",[f.runId])).rows[0].n,0);
 }finally{await f.close();}
});

for(const state of ['prepared','dispatching'])test('lost '+state+' COMMIT acknowledgement never grants a replacement dispatch',{skip:!isolated},async t=>{
 const {f,context}=await ready();try{
  const db=await pool.connect(),query=db.query.bind(db);let updateState:string|undefined,lost=false;
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args);
   if(typeof args[0]==='string'&&args[0].startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))updateState=JSON.parse(args[1][0]).state;
   if(args[0]==='COMMIT'&&updateState===state&&!lost){lost=true;throw Error('LOST_COMMIT_ACK');}
   return result;
  });db.release();
  await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal),/LOST_COMMIT_ACK/);assert.equal(lost,true);assert.equal(f.control.effects,0);assert.equal((await marker(f.runId)).state,state);
  await assert.rejects(()=>f.bind('b'),/No original device intent/);assert.equal(f.control.effects,0);assert.equal(f.control.calls,state==='prepared'?0:1);assert.equal(f.control.reconciles,1);
 }finally{await f.close();}
});

test('cold bind observes original stopped identity after a lost response without another stop',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  f.control.afterEffect=async()=>{throw Error('LOST_DEVICE_RESPONSE');};
  await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal),/LOST_DEVICE_RESPONSE/);const before=await marker(f.runId);assert.equal(before.state,'dispatching');assert.equal(f.control.effects,1);
  const cold=new LocalRunExecutor(f.archive,f.snapshot,f.service,{sandboxMaintenance:f.maintenance}),candidate={runId:f.runId,taskId:'b',attemptId:context.attemptId,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:'native-b',contractHash:checkpointContractFor(f.snapshot,'b')};
  await cold.bindAttempt(candidate,new AbortController().signal);const stopped=await marker(f.runId);assert.equal(stopped.state,'stopped');assert.deepEqual(stopped.identity,before.identity);assert.equal(f.control.calls,1);assert.equal(f.control.effects,1);assert.equal(f.control.reconciles,1);
 }finally{await f.close();}
});

for(const change of ['cancel','lease'])test('real Stopped fact survives '+change+' after the effect while target admission fails',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  f.control.afterEffect=async()=>{if(change==='cancel')await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);else await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2',['new-owner',f.runId]);};
  await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal));assert.equal(f.control.effects,1);assert.equal((await marker(f.runId)).state,'stopped');
  assert.equal(readRun(integrationRoot,f.runId)!.events.filter(event=>event.type==='handoff/accepted').length,1);
 }finally{await f.close();}
});

for(const change of ['progress','assignment'])test('post-COMMIT authority '+change+' uses relevant assignment semantics',{skip:!isolated},async t=>{
 const {f,context}=await ready();try{
  const db=await pool.connect(),query=db.query.bind(db);let markerWrite=false,injected=false;
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args);
   if(typeof args[0]==='string'&&args[0].startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))markerWrite=true;
   if(args[0]==='COMMIT'&&markerWrite&&!injected){injected=true;f.archive.append('team/checkpoint',{...f.state,tasks:f.state.tasks.map((task:any)=>({...task,progress:'ordinary asynchronous update',...(task.id==='native-b'?change==='progress'?{status:'claimed'}:{attemptId:'revoked'}:{})}))});}
   return result;
  });db.release();
  if(change==='progress'){await f.drive(f.executor.prepareTask(context,new AbortController().signal));assert.equal(f.control.effects,1);assert.equal((await marker(f.runId)).state,'stopped');}
  else{await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal));assert.equal(f.control.effects,0);assert.equal((await marker(f.runId)).state,'prepared');}
  assert.equal(injected,true);
 }finally{await f.close();}
});

function checkpointContractFor(snapshot:any,id:string){return checkpointContract(snapshot,snapshot.tasks.find((task:any)=>task.id===id));}

test('original commit rejects a separately valid queued backend binding',{skip:false},()=>{
 const f=originalCommit();try{
  const scope=f.row.payload.taskScope;
  const workspace=createTaskWorkspace({binding:{...scope.workspace.binding,backend:{...scope.workspace.binding.backend,image:'node@sha256:'+sha('different image')}},readPaths:[],writePaths:['a.txt'],canonicalFiles:[],origins:[]});
  scope.workspace=workspace;f.row.payload.executionScope={...f.row.payload.executionScope,binding:workspace.binding,scopeHash:workspace.scopeHash};f.row.result.result.taskExecution.scopeHash=workspace.scopeHash;
  const record=f.row.merge_record;record.scopeDigest=digest(scope);record.resultDigest=digest(f.row.result);record.receipt.scopeHash=workspace.scopeHash;const {digest:old,...base}=record;record.digest=digest(base);f.task.committed_outputs[0].receipt.scopeHash=workspace.scopeHash;
  assert.throws(()=>assertOriginalTaskCommit(f.root,f.run,f.task,f.row,f.backend));
 }finally{f.close();}
});

test('current full B canonical requires its own original claim before stopping historical A',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(integrationRoot);try{
  const b=await f.bind('b');await f.drive(f.executor.prepareTask(b,new AbortController().signal));await f.acceptA();await f.write('b','B after A accepted');const c=await f.bind('c');
  const head=(await pool.query('SELECT canonical_workspace FROM project_runs WHERE id=$1',[f.runId])).rows[0].canonical_workspace;await pool.query('UPDATE local_operations SET claim_token=NULL WHERE id=$1',[head.mergeId]);
  await assert.rejects(()=>f.drive(f.executor.prepareTask(c,new AbortController().signal)));assert.equal(f.control.effects,0);assert.equal(await marker(f.runId),null);
 }finally{await f.close();}
});

test('cold observation records original stopped fact after response loss and cancellation',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  f.control.afterEffect=async()=>{await pool.query('UPDATE project_runs SET cancel_requested=true,lease_owner=$1 WHERE id=$2',['new-owner',f.runId]);throw Error('LOST_DEVICE_RESPONSE');};
  await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal),/LOST_DEVICE_RESPONSE/);assert.equal((await marker(f.runId)).state,'dispatching');
  const cold=new LocalRunExecutor(f.archive,f.snapshot,f.service,{sandboxMaintenance:f.maintenance});
  await assert.rejects(()=>cold.bindAttempt({runId:f.runId,taskId:'b',attemptId:context.attemptId,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:'native-b',contractHash:checkpointContractFor(f.snapshot,'b')},new AbortController().signal));
  assert.equal((await marker(f.runId)).state,'stopped');assert.equal(f.control.reconciles,1);assert.equal(f.control.effects,1);assert.equal(f.control.calls,1);
 }finally{await f.close();}
});

for(const damage of ['accepted-only','checkpoint-v1','accepted-output','original-merge'])test('historical stop rejects synthetic damaged '+damage+' provenance',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  const events=readRun(integrationRoot,f.runId)!.events;
  if(damage==='accepted-only')f.archive.append('handoff/accepted',events.findLast(event=>event.type==='handoff/accepted')!.data);
  else if(damage==='original-merge'){
   const cp=events.findLast(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted')!.data;
   await pool.query("UPDATE local_operations SET merge_record=jsonb_set(merge_record,'{digest}',$1::jsonb) WHERE id=$2",[JSON.stringify(sha('damaged')),cp.lastMerge.operationId]);
  }else{
   // Negative evidence mutation only; no successful scope/merge/seal is seeded.
   if(damage==='checkpoint-v1')events.findLast(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted')!.data.version=1;
   if(damage==='accepted-output')events.findLast(event=>event.type==='handoff/accepted')!.data.outputs[0].sha256=sha('damaged');
   writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
  }
  await assert.rejects(()=>f.drive(f.executor.prepareTask(context,new AbortController().signal)));assert.equal(f.control.effects,0);assert.equal(f.control.calls,0);assert.equal(await marker(f.runId),null);
 }finally{await f.close();}
});

test('fresh stop refuses boundary payload taskId contradicting its exact task links',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  const events=readRun(integrationRoot,f.runId)!.events,boundary=events.findLast(event=>event.type==='step/boundary'&&event.data.trigger==='node-accepted')!;
  assert.equal(boundary.taskId,'a');assert.equal(boundary.data.taskId,'a');boundary.data.taskId='contradicting-task';
  writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
  await assert.rejects(()=>f.drive(f.executor.prepareTask(context,new AbortController().signal)));assert.equal(f.control.effects,0);assert.equal(f.control.calls,0);assert.equal(await marker(f.runId),null);
 }finally{await f.close();}
});

test('cold observation refuses boundary payload attemptId contradicting its original links',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  f.control.afterEffect=async()=>{throw Error('LOST_DEVICE_RESPONSE');};await assert.rejects(()=>f.executor.prepareTask(context,new AbortController().signal),/LOST_DEVICE_RESPONSE/);
  const events=readRun(integrationRoot,f.runId)!.events,boundary=events.findLast(event=>event.type==='step/boundary'&&event.data.trigger==='node-accepted')!;
  assert.equal(boundary.attemptId,'attempt-a');assert.equal(boundary.data.attemptId,'attempt-a');boundary.data.attemptId='contradicting-attempt';
  writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
  const cold=new LocalRunExecutor(f.archive,f.snapshot,f.service,{sandboxMaintenance:f.maintenance});
  await assert.rejects(()=>cold.bindAttempt({runId:f.runId,taskId:'b',attemptId:context.attemptId,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:'native-b',contractHash:checkpointContractFor(f.snapshot,'b')},new AbortController().signal));
  assert.equal((await marker(f.runId)).state,'dispatching');assert.equal(f.control.reconciles,0);assert.equal(f.control.effects,1);assert.equal(f.control.calls,1);
 }finally{await f.close();}
});

test('dispatching COMMIT boundary payload mutation prevents a new device effect',{skip:!isolated},async t=>{
 const {f,context}=await ready();try{
  const db=await pool.connect(),query=db.query.bind(db);let writtenState:string|undefined,injected=false;
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args);
   if(typeof args[0]==='string'&&args[0].startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))writtenState=JSON.parse(args[1][0]).state;
   if(args[0]==='COMMIT'&&writtenState==='dispatching'&&!injected){
    injected=true;const events=readRun(integrationRoot,f.runId)!.events,boundary=events.findLast(event=>event.type==='step/boundary'&&event.data.trigger==='node-accepted')!;
    boundary.data.taskId='changed-after-dispatching-commit';writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
   }
   return result;
  });db.release();
  await assert.rejects(()=>f.drive(f.executor.prepareTask(context,new AbortController().signal)));assert.equal(injected,true);assert.equal(f.control.effects,0);assert.equal(f.control.calls,1);assert.equal((await marker(f.runId)).state,'dispatching');
 }finally{await f.close();}
});

for(const damage of ['cp-body','accepted-only','completed-witness','cp-work-object','historical-a-object','current-b-object','producer-origin'])test('sync proof surface rejects '+damage+' changes after its original verification',{skip:!isolated},async t=>{
 const f=await acceptedStopApiFixture(integrationRoot,{producerInput:damage==='producer-origin'});try{
  if(damage==='producer-origin')await f.acceptTask('p','Producer P');
  if(damage==='historical-a-object')await f.write('a','Historical A only');
  if(damage==='current-b-object'){const b=await f.bind('b');await f.drive(f.executor.prepareTask(b,new AbortController().signal));}
  await f.acceptA();
  if(damage==='current-b-object')await f.write('b','Current B only');
  const context=await f.bind(damage==='current-b-object'?'c':'b'),beforeEffects=f.control.effects,beforeCalls=f.control.calls;
  const db=await pool.connect(),query=db.query.bind(db);let writtenState:string|undefined,heads=0,injected=false;
  const mutate=()=>{
   injected=true;const events=readRun(integrationRoot,f.runId)!.events,cpEvent=events.findLast(event=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted'&&event.data.key.taskId==='a')!;
   if(damage==='cp-body'){cpEvent.data.boundary.environment=sha('changed body with unchanged sha');writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));}
   if(damage==='accepted-only')f.archive.append('handoff/accepted',events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId==='a')!.data);
   if(damage==='completed-witness'){
    const witness=events.findLast(event=>event.type==='team/checkpoint'&&event.seq>cpEvent.seq)!;assert.ok(witness);witness.type='team/snapshot';
    writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));
   }
   if(damage==='cp-work-object')unlinkSync(join(f.archive.dir,'checkpoint-objects',sha('A')));
   if(damage==='historical-a-object')writeFileSync(join(f.archive.dir,'checkpoint-objects',sha('Historical A only')),'corrupt historical bytes');
   if(damage==='current-b-object')unlinkSync(join(f.archive.dir,'checkpoint-objects',sha('Current B only')));
   if(damage==='producer-origin'){
    const producer=structuredClone(events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId==='p')!.data);producer.workspaceRevision=sha('new producer head');producer.outputs[0].sha256=sha('new producer bytes');f.archive.append('handoff/accepted',producer);
   }
  };
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args),text=args[0];
   if(typeof text==='string'&&text==='SELECT * FROM local_operations WHERE run_id=$1 AND id=$2')heads++;
   if(typeof text==='string'&&text.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))writtenState=JSON.parse(args[1][0]).state;
   if(!injected&&(damage==='cp-body'?heads===2&&typeof text==='string'&&text.includes("lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()"):text==='COMMIT'&&writtenState==='dispatching'))mutate();
   return result;
  });db.release();
  await assert.rejects(()=>f.drive(f.executor.prepareTask(context,new AbortController().signal)));assert.equal(injected,true);assert.equal(f.control.effects,beforeEffects);assert.equal(f.control.calls,beforeCalls+1);assert.equal((await marker(f.runId)).state,damage==='cp-body'?'prepared':'dispatching');
 }finally{await f.close();}
});

test('queued task context cannot be replaced in place with another authorized task',{skip:!isolated},async()=>{
 const {f,context}=await ready();try{
  await f.bind('c');f.control.beforeCallback=async()=>{context.taskId='c';context.attemptId='attempt-c';};
  const prepared=await f.drive(f.executor.prepareTask(context,new AbortController().signal));assert.equal(prepared.key.taskId,'b');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1 AND payload->>'name'='prepare' AND payload->'taskScope'->'key'->>'taskId'='c'",[f.runId])).rows[0].n,0);
 }finally{await f.close();}
});
