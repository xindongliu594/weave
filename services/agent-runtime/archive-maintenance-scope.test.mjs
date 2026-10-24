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
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
function fixture(t){
 const temp=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(temp,'maintenance-scope-')),traceRoot=path.join(base,'runs'),writers=createArchiveWriterManager({traceRoot}),children=[];
 t.after(async()=>{for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}assert.equal(fs.realpathSync(base),base);assert.match(path.relative(temp,base),/^maintenance-scope-[A-Za-z0-9]+$/);fs.rmSync(base,{recursive:true,force:true});});
 return {traceRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot})};
}
async function child(f,action){
 const child=fork(fileURLToPath(new URL('./test-helpers/archive-maintenance-child.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_MAINTENANCE_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,runId:A,action})}}),exited=once(child,'exit');f.children.push({child,exited});
 let timer;const [message]=await Promise.race([once(child,'message'),exited.then(([code])=>{throw Error('Probe exited: '+code);}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe deadline')),10000);})]).finally(()=>clearTimeout(timer));return {child,exited,message};
}
test('maintenance holds the native exclusive against a writer in another process until its retained producer settles',async t=>{
 const f=fixture(t);let release,ready;const gate=new Promise(done=>release=done),entered=new Promise(done=>ready=done);
 const work=f.writers.withMaintenance([A],async scope=>{f.writers.assertMaintenance(A);const producer=scope.retain('original physical tail');producer.run(async()=>{ready();await gate;f.writers.assertMaintenance(A);});producer.finish();});
 await entered;const p=await child(f,'probe');assert.deepEqual(p.message,{writerBlocked:true,sourceBlocked:true});let finished=false;work.then(()=>finished=true);await new Promise(done=>setTimeout(done,20));assert.equal(finished,false);
 const retried=once(p.child,'message');release();await work;p.child.send('retry');assert.deepEqual((await retried)[0],{acquired:true});assert.equal((await p.exited)[0],0);
});
test('maintenance borrows writer helpers under its actual native mode; shared writers cannot upgrade',async t=>{
 const f=fixture(t);
 await f.writers.withMaintenance([A,B],async()=>{await f.writers.withWriter([A],async()=>{f.writers.assertWriter(A);f.writers.assertMaintenance(A);});await f.writers.withMaintenance([B],async()=>f.writers.assertMaintenance(B));});
 await f.writers.withWriter([A],async()=>{await assert.rejects(f.writers.withMaintenance([A],async()=>{}),{code:'E_ARCHIVE_WRITER_SCOPE'});assert.throws(()=>f.writers.assertMaintenance(A),{code:'E_ARCHIVE_WRITER_SCOPE'});});
 const guard=await f.fence.acquireSource(A);guard.release();
});
test('maintenance waits for a live original writer before invoking the producer',async t=>{
 const f=fixture(t),owner=await f.writers.acquireOwner([A]);let called=false;
 const pending=f.writers.withMaintenance([A],async()=>{called=true;},{timeoutMs:2000});await new Promise(done=>setTimeout(done,40));assert.equal(called,false);owner.finish();await owner.writerDrained;await pending;assert.equal(called,true);
});
test('failed maintenance keeps the OS guard until its owning process exits',async t=>{
 const f=fixture(t),p=await child(f,'fail');assert.deepEqual(p.message,{firstError:true});
 await assert.rejects(f.fence.acquireWriter([A],{timeoutMs:0}),{code:'E_ARCHIVE_FENCE_TIMEOUT'});p.child.send('exit');assert.equal((await p.exited)[0],0);const guard=await f.fence.acquireWriter([A]);guard.release();
});
