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
import {createArchiveWriterManager,registerArchiveWriterRoot,bindArchiveJournal,withArchiveMutationSync,assertArchiveSourceScope} from './archive-writer-scope.mjs';
import {createRunArchive,openRunArchive,readRun} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';
import {archiveJournal} from './journal-archive.mjs';

const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const scopeError={code:'E_ARCHIVE_WRITER_SCOPE'},timeout={code:'E_ARCHIVE_FENCE_TIMEOUT'};
function fixture(t){
  const temporary=fs.realpathSync(process.env.ARCHIVE_SOURCE_TEMP||os.tmpdir()),base=fs.mkdtempSync(path.join(temporary,'archive-source-scope-'));
  const traceRoot=path.join(base,'runs'),writers=createArchiveWriterManager({traceRoot}),children=[];
  t.after(async()=>{
    for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}
    assert.equal(fs.realpathSync(base),base);assert.match(path.relative(temporary,base),/^archive-source-scope-[A-Za-z0-9]+$/);
    fs.rmSync(base,{recursive:true,force:true});
  });
  return {base,traceRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot})};
}
async function message(p){
  const target=path.join(p.probeRoot,`${++p.nextMessage}.result.json`);
  return new Promise((resolve,reject)=>{
    const check=()=>{if(fs.existsSync(target)){clearInterval(poll);clearTimeout(deadline);resolve(JSON.parse(fs.readFileSync(target,'utf8')));return true;}};
    const poll=setInterval(check,10),deadline=setTimeout(()=>{clearInterval(poll);reject(Error('Source probe deadline'));},10000);
    p.exited.then(([code])=>{if(!check()){clearInterval(poll);clearTimeout(deadline);reject(Error('Source probe exited before result: '+code));}},reject);
    check();
  });
}
async function child(f,action){
  const probeRoot=path.join(f.base,`probe-${f.children.length+1}`);fs.mkdirSync(probeRoot);
  // Files in the task-owned fixture keep real process tests independent of sandbox IPC pipes.
  const child=spawn(process.execPath,[fileURLToPath(new URL('./test-helpers/archive-source-scope-child.mjs',import.meta.url))],{
    windowsHide:true,stdio:['ignore','inherit','inherit'],
    env:{...process.env,ARCHIVE_SOURCE_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,runId:A,action,probeRoot})},
  });
  const p={child,exited:once(child,'exit'),probeRoot,nextMessage:0,nextCommand:0};f.children.push(p);p.message=await message(p);return p;
}
function command(p,value){
  const target=path.join(p.probeRoot,`${++p.nextCommand}.command.json`),temporary=target+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,target);
}
async function send(p,value){const pending=message(p);command(p,value);return pending;}
async function stop(p){command(p,'exit');assert.equal((await p.exited)[0],0);}

test('source authority exists only in its actual manager callback and native guard alone grants none',async t=>{
  const f=fixture(t),other=fixture(t);
  assert.equal(typeof f.writers.withSource,'function');assert.equal(typeof f.writers.assertSource,'function');
  assert.throws(()=>f.writers.assertSource(A),scopeError);
  assert.throws(()=>assertArchiveSourceScope(f.writers,A),scopeError);
  const native=await f.fence.acquireSource(A);
  try{assert.throws(()=>f.writers.assertSource(A),scopeError);}finally{native.release();}
  const value=await f.writers.withSource(A,async(...args)=>{
    assert.deepEqual(args,[]);f.writers.assertSource(A);
    assertArchiveSourceScope(f.writers,A);
    await Promise.resolve();f.writers.assertSource(A);
    assert.throws(()=>f.writers.assertSource(B),scopeError);
    assert.throws(()=>other.writers.assertSource(A),scopeError);
    for(const assertion of [()=>f.writers.assertWriter(A),()=>f.writers.assertMaintenance(A),()=>f.writers.assertRootExclusive()])assert.throws(assertion,scopeError);
    return {read:'checked'};
  });
  assert.deepEqual(value,{read:'checked'});assert.throws(()=>f.writers.assertSource(A),scopeError);
});

test('source scope assertion rejects fake managers and copied real assertion closures',async t=>{
  const f=fixture(t),other=fixture(t);let called=false;
  await f.writers.withSource(A,()=>{
    assertArchiveSourceScope(f.writers,A);
    assert.throws(()=>assertArchiveSourceScope(other.writers,A),scopeError);
    assert.throws(()=>assertArchiveSourceScope(f.writers,B),scopeError);
    for(const fake of [null,undefined,{},Object.create(f.writers),{...f.writers,traceRoot:other.traceRoot},{traceRoot:f.traceRoot,assertSource(){called=true;}}]){
      assert.throws(()=>assertArchiveSourceScope(fake,A),{code:'E_ARCHIVE_WRITER_CONFIG'});
    }
    assert.equal(called,false);
  });
});

