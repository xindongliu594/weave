import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunArchive} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';
import {commitStepCheckpoint,readStepCheckpoint,checkpointDigest,checkpointContract,checkpointEnvironment,validateInheritedEvidence} from './step-checkpoints.mjs';
import {prepareTaskTool} from './task-tool-context.mjs';
const sha='a'.repeat(64), profile='task-attempt-openshell-v1';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'checkpoint-v2-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const archive=createRunArchive(root,{projectId:'p',tasks:[]});const workspace=join(archive.dir,'artifacts');mkdirSync(workspace);const key={runId:archive.id,taskId:'a',attemptId:'attempt',generation:1};
 const file=(path,text)=>({path,size:Buffer.byteLength(text),sha256:checkpointDigest(text),content:Buffer.from(text)});
 // Object SHA is byte content, not JSON content.
 const a=file('a.txt','A'),b=file('private-b.txt','B');
 const {createHash}=awaitlessCrypto;for(const row of [a,b])row.sha256=createHash('sha256').update(row.content).digest('hex');
 storeArchiveObjects(archive.dir,[a,b]);const entry=({content,...rest})=>rest,work=[entry(a)],all=[entry(a),entry(b)];
 const refs={profile,key,inputManifest:[],inputOrigins:[],workManifest:work,canonical:{revision:checkpointDigest(all),manifest:all,mergeId:null},lastMerge:null,scopeHash:sha,capabilityHash:sha};
 const boundary={taskId:'a',attemptId:'attempt',sessionId:'session',trigger:'before-tool',eventCursor:1,contractHash:sha};
 return{root,archive,workspace,refs,boundary,a,b};
}
import * as awaitlessCrypto from 'node:crypto';
test('v2 uses private immutable work refs while full canonical cache is absent',t=>{
 const f=fixture(t),saved=commitStepCheckpoint({...f,taskRefs:f.refs,workspace:join(f.root,'absent-cache')});
 assert.equal(saved.version,2);assert.deepEqual(saved.files,f.refs.workManifest);assert.equal(saved.canonical.manifest.length,2);
 assert.deepEqual(readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:saved.id}).workManifest,f.refs.workManifest);
});
test('v2 rejects malformed identity, origins, hashes and receipts before publication',t=>{
 const f=fixture(t);
 for(const mutate of [r=>r.key.runId='foreign',r=>r.key.generation=0,r=>r.scopeHash='bad',r=>r.recoverySource={},r=>r.canonical.revision=sha,r=>r.inputOrigins=[{path:'a.txt',sha256:f.a.sha256,origin:{},source:{kind:'mystery'}}],r=>r.lastMerge={status:'committed'},r=>r.workManifest[0].extra='private']){
  const refs=structuredClone(f.refs);mutate(refs);assert.throws(()=>commitStepCheckpoint({...f,taskRefs:refs}),/CHECKPOINT/);
 }
});
test('v2 authenticates private canonical objects and refuses corrupt or hardlinked refs',t=>{
 const f=fixture(t),object=join(f.archive.dir,'checkpoint-objects',f.b.sha256);writeFileSync(object,'broken');
 assert.throws(()=>commitStepCheckpoint({...f,taskRefs:f.refs}),/CHECKPOINT_CONTENT/);
 writeFileSync(object,'B');linkSync(object,join(f.root,'alias'));
 assert.throws(()=>commitStepCheckpoint({...f,taskRefs:f.refs}),/CHECKPOINT_CONTENT/);
});

