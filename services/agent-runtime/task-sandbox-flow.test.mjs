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
const {createTaskWorkspace}=createRequire(import.meta.url)('../../apps/desktop/task-workspace.cjs');
const {exportFiles,revision}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const sha='a'.repeat(64),profile='task-attempt-openshell-v1';
const key={runId:'run',taskId:'a',attemptId:'attempt',generation:1};
function scope(root,generation=1){const taskKey={...key,generation},files=exportFiles(root),readPaths=files.some(file=>file.path==='a.txt')?['a.txt']:[],origins=readPaths.map(path=>({path,runId:'run',taskId:'a',attemptId:'attempt',acceptedRevision:revision(files)}));const workspace=createTaskWorkspace({binding:{projectId:'project',planVersion:1,...taskKey,assigneeId:'employee',contractHash:sha,permissionHash:sha,backend:{kind:'openshell',version:'0.1.2',image:'node@sha256:'+sha,policyHash:sha}},readPaths,writePaths:['a.txt'],canonicalFiles:files,origins});return{profile,key:taskKey,workspace,workRevision:workspace.baseCanonicalRevision,capabilityHash:sha,inputOrigins:origins};}

test('task tool preparation uses registered generation and rejects an assignment changed while waiting',async()=>{
 const work={taskId:'a',attemptId:'attempt',executionBinding:{...key,agentId:'employee',sessionId:'session'}};let current=work,seen;
 const options={snapshot:{executionProfile:profile},archive:{id:'run'},agent:{id:'session'},employee:{id:'employee'},activeWork:()=>current,handoff:{bindExecutionScope(){}},sandbox:{prepareTask:async(context)=>{seen=context;return{profile,key,workRevision:sha,workspace:{scopeHash:sha}};}},signal:AbortSignal.timeout(1000)};
 const prepared=await prepareTaskTool(options);assert.deepEqual(seen,{agentId:'employee',sessionId:'session',taskId:'a',attemptId:'attempt',generation:1});assert.equal(prepared.scope.key.generation,1);
 options.sandbox.prepareTask=async()=>{current={...work,attemptId:'renewed'};return prepared.scope;};await assert.rejects(()=>prepareTaskTool(options),/TASK_SCOPE_CHANGED/);
 current={...work,executionBinding:undefined};await assert.rejects(()=>prepareTaskTool(options),/TASK_SCOPE_REQUIRED/);
 assert.throws(()=>assertTaskScopeBinding(taskScopeBinding(prepared.scope),{...taskScopeBinding(prepared.scope),workRevision:'b'.repeat(64)}),/TASK_SCOPE_CHANGED/);
});

test('task command proof survives another task commit but never its own changed output',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-handoff-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[],verify:['check']};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive:{id:'run',append(){}}});
 const receipt=(s,op)=>({taskExecution:{profile,key,scopeHash:s.workspace.scopeHash,operationId:op,beforeWorkRevision:revision(s.workspace.importedFiles),afterWorkRevision:revision(exportFiles(root).filter(f=>f.path==='a.txt'))},merge:{mergeId:op,operationId:op,key,scopeHash:s.workspace.scopeHash,beforeRevision:s.workRevision,afterRevision:workspaceRevision(root),workRevision:revision(exportFiles(root).filter(f=>f.path==='a.txt')),status:'committed'}});
 try{
  let s=scope(root);gate.bindExecutionScope('a','attempt',s);const before=gate.beforeFile('a','attempt','artifact_write',{path:'a.txt'});writeFileSync(join(root,'a.txt'),'A');gate.observe('a','attempt','artifact_write',{path:'a.txt'},receipt(s,randomUUID()),before);
  s=scope(root);gate.bindExecutionScope('a','attempt',s);const checked=gate.beforeFile('a','attempt','terminal_test',{});gate.observe('a','attempt','terminal_test',{command:'check'},{...receipt(s,randomUUID()),exitCode:0,output:'passed'},checked);
  writeFileSync(join(root,'b.txt'),'independent B');assert.equal(gate.prepare('a','attempt',{}).commands[0].exitCode,0);
  writeFileSync(join(root,'a.txt'),'changed A');assert.throws(()=>gate.prepare('a','attempt',{}),/UNVERIFIED_COMMAND/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('task handoff rejects a raw device success without a committed matching merge',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-raw-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[]};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive:{id:'run',append(){}}});
 try{gate.bindExecutionScope('a','attempt',scope(root));const before=gate.beforeFile('a','attempt','artifact_write',{path:'a.txt'});writeFileSync(join(root,'a.txt'),'A');assert.throws(()=>gate.observe('a','attempt','artifact_write',{path:'a.txt'},{exitCode:0},before),/TASK_MERGE_REQUIRED/);}
 finally{rmSync(root,{recursive:true,force:true});}
});

