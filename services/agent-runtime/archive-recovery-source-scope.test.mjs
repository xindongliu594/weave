import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {AsyncResource} from 'node:async_hooks';
import {createArchiveWriteFence} from './archive-write-fence.mjs';
import {createArchiveWriterManager,registerArchiveWriterRoot,assertArchiveSourceScope,withArchiveMutationSync} from './archive-writer-scope.mjs';
import {createRunArchive,openRunArchive,readRun} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';

const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',C='00000000-0000-4000-8000-000000000003';
const scopeError={code:'E_ARCHIVE_WRITER_SCOPE'},timeout={code:'E_ARCHIVE_FENCE_TIMEOUT'};
function fixture(t){
  const temporary=fs.realpathSync(process.env.ARCHIVE_SOURCE_TEMP||os.tmpdir()),base=fs.mkdtempSync(path.join(temporary,'archive-recovery-scope-'));
  const traceRoot=path.join(base,'runs'),writers=createArchiveWriterManager({traceRoot}),children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    assert.equal(fs.realpathSync(base),base);assert.match(path.relative(temporary,base),/^archive-recovery-scope-[A-Za-z0-9]+$/);
    fs.rmSync(base,{recursive:true,force:true});
  });
  return {base,traceRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot})};
}
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};}
async function child(f,action){
  const probeRoot=path.join(f.base,'probe-'+(f.children.length+1));fs.mkdirSync(probeRoot);
  const process=spawn(globalThis.process.execPath,[fileURLToPath(new URL('./test-helpers/archive-recovery-source-child.mjs',import.meta.url))],{
    windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...globalThis.process.env,ARCHIVE_RECOVERY_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,probeRoot,action,sourceRunId:A,childRunId:B,otherRunId:C})},
  });
  f.children.push(process);const exited=once(process,'exit'),target=path.join(probeRoot,'result.json');
  let poll,timer;
  const message=await Promise.race([
    new Promise((resolve,reject)=>{
      poll=setInterval(()=>{if(fs.existsSync(target))resolve(JSON.parse(fs.readFileSync(target,'utf8')));},10);
      timer=setTimeout(()=>reject(Error('Recovery scope probe deadline')),10000);
    }),
    exited.then(([code])=>{if(fs.existsSync(target))return JSON.parse(fs.readFileSync(target,'utf8'));throw Error('Recovery scope probe exited early: '+code);}),
  ]).finally(()=>{clearInterval(poll);clearTimeout(timer);});
  return {message,async stop(){fs.writeFileSync(path.join(probeRoot,'exit'),'exit');assert.equal((await exited)[0],0);}};
}

test('recovery scope binds original source authority and child writes without granting owner or maintenance',async t=>{
  const f=fixture(t),other=fixture(t);registerArchiveWriterRoot(f.writers);
  await f.writers.withWriter([A,B],()=>{createRunArchive(f.traceRoot,{synthetic:true},{id:A});createRunArchive(f.traceRoot,{synthetic:true},{id:B});});
  const before=fs.readFileSync(path.join(f.traceRoot,A,'events.jsonl'));
  const content=Buffer.from('child only'),object={content,size:content.length,sha256:createHash('sha256').update(content).digest('hex')};
  await f.writers.withRecoverySource(A,B,async scope=>{
    assert.deepEqual(Object.keys(scope),['retain']);
    f.writers.assertSource(A);assertArchiveSourceScope(f.writers,A);f.writers.assertWriter(B);
    for(const check of [()=>f.writers.assertWriter(A),()=>f.writers.assertSource(B),()=>f.writers.assertSource(C),()=>f.writers.assertMaintenance(A),()=>f.writers.assertMaintenance(B),()=>f.writers.assertRootExclusive(),()=>assertArchiveSourceScope(other.writers,A)])assert.throws(check,scopeError);
    assert.throws(()=>assertArchiveSourceScope({...f.writers},A),{code:'E_ARCHIVE_WRITER_CONFIG'});
    for(const mutate of [()=>openRunArchive(f.traceRoot,A),()=>withArchiveMutationSync(f.traceRoot,A,'writer',()=>assert.fail('source mutation')),()=>storeArchiveObjects(path.join(f.traceRoot,A),[object])])assert.throws(mutate,scopeError);
    storeArchiveObjects(path.join(f.traceRoot,B),[object]);openRunArchive(f.traceRoot,B).append('child/initialized',{ok:true});
    await f.writers.withWriter([B],()=>{f.writers.assertWriter(B);assert.throws(()=>f.writers.assertSource(A),scopeError);});
    assertArchiveSourceScope(f.writers,A);
  });
  assert.deepEqual(fs.readFileSync(path.join(f.traceRoot,A,'events.jsonl')),before);
  assert.equal(fs.existsSync(path.join(f.traceRoot,A,'checkpoint-objects')),false);
  assert.equal(readRun(f.traceRoot,B).eventCount,2);
});

