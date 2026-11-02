import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pool,migrate} from '../apps/api/src/db.ts';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';
import {readRun} from '../services/agent-runtime/trace-store.mjs';
import {commitStepCheckpoint,checkpointContract,checkpointEnvironment} from '../services/agent-runtime/step-checkpoints.mjs';

// A missing implementation produces an assertion failure before any SQL work.
const api=await import('../apps/api/src/task-recovery-provenance.ts').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('task-recovery-provenance.ts'))return null;
 throw error;
});
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const scratch=join(process.cwd(),'.superpowers','sdd','2026-10-21-task-recovery-source');
const signal=()=>new AbortController().signal;
let directory:string;
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);
 mkdirSync(scratch,{recursive:true});directory=mkdtempSync(join(scratch,'provenance-'));
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');
 await migrate();
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(directory).startsWith(resolve(scratch)+sep));rmSync(directory,{recursive:true,force:true});});

test('private provenance API exists without granting capture or initialization authority',()=>{
 assert.equal(typeof api?.verifyRecoveryCommitChain,'function');
 assert.equal(typeof api?.verifyRecoveryCheckpoint,'function');
 assert.equal(typeof api?.verifyRecoveryAcceptedCheckpoint,'function');
});

async function facts(f:Awaited<ReturnType<typeof acceptedStopApiFixture>>){
 const run=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.runId])).rows[0];
 const scopes=(await pool.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1',[f.runId])).rows;
 const operations=(await pool.query('SELECT * FROM local_operations WHERE run_id=$1',[f.runId])).rows;
 return {run,scopes,operations,events:readRun(directory,f.runId)!.events};
}
async function checkpoint(f:Awaited<ReturnType<typeof acceptedStopApiFixture>>,context:any,trigger='tool-result'){
 const operationId=f.jobs.findLast(job=>job.executionScope.key.taskId===context.taskId).id;
 const refs=await f.executor.prepareCheckpoint(context,signal(),trigger==='tool-result'?{phase:'after-tool',operationId}:{phase:trigger==='before-tool'?'before-tool':'boundary'});
 const row=(await pool.query('SELECT result FROM local_operations WHERE id=$1',[refs.lastMerge!.operationId])).rows[0];
 const boundary:any=f.archive.append('step/boundary',{taskId:context.taskId,attemptId:context.attemptId,trigger},{taskId:context.taskId,attemptId:context.attemptId,sessionId:context.sessionId});
 return commitStepCheckpoint({archive:f.archive,taskRefs:refs,boundary:{taskId:context.taskId,attemptId:context.attemptId,sessionId:context.sessionId,trigger,eventCursor:boundary.seq,contractHash:checkpointContract(f.snapshot,f.snapshot.tasks.find((task:any)=>task.id===context.taskId),refs),environment:checkpointEnvironment(f.snapshot,row.result.result.execution,refs)}});
}

test('real claimed A old checkpoint remains bound after A changes and independent B is accepted',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  const context=await f.write('a','A old');await f.write('b','B draft');const cp=await checkpoint(f,context);
  await f.write('a','A current');await f.acceptTask('b','B retained');
  const original=await facts(f),before=structuredClone(original);
  const chain=api!.verifyRecoveryCommitChain(directory,original.run,original.scopes,original.operations,f.backend);
  assert.equal(chain.commits.length,original.operations.length);
  assert.equal(chain.commits[0].row.payload.name,'prepare');
  assert.equal(chain.initial.ref.mergeId,null);
  assert.deepEqual(chain.initial.ref.manifest.map((file:any)=>file.path),['in.txt','private.txt']);
  assert.equal(chain.head.ref.mergeId,f.jobs.at(-1).id);
  assert.equal(chain.commits[0].record.before.revision,chain.commits[0].record.after.revision,'prepare is a real no-content-change commit');
  const proof=api!.verifyRecoveryCheckpoint(directory,original.run,original.events,cp.id,chain);
  assert.equal(proof.original.row.id,cp.lastMerge.operationId);
  assert.notEqual(cp.canonical.mergeId,cp.lastMerge.operationId,'historical complete canonical may belong to independent B');
  assert.equal(proof.original.result.files.find((file:any)=>file.path==='a.txt').content,Buffer.from('A old').toString('base64'));
  assert.equal(proof.ownCommits.at(-1)?.row.id,cp.lastMerge.operationId);
  assert.ok(chain.commits.filter((commit:any)=>commit.task.task_id==='a').length>proof.ownCommits.length);
  const acceptedCP=original.events.findLast((event:any)=>event.type==='step/checkpoint'&&event.data.boundary.trigger==='node-accepted')!;
  const retained=api!.verifyRecoveryAcceptedCheckpoint(directory,original.run,original.events,acceptedCP.data.id,chain);
  assert.equal(retained.task.task_id,'b');
  assert.throws(()=>api!.verifyRecoveryCheckpoint(directory,original.run,original.events,acceptedCP.data.id,chain));
  assert.deepEqual(original,before,'fact validation never repairs the source');
 }finally{await f.close();}
});

