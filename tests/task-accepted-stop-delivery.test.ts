import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {TaskAcceptedStopLifecycle} from '../apps/api/src/task-accepted-stop.ts';
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
const queryText=(args:any[])=>typeof args[0]==='string'?args[0]:args[0]?.text;
const queryValues=(args:any[])=>typeof args[0]==='string'?args[1]:args[0]?.values??args[1];

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
   if(queryText(args)?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))updateState=JSON.parse(queryValues(args)[0]).state;
   if(queryText(args)==='COMMIT'&&updateState===state&&!lost){lost=true;throw Error('LOST_COMMIT_ACK');}
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
   if(queryText(args)?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))markerWrite=true;
   if(queryText(args)==='COMMIT'&&markerWrite&&!injected){injected=true;f.archive.append('team/checkpoint',{...f.state,tasks:f.state.tasks.map((task:any)=>({...task,progress:'ordinary asynchronous update',...(task.id==='native-b'?change==='progress'?{status:'claimed'}:{attemptId:'revoked'}:{})}))});}
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
   if(queryText(args)?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))writtenState=JSON.parse(queryValues(args)[0]).state;
   if(queryText(args)==='COMMIT'&&writtenState==='dispatching'&&!injected){
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
   const result=await (query as any)(...args),text=queryText(args);
   if(typeof text==='string'&&text==='SELECT * FROM local_operations WHERE run_id=$1 AND id=$2')heads++;
   if(typeof text==='string'&&text.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))writtenState=JSON.parse(queryValues(args)[0]).state;
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

// Terminal acceptance uses the same real HTTP/result/CAS/Handoff path as above.
async function terminalReady(fresh=1){
 const f=await acceptedStopApiFixture(integrationRoot);
 try{
  if(fresh===3)for(const id of ['a','b','c'])await f.write(id,id.toUpperCase());
  await f.acceptA();
  if(fresh===2){await f.write('b','B');await f.write('c','C');}
  await f.acceptTask('b','B');await f.acceptTask('c','C');return f;
 }catch(error){await f.close();throw error;}
}
function finalize(executor:LocalRunExecutor,signal=new AbortController().signal){assert.equal(typeof (executor as any).finalizeAccepted,'function','terminal source-only entry must exist');return (executor as any).finalizeAccepted(signal);}
function observer(f:Awaited<ReturnType<typeof terminalReady>>){const lifecycle=new TaskAcceptedStopLifecycle(f.runId,f.service,f.maintenance);assert.equal(typeof (lifecycle as any).reconcileExact,'function','trusted original-ID observer must exist');return (identity:any,signal=new AbortController().signal)=>(lifecycle as any).reconcileExact(identity,signal);}
async function lastMarker(f:any){return (await pool.query("SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='c'",[f.runId])).rows[0].accepted_stop;}

test('terminal source-only stops the last accepted scope without an active target',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  const result=await finalize(f.executor);assert.deepEqual(result,{version:1,state:'stopped'});assert.equal(f.control.effects,3);assert.equal((await lastMarker(f)).state,'stopped');assert.ok(f.control.signals.at(-1) instanceof AbortSignal);
  await finalize(f.executor);assert.equal(f.control.effects,3,'confirmed stops never replay');
 }finally{await f.close();}
});

for(const damage of ['incomplete-node','missing-row','null-provenance','missing-cp','retired-row'])test('terminal all-approved proof refuses '+damage+' before any fresh effect',{skip:!isolated},async()=>{
 const f=damage==='incomplete-node'?await acceptedStopApiFixture(integrationRoot):await terminalReady();try{
  if(damage==='incomplete-node')await f.acceptA();
  if(damage==='missing-row')await pool.query("DELETE FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='null-provenance')await pool.query("UPDATE task_attempt_workspaces SET sandbox_identity=NULL WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='retired-row')await pool.query("UPDATE task_attempt_workspaces SET phase='retired' WHERE run_id=$1 AND task_id='c'",[f.runId]);
  if(damage==='missing-cp'){const events=readRun(integrationRoot,f.runId)!.events;const cp=events.findLast(event=>event.type==='step/checkpoint'&&event.data.key?.taskId==='c')!;cp.type='unrelated';writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(event=>JSON.stringify(event)+'\n').join(''));}
  const effects=f.control.effects,result=await finalize(f.executor);assert.equal(result.state,'pending');assert.equal(f.control.effects,effects);
 }finally{await f.close();}
});

