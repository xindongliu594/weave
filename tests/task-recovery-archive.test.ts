import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AsyncResource} from 'node:async_hooks';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createArchiveWriterManager,registerArchiveWriterRoot} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {archiveJournal,journalArchiveCandidate} from '../services/agent-runtime/journal-archive.mjs';

const implementation=await import('../apps/api/src/task-recovery-archive.ts').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {readTaskRecoveryArchive:undefined};throw error;
});
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',P='00000000-0000-4000-8000-000000000003';
const invalid={status:409,code:'TASK_RECOVERY_ARCHIVE_INVALID'},scopeError={code:'E_ARCHIVE_WRITER_SCOPE'};
const managerError={code:'E_ARCHIVE_WRITER_CONFIG'};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const digest=(v:unknown)=>sha(JSON.stringify(sorted(v)));

async function fixture(t:TestContext,extra:Record<string,unknown>={}){
  assert.equal(typeof implementation.readTaskRecoveryArchive,'function','private archive reader must exist');
  const read=implementation.readTaskRecoveryArchive!;
  const temp=fs.realpathSync.native(process.env.TASK_RECOVERY_ARCHIVE_TEMP??os.tmpdir()),base=fs.mkdtempSync(path.join(temp,'recovery-archive-'));
  t.after(()=>{
    assert.equal(fs.realpathSync.native(base),base);
    assert.match(path.relative(temp,base),/^recovery-archive-[A-Za-z0-9]+$/);
    fs.rmSync(base,{recursive:true,force:true});
  });
  const traceRoot=path.join(base,'runs'),writers=createArchiveWriterManager({traceRoot});
  registerArchiveWriterRoot(writers);
  const sql={id:A,project_id:P,project_version:2,snapshot:{projectId:P,planVersion:2,title:'private archive',nested:{b:2,a:1},apiKey:'fixture-private-value',...extra}};
  await writers.withWriter([A],()=>{
    const archive=createRunArchive(traceRoot,sql.snapshot,{id:A});
    archive.append('step/checkpoint',{taskId:'a',checkpointId:'old-a'});
    archive.append('handoff/accepted',{taskId:'b',revision:'retained-b'});
    archive.append('run/finished',{status:'failed'});
  });
  const dir=path.join(traceRoot,A),snapshotFile=path.join(dir,'snapshot.json'),eventsFile=path.join(dir,'events.jsonl');
  const events=()=>fs.readFileSync(eventsFile,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  const writeEvents=(value:unknown[])=>fs.writeFileSync(eventsFile,value.map(v=>JSON.stringify(v)).join('\n')+'\n');
  const rewriteSnapshot=(change:(value:any)=>void)=>{
    const value=JSON.parse(fs.readFileSync(snapshotFile,'utf8'));change(value);
    const raw=JSON.stringify(value);fs.writeFileSync(snapshotFile,raw);
    const journal=events();journal[0].data.snapshotSha256=sha(raw);writeEvents(journal);
  };
  const capture=(value:unknown=sql)=>writers.withSource(A,()=>read(writers,value));
  return {base,traceRoot,writers,sql,dir,snapshotFile,eventsFile,events,writeEvents,rewriteSnapshot,capture,read};
}

test('pins every event after the old checkpoint and returns detached snapshot/events/cursor',async t=>{
  const f=await fixture(t),before=fs.readFileSync(f.eventsFile),snapshot=fs.readFileSync(f.snapshotFile);
  const result=await f.capture(),events=f.events(),snapshotSha256=sha(snapshot);
  assert.deepEqual(result.snapshot,JSON.parse(snapshot.toString()));
  assert.equal(result.snapshot.apiKey,'[REDACTED]');
  assert.deepEqual(result.events,events);
  assert.deepEqual(result.cursor,{seq:4,snapshotSha256,eventSha256:digest(events[3]),prefixSha256:digest({kind:'task-source-archive-prefix',version:1,runId:A,throughSeq:4,snapshotSha256,events})});
  assert.deepEqual(Object.keys(result).sort(),['cursor','events','snapshot']);
  assert.deepEqual(fs.readFileSync(f.eventsFile),before);assert.deepEqual(fs.readFileSync(f.snapshotFile),snapshot);
  result.snapshot.nested.a=999;result.events[2].data.revision='changed';result.cursor.seq=1;
  const second=await f.capture();assert.equal(second.snapshot.nested.a,1);assert.equal(second.events[2].data.revision,'retained-b');assert.equal(second.cursor.seq,4);
});

test('rejects missing, duplicate, misplaced or malformed run/created even when readRun reports ok',async t=>{
  for(const kind of ['missing','duplicate','misplaced','missing-sha','wrong-sha']){
    const f=await fixture(t),events=f.events();
    if(kind==='missing')events.shift();
    if(kind==='duplicate')events.push(structuredClone(events[0]));
    if(kind==='misplaced')[events[0],events[1]]=[events[1],events[0]];
    if(kind==='missing-sha')delete events[0].data.snapshotSha256;
    if(kind==='wrong-sha')events[0].data.snapshotSha256='not-a-sha';
    events.forEach((event,i)=>event.seq=i+1);f.writeEvents(events);
    if(kind!=='wrong-sha')assert.equal(readRun(f.traceRoot,A)!.integrity,'ok');
    await assert.rejects(f.capture(),invalid,kind);
  }
});

test('rejects raw snapshot mutation and SQL snapshot mismatches without repairing either file',async t=>{
  const f=await fixture(t);fs.appendFileSync(f.snapshotFile,' ');
  assert.equal(readRun(f.traceRoot,A)!.integrity,'incomplete');
  await assert.rejects(f.capture(),invalid);
  assert.ok(fs.readFileSync(f.snapshotFile,'utf8').endsWith(' '));
  const other=await fixture(t);other.rewriteSnapshot(value=>value.nested.a=44);
  assert.equal(readRun(other.traceRoot,A)!.integrity,'ok');await assert.rejects(other.capture(),invalid);
});

test('SQL/archive identity, version and injected fields follow actual createRunArchive rules',async t=>{
  const good=await fixture(t,{id:A,formatVersion:1,createdAt:'2020-01-02T03:04:05.000Z'});
  assert.equal((await good.capture()).snapshot.createdAt,'2020-01-02T03:04:05.000Z');
  for(const extra of [{id:B},{formatVersion:2},{createdAt:'not-a-time'},{projectId:B},{planVersion:3}]){
    const f=await fixture(t,extra);await assert.rejects(f.capture(),invalid);
  }
  for(const change of [(s:any)=>s.id=B,(s:any)=>s.projectId=B,(s:any)=>s.planVersion=3,(s:any)=>s.formatVersion=2,(s:any)=>s.createdAt='2020-02-31T00:00:00.000Z']){
    const f=await fixture(t);f.rewriteSnapshot(change);await assert.rejects(f.capture(),invalid);
  }
});

test('SQL projection requires exact keys, strict UUIDs, positive safe planVersion and strict JSON',async t=>{
  const f=await fixture(t);
  for(const changed of [
    {...f.sql,id:'------------------------------------'}, {...f.sql,project_id:'AAAAAAAA-0000-4000-8000-000000000003'},
    {...f.sql,project_version:0}, {...f.sql,project_version:1.5}, {...f.sql,project_version:Number.MAX_SAFE_INTEGER+1},
    {...f.sql,verified:true}, {...f.sql,snapshot:undefined}, {...f.sql,snapshot:{...f.sql.snapshot,missing:undefined}},
    {...f.sql,snapshot:{...f.sql.snapshot,amount:Infinity}}, {...f.sql,snapshot:{...f.sql.snapshot,amount:NaN}},
    {...f.sql,snapshot:{...f.sql.snapshot,hidden:Symbol('not-json')}}, {...f.sql,snapshot:{...f.sql.snapshot,when:new Date()}},
  ])await assert.rejects(f.capture(changed),invalid);
  const missing:any={...f.sql};delete missing.project_version;await assert.rejects(f.capture(missing),invalid);
  const cycle:any={...f.sql.snapshot};cycle.loop=cycle;await assert.rejects(f.capture({...f.sql,snapshot:cycle}),invalid);
  // Matching malformed SQL/archive values must still fail identity schemas;
  // a mere SQL/archive equality check is insufficient.
  const badProject='AAAAAAAA-0000-4000-8000-000000000003',matchingProject=await fixture(t,{projectId:badProject});
  matchingProject.sql.project_id=badProject;await assert.rejects(matchingProject.capture(),invalid);
  for(const planVersion of [0,1.5,Number.MAX_SAFE_INTEGER+1]){
    const matching=await fixture(t,{planVersion});matching.sql.project_version=planVersion;await assert.rejects(matching.capture(),invalid);
  }
});

test('strict JSON rejects getters without invoking them, sparse arrays, proxies and hidden fields',async t=>{
  const f=await fixture(t);let invoked=false;
  const accessor=Object.defineProperty({...f.sql.snapshot},'business',{get(){invoked=true;return 'secret';},enumerable:true});
  const hidden=Object.defineProperty({...f.sql.snapshot},'business',{value:'secret',enumerable:false});
  const sparse=[1,,3];
  for(const snapshot of [accessor,hidden,new Proxy({...f.sql.snapshot},{}),{...f.sql.snapshot,sparse}])await assert.rejects(f.capture({...f.sql,snapshot}),invalid);
  assert.equal(invoked,false);
});

test('rejects gaps, torn tail, malformed events and nonfinite values read from JSONL',async t=>{
  for(const kind of ['gap','tail','nonfinite','null','array','missing-type','missing-data']){
    const f=await fixture(t),events=f.events();
    if(kind==='gap')events[2].seq=7;
    if(kind==='null')events[2]=null;
    if(kind==='array')events[2]=[1,2];
    if(kind==='missing-type')delete events[2].type;
    if(kind==='missing-data')delete events[2].data;
    f.writeEvents(events);
    if(kind==='tail')fs.appendFileSync(f.eventsFile,'{"seq":5');
    if(kind==='nonfinite')fs.writeFileSync(f.eventsFile,fs.readFileSync(f.eventsFile,'utf8').replace('"retained-b"','1e400'));
    const before=fs.readFileSync(f.eventsFile);await assert.rejects(f.capture(),invalid,kind);assert.deepEqual(fs.readFileSync(f.eventsFile),before);
  }
});

test('changing an early accepted record changes the full prefix pin while the same tail pin stays fixed',async t=>{
  const f=await fixture(t),first=await f.capture(),events=f.events();events[2].data.revision='replacement-b';f.writeEvents(events);
  const second=await f.capture();assert.equal(second.cursor.eventSha256,first.cursor.eventSha256);assert.notEqual(second.cursor.prefixSha256,first.cursor.prefixSha256);
  // Prefix capture is a fact pin; consistency against a previous capture belongs to the caller.
  assert.equal(second.cursor.seq,4);
});

test('object key order is stable while array order remains evidence',async t=>{
  const f=await fixture(t),first=await f.capture(),events=f.events();
  f.writeEvents(events.map(v=>Object.fromEntries(Object.entries(v).reverse())));
  assert.deepEqual((await f.capture()).cursor,first.cursor);
  events[2].data.order=['b','a'];f.writeEvents(events);const second=await f.capture();
  events[2].data.order.reverse();f.writeEvents(events);assert.notEqual((await f.capture()).cursor.prefixSha256,second.cursor.prefixSha256);
});

test('canonical digest sorts numeric-looking object keys lexically rather than JS enumeration order',async t=>{
  const f=await fixture(t),events=f.events();
  events[3]={at:'2020-01-02T03:04:05.000Z',type:'evidence/test',seq:4,data:{'2':'two','10':'ten'}};
  f.writeEvents(events);
  const expected='{"at":"2020-01-02T03:04:05.000Z","data":{"10":"ten","2":"two"},"seq":4,"type":"evidence/test"}';
  assert.equal((await f.capture()).cursor.eventSha256,sha(expected));
});

test('compressed journals preserve the same full prefix; both-file interrupted archives prefer plain',async t=>{
  const f=await fixture(t);
  await f.writers.withWriter([A],()=>{
    // Existing archive handles intentionally expire with their writer context.
    const raw=f.events();raw[1].data.output='compressible evidence\n'.repeat(2000);raw[3].data.status='completed';f.writeEvents(raw);
  });
  const plain=fs.readFileSync(f.eventsFile),before=await f.capture();
  await f.writers.withMaintenance([A],()=>archiveJournal(f.traceRoot,journalArchiveCandidate(f.traceRoot,A)));
  assert.deepEqual(await f.capture(),before);
  fs.writeFileSync(f.eventsFile,plain);assert.deepEqual(await f.capture(),before);
  const events=f.events();events[2].data.revision='new authoritative plain';f.writeEvents(events);
  const after=await f.capture();assert.notEqual(after.cursor.prefixSha256,before.cursor.prefixSha256);
  fs.unlinkSync(f.eventsFile);fs.writeFileSync(path.join(f.dir,'events.jsonl.gz'),'corrupt');await assert.rejects(f.capture(),invalid);
});

test('rejects hardlinked snapshot/journal and symlink or junction directory/file aliases',async t=>{
  for(const name of ['snapshot.json','events.jsonl']){
    const f=await fixture(t);fs.linkSync(path.join(f.dir,name),path.join(f.base,'alias'));
    await assert.rejects(f.capture(),invalid);
  }
  const f=await fixture(t),moved=path.join(f.base,'moved-run');fs.renameSync(f.dir,moved);fs.symlinkSync(moved,f.dir,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.capture(),invalid);fs.unlinkSync(f.dir);
  // A file symlink needs Windows developer privileges; junction coverage above is unconditional.
  if(process.platform!=='win32'){
    const other=await fixture(t),target=path.join(other.base,'outside.json');fs.renameSync(other.snapshotFile,target);fs.symlinkSync(target,other.snapshotFile);
    await assert.rejects(other.capture(),invalid);
  }
});

test('enforces bounds by refusing the whole archive rather than returning a truncated prefix',async t=>{
  const f=await fixture(t);f.sql.snapshot.title='x'.repeat(8*1024*1024);
  f.rewriteSnapshot(value=>value.title=f.sql.snapshot.title);await assert.rejects(f.capture(),invalid);
  const other=await fixture(t),events=other.events();events[1].data.nested={};let cursor=events[1].data.nested;
  for(let i=0;i<130;i++)cursor=cursor.child={};other.writeEvents(events);await assert.rejects(other.capture(),invalid);
});

test('requires the real live source scope for the same run and rejects expired callbacks',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.read(f.writers,f.sql),scopeError);
  await f.writers.withSource(B,()=>assert.throws(()=>f.read(f.writers,f.sql),scopeError));
  let expired!:()=>unknown;
  await f.writers.withSource(A,()=>{f.read(f.writers,f.sql);expired=AsyncResource.bind(()=>f.read(f.writers,f.sql));});
  assert.throws(()=>expired(),scopeError);
  await f.writers.withWriter([A],()=>assert.throws(()=>f.read(f.writers,f.sql),scopeError));
});