for(const trigger of ['before-tool','cycle-complete'])test(`${trigger} checkpoint exposes its historical canonical for scope reconstruction`,{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  const context=await f.write('a','A'),cp=await checkpoint(f,context,trigger);
  await f.write('b','B');const original=await facts(f);
  const chain=api!.verifyRecoveryCommitChain(directory,original.run,original.scopes,original.operations,f.backend);
  const proof=api!.verifyRecoveryCheckpoint(directory,original.run,original.events,cp.id,chain);
  assert.equal(proof.checkpoint.boundary.trigger,trigger);
  assert.equal(proof.canonical.ref.mergeId,cp.canonical.mergeId);
  assert.equal(proof.original.row.id,cp.lastMerge.operationId);
 }finally{await f.close();}
});

test('all committed original claims and exact SQL head are required, including superseded A commits',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  await f.write('a','old');await f.write('a','new');await f.write('b','B');
  const original=await facts(f),verify=(value:any)=>api!.verifyRecoveryCommitChain(directory,value.run,value.scopes,value.operations,f.backend);
  for(const damage of ['claim','missing','own-output','own-order','head-receipt','initial-import','null-head']){
   const value=structuredClone(original),old=value.operations.find((row:any)=>row.payload.name==='artifact_write'&&row.payload.taskScope.key.taskId==='a');
   if(damage==='claim')old.result.claimToken='wrong';
   if(damage==='missing')value.operations=value.operations.filter((row:any)=>row.id!==old.id);
   if(damage==='own-output')value.scopes.find((row:any)=>row.task_id==='a').committed_outputs.shift();
   if(damage==='own-order')value.scopes.find((row:any)=>row.task_id==='a').committed_outputs.reverse();
   if(damage==='head-receipt')value.run.canonical_workspace.receipt.scopeHash='0'.repeat(64);
   if(damage==='initial-import')value.run.snapshot.importedFiles[0].content='tampered';
   if(damage==='null-head'){value.run.canonical_workspace={version:1,...value.operations[0].merge_record.before,receipt:null};value.operations=[];value.scopes=[];}
   assert.throws(()=>verify(value),damage);
  }
 }finally{await f.close();}
});

const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,ordered(value[key])])):value;
const digest=(value:any)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
test('self-consistent merge records cannot skip their exact predecessor or leave an orphan commit',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  await f.write('a','A');await f.write('b','B');const original=await facts(f);
  const value=structuredClone(original),last=value.operations.find((row:any)=>row.id===value.run.canonical_workspace.mergeId);
  last.merge_record.before.mergeId=randomUUID();
  last.merge_record.digest=digest({...last.merge_record,digest:undefined});
  assert.throws(()=>api!.verifyRecoveryCommitChain(directory,value.run,value.scopes,value.operations,f.backend));
  const previous=original.operations.find((row:any)=>row.id===last.merge_record.after.mergeId)!;
  const stale=structuredClone(original);stale.run.canonical_workspace={version:1,...previous.merge_record.before,receipt:original.operations.find((row:any)=>row.id===previous.merge_record.before.mergeId)?.merge_record.receipt??null};
  assert.throws(()=>api!.verifyRecoveryCommitChain(directory,stale.run,stale.scopes,stale.operations,f.backend));
 }finally{await f.close();}
});