test('a renewed task generation cannot reuse the previous generation command proof',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-generation-')),task={id:'a',assignee:'employee',dependencies:[],inputs:[],outputs:[],inScope:[],outOfScope:[],verify:['check']};
 const gate=new HandoffGate({snapshot:{executionProfile:profile,tasks:[task]},sandbox:{root},archive:{id:'run',append(){}}});
 try{
  const s=scope(root);gate.bindExecutionScope('a','attempt',s);
  gate.observe('a','attempt','terminal_test',{command:'check'},{exitCode:0,output:'passed',taskExecution:{profile,key,scopeHash:s.workspace.scopeHash,operationId:'op',beforeWorkRevision:revision([]),afterWorkRevision:revision([])},merge:{mergeId:'op',operationId:'op',key,scopeHash:s.workspace.scopeHash,beforeRevision:s.workRevision,afterRevision:s.workRevision,workRevision:revision([]),status:'committed'}},[]);
  assert.doesNotThrow(()=>gate.prepare('a','attempt',{}));gate.bindExecutionScope('a','attempt',scope(root,2));
  assert.throws(()=>gate.prepare('a','attempt',{}),/UNVERIFIED_COMMAND/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

async function productFixture(t){
 const ctx=new Context(),fibers=[];
 for(const name of ['@deepseek-ai/dsh-llm','@deepseek-ai/dsh-session','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools']){const mod=await import(name),fiber=ctx.plugin(mod.default??mod);fibers.push(fiber);await fiber.await();}
 const agent={id:'session'},employee={id:'employee',role:'manager',tools:['artifact_write','filesystem','terminal_test']},snapshot={executionProfile:profile,agents:[employee]};
 let current={taskId:'a',attemptId:'attempt',executionBinding:{...key,agentId:'employee',sessionId:'session'}},currentScope={profile,key,workspace:{scopeHash:sha},workRevision:sha},onApproval=()=>{},onPrepare=()=>{};
 const calls=[],approvals=[],prepares=[];
 const sandbox={revision:()=>{throw Error('TASK_SHARED_REVISION_FALLBACK');},prepareTask:async(context)=>{prepares.push(context);await onPrepare();return currentScope;},execute:async(...args)=>{calls.push(args);return{artifacts:[],exitCode:0,output:'ok'};}};
 const handoff={exclusive:async(signal,work)=>{signal.throwIfAborted();return work();},bindExecutionScope(){},beforeFile:()=>[],checkpoint(){},observe(){},invalidateCommands(){},block:(_t,_a,error)=>error};
 const dispose=installProductTools(ctx,{snapshot,archive:{id:'run',append(){}},sandbox,handoff,activeWork:()=>current,captainId:()=>agent.id,gate:new Semaphore(1),requestApproval:async input=>{approvals.push(structuredClone(input));await onApproval();return'approval';}});
 t.after(async()=>{dispose();for(const fiber of fibers.reverse())await fiber.dispose();});
 return{calls,approvals,prepares,setWork:value=>{current=value;},setScope:value=>{currentScope=value;},onApproval:callback=>{onApproval=callback;},onPrepare:callback=>{onPrepare=callback;},call:(name,args)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal:AbortSignal.timeout(2000)})};
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
  runtime=new ProductDshRuntime({traceRoot:root,createExecutor:()=>({get root(){assert.equal(prepared,true,'committed cache must be ready before first read');return root;},bindAttempt(){},prepareTask(){},execute(){},prepare:async()=>{prepared=true;throw Error('EXPECTED_PREPARE_STOP');},close:async()=>{closed=true;}})});
  const stopped=await runtime.execute(job(),archive,snapshot,[]);assert.equal(stopped.status,'failed');assert.match(stopped.message,/EXPECTED_PREPARE_STOP/);assert.equal(prepared,true);assert.equal(closed,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
