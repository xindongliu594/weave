import {before,beforeEach,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pool,migrate} from '../apps/api/src/db.ts';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {acceptedStopApiFixture} from './helpers/task-accepted-stop-api-fixture.ts';

const isolated=process.env.SIMULATED_INTEGRATION==='pglite';let root:string;
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(done=>release=done);return {promise,release};};
const pause=()=>new Promise(done=>setTimeout(done,70));
before(async()=>{if(!isolated)return;root=mkdtempSync(join(tmpdir(),'accepted-stop-writer-'));process.env.DATA_DIR=root;process.env.TRACE_ROOT=root;process.env.OBSIDIAN_VAULT=join(root,'vault');await migrate();});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,task_attempt_workspaces,project_runs,projects,departments,usage,model_reservations,tool_approvals CASCADE');});
after(async()=>{if(!isolated)return;assert.equal((await pool.query('SELECT count(*)::int n FROM model_reservations')).rows[0].n,0);await pool.end();console.log('ACCEPTED_STOP_WRITER_EXIT_CLEANUP='+JSON.stringify({root,pid:process.pid}));});
async function available(f:Awaited<ReturnType<typeof acceptedStopApiFixture>>){const fence=createArchiveWriteFence({traceRoot:root,lockRoot:f.service.writers.lockRoot});try{const guard=await fence.acquireSource(f.runId,{timeoutMs:80});guard.release();return true;}catch(error){assert.equal((error as any).code,'E_ARCHIVE_FENCE_TIMEOUT');return false;}}
test('known beforeDispatch rollback does not latch the original stop scope or dispatch a device effect',{skip:!isolated,timeout:30000},async()=>{
 const f=await acceptedStopApiFixture(root);try{
  await f.acceptA();const context=await f.bind('b'),effects=f.control.effects;
  f.control.beforeCallback=async()=>{await pool.query("UPDATE project_runs SET cancel_requested=true WHERE id=$1",[f.runId]);};
  await assert.rejects(f.executor.prepareTask(context,new AbortController().signal));
  assert.equal(f.control.effects,effects);assert.equal(await available(f),true);
 }finally{await f.close();}
});
for(const failed of [false,true])test('terminal '+(failed?'unknown stop':'stopped receipt')+' retains the real provider promise through executor close',{skip:!isolated,timeout:30000},async()=>{
 const f=await acceptedStopApiFixture(root),entered=gate(),finish=gate(),original=Object.freeze(Error('physical stop response unknown'));let work:Promise<any>|undefined,closing:Promise<any>|undefined;
 try{
  await f.acceptA();await f.acceptTask('b','B');await f.acceptTask('c','C');const calls=f.control.calls;
  f.control.afterEffect=async()=>{f.service.writers.assertWriter(f.runId);entered.release();await finish.promise;if(failed)throw original;};
  work=f.executor.finalizeAccepted(new AbortController().signal);await entered.promise;
  let closed=false;closing=f.executor.close().then(()=>{closed=true;},error=>{closed=true;return error;});await pause();const early=closed,guarded=!(await available(f));finish.release();
  const outcome=await work,closeError=await closing;assert.equal(early,false);assert.equal(guarded,true);assert.equal(outcome.state,failed?'pending':'stopped');assert.equal(closeError,failed?original:undefined);assert.equal(f.control.calls,calls+1);assert.equal(await available(f),!failed);
 }finally{finish.release();await work?.catch(()=>{});await closing?.catch(()=>{});await f.close();}
});
test('an invalid physical stop receipt remains pending and latches its executor close without replay',{skip:!isolated,timeout:30000},async()=>{
 const f=await acceptedStopApiFixture(root);try{
  await f.acceptA();await f.acceptTask('b','B');await f.acceptTask('c','C');
  const provider=f.maintenance().executor,stop=provider.stopAcceptedTask;provider.stopAcceptedTask=async(...args:Parameters<typeof stop>)=>({...await stop(...args),sandboxId:'different-sandbox'});
  const first=await f.executor.finalizeAccepted(new AbortController().signal),calls=f.control.calls,reconciles=f.control.reconciles;
  assert.equal(first.state,'pending');assert.equal(await available(f),false);
  assert.equal((await f.executor.finalizeAccepted(new AbortController().signal)).state,'pending');assert.equal(f.control.calls,calls);assert.equal(f.control.reconciles,reconciles);
  await assert.rejects(f.executor.close());
 }finally{await f.close();}
});
