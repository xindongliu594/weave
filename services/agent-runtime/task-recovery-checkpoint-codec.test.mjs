import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunArchive,readRun} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';
import {checkpointDigest,checkpointContract,checkpointEnvironment,validateTaskCheckpointRefs,commitStepCheckpoint,readStepCheckpoint} from './step-checkpoints.mjs';

const child='11111111-1111-4111-8111-111111111111',parent='22222222-2222-4222-8222-222222222222',checkpointId='33333333-3333-4333-8333-333333333333';
const sha='a'.repeat(64),init='e'.repeat(64),profile='task-attempt-openshell-v1';
const file=(path,content)=>({path,size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
const snapshot={agents:[],executionTarget:{backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}}};
const proof={...snapshot.executionTarget.backend,node:'node',effectivePolicyHash:sha,uid:1000,gid:1000,cpu:1,memory:256};
const task={id:'a',assignee:'employee',outputs:[{path:'a.txt'}]};
function fixture(){
 const key={runId:child,taskId:'a',attemptId:'child-attempt',generation:1},sourceKey={runId:parent,taskId:'a',attemptId:'parent-attempt',generation:9};
 const work=[file('a.txt','A'),file('b.txt','B'),file('input.txt','input')],all=[...work,file('private.txt','private')];
 const recoverySeed={version:1,initializationDigest:init,sourceCheckpoint:{key:sourceKey,id:checkpointId,sha256:'c'.repeat(64),seq:17},workRevision:checkpointDigest(work)};
 const origins=[
  {path:'a.txt',runId:parent,taskId:'a',attemptId:sourceKey.attemptId,acceptedRevision:recoverySeed.workRevision,checkpointId},
  {path:'b.txt',runId:parent,taskId:'b',attemptId:'accepted-attempt',acceptedRevision:'b'.repeat(64)},
  {path:'input.txt',runId:child,taskId:'import',attemptId:'snapshot',acceptedRevision:sha}
 ];
 const inputManifest=work.map((entry,index)=>({...entry,origin:origins[index]}));
 const inputOrigins=[
  {path:'b.txt',sha256:work[1].sha256,origin:origins[1],source:{kind:'recovery-accepted',initializationDigest:init,key:{runId:parent,taskId:'b',attemptId:'accepted-attempt',generation:4},revision:'b'.repeat(64),acceptedDigest:'d'.repeat(64)}},
  {path:'input.txt',sha256:work[2].sha256,origin:origins[2],source:{kind:'import',snapshotId:'fixed-input',sha256:work[2].sha256,agentIds:['employee']}}
 ];
 return {profile,key,inputManifest,inputOrigins,workManifest:work,canonical:{revision:checkpointDigest(all),manifest:all,mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha,recoverySeed};
}
function legacyFixture(){
 const refs=fixture();delete refs.recoverySeed;
 refs.inputManifest=refs.inputManifest.slice(1);refs.inputOrigins[0].origin.runId=child;
 refs.inputOrigins[0].source={kind:'accepted',runId:child,taskId:'b',attemptId:'accepted-attempt',revision:'b'.repeat(64)};
 return refs;
}
const invalid=fn=>assert.throws(fn,/CHECKPOINT_(REFS|ORIGIN|MANIFEST|METADATA)_/);

test('v2 accepts exact parent checkpoint seed while keeping child identity and lower generation',()=>{
 const refs=fixture();assert.equal(validateTaskCheckpointRefs(refs,{runId:child,taskId:'a',attemptId:'child-attempt',generation:1}),refs);
 assert.equal(refs.key.generation,1);assert.equal(refs.recoverySeed.sourceCheckpoint.key.generation,9);
});

test('recovery seed and every nested pin reject missing, unknown or invalid fields',()=>{
 for(const mutate of [
  r=>r.recoverySeed=undefined,r=>r.recoverySeed=null,r=>r.recoverySeed.version=2,r=>r.recoverySeed.extra=true,
  r=>delete r.recoverySeed.workRevision,r=>r.recoverySeed.workRevision='invalid',r=>r.recoverySeed.initializationDigest='invalid',
  r=>r.recoverySeed.sourceCheckpoint.extra=true,r=>r.recoverySeed.sourceCheckpoint.id='invalid',r=>r.recoverySeed.sourceCheckpoint.sha256='invalid',
  r=>r.recoverySeed.sourceCheckpoint.seq=0,r=>r.recoverySeed.sourceCheckpoint.seq=Number.MAX_SAFE_INTEGER+1,
  r=>r.recoverySeed.sourceCheckpoint.key.generation=0,r=>r.recoverySeed.sourceCheckpoint.key.generation=1.5,
  r=>r.recoverySeed.sourceCheckpoint.key.generation=Number.MAX_SAFE_INTEGER+1,r=>delete r.recoverySeed.sourceCheckpoint.key.generation,
  r=>r.recoverySeed.sourceCheckpoint.key.extra=true,r=>r.recoverySeed.sourceCheckpoint.key.runId=child,
  r=>r.recoverySeed.sourceCheckpoint.key.runId='invalid',r=>r.recoverySeed.sourceCheckpoint.key.taskId='other-task'
 ]){const refs=fixture();mutate(refs);invalid(()=>validateTaskCheckpointRefs(refs));}
 invalid(()=>validateTaskCheckpointRefs(fixture(),{generation:2}));
});

test('only exact seed origins without fixed input ancestry can cross the run boundary',()=>{
 for(const mutate of [
  r=>delete r.recoverySeed,r=>r.inputManifest[0].origin.checkpointId='44444444-4444-4444-8444-444444444444',
  r=>delete r.inputManifest[0].origin.checkpointId,r=>r.inputManifest[0].origin.acceptedRevision=sha,
  r=>r.inputManifest[0].origin.runId='44444444-4444-4444-8444-444444444444',r=>r.inputManifest[0].origin.taskId='b',
  r=>r.inputManifest[0].origin.attemptId='foreign-attempt',r=>r.inputManifest[0].origin.generation=9,
  r=>r.workManifest=r.workManifest.slice(1),r=>r.inputOrigins.push({...r.inputOrigins[1],path:'a.txt',origin:r.inputManifest[0].origin,sha256:r.inputManifest[0].sha256})
 ]){const refs=fixture();mutate(refs);invalid(()=>validateTaskCheckpointRefs(refs));}
});

test('recovery-accepted binds foreign origin, complete source generation and initialization',()=>{
 for(const mutate of [
  s=>s.kind='accepted',s=>delete s.key.generation,s=>s.key.generation=0,s=>s.key.generation=1.5,
  s=>s.key.extra=true,s=>s.key.runId=child,s=>s.key.runId='invalid',s=>s.key.taskId='a',s=>s.key.attemptId='different',
  s=>s.revision=sha,s=>s.initializationDigest=sha,s=>s.acceptedDigest='invalid',s=>s.extra=true,s=>s.checkpointId=checkpointId
 ]){const refs=fixture();mutate(refs.inputOrigins[0].source);invalid(()=>validateTaskCheckpointRefs(refs));}
 const refs=fixture();refs.inputManifest=refs.inputManifest.slice(1);delete refs.recoverySeed;
 assert.equal(validateTaskCheckpointRefs(refs),refs,'another child task can consume retained inputs without an own seed');
 refs.inputOrigins[0].source.initializationDigest='invalid';invalid(()=>validateTaskCheckpointRefs(refs));
});

test('retained seals allow multiple outputs but reject duplicate paths and conflicting producer identities',()=>{
 const refs=fixture(),second=file('b2.txt','B2'),origin={...refs.inputOrigins[0].origin,path:'b2.txt'};
 refs.workManifest.splice(2,0,second);refs.inputManifest.splice(2,0,{...second,origin});refs.canonical.manifest.splice(2,0,second);refs.canonical.revision=checkpointDigest(refs.canonical.manifest);
 refs.inputOrigins.push({path:second.path,sha256:second.sha256,origin,source:structuredClone(refs.inputOrigins[0].source)});
 assert.equal(validateTaskCheckpointRefs(refs),refs);
 for(const mutate of [r=>r.inputOrigins.push(structuredClone(r.inputOrigins[0])),r=>r.inputOrigins[2].source.key.generation++,r=>r.inputOrigins[2].source.acceptedDigest=sha,r=>r.inputOrigins[2].source.initializationDigest=sha]){
  const bad=structuredClone(refs);mutate(bad);invalid(()=>validateTaskCheckpointRefs(bad));
 }
});

test('old import and accepted sources never gain foreign-origin or checkpoint-id permission',()=>{
 const refs=legacyFixture();assert.equal(validateTaskCheckpointRefs(refs),refs);
 for(const mutate of [r=>r.inputOrigins[0].origin.runId=parent,r=>r.inputOrigins[1].origin.runId=parent,r=>r.inputManifest[0].origin.checkpointId=checkpointId,r=>r.recoverySource={}]){
  const bad=structuredClone(refs);mutate(bad);invalid(()=>validateTaskCheckpointRefs(bad));
 }
});

test('child own-origin rolling state retains the original seed without purporting to authenticate SQL',()=>{
 const refs=fixture();refs.inputManifest[0].origin={path:'a.txt',runId:child,taskId:'a',attemptId:refs.key.attemptId,acceptedRevision:sha};
 refs.lastMerge={mergeId:'child-operation',operationId:'child-operation',key:refs.key,scopeHash:sha,beforeRevision:sha,afterRevision:sha,workRevision:checkpointDigest(refs.workManifest),status:'committed'};
 assert.equal(validateTaskCheckpointRefs(refs),refs);
 refs.lastMerge.key={...refs.key,generation:2};invalid(()=>validateTaskCheckpointRefs(refs));
});

test('new recovery metadata participates in explicit-domain contract and environment hashes',()=>{
 const refs=fixture(),contract=checkpointContract(snapshot,task,refs),environment=checkpointEnvironment(snapshot,proof,refs);
 for(const mutate of [r=>r.recoverySeed.initializationDigest=sha,r=>r.recoverySeed.sourceCheckpoint.key.generation++,r=>r.recoverySeed.sourceCheckpoint.seq++,r=>r.recoverySeed.sourceCheckpoint.sha256=sha,r=>r.recoverySeed.workRevision=sha,r=>r.inputOrigins[0].source.acceptedDigest=sha]){
  const changed=structuredClone(refs);mutate(changed);assert.notEqual(checkpointContract(snapshot,task,changed),contract);assert.notEqual(checkpointEnvironment(snapshot,proof,changed),environment);
 }
 const {profile:executionProfile,key,inputManifest,inputOrigins,scopeHash,capabilityHash}=refs;
 const oldContract=checkpointDigest({legacy:checkpointContract(snapshot,task),profile:executionProfile,key,inputManifest,inputOrigins,scopeHash,capabilityHash});
 const oldEnvironment=checkpointDigest({legacy:checkpointEnvironment(snapshot,proof),profile:executionProfile,key,inputManifest,inputOrigins,scopeHash,capabilityHash});
 assert.notEqual(contract,oldContract);assert.notEqual(environment,oldEnvironment);
 delete refs.recoverySeed;assert.notEqual(checkpointContract(snapshot,task,refs),checkpointDigest({legacy:checkpointContract(snapshot,task),profile:executionProfile,key,inputManifest,inputOrigins,scopeHash,capabilityHash}));
});

test('old v2 contract and environment golden hashes remain byte-identical',()=>{
 const refs={profile,key:{runId:child,taskId:'a',attemptId:'child-attempt',generation:1},inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:checkpointDigest([]),manifest:[],mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha};
 assert.equal(checkpointContract(snapshot,task,refs),'4dac51ebcc57823d6c4213108a07a1502edf98ec9f2a33da4419088b124e06f9');
 assert.equal(checkpointEnvironment(snapshot,proof,refs),'b3dfd0717906cb8fa401b4fb3a64c560b63c829b6b2c0600bf7fa4e136739a79');
 assert.equal(Object.hasOwn(refs,'recoverySeed'),false);
});

test('seed v2 roundtrip preserves source pins and rejects rehashed malformed historical records',t=>{
 const root=mkdtempSync(join(tmpdir(),'recovery-cp-codec-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const archive=createRunArchive(root,{projectId:'p',tasks:[]}),refs=fixture();refs.key.runId=archive.id;
 refs.inputOrigins[1].origin.runId=archive.id;
 storeArchiveObjects(archive.dir,[['a.txt','A'],['b.txt','B'],['input.txt','input'],['private.txt','private']].map(([path,text])=>({...file(path,text),content:Buffer.from(text)})));
 const boundary={taskId:'a',attemptId:refs.key.attemptId,sessionId:'child-session',trigger:'before-tool',eventCursor:1,contractHash:checkpointContract(snapshot,task,refs)};
 const saved=commitStepCheckpoint({archive,taskRefs:refs,boundary});
 assert.deepEqual(readStepCheckpoint({root,runId:archive.id,checkpointId:saved.id}),saved);
 const {sha256,seq,at,...forged}=structuredClone(saved);forged.id='44444444-4444-4444-8444-444444444444';forged.recoverySeed.sourceCheckpoint.key.generation=0;
 archive.append('step/checkpoint',{...forged,sha256:checkpointDigest(forged)});
 invalid(()=>readStepCheckpoint({root,runId:archive.id,checkpointId:forged.id}));
 const before=readRun(root,archive.id).events.length;
 refs.recoverySeed.sourceCheckpoint.key.attemptId='sk-abcdefghijkl';
 assert.throws(()=>commitStepCheckpoint({archive,taskRefs:refs,boundary}),/CHECKPOINT_METADATA_UNSAFE/);assert.equal(readRun(root,archive.id).events.length,before);
 refs.recoverySeed.sourceCheckpoint.key.attemptId='parent-attempt';refs.inputOrigins[1].source.agentIds=['employee-'+'x'.repeat(512*1024)];
 assert.throws(()=>commitStepCheckpoint({archive,taskRefs:refs,boundary}),/CHECKPOINT_STORAGE_LIMIT/);assert.equal(readRun(root,archive.id).events.length,before);
});