test('rejects structural fake managers before touching their traceRoot',async t=>{
  const f=await fixture(t);let touched=false;
  const fake={assertSource(){},get traceRoot(){touched=true;throw Error('unprotected root must never be inspected');}};
  assert.throws(()=>f.read(fake as any,f.sql),managerError);assert.equal(touched,false);
});

test('borrowed real source methods cannot authorize a cloned manager or a substituted root',async t=>{
  const f=await fixture(t);let touched=false;
  const clone={...f.writers,get traceRoot(){touched=true;throw Error('substituted root must never be inspected');}};
  await f.writers.withSource(A,()=>assert.throws(()=>f.read(clone as any,f.sql),managerError));assert.equal(touched,false);
});

for(const mode of ['input-strings','raw-snapshot','raw-journal'])test('bounds '+mode+' before exhausting a 128 MiB child heap',async t=>{
  const f=await fixture(t);
  const implementationUrl=pathToFileURL(path.resolve('apps/api/src/task-recovery-archive.ts')).href;
  const managerUrl=pathToFileURL(path.resolve('services/agent-runtime/archive-writer-scope.mjs')).href;
  const script=`import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
    import {readTaskRecoveryArchive} from ${JSON.stringify(implementationUrl)};
    import {createArchiveWriterManager,registerArchiveWriterRoot} from ${JSON.stringify(managerUrl)};
    const source=${JSON.stringify(f.sql)},root=${JSON.stringify(f.traceRoot)},mode=${JSON.stringify(mode)};
    const writers=createArchiveWriterManager({traceRoot:root});registerArchiveWriterRoot(writers);
    const dir=path.join(root,source.id),snapshotFile=path.join(dir,'snapshot.json'),journalFile=path.join(dir,'events.jsonl');
    if(mode==='input-strings')source.snapshot.wide=Array(4096).fill('x'.repeat(1024*1024));
    if(mode==='raw-snapshot'){
      const raw=fs.readFileSync(snapshotFile,'utf8').slice(0,-1)+',"wide":['+'0,'.repeat(2999999)+'0]}';
      fs.writeFileSync(snapshotFile,raw);
      const events=fs.readFileSync(journalFile,'utf8').trimEnd().split('\\n').map(JSON.parse);
      events[0].data.snapshotSha256=createHash('sha256').update(raw).digest('hex');
      fs.writeFileSync(journalFile,events.map(v=>JSON.stringify(v)).join('\\n')+'\\n');
    }
    if(mode==='raw-journal')fs.appendFileSync(journalFile,'{"seq":5,"at":"2020-01-02T03:04:05.000Z","type":"evidence/wide","data":['+'0,'.repeat(2999999)+'0]}\\n');
    try{await writers.withSource(source.id,()=>readTaskRecoveryArchive(writers,source));process.exitCode=2;}
    catch(error){if(error?.code!=='TASK_RECOVERY_ARCHIVE_INVALID')throw error;console.log('BOUNDED_ARCHIVE_REFUSAL');}
    if(mode==='input-strings'){
      source.snapshot.wide=Array(3000000).fill(0);
      try{await writers.withSource(source.id,()=>readTaskRecoveryArchive(writers,source));process.exitCode=2;}
      catch(error){if(error?.code!=='TASK_RECOVERY_ARCHIVE_INVALID')throw error;console.log('BOUNDED_ARRAY_REFUSAL');}
    }`;
  const child=spawnSync(process.execPath,['--max-old-space-size=128','--import','tsx','--input-type=module','--eval',script],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:64*1024});
  assert.ifError(child.error);assert.equal(child.status,0,child.stderr.slice(-1600));assert.match(child.stdout,/BOUNDED_ARCHIVE_REFUSAL/);
  if(mode==='input-strings')assert.match(child.stdout,/BOUNDED_ARRAY_REFUSAL/);
});