test('private canonical validation failures do not reveal another task filename',t=>{
 const f=fixture(t);writeFileSync(join(f.archive.dir,'checkpoint-objects',f.b.sha256),'broken');
 assert.throws(()=>commitStepCheckpoint({...f,taskRefs:f.refs}),{message:'CHECKPOINT_CONTENT_INVALID'});
});
test('v2 latest canonical and own last merge are independent but own work must match receipt',t=>{
 const f=fixture(t);f.refs.lastMerge={mergeId:'op-a',operationId:'op-a',key:f.refs.key,scopeHash:sha,beforeRevision:sha,afterRevision:sha,workRevision:checkpointDigest(f.refs.workManifest),status:'committed'};
 f.refs.canonical.mergeId='op-b';assert.equal(commitStepCheckpoint({...f,taskRefs:f.refs}).lastMerge.operationId,'op-a');
 f.refs.lastMerge.workRevision=sha;assert.throws(()=>commitStepCheckpoint({...f,taskRefs:f.refs}),/CHECKPOINT/);
});
test('task preparation holds and rejects a private checkpoint barrier before returning dispatch context',async()=>{
 let release,reject,settled=false,binds=0;let pending=new Promise((res,rej)=>{release=res;reject=rej;});
 const key={runId:'run',taskId:'a',attemptId:'attempt',generation:1},work={taskId:'a',attemptId:'attempt',executionBinding:{...key,agentId:'employee',sessionId:'session'}};
 const scope={profile,key,workRevision:sha,workspace:{scopeHash:sha}},options={snapshot:{executionProfile:profile},archive:{id:'run'},agent:{id:'session'},employee:{id:'employee'},activeWork:()=>work,handoff:{bindExecutionScope(){},bindCheckpoint(){binds++;}},sandbox:{prepareTask:async()=>scope,prepareCheckpoint:async()=>pending},signal:AbortSignal.timeout(2000)};
 const call=prepareTaskTool(options).then(v=>{settled=true;return v;});await new Promise(setImmediate);assert.equal(settled,false);assert.equal(binds,0);release({profile,key});await call;assert.equal(binds,1);
 pending=new Promise((res,rej)=>{reject=rej;});const failed=prepareTaskTool(options);await new Promise(setImmediate);reject(Error('private object fsync failed'));await assert.rejects(failed,/fsync failed/);assert.equal(binds,1);
 delete options.sandbox.prepareCheckpoint;await assert.rejects(()=>prepareTaskTool(options),/TASK_CHECKPOINT_REQUIRED/);
});


test('v2 reader rejects forged work alias, origin identity and missing private canonical objects',t=>{
 const f=fixture(t),saved=commitStepCheckpoint({...f,taskRefs:f.refs});
 const forged=(change)=>{const {sha256,seq,at,...data}=structuredClone(saved);data.id=awaitlessCrypto.randomUUID();change(data);f.archive.append('step/checkpoint',{...data,sha256:checkpointDigest(data)});return data.id;};
 for(const mutate of [d=>d.files=d.canonical.manifest,d=>d.key.runId=awaitlessCrypto.randomUUID(),d=>d.boundary.attemptId='foreign',d=>d.recoverySource={sourceRunId:f.archive.id},d=>d.receipts=[{command:'passed',inheritedFrom:{runId:f.archive.id}}]]){
  const checkpointId=forged(mutate);assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId}),/CHECKPOINT/);
 }
 rmSync(join(f.archive.dir,'checkpoint-objects',f.b.sha256));
 assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:saved.id}),/CHECKPOINT_CONTENT/);
});
test('v2 failed append never publishes refs and unfinished evidence is always fresh',t=>{
 const f=fixture(t);let id;const archive={...f.archive,append(type,data){id=data.id;throw Error('disk full');}};
 assert.throws(()=>commitStepCheckpoint({...f,archive,taskRefs:f.refs}),/disk full/);
 assert.throws(()=>readStepCheckpoint({root:f.root,runId:f.archive.id,checkpointId:id}),/CHECKPOINT_NOT_FOUND/);
 assert.deepEqual(validateInheritedEvidence({snapshot:{executionProfile:profile},task:{verificationReuse:'same-workspace'}}),{reusable:false,reasons:['TASK_REQUIRES_FRESH_VERIFICATION'],evidenceRefs:[]});
});
test('v2 source identity and capabilities change contract and environment digests',t=>{
 const f=fixture(t),snapshot={agents:[],executionTarget:{backend:{kind:'openshell',image:'node@sha256:'+sha,version:'0.1.2',policyHash:sha}}},proof={...snapshot.executionTarget.backend,node:'node',effectivePolicyHash:sha,uid:1000,gid:1000,cpu:1,memory:256},task={id:'a',assignee:'employee'};
 const contract=checkpointContract(snapshot,task,f.refs),environment=checkpointEnvironment(snapshot,proof,f.refs);
 for(const mutate of [r=>r.key.generation++,r=>r.capabilityHash='b'.repeat(64),r=>r.inputOrigins=[{source:{kind:'import',snapshotId:'other'}}]]){const refs=structuredClone(f.refs);mutate(refs);assert.notEqual(checkpointContract(snapshot,task,refs),contract);assert.notEqual(checkpointEnvironment(snapshot,proof,refs),environment);}
});