test('terminal prepare refuses capability mutation during initialization before any device prepare',{skip:!isolated},async t=>{
 const f=await acceptedStopApiFixture(integrationRoot);try{
  const db=await pool.connect(),query=db.query.bind(db);let changed=false;
  t.mock.method(db,'query',async(...args:any[])=>{const result=await (query as any)(...args);if(queryText(args)==='COMMIT'&&!changed){changed=true;f.maintenance().executor.acceptedStopCapabilities=()=>({version:1,deadline:'wrong'} as any);}return result;});db.release();
  await assert.rejects(()=>f.executor.prepare(new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});assert.equal(changed,true);assert.equal(f.jobs.length,0);assert.equal(f.control.effects,0);
  await assert.rejects(()=>f.executor.prepare(new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
 }finally{t.mock.restoreAll();await f.close();}
});

for(const fresh of [2,3])test('terminal fresh-stop bound handles '+fresh+' real accepted scopes',{skip:!isolated},async()=>{
 const f=await terminalReady(fresh);try{
  const before=f.control.effects,result=await finalize(f.executor);
  assert.equal(result.state,fresh===2?'stopped':'pending');assert.equal(f.control.effects-before,fresh===2?2:0);
  if(fresh===3){assert.equal(result.reasonCode,'TASK_STOP_FINALIZE_LIMIT');assert.equal((await pool.query('SELECT count(*)::int AS n FROM task_attempt_workspaces WHERE run_id=$1 AND accepted_stop IS NOT NULL',[f.runId])).rows[0].n,0);}
 }finally{await f.close();}
});

for(const mutation of ['cap-method','cap-response','related-node','unrelated-progress'])test('terminal dispatch rechecks '+mutation+' after provider queue wait',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  const before=f.control.effects;
  const response:any={version:1,deadline:'shared-abort-v1'};
  if(mutation==='cap-response')f.maintenance().executor.acceptedStopCapabilities=()=>response;
  f.control.beforeCallback=async()=>{
   if(mutation==='cap-method')f.maintenance().executor.acceptedStopCapabilities=()=>({version:1,deadline:'shared-abort-v1'});
   if(mutation==='cap-response')response.deadline='wrong';
   if(mutation==='related-node'){f.state.tasks[0].status='in_progress';f.archive.append('team/checkpoint',f.state);}
   if(mutation==='unrelated-progress')f.archive.append('team/progress',{message:'still flushing'});
  };
  const result=await finalize(f.executor);assert.equal(result.state,mutation==='unrelated-progress'?'stopped':'pending');assert.equal(f.control.effects-before,mutation==='unrelated-progress'?1:0);
 }finally{await f.close();}
});

test('terminal confirmed fact survives SQL cancellation and lease transfer',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  f.control.afterEffect=async()=>{await pool.query('UPDATE project_runs SET cancel_requested=true,lease_owner=$1 WHERE id=$2',['new-owner',f.runId]);};
  await finalize(f.executor);assert.equal((await lastMarker(f)).state,'stopped');assert.equal(f.control.effects,3);
 }finally{await f.close();}
});

test('terminal aborted bookkeeping retains original marker and exact observer only reads original ID',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  const runAbort=new AbortController();f.control.afterEffect=async()=>{runAbort.abort();await pool.query('UPDATE project_runs SET cancel_requested=true,lease_owner=$1 WHERE id=$2',['new-owner',f.runId]);};
  const result=await finalize(f.executor,runAbort.signal);assert.equal(result.state,'pending');const stored=await lastMarker(f);assert.equal(stored.state,'dispatching');assert.equal(f.control.effects,3);assert.equal(f.control.signals.at(-1)?.aborted,true);
  await observer(f)({key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId});assert.equal((await lastMarker(f)).state,'stopped');assert.equal(f.control.effects,3);assert.equal(f.control.reconciles,1);
 }finally{await f.close();}
});

test('terminal pool acquisition abort releases late client before BEGIN or fn',{skip:!isolated},async t=>{
 const f=await terminalReady();let db:any,deliver:((db:any)=>void)|undefined;const cancellation=new AbortController();try{
  assert.equal(typeof (f.executor as any).finalizeAccepted,'function','terminal source-only entry must exist');
  db=await pool.connect();const query=db.query.bind(db);let queries=0,releases=0,entered!:()=>void;
  const acquired=new Promise<void>(done=>{entered=done;});
  t.mock.method(db,'query',async(...args:any[])=>{queries++;return (query as any)(...args);});const release=t.mock.method(db,'release',()=>{releases++;});
  const held=new Promise<any>(done=>{deliver=done;});t.mock.method(pool,'connect',()=>{entered();return held;});
  const pending=finalize(f.executor,cancellation.signal);await acquired;cancellation.abort();assert.equal((await pending).state,'pending');deliver!(db);await new Promise(done=>setImmediate(done));assert.equal(queries,0);assert.equal(releases,1);
 }finally{cancellation.abort();if(db){deliver?.(db);await new Promise(done=>setImmediate(done));}t.mock.restoreAll();db?.release();await f.close();}
});

