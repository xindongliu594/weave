import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {ProductDshRuntime} from './product-runtime.mjs';
import {createRunArchive,readRun} from './trace-store.mjs';

const {manifest,revision}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const profile='task-attempt-openshell-v1',sha=value=>createHash('sha256').update(value).digest('hex');
const file=(path,text)=>({path,content:Buffer.from(text).toString('base64')});

// Real archive and ProductRuntime, fixture executor only. The preparation callback
// stands for coordinator SQL verification; these tests make no SQL/model claims.
function fixture(t,{initialEvent=true}={}){
 const root=mkdtempSync(join(tmpdir(),'product-recovery-')),id=randomUUID(),parent=randomUUID(),checkpointId=randomUUID();
 const initial=[file('a.txt','A checkpoint'),file('b.txt','B retained')],current=[file('a.txt','A child advanced'),file('b.txt','B retained')];
 const snapshot={projectId:randomUUID(),planVersion:1,executionProfile:profile,executionTarget:{kind:'local',backend:{kind:'openshell'}},
  executionBudget:1,policy:{maxBudget:1,maxConcurrentAgents:1,deadlineSeconds:3,contextBytes:64000},tasks:[],agents:[],
  approval:{kind:'resume',parentRunId:parent,approvedAt:new Date().toISOString()},completedCheckpoints:['b'],handoffCheckpoints:[],
  recovery:{version:1,sourceRunId:parent,workspaceCheckpoint:{id:checkpointId,runId:parent,sha256:sha('checkpoint')},files:manifest(initial),completed:[],nodes:{}}};
 const archive=createRunArchive(root,snapshot,{id}),key={runId:parent,taskId:'a',attemptId:'parent-a',generation:1};
 const initialization={version:1,childRunId:id,source:{version:1,mode:'live-sql-v1',sourceRunId:parent,
  sourceHead:{version:1,revision:revision(current),manifest:manifest(current),mergeId:randomUUID(),receipt:null},
  sourceCheckpoint:{key,id:checkpointId,sha256:sha('checkpoint'),seq:4},sourceHistoryDigest:sha('history'),
  sourceArchiveCursor:{seq:8,eventSha256:sha('event'),prefixSha256:sha('prefix'),snapshotSha256:sha('snapshot')},
  authority:{projectId:snapshot.projectId,planVersion:1,taskId:'a',contractHash:sha('contract'),permissionHash:sha('permission'),capabilityHash:sha('capability'),resourceRevision:1,
   backend:{kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')}}},
  approvalDigest:sha('approval'),readPaths:['a.txt'],writePaths:['a.txt'],checkpointWorkRevision:sha('work'),plannerScopeHash:sha('planner'),
  delta:[{path:'a.txt',beforeSha256:sha('A later'),afterSha256:sha('A checkpoint'),size:12}],
  initialHead:{version:1,revision:revision(initial),manifest:manifest(initial),mergeId:null,receipt:null},digest:sha('initialization')};
 const event={version:1,sourceKey:'task-recovery-initialized:'+id,initialization};
 if(initialEvent)archive.append('task/recovery-initialized',event);
 const prepared={kind:'task-recovery-initialized',runId:id,initializationDigest:initialization.digest,currentRevision:revision(current)};
 const artifacts=join(archive.dir,'artifacts');mkdirSync(artifacts);for(const row of current)writeFileSync(join(artifacts,row.path),Buffer.from(row.content,'base64'));
 const bytes=readFileSync(join(archive.dir,'snapshot.json'));
 t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return {root,id,snapshot,archive,event,prepared,artifacts,current,bytes};
}

function executor(f,{prepare=async()=>{throw Error('EXPECTED_PREPARE_STOP');},readCanonical=async()=>({ref:{revision:revision(f.current),manifest:manifest(f.current),mergeId:randomUUID()},files:f.current})}={}){
 return {root:f.artifacts,prepare,readCanonical,bindAttempt(){},prepareTask(){},prepareCheckpoint(){},execute(){},finalizeAccepted(){throw Error('FINALIZER_MUST_NOT_RUN');},async close(){}};
}

test('initialized recovery starts from its fixed archive without a second creation or snapshot rewrite',async t=>{
 const f=fixture(t),runtime=new ProductDshRuntime({traceRoot:f.root,createExecutor:()=>executor(f)});
 const started=await runtime.start({runId:f.id,approvedSnapshot:f.snapshot,routes:[],prepareWorkspace:()=>f.prepared});
 const result=await started.completion;await started.writerDrained;
 assert.equal(result.status,'failed');assert.match(result.message,/EXPECTED_PREPARE_STOP/);
 assert.deepEqual(readFileSync(join(f.archive.dir,'snapshot.json')),f.bytes);
 const events=readRun(f.root,f.id).events;
 assert.equal(events.filter(row=>row.type==='run/created').length,1);
 assert.equal(events.filter(row=>row.type==='task/recovery-initialized').length,1);
 assert.equal(events.filter(row=>row.type==='run/queued').length,1);
});

for(const damage of ['missing-receipt','wrong-run','wrong-digest','bad-current-revision','extra-receipt-field','async-receipt','snapshot-mismatch','missing-event','duplicate-event','wrong-event-child','wrong-event-source','duplicate-created']){
 test('recovery refuses '+damage+' before opening the initialized archive',async t=>{
  const f=fixture(t,{initialEvent:damage!=='missing-event'});let prepared=f.prepared,snapshot=f.snapshot;
  if(damage==='missing-receipt')prepared=undefined;
  if(damage==='wrong-run')prepared={...prepared,runId:randomUUID()};
  if(damage==='wrong-digest')prepared={...prepared,initializationDigest:sha('wrong')};
  if(damage==='bad-current-revision')prepared={...prepared,currentRevision:'invalid'};
  if(damage==='extra-receipt-field')prepared={...prepared,skipRecovery:true};
  if(damage==='async-receipt')prepared=Promise.resolve(prepared);
  if(damage==='snapshot-mismatch')snapshot={...snapshot,planVersion:2};
  if(damage==='duplicate-event')f.archive.append('task/recovery-initialized',f.event);
  if(damage==='wrong-event-child'||damage==='wrong-event-source'){
   const events=readRun(f.root,f.id).events;
   const marker=events.find(row=>row.type==='task/recovery-initialized').data.initialization;
   if(damage==='wrong-event-child')marker.childRunId=randomUUID();else marker.source.sourceRunId=randomUUID();
   writeFileSync(join(f.archive.dir,'events.jsonl'),events.map(row=>JSON.stringify(row)+'\n').join(''));
  }
  if(damage==='duplicate-created')f.archive.append('run/created',readRun(f.root,f.id).events[0].data);
  const original=readFileSync(join(f.archive.dir,'events.jsonl'));
  const runtime=new ProductDshRuntime({traceRoot:f.root,createExecutor:()=>{throw Error('EXECUTOR_MUST_NOT_OPEN');}});
  await assert.rejects(()=>runtime.start({runId:f.id,approvedSnapshot:snapshot,routes:[],prepareWorkspace:()=>prepared}),/TASK_RECOVERY_INITIALIZATION_INVALID/);
  assert.equal(runtime.jobs.size,0);assert.deepEqual(readFileSync(join(f.archive.dir,'snapshot.json')),f.bytes);
  assert.deepEqual(readFileSync(join(f.archive.dir,'events.jsonl')),original);
 });
}

test('ordinary starts do not reopen an unrelated existing archive',async t=>{
 const f=fixture(t),runtime=new ProductDshRuntime({traceRoot:f.root});
 const snapshot={...f.snapshot};delete snapshot.recovery;
 await assert.rejects(()=>runtime.start({runId:f.id,approvedSnapshot:snapshot,routes:[]}),error=>error.code==='EEXIST');
 assert.deepEqual(readFileSync(join(f.archive.dir,'snapshot.json')),f.bytes);
});

test('advanced recovery checks current executor canonical and ignores initial snapshot file SHAs',async t=>{
 const f=fixture(t),runtime=new ProductDshRuntime({traceRoot:f.root,createExecutor:()=>executor(f,{prepare:async()=>{}}),
  runtimeBindingsForRun:async()=>{throw Error('EXPECTED_BEFORE_HOST_STOP');}});
 const started=await runtime.start({runId:f.id,approvedSnapshot:f.snapshot,routes:[],prepareWorkspace:()=>f.prepared});
 const result=await started.completion;await started.writerDrained;
 assert.equal(result.status,'failed');assert.match(result.message,/EXPECTED_BEFORE_HOST_STOP/);
 assert.equal(readFileSync(join(f.artifacts,'a.txt'),'utf8'),'A child advanced');
 assert.deepEqual(readFileSync(join(f.archive.dir,'snapshot.json')),f.bytes);
});

for(const damage of ['missing-reader','cache-changed','canonical-revision','canonical-manifest','canonical-bytes'])test('recovery canonical refuses '+damage+' before Host creation',async t=>{
 const f=fixture(t),local=executor(f,{prepare:async()=>{}});
 if(damage==='missing-reader')delete local.readCanonical;
 if(damage==='cache-changed')local.prepare=async()=>{writeFileSync(join(f.artifacts,'a.txt'),'changed cache');};
 if(damage==='canonical-revision')local.readCanonical=async()=>({ref:{revision:sha('wrong'),manifest:manifest(f.current),mergeId:randomUUID()},files:f.current});
 if(damage==='canonical-manifest')local.readCanonical=async()=>({ref:{revision:revision(f.current),manifest:manifest(f.current).slice(1),mergeId:randomUUID()},files:f.current});
 if(damage==='canonical-bytes')local.readCanonical=async()=>({ref:{revision:revision(f.current),manifest:manifest(f.current),mergeId:randomUUID()},files:[file('a.txt','foreign'),f.current[1]]});
 const runtime=new ProductDshRuntime({traceRoot:f.root,createExecutor:()=>local,runtimeBindingsForRun:async()=>{throw Error('HOST_MUST_NOT_OPEN');}});
 const started=await runtime.start({runId:f.id,approvedSnapshot:f.snapshot,routes:[],prepareWorkspace:()=>f.prepared});
 const result=await started.completion;await started.writerDrained;
 assert.equal(result.status,'failed');assert.match(result.message,/TASK_RECOVERY_CANONICAL_(?:REQUIRED|INVALID)/);
 assert.equal(readRun(f.root,f.id).events.some(row=>row.type==='run/captain'),false);
});

test('legacy recovery still rejects a file changed from its approved recovery manifest',async t=>{
 const f=fixture(t),snapshot={...f.snapshot,executionProfile:'legacy-run-v1'},archive=createRunArchive(f.root,snapshot);
 const runtime=new ProductDshRuntime({traceRoot:f.root,createExecutor:()=>({root:f.artifacts,async prepare(){},async close(){}})});
 const job={controller:new AbortController(),cancelled:false};
 const result=await runtime.execute(job,archive,snapshot,[]);await runtime.drainJob(job);
 assert.equal(result.status,'failed');assert.match(result.message,/RECOVERY_FILE_CHANGED/);
});
