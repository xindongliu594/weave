import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AsyncResource } from 'node:async_hooks';
import { createArchiveWriteFence } from './archive-write-fence.mjs';
const { createArchiveWriterManager } = await import('./archive-writer-scope.mjs').catch(() => ({}));
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const scopeError={code:'E_ARCHIVE_WRITER_SCOPE'};
function fixture(t){
  const temp=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(temp,'writer-scope-'));
  const traceRoot=path.join(base,'runs'),lockRoot=path.join(base,'.archive-write-locks');
  const writers=createArchiveWriterManager({traceRoot});
  const children=[];
  t.after(async()=>{
    for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}
    assert.equal(fs.realpathSync(base),base);assert.match(path.relative(temp,base),/^writer-scope-[A-Za-z0-9]+$/);fs.rmSync(base,{recursive:true,force:true});
  });
  return {base,traceRoot,lockRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot})};
}
async function probe(f,extra={}){
  const child=fork(fileURLToPath(new URL('./test-helpers/archive-writer-source-child.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.lockRoot,runId:A,...extra})}});
  const exited=once(child,'exit');f.children.push({child,exited});let timer;
  const message=await Promise.race([
    once(child,'message').then(([value])=>value),
    exited.then(([code])=>{throw Error('Probe exited before result: '+code);}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe readiness deadline')),10000);}),
  ]).finally(()=>clearTimeout(timer));
  return {child,exited,message};
}
test('manager exists',()=>assert.equal(typeof createArchiveWriterManager,'function'));
test('stable mapping is shared, conflicts and tool workspace overlap fail at startup',t=>{
  const f=fixture(t);
  assert.equal(createArchiveWriterManager({traceRoot:f.traceRoot}),f.writers);
  assert.throws(()=>createArchiveWriterManager({traceRoot:f.traceRoot,lockRoot:path.join(f.base,'other')}),{code:'E_ARCHIVE_WRITER_CONFIG'});
  assert.throws(()=>createArchiveWriterManager({traceRoot:path.join(f.base,'other-runs'),lockRoot:path.join(f.base,'tools','locks'),workspaceRoots:[path.join(f.base,'tools')]}),{code:'E_ARCHIVE_WRITER_CONFIG'});
});
test('subset borrows only the active originating chain and rejects expansion and another manager',async t=>{
  const f=fixture(t),other=fixture(t);let original;
  await f.writers.withWriter([B,A],async owner=>{
    original=owner;f.writers.assertWriter(A);
    await f.writers.withWriter([A],async borrowed=>{assert.notEqual(borrowed,owner);assert.equal(borrowed.finish,undefined);assert.equal(borrowed.closeAdmission,undefined);f.writers.assertWriter(A);});
    await assert.rejects(f.writers.withWriter([A,'00000000-0000-4000-8000-000000000003'],async()=>{}),scopeError);
    await assert.rejects(other.writers.withWriter([A],async()=>{}),scopeError);
  });
  assert.throws(()=>original.run(()=>f.writers.assertWriter(A)),scopeError);
  assert.throws(()=>f.writers.assertWriter(A),scopeError);
});
test('independent chains acquire independent owners rather than borrowing live run IDs',async t=>{
  const f=fixture(t),one=await f.writers.acquireOwner([A]),two=await f.writers.acquireOwner([A]);
  assert.notEqual(one,two);one.finish();await one.writerDrained;
  await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  two.finish();await two.writerDrained;const source=await f.fence.acquireSource(A);source.release();
});
test('parent closes admission, retained original promise blocks release even after premature finish',async t=>{
  const f=fixture(t),owner=await f.writers.acquireOwner([A]),producer=owner.retain('registered callback');
  let resume,late;const gate=new Promise(resolve=>{resume=resolve;});
  const work=producer.run(async()=>{await gate;f.writers.assertWriter(A);late=AsyncResource.bind(()=>f.writers.withWriter([A],async()=>{}));});
  owner.finish();assert.throws(()=>owner.retain('too late'),scopeError);
  producer.finish();await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  resume();await work;await owner.writerDrained;
  assert.throws(()=>producer.run(()=>{}),scopeError);
  await assert.rejects(late(),scopeError);
  const source=await f.fence.acquireSource(A);source.release();
});
test('nested invocation expires before the live parent and preserves its explicitly retained tail',async t=>{
  const f=fixture(t);let late,tail,lateError,returned;const bodyReturned=new Promise(resolve=>{returned=resolve;});
  const parent=f.writers.withWriter([A],async()=>{
    await f.writers.withWriter([A],async borrowed=>{
      tail=borrowed.retain('nested original tail');
      late=AsyncResource.bind(()=>f.writers.withWriter([A],async()=>f.writers.assertWriter(A)));
    });
    try{await late();}catch(error){lateError=error;}
    returned();
  });
  await bodyReturned;
  let resume;const gate=new Promise(resolve=>{resume=resolve;});
  const original=tail.run(async()=>{await gate;f.writers.assertWriter(A);});tail.finish();
  await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  resume();await original;await parent;
  assert.equal(lateError?.code,scopeError.code,'completed nested context must not borrow its still-live parent');
  const source=await f.fence.acquireSource(A);source.release();
});
test('borrowed view rejects a different live owner of the same run while retained producers remain transferable',async t=>{
  const f=fixture(t),one=await f.writers.acquireOwner([A]),two=await f.writers.acquireOwner([A]);
  let view,retained,ready,resume,foreignError,transferred=false;
  const registered=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{resume=resolve;});
  const original=one.run(()=>f.writers.withWriter([A],async borrowed=>{view=borrowed;retained=borrowed.retain('explicit transfer');ready();await gate;}));
  await registered;
  two.run(()=>{
    try{const accidental=view.retain('foreign owner must not retain');accidental.finish();}catch(error){foreignError=error;}
    retained.run(()=>{f.writers.assertWriter(A);transferred=true;});retained.finish();
  });
  resume();await original;one.finish();two.finish();await Promise.all([one.writerDrained,two.writerDrained]);
  assert.equal(foreignError?.code,scopeError.code);assert.equal(transferred,true);
  const source=await f.fence.acquireSource(A);source.release();
});
test('borrowed view cannot retain after its nested invocation settles even inside the original parent',async t=>{
  const f=fixture(t);let stale,staleError;
  await f.writers.withWriter([A],async()=>{
    await f.writers.withWriter([A],async borrowed=>{stale=borrowed;});
    try{const accidental=stale.retain('late unretained view');accidental.finish();}catch(error){staleError=error;}
  });
  assert.equal(staleError?.code,scopeError.code);
  const source=await f.fence.acquireSource(A);source.release();
});
for(const style of ['sync','async'])test('caught nested failure latches the original OS guard: '+style,async t=>{
  const f=fixture(t),{child,exited,message}=await probe(f,{action:'failed-nested',style});
  try{
    assert.deepEqual(message,{caught:true,outerError:'nested producer failed'});
    await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  }finally{child.send('exit');assert.equal((await exited)[0],0);}
  const source=await f.fence.acquireSource(A);source.release();
});
test('failed original producer latches failure and never grants source',async t=>{
  const f=fixture(t),{child,exited,message}=await probe(f,{action:'failed-producer'});
  assert.deepEqual(message,{latched:true});
  await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  child.send('exit');assert.equal((await exited)[0],0);
  const source=await f.fence.acquireSource(A);source.release();
});
test('real source process cannot enter until delayed retained writer actually settles',async t=>{
  const f=fixture(t),owner=await f.writers.acquireOwner([A]),producer=owner.retain('delayed terminal tail');
  let resume;const gate=new Promise(resolve=>{resume=resolve;});const work=producer.run(async()=>{await gate;f.writers.assertWriter(A);});
  owner.finish();producer.finish();
  const {child,exited,message}=await probe(f);
  assert.deepEqual(message,{blocked:true});
  resume();await work;await owner.writerDrained;child.send('retry');
  assert.deepEqual((await once(child,'message'))[0],{acquired:true});assert.equal((await exited)[0],0);
});
