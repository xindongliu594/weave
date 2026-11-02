import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {assertOriginalTaskCommit} from '../apps/api/src/task-original-commit.ts';
import {pool} from '../apps/api/src/db.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {isolated,integrationRoot,createTaskWorkspace,sha,digest,queryText,queryValues,originalCommit,ready,marker,checkpointContractFor} from './helpers/task-accepted-stop-delivery-support.ts';

test('task preparation fails closed before SQL when trusted stop maintenance is missing',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'accepted-stop-provider-'));
 try{
  const executor=new LocalRunExecutor({id:'unused',dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'unused'} as any);
  await assert.rejects(async()=>executor.prepareTask({agentId:'employee',sessionId:'session',taskId:'task',attemptId:'attempt',generation:1},new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
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
  // An uncertain COMMIT poisons this original writer. A warm retry must stay
  // behind that fence, rather than pretending it is an independent restart.
  await assert.rejects(()=>f.bind('b'),/LOST_COMMIT_ACK/);assert.equal(f.control.effects,0);assert.equal(f.control.calls,state==='prepared'?0:1);assert.equal(f.control.reconciles,0);
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
