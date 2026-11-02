import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import * as scopes from './archive-writer-scope.mjs';
import {createArchiveWriteFence} from './archive-write-fence.mjs';
import {createRunArchive,openRunArchive,readRun} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';
import {archiveJournal,journalArchiveCandidate} from './journal-archive.mjs';

const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
const denied={code:'E_ARCHIVE_WRITER_SCOPE'};
function fixture(t,{register=true}={}){
  const temp=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(temp,'trace-scope-'));
  const traceRoot=path.join(base,'runs'),writers=scopes.createArchiveWriterManager({traceRoot}),children=[];
  if(register)scopes.registerArchiveWriterRoot(writers);
  t.after(async()=>{
    for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}
    assert.equal(fs.realpathSync(base),base);assert.equal(path.dirname(base),temp);assert.match(path.basename(base),/^trace-scope-[A-Za-z0-9]+$/);
    fs.rmSync(base,{recursive:true});
  });
  return {base,traceRoot,writers,children,fence:createArchiveWriteFence({traceRoot,lockRoot:writers.lockRoot})};
}
async function child(f,action,extra={}){
  const proc=fork(fileURLToPath(new URL('./test-helpers/archive-trace-child.mjs',import.meta.url)),[],{
    windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],
    env:{...process.env,ARCHIVE_TRACE_TEST:JSON.stringify({traceRoot:f.traceRoot,lockRoot:f.writers.lockRoot,runId:A,action,...extra})},
  });
  const exited=once(proc,'exit');f.children.push({child:proc,exited});
  const [ready]=await once(proc,'message');assert.equal(ready.ready,true);return {proc,exited};
}

test('registered roots reject create/open/append without a live writer before changing bytes',async t=>{
  const f=fixture(t);
  assert.throws(()=>createRunArchive(f.traceRoot,{}, {id:A}),denied);
  assert.equal(fs.existsSync(path.join(f.traceRoot,A)),false);
  let handle;
  await f.writers.withWriter([A],async()=>{handle=createRunArchive(f.traceRoot,{}, {id:A});handle.append('safe');});
  const before=fs.readFileSync(path.join(f.traceRoot,A,'events.jsonl'));
  assert.throws(()=>openRunArchive(f.traceRoot,A),denied);
  assert.throws(()=>handle.append('late'),denied);
  assert.deepEqual(fs.readFileSync(path.join(f.traceRoot,A,'events.jsonl')),before);
});

test('old handles cannot borrow a new owner, wrong run or an expired nested invocation',async t=>{
  const f=fixture(t);let stale,nested;
  await f.writers.withWriter([A],async()=>{stale=createRunArchive(f.traceRoot,{}, {id:A});});
  await f.writers.withWriter([A,B],async()=>{
    assert.throws(()=>stale.append('resurrected'),denied);
    await f.writers.withWriter([A],async()=>{nested=openRunArchive(f.traceRoot,A);nested.append('nested');});
    assert.throws(()=>nested.append('expired nested'),denied);
    openRunArchive(f.traceRoot,A).append('fresh');
  });
  await f.writers.withWriter([B],async()=>assert.throws(()=>openRunArchive(f.traceRoot,A),denied));
  assert.deepEqual(readRun(f.traceRoot,A).events.map(e=>e.type),['run/created','nested','fresh']);
});

test('registration invalidates preexisting raw handles and relative spelling cannot bypass it',async t=>{
  const f=fixture(t,{register:false}),raw=createRunArchive(f.traceRoot,{}, {id:A});
  scopes.registerArchiveWriterRoot(f.writers);
  assert.throws(()=>raw.append('raw'),denied);
  assert.throws(()=>openRunArchive(path.relative(process.cwd(),f.traceRoot),A),denied);
  await f.writers.withWriter([A],async()=>{
    assert.throws(()=>raw.append('raw borrowed'),denied);
    openRunArchive(f.traceRoot,A).append('owned');
  });
  assert.equal(readRun(f.traceRoot,A).eventCount,2);
});

test('SHA object writes require the matching writer before creating the object directory',async t=>{
  const f=fixture(t),content=Buffer.from('checkpoint version'),entry={content,size:content.length,sha256:createHash('sha256').update(content).digest('hex')};
  await f.writers.withWriter([A],async()=>createRunArchive(f.traceRoot,{}, {id:A}));
  const dir=path.join(f.traceRoot,A),objects=path.join(dir,'checkpoint-objects');
  assert.throws(()=>storeArchiveObjects(dir,[entry]),denied);assert.equal(fs.existsSync(objects),false);
  await f.writers.withWriter([B],async()=>assert.throws(()=>storeArchiveObjects(dir,[entry]),denied));
  await f.writers.withWriter([A],async()=>storeArchiveObjects(dir,[entry]));
  assert.deepEqual(fs.readFileSync(path.join(objects,entry.sha256)),content);
});