test('source expires after sync and async callbacks including escaped async resources',async t=>{
  const f=fixture(t);
  for(const style of ['sync','async']){
    let escaped,lateAcquire,microtask;
    const body=()=>{
      escaped=AsyncResource.bind(()=>f.writers.assertSource(A));
      lateAcquire=AsyncResource.bind(()=>f.writers.withSource(A,()=>assert.fail('escaped context reacquired')));
      if(style==='sync')microtask=new Promise(resolve=>queueMicrotask(()=>{assert.throws(escaped,scopeError);resolve();}));
      return 'read';
    };
    assert.equal(await f.writers.withSource(A,style==='sync'?body:async()=>body()),'read');
    if(microtask)await microtask;
    assert.throws(escaped,scopeError);await assert.rejects(lateAcquire(),scopeError);
    await f.writers.withWriter([A],()=>assert.throws(escaped,scopeError));
  }
});

test('source refuses nesting, writer ownership and cross-root authority in either direction',async t=>{
  const f=fixture(t),other=fixture(t);let entered=0;
  await f.writers.withSource(A,async()=>{
    for(const attempt of [
      ()=>f.writers.withSource(A,()=>entered++),()=>f.writers.withSource(B,()=>entered++),
      ()=>other.writers.withSource(A,()=>entered++),()=>f.writers.withWriter([A],()=>entered++),
      ()=>f.writers.withMaintenance([A],()=>entered++),()=>f.writers.withRootExclusive(()=>entered++),
      ()=>f.writers.acquireOwner([A]),()=>other.writers.withWriter([A],()=>entered++),
    ])await assert.rejects(attempt(),scopeError);
    f.writers.assertSource(A);
  });
  for(const enter of [fn=>f.writers.withWriter([A],fn),fn=>f.writers.withMaintenance([A],fn),fn=>f.writers.withRootExclusive(fn)]){
    await enter(async()=>{
      assert.throws(()=>f.writers.assertSource(A),scopeError);
      await assert.rejects(f.writers.withSource(A,()=>entered++),scopeError);
    });
  }
  assert.equal(entered,0);
});

test('source cannot bind a journal, mutate registered files or reuse an earlier writer handle',async t=>{
  const f=fixture(t);registerArchiveWriterRoot(f.writers);let archive;
  await f.writers.withWriter([A],()=>{archive=createRunArchive(f.traceRoot,{synthetic:true},{id:A});});
  const before=fs.readFileSync(path.join(archive.dir,'events.jsonl'));
  const bytes=Buffer.from('source must not write'),sha256=createHash('sha256').update(bytes).digest('hex');
  await f.writers.withSource(A,()=>{
    for(const mutate of [
      ()=>bindArchiveJournal(f.traceRoot,A),()=>createRunArchive(f.traceRoot,{}, {id:A}),
      ()=>openRunArchive(f.traceRoot,A),()=>archive.append('forbidden'),
      ()=>withArchiveMutationSync(f.traceRoot,A,'writer',()=>assert.fail('writer mutation ran')),
      ()=>withArchiveMutationSync(f.traceRoot,A,'maintenance',()=>assert.fail('maintenance mutation ran')),
      ()=>storeArchiveObjects(archive.dir,[{content:bytes,size:bytes.length,sha256}]),
      ()=>archiveJournal(f.traceRoot,{runId:A}),
    ])assert.throws(mutate,scopeError);
    assert.equal(readRun(f.traceRoot,A).eventCount,1);f.writers.assertSource(A);
  });
  assert.deepEqual(fs.readFileSync(path.join(archive.dir,'events.jsonl')),before);
  assert.equal(fs.existsSync(path.join(archive.dir,'checkpoint-objects')),false);
  await f.writers.withWriter([A],()=>openRunArchive(f.traceRoot,A).append('allowed'));
  assert.equal(readRun(f.traceRoot,A).eventCount,2);
});

test('sync and async read validation rejection releases the source guard and preserves original errors',async t=>{
  const f=fixture(t);
  for(const style of ['sync','async']){
    const original=Object.assign(Error('synthetic invalid read'),{code:'SOURCE_INVALID'});let escaped;
    const read=()=>{escaped=AsyncResource.bind(()=>f.writers.assertSource(A));f.writers.assertSource(A);throw original;};
    await assert.rejects(f.writers.withSource(A,style==='sync'?read:async()=>read()),error=>error===original);
    assert.throws(escaped,scopeError);
    const p=await child(f,'writer-once');assert.deepEqual(p.message,{writerAcquired:true});await stop(p);
    await f.writers.withSource(A,()=>f.writers.assertSource(A));
  }
});

