import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {assertOriginalTaskCommit} from '../apps/api/src/task-original-commit.ts';
import {pool} from '../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {isolated,integrationRoot,createTaskWorkspace,sha,digest,queryText,queryValues,originalCommit,ready,marker,checkpointContractFor} from './helpers/task-accepted-stop-delivery-support.ts';

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