test('terminal dispatching COMMIT loss preserves original ID with no fresh device effect',{skip:!isolated},async t=>{
 const f=await terminalReady();try{
  const db=await pool.connect(),query=db.query.bind(db);let written:string|undefined,lost=false,timeouts=0;
  t.mock.method(db,'query',async(...args:any[])=>{
   if(queryText(args)?.includes("set_config('statement_timeout'")){const ms=Number(queryValues(args)[0]);assert.ok(ms>0&&ms<=120000);timeouts++;}
   const result=await (query as any)(...args);
   if(queryText(args)?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))written=JSON.parse(queryValues(args)[0]).state;
   if(queryText(args)==='COMMIT'&&written==='dispatching'&&!lost){lost=true;throw Error('TERMINAL_LOST_COMMIT_ACK');}return result;
  });db.release();
  const before=f.control.effects,result=await finalize(f.executor);assert.equal(result.state,'pending');assert.equal(lost,true);assert.ok(timeouts>0);assert.equal(f.control.effects,before);const stored=await lastMarker(f);assert.equal(stored.state,'dispatching');
  const observe=observer(f);await assert.rejects(()=>observe({key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId}),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});assert.equal(f.control.effects,before);
 }finally{t.mock.restoreAll();await f.close();}
});

test('terminal rechecks another approved slot accepted proof after dispatching COMMIT',{skip:!isolated},async t=>{
 const f=await terminalReady();try{
  const db=await pool.connect(),query=db.query.bind(db);let written:string|undefined,changed=false;
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args);
   if(queryText(args)?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))written=JSON.parse(queryValues(args)[0]).state;
   if(queryText(args)==='COMMIT'&&written==='dispatching'&&!changed){changed=true;f.archive.append('handoff/accepted',readRun(integrationRoot,f.runId)!.events.findLast(event=>event.type==='handoff/accepted'&&event.data.taskId==='a')!.data);}return result;
  });db.release();
  const before=f.control.effects,result=await finalize(f.executor);assert.equal(result.state,'pending');assert.equal(changed,true);assert.equal(f.control.effects,before);assert.equal((await lastMarker(f)).state,'dispatching');
 }finally{t.mock.restoreAll();await f.close();}
});

test('terminal shared 120-second deadline begins before pool acquisition',{skip:!isolated},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'terminal-timeout-'));try{
  const caps={acceptedStopCapabilities:()=>({version:1,deadline:'shared-abort-v1'}),stopAcceptedTask:async()=>{},reconcileAcceptedTaskStop:async()=>{}};
  const executor=new LocalRunExecutor({id:randomUUID(),dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'owner'} as any,{sandboxMaintenance:()=>({deviceId:'d',grantId:'g',fingerprint:sha('f'),executor:caps as any})});
  assert.equal(typeof (executor as any).finalizeAccepted,'function','terminal source-only entry must exist');
  let entered!:()=>void;const acquired=new Promise<void>(done=>{entered=done;});t.mock.method(pool,'connect',()=>{entered();return new Promise(()=>{});});
  t.mock.timers.enable({apis:['setTimeout','Date']});const pending=finalize(executor);await acquired;t.mock.timers.tick(120000);assert.equal((await pending).state,'pending');
 }finally{t.mock.timers.reset();t.mock.restoreAll();rmSync(directory,{recursive:true,force:true});}
});

test('terminal exact observer rejects extra identity fields and class-run mismatch',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  await finalize(f.executor);const stored=await lastMarker(f),exact={key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId},observe=observer(f);
  await assert.rejects(()=>observe({...exact,proof:stored.proof}),{code:'TASK_STOP_IDENTITY_MISMATCH'});
  await assert.rejects(()=>observe({...exact,key:{...exact.key,runId:randomUUID()}}),{code:'TASK_STOP_IDENTITY_MISMATCH'});
  await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);await assert.rejects(()=>observe(exact));assert.equal(f.control.effects,3);assert.equal(f.control.reconciles,0);
 }finally{await f.close();}
});

