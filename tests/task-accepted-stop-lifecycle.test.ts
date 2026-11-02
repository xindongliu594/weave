import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {pool} from '../apps/api/src/db.ts';
import {isolated,sha,terminalReady,finalize} from './helpers/task-accepted-stop-delivery-support.ts';

test('terminal pool acquisition abort releases late client before BEGIN or fn',{skip:!isolated},async t=>{
 const f=await terminalReady();let db:any,deliver:((db:any)=>void)|undefined,pending:Promise<any>|undefined;const cancellation=new AbortController();try{
  assert.equal(typeof (f.executor as any).finalizeAccepted,'function','terminal source-only entry must exist');
  db=await pool.connect();const query=db.query.bind(db);let queries=0,releases=0,entered!:()=>void;
  const acquired=new Promise<void>(done=>{entered=done;});
  t.mock.method(db,'query',async(...args:any[])=>{queries++;return (query as any)(...args);});const release=t.mock.method(db,'release',()=>{releases++;});
  const held=new Promise<any>(done=>{deliver=done;});t.mock.method(pool,'connect',()=>{entered();return held;});
  let settled=false;pending=finalize(f.executor,cancellation.signal);pending!.then(()=>{settled=true;});await acquired;cancellation.abort();await new Promise(done=>setImmediate(done));
  assert.equal(settled,false,'cancellation must still drain the original pool producer');assert.equal(queries,0);assert.equal(releases,0);
  deliver!(db);assert.equal((await pending).state,'pending');assert.equal(queries,0);assert.equal(releases,1);
 }finally{cancellation.abort();if(db)deliver?.(db);await pending?.catch(()=>{});t.mock.restoreAll();db?.release();await f.close();}
});

test('terminal shared deadline abort waits for the original pool acquisition before physical drain',{skip:!isolated},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'terminal-timeout-'));let finish:()=>void=()=>{},pending:Promise<any>|undefined;try{
  const caps={acceptedStopCapabilities:()=>({version:1,deadline:'shared-abort-v1'}),stopAcceptedTask:async()=>{},reconcileAcceptedTaskStop:async()=>{}};
  const writers=createArchiveWriterManager({traceRoot:directory}),fence=createArchiveWriteFence({traceRoot:directory,lockRoot:writers.lockRoot}),runId=randomUUID();
  const executor=new LocalRunExecutor({id:runId,dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'owner',writers} as any,{sandboxMaintenance:()=>({deviceId:'d',grantId:'g',fingerprint:sha('f'),executor:caps as any})});
  assert.equal(typeof (executor as any).finalizeAccepted,'function','terminal source-only entry must exist');
  let entered!:()=>void;const acquired=new Promise<void>(done=>{entered=done;}),original=new Promise<void>(done=>{finish=done;}),connect=pool.connect.bind(pool);let queries=0,releases=0;
  t.mock.method(pool,'connect',async()=>{entered();await original;const db=await connect(),query=db.query.bind(db),release=db.release.bind(db);db.query=((...args:any[])=>{queries++;return (query as any)(...args);}) as any;db.release=((value?:any)=>{db.query=query as any;db.release=release;releases++;release(value);}) as any;return db;});
  t.mock.timers.enable({apis:['setTimeout','Date']});let settled=false;pending=finalize(executor);pending!.then(()=>{settled=true;});await acquired;t.mock.timers.tick(120000);await new Promise(done=>setImmediate(done));
  assert.equal(settled,false,'business cancellation cannot replace the original pool producer');t.mock.timers.reset();
  await assert.rejects(fence.acquireSource(runId,{timeoutMs:80}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  finish();assert.equal((await pending).state,'pending');assert.equal(queries,0);assert.equal(releases,1);
  const source=await fence.acquireSource(runId,{timeoutMs:80});source.release();
 }finally{finish();t.mock.timers.reset();await pending?.catch(()=>{});t.mock.restoreAll();rmSync(directory,{recursive:true,force:true});}
});

for(const method of ['prepareTask','prepare'])for(const invalid of ['missing','extra','wrong','async'])test('terminal '+method+' preflight rejects '+invalid+' shared-deadline capability before SQL',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'terminal-preflight-'));try{
  const adapter={deviceId:'d',grantId:'g',fingerprint:sha('f'),executor:{stopAcceptedTask:async()=>{},reconcileAcceptedTaskStop:async()=>{}}};
  if(invalid!=='missing')Object.assign(adapter.executor,{acceptedStopCapabilities:()=>invalid==='extra'?{version:1,deadline:'shared-abort-v1',extra:true}:invalid==='wrong'?{version:1,deadline:'wrong'}:Promise.resolve({version:1,deadline:'shared-abort-v1'})});
  const executor=new LocalRunExecutor({id:'unused',dir:directory},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:directory,owner:'unused'} as any,{sandboxMaintenance:()=>adapter as any});
  const connect=t.mock.method(pool,'connect',async()=>{throw Error('UNEXPECTED_POOL_ACCESS');});
  await assert.rejects(async()=>method==='prepare'?executor.prepare(new AbortController().signal):executor.prepareTask({agentId:'e',sessionId:'s',taskId:'t',attemptId:'a',generation:1},new AbortController().signal),{code:'TASK_STOP_UNAVAILABLE'});
  assert.equal(connect.mock.callCount(),0,'invalid stop capabilities must be rejected before acquiring a database connection');
 }finally{t.mock.restoreAll();rmSync(directory,{recursive:true,force:true});}
});
