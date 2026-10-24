import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import * as execution from '../apps/api/src/task-execution.ts';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {executionMode,executionProfileForApproval,assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {LocalRunExecutor} from '../apps/api/src/local-execution.ts';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pool} from '../apps/api/src/db.ts';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
const {ReworkGate}=createRequire(import.meta.url)('../services/agent-runtime/rework.mjs');
const {revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
test('explicit execution mode is independent of identity and task profile stays unavailable',()=>{
 assert.equal(executionMode({}), 'legacy');
 assert.equal(executionMode({WEIWU_IDENTITY_MODE:'oidc'}),'legacy');
 assert.throws(()=>executionMode({WEIWU_EXECUTION_MODE:'demo'}));
 assert.doesNotThrow(()=>assertExecutionProfile({},'legacy'));
 assert.throws(()=>assertExecutionProfile({},'enterprise'));
 assert.throws(()=>assertExecutionProfile({executionProfile:'task-attempt-openshell-v1'},'legacy'));
 assert.throws(()=>executionProfileForApproval({executionTarget:{kind:'server'},tasks:[]},'enterprise'));
});
async function fixture(){
 const sql=new PGlite();
 await sql.exec(`CREATE TABLE projects(id text PRIMARY KEY,version int DEFAULT 1);INSERT INTO projects(id) VALUES('project');
 CREATE TABLE project_runs(id text PRIMARY KEY,status text,lease_owner text,lease_until timestamptz,cancel_requested boolean,project_id text DEFAULT 'project',project_version int DEFAULT 1,snapshot jsonb);
 INSERT INTO project_runs(id,status,lease_owner,lease_until,cancel_requested) VALUES('run','running','owner',now()+interval '1 hour',false);
 CREATE TABLE task_attempt_workspaces(run_id text,task_id text,attempt_id text,generation int,principal text,session_id text,runtime_task_id text,contract_hash text,permission_hash text,capability_hash text,contract jsonb,input_origins jsonb DEFAULT '[]',committed_outputs jsonb DEFAULT '[]',scope jsonb,work_revision text,phase text DEFAULT 'active',accepted_stop jsonb,PRIMARY KEY(run_id,task_id,attempt_id,generation));
 CREATE TABLE local_operations(id text,run_id text,status text,merge_state text,payload jsonb,result jsonb,late_result jsonb,started boolean);`);
 const db={query:async(input:string|{text:string;values?:any[]},p?:any[])=>{const s=typeof input==='string'?input:input.text,values=typeof input==='string'?p:input.values??p;const r=await sql.query(s,values);return {...r,rowCount:r.rows.length||r.affectedRows};}} as any;
 const task={id:'task',assignee:'employee',inputs:[{path:'input.txt'}],outputs:[{path:'output.txt'}],inScope:['output.txt'],outOfScope:[],dependencies:[]};
 const snapshot:any={projectId:'project',planVersion:1,executionProfile:'task-attempt-openshell-v1',agents:[{id:'employee',employeeId:'original',tools:['filesystem','artifact_write']}],tasks:[task],policy:{allowedTools:['filesystem','artifact_write']},executionTarget:{kind:'local',backend:{kind:'openshell',version:'0.1.2',image:'image@sha256:'+sha('image'),policySha256:sha('policy')}},importedFiles:[{path:'input.txt',content:'input',sha256:sha('input'),snapshotId:'snapshot',agentIds:['original']}]};
 const run:any={id:'run',project_id:'project',project_version:1,lease_owner:'owner',snapshot,events:[{type:'team/checkpoint',data:{members:[{id:'session',name:'employee'}],tasks:[{id:'native-task',assignee:'employee',attemptId:'attempt',status:'in_progress'}]}},{type:'run/task-mapping',data:{tasks:[{task_id:'native-task',seed_id:'task'}]}}]};
 const candidate:any={runId:'run',taskId:'task',attemptId:'attempt',agentId:'employee',sessionId:'session',runtimeTaskId:'native-task',contractHash:checkpointContract(snapshot,task)};
 const canonical={files:[file('input.txt','input'),file('private.txt','private')],revision:revision([file('input.txt','input'),file('private.txt','private')])};
 return {sql,db,run,candidate,canonical};
}
test('server allocates generation, pins true import ancestry and never imports private files',async()=>{
 const f=await fixture();try{
  const assignment=await execution.bindTrustedAttempt(f.db,f.run,f.candidate);
  assert.equal(assignment.generation,1);
  const scope=await execution.resolveTaskScope(f.db,f.run,assignment,f.canonical,null);
  assert.deepEqual(scope.workspace.importedFiles,[file('input.txt','input')]);
  assert.equal(scope.inputOrigins[0].source.kind,'import');
  assert.equal(scope.inputOrigins[0].source.snapshotId,'snapshot');
  assert.equal((await f.db.query('SELECT * FROM local_operations')).rows.length,0);
 }finally{await f.sql.close();}
});
for(const [name,mutate] of Object.entries<(f:any)=>void>({
 'forged employee':f=>f.candidate.agentId='other',
 'forged task':f=>f.candidate.taskId='other',
 'forged attempt':f=>f.candidate.attemptId='other',
 'forged session':f=>f.candidate.sessionId='other',
 'forged assignee':f=>f.run.events[0].data.tasks[0].assignee='other',
 'completed task':f=>f.run.events[0].data.tasks[0].status='completed',
 'failed task':f=>f.run.events[0].data.tasks[0].status='failed',
 'model readPaths':f=>f.candidate.readPaths=['private.txt'],
 'stale rework hash':f=>f.run.events.push({type:'quality/rework-created',data:{bindings:[{task_id:'native-task',seed_id:'task'}],repairContract:{...f.run.snapshot.tasks[0],objective:'new contract'}}}),
}))test(name+' rejected before queue',async()=>{
 const f=await fixture();try{mutate(f);await assert.rejects(()=>execution.bindTrustedAttempt(f.db,f.run,f.candidate));assert.equal((await f.db.query('SELECT * FROM local_operations')).rows.length,0);}finally{await f.sql.close();}
});
for(const variant of ['expired lease','missing generation','import denied','input changed','existing output','unaccepted producer','cross run accepted','cross run checkpoint'])test(variant+' rejected before queue',async()=>{
 const f=await fixture();try{
  if(variant==='expired lease')await f.sql.exec("UPDATE project_runs SET lease_until=now()-interval '1 second'");
  if(variant==='expired lease'){await assert.rejects(()=>execution.bindTrustedAttempt(f.db,f.run,f.candidate));return;}
  const assignment=await execution.bindTrustedAttempt(f.db,f.run,f.candidate);
  if(variant==='missing generation')delete (assignment as any).generation;
  if(variant==='import denied')f.run.snapshot.importedFiles[0].agentIds=['other'];
  if(variant==='input changed')f.canonical.files[0]=file('input.txt','changed');
  if(variant==='existing output')f.canonical.files.push(file('output.txt','private'));
  if(variant.includes('producer')||variant.includes('cross run')){
   f.run.snapshot.tasks[0].inputs[0].producerTaskId='producer';
   if(variant!=='unaccepted producer')f.run.events.push({type:'handoff/accepted',data:{runId:'other',taskId:'producer',attemptId:'producer-attempt',workspaceRevision:sha('rev'),outputs:[{path:'input.txt',sha256:sha('input')}]}});
   if(variant==='cross run checkpoint')f.run.snapshot.handoffCheckpoints=[{runId:'other',taskId:'producer',attemptId:'p',workspaceRevision:sha('rev'),outputs:[{path:'input.txt',sha256:sha('input')}]}];
   f.candidate.contractHash=checkpointContract(f.run.snapshot,f.run.snapshot.tasks[0]);
   await f.db.query('UPDATE task_attempt_workspaces SET contract_hash=$1,contract=$2',[f.candidate.contractHash,f.run.snapshot.tasks[0]]);
   assignment.contractHash=f.candidate.contractHash;
  }
  f.canonical.revision=revision(f.canonical.files);
  await assert.rejects(()=>execution.resolveTaskScope(f.db,f.run,assignment,f.canonical,null));
  assert.equal((await f.db.query('SELECT * FROM local_operations')).rows.length,0);
 }finally{await f.sql.close();}
});
test('scope rolls unrelated baseline while original input SHA stays pinned',async()=>{
 const f=await fixture();try{
  const a=await execution.bindTrustedAttempt(f.db,f.run,f.candidate),first=await execution.resolveTaskScope(f.db,f.run,a,f.canonical,null);
  f.canonical.files[1]=file('private.txt','new private');f.canonical.revision=revision(f.canonical.files);
  const second=await execution.resolveTaskScope(f.db,f.run,a,f.canonical,first);
  assert.notEqual(second.workspace.scopeHash,first.workspace.scopeHash);
  assert.deepEqual(second.inputOrigins,first.inputOrigins);
  f.canonical.files[0]=file('input.txt','changed');f.canonical.revision=revision(f.canonical.files);
  await assert.rejects(()=>execution.resolveTaskScope(f.db,f.run,a,f.canonical,second));
 }finally{await f.sql.close();}
});
test('own committed input modifications roll twice and preserve original import ancestry',async()=>{
 const f=await fixture();try{
  f.run.snapshot.tasks[0].outputs=[{path:'input.txt'}];f.run.snapshot.tasks[0].inScope=['input.txt'];f.candidate.contractHash=checkpointContract(f.run.snapshot,f.run.snapshot.tasks[0]);
  const a=await execution.bindTrustedAttempt(f.db,f.run,f.candidate),first=await execution.resolveTaskScope(f.db,f.run,a,f.canonical,null);
  const commits:any[]=[];let previous=first;
  for(const [index,text] of ['second','third'].entries()){
   f.canonical.files[0]=file('input.txt',text);f.canonical.revision=revision(f.canonical.files);
   commits.push({scope:previous,receipt:{profile:previous.profile,key:previous.key,scopeHash:previous.workspace.scopeHash,operationId:'operation-'+index,beforeWorkRevision:previous.workRevision,afterWorkRevision:f.canonical.revision},files:[{path:'input.txt',sha256:sha(text)}]});
   await f.db.query('UPDATE task_attempt_workspaces SET committed_outputs=$1',[commits]);
   const scope=await execution.resolveTaskScope(f.db,f.run,a,f.canonical,previous);
   assert.deepEqual(scope.inputOrigins,first.inputOrigins);assert.equal(scope.workspace.inputManifest[0].sha256,sha(text));assert.notEqual(scope.workspace.scopeHash,previous.workspace.scopeHash);previous=scope;
  }
  commits[0].scope.workspace.binding.runId='forged-run';
  // A valid helper workspace for another run is still an invalid commit ancestry.
  const {createTaskWorkspace}=createRequire(import.meta.url)('../apps/desktop/task-workspace.cjs');
  commits[0].scope.workspace=createTaskWorkspace({binding:commits[0].scope.workspace.binding,readPaths:['input.txt'],writePaths:['input.txt'],canonicalFiles:[file('input.txt','input'),file('private.txt','private')],origins:commits[0].scope.workspace.inputManifest.map((i:any)=>i.origin)});
  commits[0].receipt.scopeHash=commits[0].scope.workspace.scopeHash;
  await f.db.query('UPDATE task_attempt_workspaces SET committed_outputs=$1',[commits]);
  await assert.rejects(()=>execution.resolveTaskScope(f.db,f.run,a,f.canonical,previous));
 }finally{await f.sql.close();}
});
test('task profile launch stays closed and unbound execute never reaches shared operation queue',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'task-scope-'));let enqueued=0;
 try{
  const writers=createArchiveWriterManager({traceRoot:dir});
  const executor=new LocalRunExecutor({id:randomUUID(),dir,append(){}},{executionProfile:'task-attempt-openshell-v1'},{traceRoot:dir,writers,enqueue(){enqueued++;throw Error('queue reached');}} as any);
  assert.throws(()=>assertExecutionProfile(executor.snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});
  for(const context of [{},{agentId:'forged'},{taskId:'forged'},{attemptId:'forged'},{sessionId:'forged'},{generation:0}])await assert.rejects(()=>executor.execute('filesystem',{path:'private.txt'},new AbortController().signal,context),{code:'TASK_SCOPE_DENIED'});
  assert.equal(enqueued,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('real LocalRunExecutor binds and rechecks trusted archive against isolated SQL before any queue',async()=>{
 const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'task-sql-')),originalConnect=pool.connect;
 try{
  await f.db.query('UPDATE project_runs SET snapshot=$1',[f.run.snapshot]);
  // Production Host receives the JSONB snapshot read from project_runs, including its stable key ordering.
  f.run.snapshot=(await f.db.query('SELECT snapshot FROM project_runs')).rows[0].snapshot;
  f.candidate.contractHash=checkpointContract(f.run.snapshot,f.run.snapshot.tasks[0]);
  const archive=createRunArchive(dir,f.run.snapshot);
  for(const event of f.run.events)archive.append(event.type,event.data);
  await f.db.query('UPDATE project_runs SET id=$1,snapshot=$2',[archive.id,f.run.snapshot]);
  (pool as any).connect=async()=>({...f.db,release(){}});
  const writers=createArchiveWriterManager({traceRoot:dir});
  const executor=new LocalRunExecutor(archive,f.run.snapshot,{owner:'owner',traceRoot:dir,writers} as any);
  // The adapter is an in-memory database; no environment DATABASE_URL is read or contacted.
  const candidate={...f.candidate,runId:archive.id},signal=new AbortController().signal;
  const assignment=await executor.bindAttempt(candidate,signal);
  assert.equal(assignment.generation,1);
  const context={agentId:assignment.agentId,sessionId:assignment.sessionId,taskId:assignment.taskId,attemptId:assignment.attemptId,generation:assignment.generation};
  // Populate the trusted compatibility cache only for this unavailable profile fixture.
  mkdirSync(executor.root,{recursive:true});
  for(const item of f.canonical.files)writeFileSync(join(executor.root,item.path),Buffer.from(item.content,'base64'));
  const scope=await executor.taskScope(context,signal);assert.equal(scope.key.runId,archive.id);
  for(const field of ['agentId','sessionId','taskId','attemptId','generation'])await assert.rejects(()=>executor.taskScope({...context,[field]:field==='generation'?99:'forged'} as any,signal));
  archive.append('team/checkpoint',{...f.run.events[0].data,tasks:[{...f.run.events[0].data.tasks[0],status:'completed'}]});
  await assert.rejects(()=>executor.taskScope(context,signal));
  archive.append('team/checkpoint',f.run.events[0].data);
  await f.db.query('UPDATE projects SET version=2');
  await assert.rejects(()=>executor.bindAttempt(candidate,signal),{code:'RUN_REAPPROVAL_REQUIRED'});
  assert.equal((await f.db.query('SELECT * FROM local_operations')).rows.length,0);
 }finally{pool.connect=originalConnect;await f.sql.close();rmSync(dir,{recursive:true,force:true});}
});
test('trusted rework contract pins original accepted attempt rather than stale snapshot contract',async()=>{
 const f=await fixture();try{
  const repair={...f.run.snapshot.tasks[0],kind:'repair',sourceTaskId:'task',inputs:[{path:'input.txt',producerTaskId:'task'}]};
  f.run.events.push({type:'handoff/accepted',data:{runId:'run',taskId:'task',attemptId:'original-attempt',workspaceRevision:sha('accepted revision'),outputs:[{path:'input.txt',sha256:sha('input')}]}});
  f.run.events.push({type:'quality/rework-created',data:{bindings:[{task_id:'native-task',seed_id:'task'}],repairContract:repair}});
  f.candidate.contractHash=checkpointContract(f.run.snapshot,repair);
  const a=await execution.bindTrustedAttempt(f.db,f.run,f.candidate),scope=await execution.resolveTaskScope(f.db,f.run,a,f.canonical,null);
  assert.equal(scope.inputOrigins[0].source.kind,'accepted');assert.equal(scope.inputOrigins[0].origin.attemptId,'original-attempt');
 }finally{await f.sql.close();}
});
test('real multi-output ReworkGate keeps sealed delivery inputs and grants only narrowed writes through later scopes',async()=>{
 const f=await fixture();try{
  const source={id:'task',assignee:'employee',inputs:[],outputs:[{path:'a.txt'},{path:'b.txt'}],dependencies:[],inScope:['a.txt','b.txt'],outOfScope:[],verify:[]};
  const review={id:'review',assignee:'reviewer',kind:'review',reviewedTaskId:'task',inputs:[],outputs:[],dependencies:['task'],inScope:[],outOfScope:[]};
  f.run.snapshot.tasks=[source,review];f.run.snapshot.agents.push({id:'reviewer',tools:[]});
  const original={id:'native-original',assignee:'employee',status:'completed',attemptId:'original'};
  const repair={id:'native-repair',kind:'repair',assignee:'employee',sourceTaskId:original.id,dependencies:[original.id],round:2,verify:[],sourceFindingIds:['f1'],inScope:['a.txt'],outOfScope:[],status:'in_progress',attemptId:'repair-attempt'};
  const state={members:[{id:'session',name:'employee'}],tasks:[original,repair,{id:'native-review2',kind:'review',assignee:'reviewer',reviewedTaskId:repair.id,dependencies:[repair.id],round:2}]};
  const events:any[]=[];
  const gate=new ReworkGate({snapshot:f.run.snapshot,handoff:{tasks:new Map(),block(){throw Error('unexpected rework block');}},archive:{append(type:string,data:any){events.push({type,data});}},taskIds:new Map(),state:()=>state});
  gate.pending={source,review,work:{task:{reviewedTaskId:original.id,round:1},taskId:review.id,attemptId:'review-attempt'},findings:[{id:'f1',requiredFix:'Fix a.txt'}],before:{tasks:[original]},round:1};
  gate.reconcile();assert.equal(gate.failure,undefined);
  const contract=gate.contractFor(repair.id);
  assert.deepEqual(contract.outputs,source.outputs);assert.deepEqual(contract.inScope,['a.txt']);
  f.canonical.files=[file('a.txt','original a'),file('b.txt','sealed b')];f.canonical.revision=revision(f.canonical.files);
  f.run.events=[{type:'handoff/accepted',data:{runId:'run',taskId:'task',attemptId:'original',workspaceRevision:f.canonical.revision,outputs:[{path:'a.txt',sha256:sha('original a')},{path:'b.txt',sha256:sha('sealed b')}] }},...events,{type:'team/checkpoint',data:state}];
  const candidate={...f.candidate,attemptId:repair.attemptId,runtimeTaskId:repair.id,contractHash:checkpointContract(f.run.snapshot,contract)};
  const assignment=await execution.bindTrustedAttempt(f.db,f.run,candidate);
  const scope=await execution.resolveTaskScope(f.db,f.run,assignment,f.canonical,null);
  assert.equal(scope.workspace.binding.contractHash,candidate.contractHash);
  assert.deepEqual(scope.workspace.readPaths,['a.txt','b.txt']);assert.deepEqual(scope.workspace.writePaths,['a.txt']);
  assert.equal(scope.inputOrigins.find(i=>i.path==='b.txt')?.origin.attemptId,'original');
  const {validateTaskExport,planTaskMerge}=createRequire(import.meta.url)('../apps/desktop/task-workspace.cjs');
  assert.throws(()=>validateTaskExport(scope.workspace,[file('a.txt','fixed a'),file('b.txt','unauthorized b')]),/Read-only input was modified/);
  const plan=planTaskMerge(scope.workspace,[file('a.txt','fixed a'),file('b.txt','sealed b')],f.canonical.files);
  assert.deepEqual(plan.delta.map((d:any)=>d.path),['a.txt']);
  const commits=[{scope,receipt:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,operationId:'repair-write-a',beforeWorkRevision:scope.workRevision,afterWorkRevision:plan.afterRevision},files:plan.delta.map((d:any)=>({path:d.path,sha256:d.afterSha256}))}];
  await f.db.query('UPDATE task_attempt_workspaces SET committed_outputs=$1',[commits]);
  f.canonical={files:plan.mergedFiles,revision:plan.afterRevision};
  const next=await execution.resolveTaskScope(f.db,f.run,assignment,f.canonical,scope);
  assert.deepEqual(next.workspace.writePaths,['a.txt']);assert.deepEqual(next.inputOrigins,scope.inputOrigins);
  // A claimed commit cannot turn the retained delivery output into a writable path.
  commits[0].files.push({path:'b.txt',sha256:sha('unauthorized b')});
  await f.db.query('UPDATE task_attempt_workspaces SET committed_outputs=$1',[commits]);
  f.canonical.files=[file('a.txt','fixed a'),file('b.txt','unauthorized b')];f.canonical.revision=revision(f.canonical.files);
  await assert.rejects(()=>execution.resolveTaskScope(f.db,f.run,assignment,f.canonical,next),{code:'TASK_SCOPE_DENIED',message:'提交输出超出任务合同'});
  assert.equal((await f.db.query('SELECT * FROM local_operations')).rows.length,0);
 }finally{await f.sql.close();}
});