test('synchronous task checkpoint failure stays fatal across tasks and fresh generations before any tool body',async t=>{
 const {HandoffGate}=await import('./handoff.mjs'),{createTaskWorkspace}=await import('../../apps/desktop/task-workspace.cjs'),f=fixture(t);
 f.refs.workManifest=[];f.refs.canonical={revision:checkpointDigest([]),manifest:[],mergeId:null};
 const task={id:'a',assignee:'reader',dependencies:[],inputs:[],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[],verify:[]};
 const workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...f.refs.key,assigneeId:'reader',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:['a.txt'],canonicalFiles:[],origins:[]});
 const archive={...f.archive,append(type,...args){if(type==='step/checkpoint')throw Error('BEFORE_TOOL_SYNC_FAILURE');return f.archive.append(type,...args);}},gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root:f.workspace},archive});
 const scope={profile,key:f.refs.key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};
 f.refs.scopeHash=workspace.scopeHash;gate.bindExecutionScope('a','attempt',scope);gate.bindCheckpoint('a','attempt',f.refs,{sessionId:'session'});
 assert.throws(()=>gate.checkpoint('a','attempt','before-tool'),/TASK_CHECKPOINT_PUBLICATION_FAILED.*BEFORE_TOOL_SYNC_FAILURE/);
 assert.throws(()=>gate.assertCheckpointReady('b','new-attempt',99),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
 assert.throws(()=>gate.bindExecutionScope('a','attempt',{...scope,key:{...scope.key,generation:2}}),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
 let dispatched=0;await assert.rejects(()=>gate.exclusive(AbortSignal.timeout(1000),()=>{dispatched++;}),/TASK_CHECKPOINT_PUBLICATION_FAILED/);assert.equal(dispatched,0);
});
test('failed task node checkpoint preserves history without publishing a runnable committed seal',async t=>{
 const {HandoffGate}=await import('./handoff.mjs'),f=fixture(t),task={id:'a',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root:f.workspace},archive:f.archive}),record={taskId:'a',attemptId:'attempt'};
 gate.stage(record);assert.throws(()=>gate.commit(record),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
 gate.rollback(record,undefined);
 assert.equal(gate.accepted.get('a'),record,'provisional original acceptance remains history');assert.equal(gate.committed.has('a'),false,'no committed runnable seal without a checkpoint');
 assert.throws(()=>gate.assertCheckpointReady('a','other-attempt',2),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
});

for(const missing of ['session','task'])test('task commit refuses missing '+missing+' instead of publishing a checkpoint-free seal',async t=>{
 const {HandoffGate}=await import('./handoff.mjs'),{createTaskWorkspace}=await import('../../apps/desktop/task-workspace.cjs'),{readRun}=await import('./trace-store.mjs'),f=fixture(t);
 const task={id:'a',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]};
 const workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...f.refs.key,assigneeId:'reader',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});
 const refs={...f.refs,inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:checkpointDigest([]),manifest:[],mergeId:null},scopeHash:workspace.scopeHash};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root:f.workspace},archive:f.archive}),record={taskId:'a',attemptId:'attempt'};
 gate.bindExecutionScope('a','attempt',{profile,key:refs.key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]});
 if(missing==='session')gate.bindCheckpoint('a','attempt',refs);
 else{gate.bindCheckpoint('a','attempt',refs,{sessionId:'session'});gate.tasks.delete('a');}
 gate.stage(record);assert.throws(()=>gate.commit(record),/TASK_CHECKPOINT_REQUIRED/);
 assert.equal(gate.committed.has('a'),false);assert.equal(readRun(f.root,f.archive.id).events.filter(e=>e.type==='step/checkpoint').length,0);
 assert.throws(()=>gate.assertCheckpointReady('a','new-attempt',2),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
});