test('source validates inputs and native options without leaking guards or invoking rejected callbacks',async t=>{
  const f=fixture(t);let invoked=0;
  for(const id of ['',undefined,'FFFFFFFF-0000-4000-8000-000000000001','../'+A,[],[A]])await assert.rejects(f.writers.withSource(id,()=>invoked++),scopeError);
  await assert.rejects(f.writers.withSource(A,null),scopeError);
  for(const options of [null,2,{timeoutMs:-1},{timeoutMs:2001},{timeoutMs:0.5},{signal:{aborted:false}}]){
    await assert.rejects(f.writers.withSource(A,()=>invoked++,options),{code:'E_ARCHIVE_FENCE_OPTIONS'});
  }
  const abort=new AbortController();abort.abort();
  await assert.rejects(f.writers.withSource(A,()=>invoked++,{signal:abort.signal}),{code:'E_ARCHIVE_FENCE_ABORTED'});
  assert.equal(invoked,0);
  assert.equal(await f.writers.withSource(A,()=>7,{timeoutMs:0}),7);
  await f.writers.withWriter([A],()=>f.writers.assertWriter(A));
});

test('source forwards contended timeout and abort and never enters the callback',async t=>{
  const f=fixture(t),owner=await f.writers.acquireOwner([A]);let invoked=false;
  try{
    await assert.rejects(f.writers.withSource(A,()=>{invoked=true;},{timeoutMs:20}),timeout);
    const abort=new AbortController(),pending=f.writers.withSource(A,()=>{invoked=true;},{signal:abort.signal,timeoutMs:2000});
    setTimeout(()=>abort.abort(),20);
    await assert.rejects(pending,{code:'E_ARCHIVE_FENCE_ABORTED'});assert.equal(invoked,false);
  }finally{owner.finish();await owner.writerDrained;}
  await f.writers.withSource(A,()=>f.writers.assertSource(A));
});

test('real processes enforce writer to source to writer exclusion until each original callback settles',async t=>{
  const f=fixture(t),owner=await f.writers.acquireOwner([A]);
  const p=await child(f,'source-hold');assert.deepEqual(p.message,{sourceBlocked:true});
  owner.finish();await owner.writerDrained;
  assert.deepEqual(await send(p,'acquire'),{sourceAcquired:true});
  await assert.rejects(f.writers.withWriter([A],()=>assert.fail('writer overlapped source'),{timeoutMs:0}),timeout);
  await assert.rejects(f.writers.withSource(A,()=>assert.fail('second source overlapped'),{timeoutMs:0}),timeout);
  await assert.rejects(f.writers.withRootExclusive(()=>assert.fail('root overlapped source'),{timeoutMs:0}),timeout);
  await f.writers.withWriter([B],()=>f.writers.assertWriter(B));
  assert.deepEqual(await send(p,'release'),{sourceReleased:true});await stop(p);
  await f.writers.withWriter([A],()=>f.writers.assertWriter(A));
});

test('a failed original writer physically blocks manager source until its process exits',async t=>{
  const f=fixture(t),p=await child(f,'failed-writer');assert.deepEqual(p.message,{writerFailed:true});
  await assert.rejects(f.writers.withSource(A,()=>assert.fail('failed writer admitted source'),{timeoutMs:0}),timeout);
  await stop(p);await f.writers.withSource(A,()=>f.writers.assertSource(A));
});

for(const action of ['identity-assert','identity-final','release-failure'])test('source fails closed on native '+action+' until its process exits',async t=>{
  const f=fixture(t),p=await child(f,action);
  assert.deepEqual(p.message,{failedClosed:true,code:action==='release-failure'?'E_ARCHIVE_FENCE_IO':'E_ARCHIVE_FENCE_IDENTITY'});
  await assert.rejects(f.writers.withWriter([A],()=>assert.fail('failed native source admitted writer'),{timeoutMs:0}),timeout);
  await assert.rejects(f.writers.withSource(A,()=>assert.fail('failed native source admitted source'),{timeoutMs:0}),timeout);
  await assert.rejects(f.writers.withRootExclusive(()=>assert.fail('failed native source admitted root'),{timeoutMs:0}),timeout);
  await stop(p);await f.writers.withSource(A,()=>f.writers.assertSource(A));
});

test('partial native release rejects without publishing facts after authority expires even if the lifetime unlocked',async t=>{
  const f=fixture(t),p=await child(f,'partial-release');
  assert.deepEqual(p.message,{rejected:true,code:'E_ARCHIVE_FENCE_IO',published:false,authorityExpired:true});
  // closeAll may close the lifetime before another close fails; rejection cannot undo that close.
  await f.writers.withWriter([A],()=>f.writers.assertWriter(A),{timeoutMs:0});
  await assert.rejects(f.writers.withRootExclusive(()=>assert.fail('unclosed root handle released'),{timeoutMs:0}),timeout);
  await stop(p);await f.writers.withSource(A,()=>f.writers.assertSource(A));
});
