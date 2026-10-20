import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {HandoffGate,workspaceRevision} from './handoff.mjs';
import {prepareTaskTool,taskScopeBinding,assertTaskScopeBinding} from './task-tool-context.mjs';
import {Context} from '@deepseek-ai/cordis';
import {installProductTools} from './product-tools.mjs';
import {Semaphore} from './limits.mjs';
import {ProductDshRuntime} from './product-runtime.mjs';
import {createRunArchive} from './trace-store.mjs';
import {storeArchiveObjects} from './archive-objects.mjs';
const {createTaskWorkspace}=createRequire(import.meta.url)('../../apps/desktop/task-workspace.cjs');
const {exportFiles,revision,manifest}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const sha='a'.repeat(64),profile='task-attempt-openshell-v1';
const key={runId:'run',taskId:'a',attemptId:'attempt',generation:1};
function scope(root,generation=1,identity=key){const taskKey={...identity,generation},files=exportFiles(root),readPaths=files.some(file=>file.path==='a.txt')?['a.txt']:[],origins=readPaths.map(path=>({path,runId:taskKey.runId,taskId:taskKey.taskId,attemptId:taskKey.attemptId,acceptedRevision:revision(files)}));const workspace=createTaskWorkspace({binding:{projectId:'project',planVersion:1,...taskKey,assigneeId:'employee',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths,writePaths:['a.txt'],canonicalFiles:files,origins});return{profile,key:taskKey,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:[]};}

function bindResultRefs(gate,s,root,result){
 const all=exportFiles(root),allowed=new Set([...s.workspace.readPaths,...s.workspace.writePaths]);
 storeArchiveObjects(gate.archive.dir,manifest(all).map(row=>({...row,content:Buffer.from(all.find(f=>f.path===row.path).content,'base64')})));
 gate.bindCheckpoint(s.key.taskId,s.key.attemptId,{profile,key:s.key,inputManifest:s.workspace.inputManifest,inputOrigins:[],workManifest:manifest(all.filter(f=>allowed.has(f.path))),canonical:{revision:revision(all),manifest:manifest(all),mergeId:result.merge.mergeId},lastMerge:result.merge,scopeHash:s.workspace.scopeHash,capabilityHash:sha},{sessionId:'session'});
}

test('task tool preparation uses registered generation and rejects an assignment changed while waiting',async()=>{
 const work={taskId:'a',attemptId:'attempt',executionBinding:{...key,agentId:'employee',sessionId:'session'}};let current=work,seen;
 const options={snapshot:{executionProfile:profile},archive:{id:'run'},agent:{id:'session'},employee:{id:'employee'},activeWork:()=>current,handoff:{bindExecutionScope(){},bindCheckpoint(){}},sandbox:{prepareCheckpoint:async()=>({profile,key}),prepareTask:async(context)=>{seen=context;return{profile,key,workRevision:sha,workspace:{scopeHash:sha}};}},signal:AbortSignal.timeout(1000)};
 const prepared=await prepareTaskTool(options);assert.deepEqual(seen,{agentId:'employee',sessionId:'session',taskId:'a',attemptId:'attempt',generation:1});assert.equal(prepared.scope.key.generation,1);
 options.sandbox.prepareTask=async()=>{current={...work,attemptId:'renewed'};return prepared.scope;};await assert.rejects(()=>prepareTaskTool(options),/TASK_SCOPE_CHANGED/);
 current={...work,executionBinding:undefined};await assert.rejects(()=>prepareTaskTool(options),/TASK_SCOPE_REQUIRED/);
 assert.throws(()=>assertTaskScopeBinding(taskScopeBinding(prepared.scope),{...taskScopeBinding(prepared.scope),workRevision:'b'.repeat(64)}),/TASK_SCOPE_CHANGED/);
});

test('task command proof survives another task commit but never its own changed output',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-handoff-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[],verify:['check']};
 const archive=createRunArchive(root+'-archive',{projectId:'project',tasks:[task]}),localKey={...key,runId:archive.id};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive});
 const receipt=(s,op)=>({taskExecution:{profile,key:localKey,scopeHash:s.workspace.scopeHash,operationId:op,beforeWorkRevision:revision(s.workspace.importedFiles),afterWorkRevision:revision(exportFiles(root).filter(f=>f.path==='a.txt'))},merge:{mergeId:op,operationId:op,key:localKey,scopeHash:s.workspace.scopeHash,beforeRevision:s.workRevision,afterRevision:workspaceRevision(root),workRevision:revision(exportFiles(root).filter(f=>f.path==='a.txt')),status:'committed'}});
 try{
  let s=scope(root,1,localKey);gate.bindExecutionScope('a','attempt',s);const before=gate.beforeFile('a','attempt','artifact_write',{path:'a.txt'});writeFileSync(join(root,'a.txt'),'A');const written=receipt(s,randomUUID());bindResultRefs(gate,s,root,written);gate.observe('a','attempt','artifact_write',{path:'a.txt'},written,before);
  s=scope(root,1,localKey);gate.bindExecutionScope('a','attempt',s);const checked=gate.beforeFile('a','attempt','terminal_test',{});const tested={...receipt(s,randomUUID()),exitCode:0,output:'passed'};bindResultRefs(gate,s,root,tested);gate.observe('a','attempt','terminal_test',{command:'check'},tested,checked);
  writeFileSync(join(root,'b.txt'),'independent B');assert.equal(gate.prepare('a','attempt',{}).commands[0].exitCode,0);
  writeFileSync(join(root,'a.txt'),'changed A');assert.throws(()=>gate.prepare('a','attempt',{}),/UNVERIFIED_COMMAND/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(root+'-archive',{recursive:true,force:true});}
});

