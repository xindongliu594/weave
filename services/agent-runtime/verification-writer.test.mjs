import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createArchiveWriterManager} from './archive-writer-scope.mjs';
import {createArchiveWriteFence} from './archive-write-fence.mjs';
import {EmployeeHostFactory} from './employee-hosts.mjs';
import {runTraceVerification,verificationSnapshot} from './verification.mjs';
import {readRun} from './trace-store.mjs';

// Keep real pinned DSH setup, native sessions, trace append and original close.
// Only the cleanup boundary is delayed/failed. The fixture never uses an API.
const gate=()=>{let release;const promise=new Promise(done=>release=done);return {promise,release};};
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function reached(promise){let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('verification did not reach original close')),10000);})]);}finally{clearTimeout(timer);}}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'verification-writer-')),traceRoot=join(root,'runs');
 const writers=createArchiveWriterManager({traceRoot}),fence=createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot});
 let external=0;t.mock.method(globalThis,'fetch',async()=>{external++;throw Error('external request forbidden');});
 t.after(()=>{assert.equal(external,0);console.log('VERIFICATION_WRITER_EXIT_CLEANUP='+JSON.stringify({root,pid:process.pid}));});
 return {root,traceRoot,writers,fence};
}
async function probe(f,runId){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../tests/fixtures/archive-admission-probe.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,runId})}});
 const exited=once(child,'exit');let timer;
 try{return await Promise.race([once(child,'message').then(([value])=>value),exited.then(()=>{throw Error('probe exited early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('probe timeout')),10000);})]);}
 finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}
}

test('verification waits for root admission before allocating archive or DSH sessions',{timeout:20000},async t=>{
 const f=await fixture(t),source=await f.fence.acquireRootExclusive();let pending,settled=false,released=false;
 try{
  pending=runTraceVerification(f.traceRoot,{writers:f.writers});pending.then(()=>settled=true,()=>settled=true);
  await pause(120);assert.deepEqual(await readdir(f.traceRoot),[]);assert.equal(settled,false);
  source.release();released=true;const run=await pending;assert.equal(run.status,'completed');
  assert.deepEqual(await readdir(f.traceRoot),[run.id]);assert.deepEqual(await probe(f,run.id),{acquired:true});
 }finally{if(!released)source.release();await pending;}
});

for(const failure of [false,true])test('verification retains original delayed close'+(failure?' failure':''),{timeout:20000},async t=>{
 const f=await fixture(t),entered=gate(),release=gate(),original=EmployeeHostFactory.prototype.close;let id,calls=0,pending,observed,settled=false;
 t.mock.method(EmployeeHostFactory.prototype,'close',async function(){calls++;id=this.archive.id;entered.release();await release.promise;await original.call(this);if(failure)throw Error('original teardown failure');});
 try{
  pending=runTraceVerification(f.traceRoot,{writers:f.writers}).catch(error=>error);pending.then(()=>settled=true);
  await reached(entered.promise);observed=await probe(f,id);assert.equal(settled,false);release.release();const result=await pending;
  if(failure){assert.equal(result.code,'RUNTIME_WRITER_DRAIN_FAILED');assert.deepEqual(await probe(f,id),{blocked:true});}
  else{assert.equal(result.status,'completed');assert.deepEqual(await probe(f,id),{acquired:true});}
 }finally{release.release();await pending;}
 assert.equal(calls,1);assert.deepEqual(observed,{blocked:true});
 assert.equal(readRun(f.traceRoot,id).events.filter(event=>event.type==='run/finished').length,1);
});

test('known verification business rejection releases after original successful cleanup and failed terminal',{timeout:20000},async t=>{
 const f=await fixture(t),snapshot=verificationSnapshot();snapshot.agents=[];
 let error;try{await runTraceVerification(f.traceRoot,{writers:f.writers,snapshot});}catch(caught){error=caught;}
 assert.ok(error);const ids=await readdir(f.traceRoot);assert.equal(ids.length,1);
 const run=readRun(f.traceRoot,ids[0]);assert.equal(run.status,'failed');assert.deepEqual(await probe(f,ids[0]),{acquired:true});
});

test('verification requires the same explicit application manager before any archive write',{timeout:20000},async t=>{
 const f=await fixture(t),foreign=createArchiveWriterManager({traceRoot:join(f.root,'foreign')});
 await assert.rejects(runTraceVerification(f.traceRoot,{writers:foreign}),{code:'E_ARCHIVE_WRITER_CONFIG'});
 await assert.rejects(runTraceVerification(f.traceRoot),{code:'E_ARCHIVE_WRITER_CONFIG'});
 assert.deepEqual(await readdir(f.traceRoot),[]);
});

test('failed terminal append preserves the original cleanup failure and latched writer',{timeout:20000},async t=>{
 const f=await fixture(t),original=EmployeeHostFactory.prototype.close;let id,calls=0,error;
 t.mock.method(EmployeeHostFactory.prototype,'close',async function(){
  calls++;id=this.archive.id;await original.call(this);writeFileSync(join(f.traceRoot,id,'events.jsonl'),'corrupt\n');throw Error('first teardown failure');
 });
 try{await runTraceVerification(f.traceRoot,{writers:f.writers});}catch(caught){error=caught;}
 assert.equal(error?.code,'RUNTIME_WRITER_DRAIN_FAILED');assert.equal(calls,1);assert.deepEqual(await probe(f,id),{blocked:true});
});

test('unpublished actual employee setup keeps verification source unavailable',{timeout:20000},async t=>{
 const f=await fixture(t),materialize=EmployeeHostFactory.prototype.materialize,close=EmployeeHostFactory.prototype.close;let id,cleanupCode,error;
 t.mock.method(EmployeeHostFactory.prototype,'materialize',function(owner,options,resume){
  return materialize.call(this,owner,{...options,setup:async(ctx,agent)=>{await options.setup?.(ctx,agent);throw Error('fixture original setup failed');}},resume);
 });
 t.mock.method(EmployeeHostFactory.prototype,'close',async function(){id=this.archive.id;try{return await close.call(this);}catch(caught){cleanupCode=caught.code;throw caught;}});
 try{await runTraceVerification(f.traceRoot,{writers:f.writers});}catch(caught){error=caught;}
 assert.ok(error);assert.equal(cleanupCode,'RUNTIME_WRITER_DRAIN_UNPROVEN');assert.deepEqual(await probe(f,id),{blocked:true});
});