test('a live handle also refuses a different simultaneous owner of the same run',async t=>{
  const f=fixture(t),one=await f.writers.acquireOwner([A]),two=await f.writers.acquireOwner([A]);
  let handle,ready,release;const created=new Promise(done=>{ready=done;}),gate=new Promise(done=>{release=done;});
  const original=one.run(async()=>{handle=createRunArchive(f.traceRoot,{}, {id:A});ready();await gate;handle.append('origin');});
  await created;
  try{two.run(()=>{assert.throws(()=>handle.append('foreign'),denied);openRunArchive(f.traceRoot,A).append('independent');});}
  finally{release();await original;one.finish();two.finish();await Promise.all([one.writerDrained,two.writerDrained]);}
  assert.deepEqual(readRun(f.traceRoot,A).events.map(e=>e.type),['run/created','independent','origin']);
});

test('a junction spelling of a registered root cannot use the standalone trace API',async t=>{
  const f=fixture(t),alias=path.join(f.base,'alias');
  fs.symlinkSync(f.traceRoot,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>createRunArchive(alias,{}, {id:A}),{code:'E_ARCHIVE_WRITER_CONFIG'});
  assert.equal(fs.existsSync(path.join(f.traceRoot,A)),false);
});

test('journal compression requires maintenance ownership and preserves readable original events',async t=>{
  const f=fixture(t);
  await f.writers.withWriter([A],async()=>{const a=createRunArchive(f.traceRoot,{}, {id:A});a.append('large',{text:'synthetic '.repeat(1000)});a.append('run/finished',{status:'completed'});});
  const candidate=journalArchiveCandidate(f.traceRoot,A),before=readRun(f.traceRoot,A);
  await f.writers.withWriter([A],async()=>assert.throws(()=>archiveJournal(f.traceRoot,candidate),denied));
  assert.equal(fs.existsSync(path.join(f.traceRoot,A,'events.jsonl.gz')),false);
  await f.writers.withMaintenance([A],async()=>archiveJournal(f.traceRoot,candidate));
  assert.deepEqual(readRun(f.traceRoot,A).events,before.events);
  assert.equal(fs.existsSync(path.join(f.traceRoot,A,'events.jsonl')),false);
});

test('a real journal lock prevents production append and leaves bytes unchanged on timeout',{timeout:15000},async t=>{
  const f=fixture(t);
  await f.writers.withWriter([A],async()=>{
    const archive=createRunArchive(f.traceRoot,{}, {id:A}),before=fs.readFileSync(path.join(archive.dir,'events.jsonl'));
    const held=await child(f,'hold-journal',{holdMs:3200});
    assert.throws(()=>archive.append('must not appear'),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
    assert.deepEqual(fs.readFileSync(path.join(archive.dir,'events.jsonl')),before);
    assert.equal((await held.exited)[0],0);archive.append('after lock released');
  });
  assert.equal(readRun(f.traceRoot,A).eventCount,2);
});

test('two real production writers preserve contiguous sequence and deduplicate overlapping source keys',{timeout:20000},async t=>{
  const f=fixture(t);await f.writers.withWriter([A],async()=>createRunArchive(f.traceRoot,{}, {id:A}));
  const workers=await Promise.all([child(f,'append',{label:'one'}),child(f,'append',{label:'two'})]);
  workers.forEach(({proc})=>proc.send('go'));
  assert.deepEqual(await Promise.all(workers.map(async({exited})=>(await exited)[0])),[0,0]);
  const run=readRun(f.traceRoot,A);assert.equal(run.integrity,'ok');assert.equal(run.eventCount,121);
  assert.deepEqual(run.events.map(e=>e.seq),Array.from({length:121},(_,i)=>i+1));
  assert.equal(new Set(run.events.slice(1).map(e=>e.sourceKey)).size,120);
  assert.equal(run.events.filter(e=>e.type==='shared').length,40);
});

test('source guard waits for retained production append then prevents a new process writer',{timeout:15000},async t=>{
  const f=fixture(t),owner=await f.writers.acquireOwner([A]),tail=owner.retain('late trace');
  let release;const gate=new Promise(done=>{release=done;});
  const work=tail.run(async()=>{const archive=createRunArchive(f.traceRoot,{}, {id:A});await gate;archive.append('late settled');});
  owner.finish();tail.finish();await assert.rejects(f.fence.acquireSource(A),{code:'E_ARCHIVE_FENCE_TIMEOUT'});
  release();await work;await owner.writerDrained;
  const source=await f.fence.acquireSource(A);
  try{const probe=await child(f,'blocked-writer');assert.equal((await probe.exited)[0],0);}
  finally{source.release();}
  assert.equal(readRun(f.traceRoot,A).eventCount,2);
});