test('recovery scope refuses nesting, cross-root borrowing and expansion in both directions',async t=>{
  const f=fixture(t),other=fixture(t);let entered=0;
  await f.writers.withRecoverySource(A,B,async()=>{
    for(const acquire of [()=>f.writers.withRecoverySource(A,B,()=>entered++),()=>f.writers.withSource(A,()=>entered++),()=>f.writers.withWriter([A],()=>entered++),()=>f.writers.withWriter([B,C],()=>entered++),()=>f.writers.withMaintenance([B],()=>entered++),()=>f.writers.withRootExclusive(()=>entered++),()=>f.writers.acquireOwner([B]),()=>other.writers.withWriter([B],()=>entered++)])await assert.rejects(acquire(),scopeError);
  });
  for(const enter of [fn=>f.writers.withSource(A,fn),fn=>f.writers.withWriter([B],fn),fn=>f.writers.withMaintenance([A,B],fn),fn=>f.writers.withRootExclusive(fn)])await enter(async()=>{
    await assert.rejects(f.writers.withRecoverySource(A,B,()=>entered++),scopeError);
  });
  assert.equal(entered,0);
});

test('source and child authority expire at callback settlement, including escaped async resources',async t=>{
  const f=fixture(t);
  for(const style of ['sync','async']){
    let escaped,borrowed,lateAcquire;
    const body=scope=>{
      borrowed=scope;escaped=AsyncResource.bind(()=>{f.writers.assertSource(A);f.writers.assertWriter(B);});
      lateAcquire=AsyncResource.bind(()=>f.writers.withRecoverySource(A,B,()=>assert.fail('expired acquisition')));
      return {knownRejection:true};
    };
    assert.deepEqual(await f.writers.withRecoverySource(A,B,style==='sync'?body:async scope=>body(scope)),{knownRejection:true});
    assert.throws(escaped,scopeError);assert.throws(()=>borrowed.retain('expired'),scopeError);await assert.rejects(lateAcquire(),scopeError);
    assert.throws(()=>assertArchiveSourceScope(f.writers,A),scopeError);assert.throws(()=>f.writers.assertWriter(B),scopeError);
  }
});

test('retained child work holds both native locks but never receives source authority',async t=>{
  const f=fixture(t),returned=gate(),release=gate();let retained,escaped;
  const pending=f.writers.withRecoverySource(A,B,scope=>{
    retained=scope.retain('child projection tail');escaped=AsyncResource.bind(()=>f.writers.assertSource(A));returned.release();
  });
  await returned.promise;
  const original=retained.run(async()=>{assert.throws(escaped,scopeError);f.writers.assertWriter(B);assert.throws(()=>f.writers.assertSource(A),scopeError);await release.promise;f.writers.assertWriter(B);});
  retained.finish();
  try{for(const id of [A,B])await assert.rejects(f.fence.acquireSource(id),timeout);}
  finally{release.release();await original;await pending;}
  for(const id of [A,B]){const guard=await f.fence.acquireSource(id);guard.release();}
});

test('recovery validates distinct identities and options, releasing partial sorted acquisitions',async t=>{
  const f=fixture(t);let entered=0;
  for(const ids of [[A,A],['',B],[A,undefined],[A,'FFFFFFFF-0000-4000-8000-000000000002']])await assert.rejects(f.writers.withRecoverySource(...ids,()=>entered++),scopeError);
  await assert.rejects(f.writers.withRecoverySource(A,B,null),scopeError);
  for(const options of [null,{timeoutMs:-1},{timeoutMs:2001},{signal:{aborted:false}}])await assert.rejects(f.writers.withRecoverySource(A,B,()=>entered++,options),{code:'E_ARCHIVE_FENCE_OPTIONS'});
  const owner=await f.writers.acquireOwner([B]);
  try{
    await assert.rejects(f.writers.withRecoverySource(B,A,()=>entered++,{timeoutMs:20}),timeout);
    const abort=new AbortController(),pending=f.writers.withRecoverySource(B,A,()=>entered++,{timeoutMs:2000,signal:abort.signal});setTimeout(()=>abort.abort(),20);
    await assert.rejects(pending,{code:'E_ARCHIVE_FENCE_ABORTED'});
    const guard=await f.fence.acquireSource(A);guard.release();
  }finally{owner.finish();await owner.writerDrained;}
  assert.equal(entered,0);
  await f.writers.withRecoverySource(A,B,()=>{});
});

test('independent process cannot write, read-source or initialize either guarded run while third run stays usable',async t=>{
  const f=fixture(t);
  await f.writers.withRecoverySource(A,B,async()=>{
    const p=await child(f,'probe');assert.deepEqual(p.message,{blocked:7,otherWriter:true});await p.stop();
  });
  const p=await child(f,'hold');assert.deepEqual(p.message,{acquired:true});
  await assert.rejects(f.writers.withRecoverySource(B,A,()=>assert.fail('second initializer entered'),{timeoutMs:0}),timeout);
  await p.stop();await f.writers.withRecoverySource(A,B,()=>{});
});

for(const action of ['callback-failure','caught-nested-failure','identity-failure','identity-child-failure'])test('recovery '+action+' preserves writer fail-closed policy until original process exits',async t=>{
  const f=fixture(t),p=await child(f,action);assert.deepEqual(p.message,{failedClosed:true});
  for(const id of [A,B]){
    await assert.rejects(f.writers.withWriter([id],()=>assert.fail('failed initializer admitted writer'),{timeoutMs:0}),timeout);
    await assert.rejects(f.writers.withSource(id,()=>assert.fail('failed initializer admitted source'),{timeoutMs:0}),timeout);
  }
  await p.stop();await f.writers.withRecoverySource(A,B,()=>{});
});