test('checkpoint exact outer session, boundary cursor/trigger and current generation cannot be substituted',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  const context=await f.write('a','A'),cp=await checkpoint(f,context),original=await facts(f);
  for(const damage of ['session','boundary-session','trigger','task-link','new-generation','completed','mapping']){
   const value=structuredClone(original);
   const event=value.events.find((event:any)=>event.type==='step/checkpoint'&&event.data.id===cp.id)!;
   const boundary=value.events.find((event:any)=>event.seq===cp.boundary.eventCursor)!;
   if(damage==='session')event.sessionId='different';
   if(damage==='boundary-session')boundary.sessionId='different';
   if(damage==='trigger')boundary.data.trigger='before-tool';
   if(damage==='task-link')event.taskId='b';
   if(damage==='new-generation')value.scopes.push({...value.scopes[0],generation:2,phase:'active',committed_outputs:[]});
   if(damage==='completed')value.events.findLast((event:any)=>event.type==='team/checkpoint')!.data.tasks.find((task:any)=>task.id==='native-a').status='completed';
   if(damage==='mapping')value.events.push({seq:value.events.length+1,type:'run/task-mapping',data:{tasks:[{task_id:'replacement',seed_id:'a'}]}} as any);
   const chain=api!.verifyRecoveryCommitChain(directory,value.run,value.scopes,value.operations,f.backend);
   assert.throws(()=>api!.verifyRecoveryCheckpoint(directory,value.run,value.events,cp.id,chain),damage);
  }
 }finally{await f.close();}
});

test('selected checkpoint requires the exact original queued identity before its boundary',{skip:!isolated},async()=>{
 const f=await acceptedStopApiFixture(directory,{resourceRevision:1});try{
  const context=await f.write('a','A'),cp=await checkpoint(f,context),original=await facts(f);
  const chain=api!.verifyRecoveryCommitChain(directory,original.run,original.scopes,original.operations,f.backend);
  const id=cp.lastMerge.operationId;
  for(const damage of ['missing-queue','queued-after','queue-context','merge-after','merge-receipt']){
   const events=structuredClone(original.events),queued=events.find(event=>event.type==='local/operation-queued'&&event.data.operationId===id)!;
   const merged=events.find(event=>event.type==='task/merge-committed'&&event.data.operationId===id)!;
   if(damage==='queued-after')events.push({...structuredClone(queued),seq:events.length+1});
   if(['missing-queue','queued-after'].includes(damage))queued.data.operationId=randomUUID();
   if(damage==='queue-context')queued.data.generation++;
   if(damage==='merge-after')events.push({...structuredClone(merged),seq:events.length+1});
   if(['merge-after','merge-receipt'].includes(damage))merged.data.scopeHash='0'.repeat(64);
   assert.throws(()=>api!.verifyRecoveryCheckpoint(directory,original.run,events,cp.id,chain),damage);
  }
  const absent=structuredClone(original.events);
  absent.find(event=>event.type==='task/merge-committed'&&event.data.operationId===id)!.type='historical/omitted-publication';
  assert.equal(api!.verifyRecoveryCheckpoint(directory,original.run,absent,cp.id,chain).original.row.id,id,'a lost merge publication does not erase the SQL commit');
  const replay=structuredClone(original.events),merged=replay.find(event=>event.type==='task/merge-committed'&&event.data.operationId===id)!;
  replay.push({...structuredClone(merged),seq:replay.length+1});
  assert.equal(api!.verifyRecoveryCheckpoint(directory,original.run,replay,cp.id,chain).original.row.id,id,'a later replay does not invalidate the original receipt');
 }finally{await f.close();}
});
