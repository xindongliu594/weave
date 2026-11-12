import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {taskRecoveryRuntimeFixture} from './helpers/task-recovery-runtime-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-live-20261102');let root:string;
const signal=()=>new AbortController().signal;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'consumers-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,projects,project_runs,task_attempt_workspaces,local_operations,local_devices,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['usage','model_reservations','models'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});

test('child operation and checkpoint preserve selected seed without importing opaque files',{skip:!isolated},async()=>{
 const f=await taskRecoveryRuntimeFixture(root);try{
  const {context,scope}=await f.child.prepare('a');
  assert.equal(scope.key.runId,f.childRunId);assert.equal(context.sessionId,'child-session');assert.equal(context.attemptId,'child-attempt-a');
  assert.deepEqual(scope.workspace.importedFiles.map((file:any)=>file.path),['a.txt','in.txt']);
  assert.equal(Buffer.from(scope.workspace.importedFiles.find((file:any)=>file.path==='a.txt')!.content,'base64').toString(),'A checkpoint');
  assert.deepEqual(scope.recoverySeed,{version:1,initializationDigest:f.initialized.initialization.digest,sourceCheckpoint:{key:f.cp.key,id:f.cp.id,sha256:f.cp.sha256,seq:f.cp.seq},workRevision:f.initialized.initialization.checkpointWorkRevision});
  const before=await f.child.executor.prepareCheckpoint(context,signal(),{phase:'before-tool'});assert.deepEqual(before.recoverySeed,scope.recoverySeed);
  await f.child.write('a','A child');const operation=f.jobs.at(-1)!;
  const after=await f.child.executor.prepareCheckpoint(context,signal(),{phase:'after-tool',operationId:operation.id});
  assert.deepEqual(after.recoverySeed,scope.recoverySeed);assert.equal(after.lastMerge!.key.runId,f.childRunId);
  assert.equal(after.workManifest.find((file:any)=>file.path==='a.txt')!.sha256===f.cp.workManifest.find((file:any)=>file.path==='a.txt')!.sha256,false);
  const childOps=(await pool.query('SELECT payload FROM local_operations WHERE run_id=$1',[f.childRunId])).rows;
  assert.ok(childOps.length>=2);assert.ok(childOps.every(row=>!JSON.stringify(row.payload.executionScope).includes('private.txt')));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_attempt_workspaces WHERE run_id=$1 AND task_id='b'",[f.childRunId])).rows[0].n,0);
 }finally{await f.close();}
});

test('terminal retained seal completes without a child B workspace or copied stop marker',{skip:!isolated},async()=>{
 const f=await taskRecoveryRuntimeFixture(root);try{
  const parentB=structuredClone(f.child.snapshot.handoffCheckpoints.find((record:any)=>record.taskId==='b')),effects=f.control.effects;
  await f.child.acceptTask('a','A child');await f.child.acceptTask('c','C child');
  const result=await f.child.executor.finalizeAccepted(signal());assert.deepEqual(result,{version:1,state:'stopped'});
  assert.equal(f.control.effects-effects,2,'only the two materialized child sandboxes stop');
  const rows=(await pool.query('SELECT task_id,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id',[f.childRunId])).rows;
  assert.deepEqual(rows.map(row=>row.task_id),['a','c']);assert.ok(rows.every(row=>row.accepted_stop.state==='stopped'));
  assert.deepEqual(f.child.snapshot.handoffCheckpoints.find((record:any)=>record.taskId==='b'),parentB);
  assert.equal(readRun(root,f.childRunId)!.events.filter(event=>event.type==='handoff/accepted'&&event.data.taskId==='b').length,0);
  const childOps=(await pool.query('SELECT payload FROM local_operations WHERE run_id=$1',[f.childRunId])).rows;assert.ok(childOps.every(row=>row.payload.taskScope.key.taskId!=='b'));
 }finally{await f.close();}
});

test('checkpoint rejects a selected seed whose parent generation was changed in SQL',{skip:!isolated},async()=>{
 const f=await taskRecoveryRuntimeFixture(root);try{
  const {context}=await f.child.prepare('a');
  await pool.query("UPDATE task_attempt_workspaces SET scope=jsonb_set(scope,'{recoverySeed,sourceCheckpoint,key,generation}','99') WHERE run_id=$1 AND task_id='a'",[f.childRunId]);
  const before=f.jobs.length;await assert.rejects(()=>f.child.executor.prepareCheckpoint(context,signal(),{phase:'before-tool'}));assert.equal(f.jobs.length,before);
 }finally{await f.close();}
});

test('retained B cannot lose its native completed identity before the last child stop',{skip:!isolated},async()=>{
 const f=await taskRecoveryRuntimeFixture(root);try{
  await f.child.acceptTask('a','A child');await f.child.acceptTask('c','C child');
  f.child.state.tasks.find((task:any)=>task.id==='child-native-b').status='in_progress';f.child.archive.append('team/checkpoint',f.child.state);
  const effects=f.control.effects,result=await f.child.executor.finalizeAccepted(signal());
  assert.equal(result.state,'pending');assert.equal(f.control.effects,effects,'changed retained state cannot authorize a fresh child stop');
 }finally{await f.close();}
});
