import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {taskRecoverySourceFixture} from './helpers/task-recovery-source-fixture.ts';
import {decodeTaskRecoveryEvidence} from '../apps/api/src/task-recovery-state.ts';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';

const api=await import('../apps/api/src/task-recovery-initialization.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND'&&error.message.includes('task-recovery-initialization.ts'))return {} as any;throw error;});
const isolated=process.env.SIMULATED_INTEGRATION==='pglite',base=resolve('.private/recovery-live-20261101');let root:string;
before(async()=>{if(!isolated)return;mkdirSync(base,{recursive:true});root=mkdtempSync(join(base,'initializer-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE departments,projects,project_runs,task_attempt_workspaces,local_operations,local_devices,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['usage','model_reservations','models'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(root).startsWith(base+sep));rmSync(root,{recursive:true});});

test('private initializer takes locators and obtains the actual guarded source itself',()=>assert.equal(typeof api.initializeLiveTaskRecovery,'function'));

test('migration adds nullable evidence without minting certificates or resetting old runs',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  const fields=(await pool.query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name='project_runs' AND column_name='task_evidence'")).rows;
  assert.equal(fields.length,1);assert.equal(fields[0].is_nullable,'YES');assert.equal(fields[0].column_default,null);
  const row=(await pool.query('SELECT canonical_workspace,task_evidence,snapshot FROM project_runs WHERE id=$1',[f.runId])).rows[0];
  assert.equal(row.task_evidence,null);assert.ok(row.canonical_workspace.mergeId);
  await migrate();assert.deepEqual((await pool.query('SELECT canonical_workspace,task_evidence,snapshot FROM project_runs WHERE id=$1',[f.runId])).rows[0],row);
 }finally{await f.close();}
});

test('NULL-only publication copies full candidate once, preserves source and repairs only child cache',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  createRunArchive(root,f.childSnapshot,{id:f.childRunId});
  const before=(await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[f.runId])).rows[0].row,journal=readFileSync(join(root,f.runId,'events.jsonl'));
  const result=await api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);
  assert.equal(result.existing,false);assert.equal(result.initialization.childRunId,f.childRunId);
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[f.childRunId])).rows[0],marker=decodeTaskRecoveryEvidence(row.task_evidence).recoveryInitialization!;
  assert.equal(marker.digest,result.initialization.digest);assert.deepEqual(row.canonical_workspace,marker.initialHead);assert.equal(marker.initialHead.mergeId,null);assert.equal(marker.initialHead.receipt,null);
  assert.deepEqual(marker.delta.map(item=>item.path),['a.txt']);
  const canonical=readCommittedCanonical(root,row);assert.equal(Buffer.from(canonical.files.find(file=>file.path==='a.txt')!.content,'base64').toString(),'A checkpoint');assert.equal(Buffer.from(canonical.files.find(file=>file.path==='b.txt')!.content,'base64').toString(),'B accepted later');
  const repeated=await api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);assert.equal(repeated.existing,true);assert.equal(repeated.initialization.digest,marker.digest);
  assert.equal(readRun(root,f.childRunId)!.events.filter(event=>event.type==='task/recovery-initialized').length,1);
  assert.deepEqual(readFileSync(join(root,f.runId,'events.jsonl')),journal);assert.deepEqual((await pool.query('SELECT row_to_json(r) AS row FROM project_runs r WHERE id=$1',[f.runId])).rows[0].row,before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations WHERE run_id=$1',[f.childRunId])).rows[0].n,0);
 }finally{await f.close();}
});

for(const damage of ['head-only','marker-only'])test('initializer refuses partial or unrelated existing state: '+damage,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  createRunArchive(root,f.childSnapshot,{id:f.childRunId});
  if(damage==='head-only')await pool.query('UPDATE project_runs SET canonical_workspace=(SELECT canonical_workspace FROM project_runs WHERE id=$1) WHERE id=$2',[f.runId,f.childRunId]);
  else await pool.query("UPDATE project_runs SET task_evidence='{}' WHERE id=$1",[f.childRunId]);
  await assert.rejects(()=>api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal));
 }finally{await f.close();}
});

for(const point of ['blob-fsync','before-sql-commit'])test('pre-publication failure leaves both SQL fields NULL: '+point,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  createRunArchive(root,f.childSnapshot,{id:f.childRunId});
  await assert.rejects(()=>api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal,(stage:string)=>{if(stage===point)throw Error('INJECTED_'+point);}),new RegExp('INJECTED_'+point));
  assert.deepEqual((await pool.query('SELECT canonical_workspace,task_evidence FROM project_runs WHERE id=$1',[f.childRunId])).rows[0],{canonical_workspace:null,task_evidence:null});
 }finally{await f.close();}
});

for(const point of ['after-sql-commit','archive-append','cache-mirror'])test('post-publication failure repairs reporting without reinitializing: '+point,{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);try{
  createRunArchive(root,f.childSnapshot,{id:f.childRunId});
  await assert.rejects(()=>api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal,(stage:string)=>{if(stage===point)throw Error('INJECTED_'+point);}),new RegExp('INJECTED_'+point));
  const published=(await pool.query('SELECT canonical_workspace,task_evidence FROM project_runs WHERE id=$1',[f.childRunId])).rows[0];
  assert.ok(published.canonical_workspace);assert.ok(published.task_evidence);
  const result=await api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);assert.equal(result.existing,true);
  assert.deepEqual((await pool.query('SELECT canonical_workspace,task_evidence FROM project_runs WHERE id=$1',[f.childRunId])).rows[0],published);
  assert.equal(readRun(root,f.childRunId)!.events.filter(event=>event.type==='task/recovery-initialized').length,1);
 }finally{await f.close();}
});

test('lost COMMIT response is observed through a new connection and never repeats initialization UPDATE',{skip:!isolated},async()=>{
 const f=await taskRecoverySourceFixture(root);let updateCalls=0,injected=false,connections=0;
 const originalConnect=pool.connect;
 try{
  createRunArchive(root,f.childSnapshot,{id:f.childRunId});
  (pool as any).connect=async function(){
   connections++;const client:any=await (originalConnect as any).call(pool),query=client.query,release=client.release;let written=false;
   (client as any).query=async function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(sql?.startsWith('UPDATE project_runs SET canonical_workspace=$1,task_evidence=$2')){updateCalls++;written=true;}
    const result=await (query as any).apply(client,args);
    if(sql==='COMMIT'&&written&&!injected){injected=true;throw Error('LOST_COMMIT_RESPONSE');}
    return result;
   };
   client.release=function(error?:any){client.query=query;client.release=release;return release.call(client,error);};return client;
  };
  const result=await api.initializeLiveTaskRecovery(f.writers,f.input,new AbortController().signal);
  assert.equal(injected,true);assert.equal(updateCalls,1);assert.ok(connections>=3);assert.equal(result.existing,true);
  assert.equal(readRun(root,f.childRunId)!.events.filter(event=>event.type==='task/recovery-initialized').length,1);
 }finally{pool.connect=originalConnect;await f.close();}
});