test('task handoff rejects a raw device success without a committed matching merge',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-raw-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[]};
 const archive=createRunArchive(root+'-archive',{projectId:'project',tasks:[task]}),localKey={...key,runId:archive.id};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive});
 try{gate.bindExecutionScope('a','attempt',scope(root,1,localKey));const before=gate.beforeFile('a','attempt','artifact_write',{path:'a.txt'});writeFileSync(join(root,'a.txt'),'A');assert.throws(()=>gate.observe('a','attempt','artifact_write',{path:'a.txt'},{exitCode:0},before),/TASK_CHECKPOINT_REQUIRED|TASK_MERGE_REQUIRED/);}
 finally{rmSync(root,{recursive:true,force:true});rmSync(root+'-archive',{recursive:true,force:true});}
});

test('a renewed task generation cannot reuse the previous generation command proof',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-generation-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:['check']};
 const archive=createRunArchive(root+'-archive',{projectId:'project',tasks:[task]}),localKey={...key,runId:archive.id};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive});
 try{
  const s=scope(root,1,localKey);gate.bindExecutionScope('a','attempt',s);
  const tested={exitCode:0,output:'passed',taskExecution:{profile,key:localKey,scopeHash:s.workspace.scopeHash,operationId:'op',beforeWorkRevision:revision([]),afterWorkRevision:revision([])},merge:{mergeId:'op',operationId:'op',key:localKey,scopeHash:s.workspace.scopeHash,beforeRevision:s.workRevision,afterRevision:s.workRevision,workRevision:revision([]),status:'committed'}};bindResultRefs(gate,s,root,tested);gate.observe('a','attempt','terminal_test',{command:'check'},tested,[]);
  assert.doesNotThrow(()=>gate.prepare('a','attempt',{}));gate.bindExecutionScope('a','attempt',scope(root,2,localKey));
  assert.throws(()=>gate.prepare('a','attempt',{}),/UNVERIFIED_COMMAND/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(root+'-archive',{recursive:true,force:true});}
});

async function productFixture(t){
 const ctx=new Context(),fibers=[];
 for(const name of ['@deepseek-ai/dsh-llm','@deepseek-ai/dsh-session','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools']){const mod=await import(name),fiber=ctx.plugin(mod.default??mod);fibers.push(fiber);await fiber.await();}
 const agent={id:'session'},employee={id:'employee',role:'manager',tools:['artifact_write','filesystem','terminal_test']},snapshot={executionProfile:profile,agents:[employee]};
 let current={taskId:'a',attemptId:'attempt',executionBinding:{...key,agentId:'employee',sessionId:'session'}},currentScope={profile,key,workspace:{scopeHash:sha},workRevision:sha},onApproval=()=>{},onPrepare=()=>{},onCheckpoint=()=>{};
 const calls=[],approvals=[],prepares=[],checkpoints=[],observations=[];
 const sandbox={prepareCheckpoint:async(context,signal,options)=>{checkpoints.push(options);await onCheckpoint(options);return{profile,key};},revision:()=>{throw Error('TASK_SHARED_REVISION_FALLBACK');},prepareTask:async(context)=>{prepares.push(context);await onPrepare();return currentScope;},execute:async(...args)=>{calls.push(args);return{artifacts:[],exitCode:0,output:'ok',taskExecution:{operationId:'original-op'}};}};
 const handoff={exclusive:async(signal,work)=>{signal.throwIfAborted();return work();},bindExecutionScope(){},bindCheckpoint(){},beforeFile:()=>[],checkpoint(){},observe(...args){observations.push(args);},invalidateCommands(){},block:(_t,_a,error)=>error};
 const dispose=installProductTools(ctx,{snapshot,archive:{id:'run',append(){}},sandbox,handoff,activeWork:()=>current,captainId:()=>agent.id,gate:new Semaphore(1),requestApproval:async input=>{approvals.push(structuredClone(input));await onApproval();return'approval';}});
 t.after(async()=>{dispose();for(const fiber of fibers.reverse())await fiber.dispose();});
 return{calls,approvals,prepares,checkpoints,observations,onCheckpoint:callback=>{onCheckpoint=callback;},setWork:value=>{current=value;},setScope:value=>{currentScope=value;},onApproval:callback=>{onApproval=callback;},onPrepare:callback=>{onPrepare=callback;},call:(name,args)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal:AbortSignal.timeout(2000)})};
}

