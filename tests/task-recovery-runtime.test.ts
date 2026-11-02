import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {taskRecoverySourceFixture,completeTaskRecoverySnapshot} from './helpers/task-recovery-source-fixture.ts';
import {initializeLiveTaskRecovery} from '../apps/api/src/task-recovery-initialization.ts';

const api=await import('../apps/api/src/task-recovery-runtime.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('task-recovery-runtime.ts'))return {} as any;throw error;});
const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-live-20261102');let root:string;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'runtime-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,projects,project_runs,task_attempt_workspaces,local_operations,local_devices,usage,model_reservations,tool_approvals CASCADE');});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});
test('runtime recovery authenticates SQL state instead of accepting caller proof',()=>assert.equal(typeof api.assertTaskRecoveryRuntime,'function'));
test('initialized NULL root exposes only selected output seed and keeps opaque files private',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  await completeTaskRecoverySnapshot(f,root);
  await initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.childRunId])).rows[0];
  const state=await api.assertTaskRecoveryRuntime(pool,root,row);
  assert.equal(state.initialization.childRunId,f.childRunId);assert.deepEqual(state.seedOutputs.map((v:any)=>v.path),['a.txt']);
  assert.equal(state.selectedSeed.sourceCheckpoint.key.runId,f.runId);assert.equal(state.selectedSeed.sourceCheckpoint.key.generation,f.cp.key.generation);
  assert.equal(state.currentCanonical.ref.mergeId,null);assert.ok(state.currentCanonical.files.some((v:any)=>v.path==='private.txt'));
  assert.equal(state.seedOutputs[0].origin.checkpointId,f.cp.id);assert.equal(state.seedOutputs[0].origin.acceptedRevision,state.selectedSeed.workRevision);
 }finally{await f.close();}
});
for(const damage of ['caller-marker','sql-snapshot','sql-root'])test('runtime rejects changed '+damage,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  await completeTaskRecoverySnapshot(f,root);
  await initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.childRunId])).rows[0];
  if(damage==='caller-marker')row.task_evidence=null;
  if(damage==='sql-snapshot'){row.snapshot.recovery.sourceRunId=f.childRunId;await pool.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[row.snapshot,row.id]);}
  if(damage==='sql-root'){await pool.query('UPDATE project_runs SET canonical_workspace=(SELECT canonical_workspace FROM project_runs WHERE id=$1) WHERE id=$2',[f.runId,f.childRunId]);row.canonical_workspace=(await pool.query('SELECT canonical_workspace FROM project_runs WHERE id=$1',[row.id])).rows[0].canonical_workspace;}
  await assert.rejects(()=>api.assertTaskRecoveryRuntime(pool,root,row));
 }finally{await f.close();}
});
test('locator-only private initialization cannot authorize running a team',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  await initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.childRunId])).rows[0];
  await assert.rejects(()=>api.assertTaskRecoveryRuntime(pool,root,row));
 }finally{await f.close();}
});
