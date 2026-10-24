import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createArchiveWriteFence} from './archive-write-fence.mjs';
import {createArchiveWriterManager} from './archive-writer-scope.mjs';
const A='00000000-0000-4000-8000-000000000001';
function fixture(t){
 const temporary=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(temporary,'backup-root-scope-')),traceRoot=path.join(base,'runs'),writers=createArchiveWriterManager({traceRoot}),children=[];
 t.after(async()=>{for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}assert.equal(fs.realpathSync(base),base);assert.match(path.relative(temporary,base),/^backup-root-scope-[A-Za-z0-9]+$/);fs.rmSync(base,{recursive:true,force:true});});
 return {base,traceRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot})};
}
async function probe(f,action){
 const child=fork(fileURLToPath(new URL('./test-helpers/archive-root-child.mjs',import.meta.url)),[],{stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_ROOT_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,runId:A,action})}}),exited=once(child,'exit');f.children.push({child,exited});
 let timer;const [message]=await Promise.race([once(child,'message'),exited.then(([code])=>{throw Error('Probe exited: '+code);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe deadline')),10000);})]).finally(()=>clearTimeout(timer));return {child,exited,message};
}
test('root scope spans its retained original producer and excludes all native modes in a second process',async t=>{
 const f=fixture(t);let release,ready;const gate=new Promise(done=>release=done),entered=new Promise(done=>ready=done);
 const work=f.writers.withRootExclusive(async scope=>{f.writers.assertRootExclusive();const producer=scope.retain('original backup tail');producer.run(async()=>{ready();await gate;f.writers.assertRootExclusive();});producer.finish();});
 await entered;const p=await probe(f,'probe');assert.deepEqual(p.message,{writer:true,source:true,maintenance:true,root:true});let finished=false;work.then(()=>finished=true);await new Promise(done=>setTimeout(done,20));assert.equal(finished,false);
 const retried=once(p.child,'message');release();await work;p.child.send('retry');assert.deepEqual((await retried)[0],{acquired:true});assert.equal((await p.exited)[0],0);
});
test('root scope waits for original writer and permits only root nesting without forged run authority',async t=>{
 const f=fixture(t),owner=await f.writers.acquireOwner([A]);let called=false;
 const work=f.writers.withRootExclusive(async()=>{called=true;f.writers.assertRootExclusive();await f.writers.withRootExclusive(async()=>f.writers.assertRootExclusive());assert.throws(()=>f.writers.assertWriter(A),{code:'E_ARCHIVE_WRITER_SCOPE'});await assert.rejects(f.writers.withWriter([A],async()=>{}),{code:'E_ARCHIVE_WRITER_SCOPE'});},{timeoutMs:2000});
 await new Promise(done=>setTimeout(done,30));assert.equal(called,false);owner.finish();await owner.writerDrained;await work;
 await f.writers.withWriter([A],async()=>{await assert.rejects(f.writers.withRootExclusive(async()=>{}),{code:'E_ARCHIVE_WRITER_SCOPE'});});
 await f.writers.withMaintenance([A],async()=>{await assert.rejects(f.writers.withRootExclusive(async()=>{}),{code:'E_ARCHIVE_WRITER_SCOPE'});});
});
test('root exchange validates the real root mode with an empty ID set and permits the next writer on the new generation',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.traceRoot,'old'),'old');
 await f.writers.withRootExclusive(async()=>{fs.renameSync(f.traceRoot,path.join(f.base,'before'));fs.mkdirSync(f.traceRoot);fs.writeFileSync(path.join(f.traceRoot,'new'),'new');f.writers.assertRootExclusive();});
 await f.writers.withWriter([A],async()=>f.writers.assertWriter(A));assert.equal(fs.readFileSync(path.join(f.base,'before','old'),'utf8'),'old');
});
test('unknown root producer preserves the original error and guard until its process exits',async t=>{
 const f=fixture(t),p=await probe(f,'fail');assert.deepEqual(p.message,{original:true});await assert.rejects(f.fence.acquireWriter([A],{timeoutMs:0}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});p.child.send('exit');assert.equal((await p.exited)[0],0);const guard=await f.fence.acquireRootExclusive();guard.release();
});
test('pending restore startup never creates a missing trace; only the original root mode may reconcile it',async t=>{
 const f=fixture(t),traceRoot=path.join(f.base,'missing-runs'),writers=createArchiveWriterManager({traceRoot,initializeTraceRoot:false});
 assert.equal(fs.existsSync(traceRoot),false);const fence=createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot,allowMissingTraceRoot:true});
 for(const acquire of [()=>fence.acquireWriter([A]),()=>fence.acquireSource(A),()=>fence.acquireMaintenance([A])])await assert.rejects(acquire(),{code:'E_ARCHIVE_FENCE_IDENTITY'});
 await writers.withRootExclusive(async()=>{writers.assertRootExclusive();assert.equal(fs.existsSync(traceRoot),false);fs.mkdirSync(traceRoot);writers.assertRootExclusive();});
 await writers.withWriter([A],async()=>writers.assertWriter(A));
});