test('actual product tool body binds prepared generation and exact scope before transport',async t=>{
 const f=await productFixture(t);let result=await f.call('artifact_write',{path:'a.txt',content:'A'});assert.equal(result.isError,false);
 result=await f.call('terminal_test',{command:'check'});assert.equal(result.isError,false);
 assert.equal(f.calls.length,2);for(const [,args,,context] of f.calls){assert.deepEqual(args.executionScope,{profile,key,scopeHash:sha,workRevision:sha});assert.equal(args.expectedWorkspaceRevision,sha);assert.equal(context.generation,1);assert.deepEqual(context.executionScope,args.executionScope);}
 assert.deepEqual(f.calls[1][1],f.approvals[0].arguments);assert.equal(f.calls[1][3].approvalId,'approval');
});

test('waiting approval cannot authorize a renewed scope and missing registration dispatches nothing',async t=>{
 const f=await productFixture(t);f.onApproval(()=>f.setScope({profile,key,workspace:{scopeHash:'b'.repeat(64)},workRevision:'b'.repeat(64)}));
 const old=await f.call('terminal_test',{command:'check'});assert.equal(old.isError,true);assert.match(old.error.message,/TASK_SCOPE_CHANGED/);assert.equal(f.calls.length,0);
 f.onApproval(()=>{});const fresh=await f.call('terminal_test',{command:'check'});assert.equal(fresh.isError,false);assert.equal(f.calls.length,1);assert.equal(f.approvals.length,2);
 f.setWork({taskId:'a',attemptId:'attempt'});const missing=await f.call('artifact_write',{path:'a.txt',content:'A'});assert.equal(missing.isError,true);assert.match(missing.error.message,/TASK_SCOPE_REQUIRED/);assert.equal(f.calls.length,1);
});

test('task runtime refuses shared fallback and initializes committed cache before any cache read',async()=>{
 const root=mkdtempSync(join(tmpdir(),'task-runtime-')),snapshot={executionProfile:profile,executionTarget:{kind:'local',backend:{kind:'openshell'}},policy:{maxConcurrentAgents:1,deadlineSeconds:3}},job=()=>({controller:new AbortController(),cancelled:false});
 try{
  let archive=createRunArchive(root,snapshot);let runtime=new ProductDshRuntime({traceRoot:root});
  const absent=await runtime.execute(job(),archive,snapshot,[]);assert.equal(absent.status,'failed');assert.match(absent.message,/TASK_EXECUTION_REQUIRED/);
  let prepared=false,closed=false;archive=createRunArchive(root,snapshot);
  runtime=new ProductDshRuntime({traceRoot:root,createExecutor:()=>({get root(){assert.equal(prepared,true,'committed cache must be ready before first read');return root;},bindAttempt(){},prepareTask(){},prepareCheckpoint(){},execute(){},finalizeAccepted(){throw Error('FINALIZER_MUST_NOT_RUN_AFTER_FAILED_PREPARE');},prepare:async()=>{prepared=true;throw Error('EXPECTED_PREPARE_STOP');},close:async()=>{closed=true;}})});
  const stopped=await runtime.execute(job(),archive,snapshot,[]);assert.equal(stopped.status,'failed');assert.match(stopped.message,/EXPECTED_PREPARE_STOP/);assert.equal(prepared,true);assert.equal(closed,true);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(root+'-archive',{recursive:true,force:true});}
});

test('product checkpoint holds tool body before dispatch and exact-operation observation after dispatch',async t=>{
 const f=await productFixture(t);let release;let held=new Promise(resolve=>{release=resolve;});
 f.onCheckpoint(({phase})=>phase==='before-tool'?held:undefined);
 const call=f.call('artifact_write',{path:'a.txt',content:'A'});await new Promise(setImmediate);assert.equal(f.calls.length,0);assert.equal(f.observations.length,0);
 release();await call;assert.equal(f.calls.length,1);assert.equal(f.observations.length,1);assert.deepEqual(f.checkpoints.at(-1),{phase:'after-tool',operationId:'original-op'});
 held=new Promise(resolve=>{release=resolve;});f.onCheckpoint(({phase})=>phase==='after-tool'?held:undefined);
 let settled=false;const after=f.call('artifact_write',{path:'a.txt',content:'A'}).then(result=>{settled=true;return result;});await new Promise(setImmediate);assert.equal(f.calls.length,2);assert.equal(f.observations.length,1);assert.equal(settled,false);release();await after;assert.equal(f.observations.length,2);
});
test('rejected before-tool checkpoint prevents transport and rejected result checkpoint prevents observation',async t=>{
 const f=await productFixture(t);f.onCheckpoint(()=>{throw Error('CHECKPOINT_PRIVATE_FAILURE');});
 const before=await f.call('artifact_write',{path:'a.txt',content:'A'});assert.equal(before.isError,true);assert.equal(f.calls.length,0);
 f.onCheckpoint(({phase})=>{if(phase==='after-tool')throw Error('CHECKPOINT_PRIVATE_FAILURE');});
 const after=await f.call('artifact_write',{path:'a.txt',content:'A'});assert.equal(after.isError,true);assert.equal(f.calls.length,1);assert.equal(f.observations.length,0);
});