for(const method of ['prepareTask','prepare'])for(const invalid of ['missing','extra','wrong','async'])test('terminal '+method+' preflight rejects '+invalid+' shared-deadline capability before SQL',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'terminal-preflight-'));try{
  const adapter={deviceId:'d',grantId:'g',fingerprint:sha('f'),executor:{stopAcceptedTask:async()=>{},reconcileAcceptedTaskStop:async()=>{}}};
  if(invalid!=='missing')Object.assign(adapter.executor,{acceptedStopCapabilities:()=>invalid==='extra'?{version:1,deadline:'shared-abort-v1',extra:true}:invalid==='wrong'?{version:1,deadline:'wrong'}:Promise.resolve({version:1,deadline:'shared-abort-v1'})});
  const executor=new LocalRunExecutor({id:'unused',dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'unused'} as any,{sandboxMaintenance:()=>adapter as any});
  t.mock.method(pool,'connect',async()=>{throw Error('UNEXPECTED_POOL_ACCESS');});
  await assert.rejects(()=>method==='prepare'?executor.prepare(new AbortController().signal):executor.prepareTask({agentId:'e',sessionId:'s',taskId:'t',attemptId:'a',generation:1},new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
 }finally{t.mock.restoreAll();rmSync(directory,{recursive:true,force:true});}
});

for(const mode of ['abort','deadline'])for(const stage of ['begin','set','query','commit','rollback'])test('terminal review SQL '+stage+' reply hold obeys shared '+mode+' and discards client',{skip:!isolated},async t=>{
 const f=await terminalReady();const cancellation=new AbortController();let pending:Promise<any>|undefined,stream:any,onReadable:(()=>void)|undefined;let armed=false,held=false,settled=false,db:any;const releases:any[]=[];
 const released=(error:any,client:any)=>{if(client===db)releases.push(error);};
 try{
  db=await pool.connect();stream=db.connection.stream;const original=db.query.bind(db);let written:string|undefined,nativeCalls=0;
  let arrived!:()=>void;const responseHeld=new Promise<void>(done=>{arrived=done;});
  t.mock.method(db,'query',(...args:any[])=>{
   nativeCalls++;const text=queryText(args);
   if(stage==='rollback'&&!armed&&text==='SELECT project_id FROM project_runs WHERE id=$1'){armed=true;return (original as any)({text:'SELECT 1/0',query_timeout:args[0]?.query_timeout});}
   const target=stage==='begin'?text==='BEGIN':stage==='set'?text?.includes("set_config('statement_timeout'"):stage==='query'?text==='SELECT project_id FROM project_runs WHERE id=$1':stage==='commit'?text==='COMMIT'&&written==='dispatching':text==='ROLLBACK';
   if(target&&!held){held=true;stream.pause();onReadable=()=>arrived();stream.once('readable',onReadable);}
   if(text?.startsWith('UPDATE task_attempt_workspaces SET accepted_stop='))written=JSON.parse(queryValues(args)[0]).state;
   return (original as any)(...args);
  });db.release();pool.on('release',released);
  if(mode==='deadline')t.mock.timers.enable({apis:['setTimeout']});
  const effects=f.control.effects;pending=Promise.resolve(finalize(f.executor,cancellation.signal));pending.then(()=>{settled=true;});await responseHeld;
  if(mode==='deadline')t.mock.timers.tick(120000);else cancellation.abort();
  await new Promise(done=>setImmediate(done));await new Promise(done=>setImmediate(done));
  assert.equal(settled,true,'SQL reply wait must settle on the shared signal before the reply is released');assert.equal((await pending).state,'pending');assert.equal(releases.filter(Boolean).length,1);assert.ok(releases.at(-1),'uncertain or aborted client must be discarded');
  const calls=nativeCalls;if(onReadable)stream.removeListener('readable',onReadable);stream.resume();await new Promise(done=>setImmediate(done));assert.equal(nativeCalls,calls,'late response cannot continue a transaction');assert.equal(f.control.effects,effects);
  t.mock.timers.reset();t.mock.restoreAll();const replacement=await pool.connect();try{assert.notEqual(replacement,db,'discarded connection is never reacquired');await replacement.query('SELECT 1');}finally{replacement.release();}
  if(stage==='commit')assert.ok(['prepared','dispatching'].includes((await lastMarker(f)).state));
 }finally{
  cancellation.abort();if(onReadable)stream?.removeListener('readable',onReadable);stream?.resume();t.mock.timers.reset();if(pending)await pending;t.mock.restoreAll();pool.removeListener('release',released);await f.close();
 }
});

for(const replaced of [false,true])test('terminal review stopped duplicate '+(replaced?'refuses replaced grant root':'observes original ID without fresh stop'),{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  await finalize(f.executor);const stored=await lastMarker(f),effects=f.control.effects;
  if(replaced){renameSync(f.bindingRoot,f.bindingRoot+'.retained');mkdirSync(f.bindingRoot);}
  const request={key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId},observe=observer(f);
  if(replaced)await assert.rejects(()=>observe(request),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});else await observe(request);
  assert.equal(f.control.reconciles,1,'SQL stopped does not waive the current trusted local binding check');assert.equal(f.control.effects,effects);assert.equal((await lastMarker(f)).state,'stopped');
 }finally{await f.close();}
});