for(const location of ['own work','full canonical only'])test('v2 refuses redaction-changing legal filename in '+location+' before archival publication',async t=>{
 const {validateTaskCheckpointRefs}=await import('./step-checkpoints.mjs'),{HandoffGate}=await import('./handoff.mjs'),{readRun}=await import('./trace-store.mjs'),f=fixture(t),path='docs/sk-abcdefghijkl.txt';
 if(location==='own work'){f.refs.workManifest[0].path=path;f.refs.canonical.manifest[0].path=path;}else f.refs.canonical.manifest[1].path=path;
 f.refs.canonical.revision=checkpointDigest(f.refs.canonical.manifest);
 const unsafe=error=>error.message==='CHECKPOINT_METADATA_UNSAFE';
 assert.throws(()=>validateTaskCheckpointRefs(f.refs,{runId:f.archive.id,archiveDir:f.archive.dir}),unsafe);
 assert.throws(()=>commitStepCheckpoint({...f,taskRefs:f.refs}),unsafe);
 const task={id:'a',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]},gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root:f.workspace},archive:f.archive});
 assert.throws(()=>gate.bindCheckpoint('a','attempt',f.refs),unsafe);
 assert.equal(gate.committed.has('a'),false);assert.equal(readRun(f.root,f.archive.id).events.filter(event=>event.type==='step/checkpoint').length,0);
});
test('v2 refuses redaction-changing boundary and receipts without publishing a step checkpoint',async t=>{
 const {readRun}=await import('./trace-store.mjs'),f=fixture(t),unsafe=error=>error.message==='CHECKPOINT_METADATA_UNSAFE';
 assert.throws(()=>commitStepCheckpoint({...f,boundary:{...f.boundary,sessionId:'session-sk-abcdefghijkl'},taskRefs:f.refs}),unsafe);
 assert.throws(()=>commitStepCheckpoint({...f,receipts:[{command:'inspect sk-abcdefghijkl'}],taskRefs:f.refs}),unsafe);
 assert.equal(readRun(f.root,f.archive.id).events.filter(event=>event.type==='step/checkpoint').length,0);
});
test('v2 treats unexpected mutation in actual archive append return data as fatal publication',async t=>{
 const {HandoffGate}=await import('./handoff.mjs'),{createTaskWorkspace}=await import('../../apps/desktop/task-workspace.cjs'),{readRun}=await import('./trace-store.mjs'),f=fixture(t);
 const task={id:'a',assignee:'reader',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:[]},workspace=createTaskWorkspace({binding:{projectId:'fixture',planVersion:1,...f.refs.key,assigneeId:'reader',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths:[],writePaths:[],canonicalFiles:[],origins:[]});
 const refs={...f.refs,inputManifest:[],inputOrigins:[],workManifest:[],canonical:{revision:checkpointDigest([]),manifest:[],mergeId:null},scopeHash:workspace.scopeHash};
 const archive={...f.archive,append(type,...args){const event=f.archive.append(type,...args);return type==='step/checkpoint'?{...event,data:{...event.data,unexpected:'writer mutation'}}:event;}};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root:f.workspace},archive}),record={taskId:'a',attemptId:'attempt'};
 gate.bindExecutionScope('a','attempt',{profile,key:refs.key,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]});gate.bindCheckpoint('a','attempt',refs,{sessionId:'session'});gate.stage(record);
 assert.throws(()=>gate.commit(record),/TASK_CHECKPOINT_PUBLICATION_FAILED: CHECKPOINT_METADATA_UNSAFE/);assert.equal(gate.committed.has('a'),false);
 assert.throws(()=>gate.assertCheckpointReady('b','attempt2',2),/TASK_CHECKPOINT_PUBLICATION_FAILED/);
 const saved=readRun(f.root,f.archive.id).events.find(event=>event.type==='step/checkpoint');assert.ok(saved,'already appended event remains historical evidence');assert.equal(saved.data.unexpected,undefined,'actual durable event is not rewritten to the mutated return value');
});
