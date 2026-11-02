import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {taskRecoverySourceFixture} from './helpers/task-recovery-source-fixture.ts';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-live-20261101');let root:string;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'source-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,projects,project_runs,task_attempt_workspaces,local_operations,local_devices,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['usage','model_reservations','models'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});

const implementation=await import('../apps/api/src/task-recovery-source.ts').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {} as any;
 throw error;
});

for(const trigger of ['tool-result','before-tool','cycle-complete'])test('actual SQL source capture rolls A back and retains accepted B: '+trigger,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root,trigger);try{
  const sourceBefore=(await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[f.runId])).rows[0].row;
  const journalBefore=readFileSync(join(root,f.runId,'events.jsonl'));
  const result=await implementation.captureLiveTaskRecoverySource(f.writers,f.input,new AbortController().signal);
  assert.equal(result.source.sourceCheckpoint.id,f.cp.id);assert.equal(result.scope.retained.length,1);
  const files=result.scope.candidate.files;
  assert.equal(Buffer.from(files.find((file:any)=>file.path==='a.txt').content,'base64').toString(),'A checkpoint');
  assert.equal(Buffer.from(files.find((file:any)=>file.path==='b.txt').content,'base64').toString(),'B accepted later');
  assert.equal(Buffer.from(files.find((file:any)=>file.path==='private.txt').content,'base64').toString(),'private');
  assert.deepEqual((await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[f.runId])).rows[0].row,sourceBefore);
  assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),journalBefore);
  assert.equal((await pool.query('SELECT canonical_workspace FROM project_runs WHERE id=$1',[f.childRunId])).rows[0].canonical_workspace,null);
 }finally{await f.close();}
});

for(const damage of ['late-result','wrong-claim','source-lease','child-contract','revoke-device','unknown-stop','wrong-checkpoint-sha','child-source','child-completed','child-handoff'])test('SQL source capture refuses '+damage,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  if(damage==='late-result')await pool.query("UPDATE local_operations SET late_result='{}' WHERE id=$1",[f.jobs[0].id]);
  if(damage==='wrong-claim')await pool.query('UPDATE local_operations SET claim_token=$1 WHERE id=$2',['wrong',f.jobs[0].id]);
  if(damage==='source-lease')await pool.query('UPDATE project_runs SET lease_owner=$1 WHERE id=$2',['late-owner',f.runId]);
  if(damage==='child-contract')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{resourceRevision}','2') WHERE id=$1",[f.childRunId]);
  if(damage==='revoke-device')await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);
  if(damage==='unknown-stop')await pool.query("UPDATE task_attempt_workspaces SET accepted_stop='{}' WHERE run_id=$1 AND task_id='b'",[f.runId]);
  if(damage==='wrong-checkpoint-sha')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{recovery,workspaceCheckpoint,sha256}',$1::jsonb) WHERE id=$2",[JSON.stringify('0'.repeat(64)),f.childRunId]);
  if(damage==='child-source')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{recovery,sourceRunId}',$1::jsonb) WHERE id=$2",[JSON.stringify(randomUUID()),f.childRunId]);
  if(damage==='child-completed')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{completedCheckpoints}','[\"a\"]') WHERE id=$1",[f.childRunId]);
  if(damage==='child-handoff')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{handoffCheckpoints}','[]') WHERE id=$1",[f.childRunId]);
  await assert.rejects(()=>implementation.captureLiveTaskRecoverySource(f.writers,f.input,new AbortController().signal));
  assert.equal((await pool.query('SELECT canonical_workspace FROM project_runs WHERE id=$1',[f.childRunId])).rows[0].canonical_workspace,null);
 }finally{await f.close();}
});

test('live source capture is a concrete private entry, not caller supplied verified facts',()=>{
 assert.equal(typeof implementation.captureLiveTaskRecoverySource,'function');
});

test('fake source callback authority cannot reach SQL or return a source certificate',async()=>{
 assert.equal(typeof implementation.captureLiveTaskRecoverySource,'function');
 const fake={traceRoot:'unused',withSource:async(_id:string,fn:()=>any)=>fn(),assertSource:()=>{}};
 await assert.rejects(()=>implementation.captureLiveTaskRecoverySource(fake,{sourceRunId:randomUUID(),childRunId:randomUUID(),checkpointId:randomUUID()},new AbortController().signal),{code:'E_ARCHIVE_WRITER_CONFIG'});
});
