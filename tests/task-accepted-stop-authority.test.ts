import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pool} from '../apps/api/src/db.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {isolated,integrationRoot,queryText,queryValues,terminalReady,finalize,observer,lastMarker} from './helpers/task-accepted-stop-delivery-support.ts';

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
  const observe=observer(f),request={key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId};let first:unknown;
  await assert.rejects(()=>observe(request),(error:any)=>{first=error;return error.code==='LOCAL_OUTCOME_UNKNOWN';});
  await assert.rejects(()=>observe(request),error=>error===first);
  assert.equal(f.control.reconciles,1);assert.equal(f.control.effects,before);assert.deepEqual(await lastMarker(f),stored);
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

test('terminal exact observer rejects extra identity fields and class-run mismatch',{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  await finalize(f.executor);const stored=await lastMarker(f),exact={key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId},observe=observer(f);
  await assert.rejects(()=>observe({...exact,proof:stored.proof}),{code:'TASK_STOP_IDENTITY_MISMATCH'});
  await assert.rejects(()=>observe({...exact,key:{...exact.key,runId:randomUUID()}}),{code:'TASK_STOP_IDENTITY_MISMATCH'});
  await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);await assert.rejects(()=>observe(exact));assert.equal(f.control.effects,3);assert.equal(f.control.reconciles,0);
 }finally{await f.close();}
});

for(const replaced of [false,true])test('terminal review stopped duplicate '+(replaced?'refuses replaced grant root':'observes original ID without fresh stop'),{skip:!isolated},async()=>{
 const f=await terminalReady();try{
  await finalize(f.executor);const stored=await lastMarker(f),effects=f.control.effects;
  if(replaced){renameSync(f.bindingRoot,f.bindingRoot+'.retained');mkdirSync(f.bindingRoot);}
  const request={key:stored.identity.key,sandboxId:stored.identity.sandboxId,workspaceRevision:stored.identity.workspaceRevision,stopId:stored.identity.stopId},observe=observer(f);
  if(replaced){let first:unknown;await assert.rejects(()=>observe(request),(error:any)=>{first=error;return error.message==='LOCAL_BINDING_CHANGED';});await assert.rejects(()=>observe(request),error=>error===first);}else await observe(request);
  assert.equal(f.control.reconciles,1,'SQL stopped does not waive the current trusted local binding check');assert.equal(f.control.effects,effects);assert.equal((await lastMarker(f)).state,'stopped');
 }finally{await f.close();}
});
