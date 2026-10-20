import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {createRunArchive,readRun} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {initializeTaskCanonical,readCommittedCanonical,commitTaskResult,reconcileTaskMerge,materializeCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {assertCurrentRunPermissions,assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {AppError} from '../apps/api/src/provider.ts';
import {bindTrustedAttempt,resolveTaskScope} from '../apps/api/src/task-execution.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
let directory:string;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write','terminal'],name:'Fixture',role:'manager'};
before(async()=>{if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);directory=mkdtempSync(join(tmpdir(),'task-canonical-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(!isolated)return;for(const name of ['usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(directory.startsWith(join(tmpdir(),'task-canonical-')));rmSync(directory,{recursive:true,force:true});});
async function fixture(){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID();
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:{kind:'local',deviceId,grantId,backend}};
 const task={id:'task',assignee:'employee',inputs:[{path:'in.txt'}],outputs:[{path:'out.txt'}],inScope:['out.txt'],outOfScope:[],dependencies:[]};
 const secondTask={...task,id:'task-b',outputs:[{path:'b.txt'}],inScope:['b.txt']};
 const snapshot:any={projectId,planVersion:1,departmentId:'department',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks:[task,secondTask],executionTarget:{...policy.executionTarget,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:sha('input'),agentIds:['employee']}]};
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents:[employee],tasks:[task]}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,sha('token'),'fixture','linux',grantId,backend]);
 const archive=createRunArchive(directory,snapshot,{id:runId});mkdirSync(join(archive.dir,'artifacts'));
 writeFileSync(join(archive.dir,'artifacts/in.txt'),'input');writeFileSync(join(archive.dir,'artifacts/secret.txt'),'private');
 archive.append('run/task-mapping',{tasks:[{task_id:'native',seed_id:'task'},{task_id:'native-b',seed_id:'task-b'}]});archive.append('team/checkpoint',{members:[{id:'session',name:'employee'}],tasks:[{id:'native',assignee:'employee',attemptId:'attempt',status:'in_progress'},{id:'native-b',assignee:'employee',attemptId:'attempt-b',status:'in_progress'}]});
 const service=new LocalOperationService(directory,owner);await initializeTaskCanonical(service,runId,new AbortController().signal);
 const run=await getRun(runId);run.events=readRun(directory,runId)!.events;
 const candidate={runId,taskId:'task',attemptId:'attempt',agentId:'employee',sessionId:'session',runtimeTaskId:'native',contractHash:checkpointContract(run.snapshot,run.snapshot.tasks[0])};
 const db=await pool.connect();let scope:any;try{await db.query('BEGIN');const assignment=await bindTrustedAttempt(db,run,candidate);const canonical=readCommittedCanonical(directory,run);scope=await resolveTaskScope(db,run,assignment,{files:canonical.files,revision:canonical.ref.revision},null);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const id=randomUUID(),files=[file('in.txt','input'),file('out.txt','output')],executionScope={profile:scope.profile,key:scope.key,binding:scope.workspace.binding,scopeHash:scope.workspace.scopeHash,readPaths:scope.workspace.readPaths,writePaths:scope.workspace.writePaths,inputManifest:scope.workspace.inputManifest,expectedWorkRevision:revision(scope.workspace.importedFiles)};
 const result={localWorkspace:'/sandbox',path:'out.txt',bytes:6,sha256:sha('output'),files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...backend,sandboxId:randomUUID(),sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,operationId:id,beforeWorkRevision:executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
 // Synthetic merge fixture represents an already prepared task sandbox.
 await pool.query('UPDATE task_attempt_workspaces SET sandbox_identity=$1',[{sandboxId:result.execution.sandboxId,localWorkspace:result.localWorkspace}]);
 const payload={runId,deviceId,grantId,name:'artifact_write',arguments:{path:'out.txt',content:'output'},context:{...candidate,generation:1,callId:'call',executionScope:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision}},taskScope:scope,executionScope};
 await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status,started,result,claim_token) VALUES($1,$2,$3,$4,$5,$6,'completed',true,$7,$8)",[id,deviceId,runId,grantId,owner,payload,{ok:true,result},randomUUID()]);
 return {runId,id,service,scope,archive,deviceId,files,result};
}
const getRun=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
const getOp=async(id:string)=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];
// Synthetic device receipt inserted into the real merge path. No command/model
// runs here; physical device execution is a separate acceptance gate.
async function completedWrite(f:Awaited<ReturnType<typeof fixture>>,taskId:string,text:string){
 const run=await getRun(f.runId),task=run.snapshot.tasks.find((t:any)=>t.id===taskId);
 const executor=new LocalRunExecutor(f.archive,run.snapshot,f.service);
 const candidate={runId:f.runId,taskId,attemptId:taskId==='task'?'attempt':'attempt-b',agentId:'employee',sessionId:'session',runtimeTaskId:taskId==='task'?'native':'native-b',contractHash:checkpointContract(run.snapshot,task)};
 const assignment=await executor.bindAttempt(candidate,new AbortController().signal);
 const scope=await executor.taskScope({agentId:'employee',sessionId:'session',taskId,attemptId:candidate.attemptId,generation:assignment.generation},new AbortController().signal);
 const path=task.outputs[0].path,files=[...scope.workspace.importedFiles.filter(file=>file.path!==path),file(path,text)],id=randomUUID();
 const executionScope={profile:scope.profile,key:scope.key,binding:scope.workspace.binding,scopeHash:scope.workspace.scopeHash,readPaths:scope.workspace.readPaths,writePaths:scope.workspace.writePaths,inputManifest:scope.workspace.inputManifest,expectedWorkRevision:revision(scope.workspace.importedFiles)};
 const result={...f.result,path,bytes:Buffer.byteLength(text),sha256:sha(text),files,artifacts:manifest(files),workspaceRevision:revision(files),taskExecution:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,operationId:id,beforeWorkRevision:executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
 const payload={runId:f.runId,deviceId:f.deviceId,grantId:run.snapshot.executionTarget.grantId,name:'artifact_write',arguments:{path,content:text},context:{...assignment,callId:randomUUID(),executionScope:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision}},taskScope:scope,executionScope};
 await pool.query("INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,status,started,result,claim_token) VALUES($1,$2,$3,$4,$5,$6,'completed',true,$7,$8)",[id,f.deviceId,f.runId,payload.grantId,f.service.owner,payload,{ok:true,result},randomUUID()]);
 return {id,scope};
}

test('expired durable intent settles as rejected and no longer fences independent work',{skip:!isolated},async()=>{
 const f=await fixture();
 await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal,point=>{if(point==='intent')throw Error('crash after intent');}),/crash after intent/);
 const original=await getOp(f.id);
 await pool.query("UPDATE local_operations SET deadline=now()-interval '1 minute' WHERE id=$1",[f.id]);
 await assert.rejects(()=>reconcileTaskMerge(f.service,f.id),{code:'TASK_MERGE_DENIED'});
 const rejected=await getOp(f.id);assert.equal(rejected.merge_state,'rejected');
 assert.deepEqual(rejected.merge_record,original.merge_record,'the immutable intent is preserved');
 assert.deepEqual(rejected.result,original.result,'the original execution receipt is preserved');
 assert.equal(rejected.merge_rejection.reason,'TASK_MERGE_DENIED');
 const next=await completedWrite(f,'task-b','B after expiry');
 await commitTaskResult(f.service,next.id,new AbortController().signal);
 assert.deepEqual(readCommittedCanonical(directory,await getRun(f.runId)).files,[file('b.txt','B after expiry'),file('in.txt','input'),file('secret.txt','private')]);
});

test('committed SQL receipt repairs evidence after plan change without new execution authority',{skip:!isolated},async()=>{
 const f=await fixture();
 await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal,point=>{if(point==='after-sql-commit')throw Error('crash after commit');}),/crash after commit/);
 const original=await getOp(f.id);assert.equal(original.merge_state,'committed');
 assert.equal(readRun(directory,f.runId)!.events.filter(event=>event.type==='task/merge-committed').length,0);
 await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[(await getRun(f.runId)).project_id]);
 await reconcileTaskMerge(f.service,f.id);
 assert.equal(readRun(directory,f.runId)!.events.filter(event=>event.type==='task/merge-committed').length,1);
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/out.txt'),'utf8'),'output');
 assert.deepEqual((await getOp(f.id)).merge_record,original.merge_record);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);
});

test('a deterministic second-transaction denial settles intent but damaged archive evidence stays pending',{skip:!isolated},async()=>{
 const denied=await fixture();
 await assert.rejects(()=>commitTaskResult(denied.service,denied.id,new AbortController().signal,point=>{if(point==='before-sql-commit')throw new AppError(409,'assignment changed','TASK_SCOPE_DENIED');}),{code:'TASK_SCOPE_DENIED'});
 assert.equal((await getOp(denied.id)).merge_state,'rejected');
 assert.equal((await getOp(denied.id)).merge_rejection.reason,'TASK_SCOPE_DENIED');
 assert.equal(readCommittedCanonical(directory,await getRun(denied.runId)).files.some(file=>file.path==='out.txt'),false);
 const damaged=await fixture();
 await assert.rejects(()=>commitTaskResult(damaged.service,damaged.id,new AbortController().signal,point=>{if(point==='intent')throw Error('crash after intent');}));
 const original=await getOp(damaged.id),journal=join(damaged.archive.dir,'events.jsonl'),bytes=readFileSync(journal);
 try{
  writeFileSync(journal,'invalid journal\n');
  await assert.rejects(()=>reconcileTaskMerge(damaged.service,damaged.id),{code:'TASK_CANONICAL_INVALID'});
  const pending=await getOp(damaged.id);assert.equal(pending.merge_state,'pending');assert.equal(pending.merge_rejection,null);assert.deepEqual(pending.merge_record,original.merge_record);
 }finally{writeFileSync(journal,bytes);}
});
test('commits full canonical, retains other task file, deduplicates merge and rolls own durable outputs',{skip:!isolated},async()=>{
 const f=await fixture(),before=readCommittedCanonical(directory,await getRun(f.runId));
 const receipt=await commitTaskResult(f.service,f.id,new AbortController().signal);assert.equal(receipt.status,'committed');assert.equal(receipt.mergeId,f.id);
 const after=readCommittedCanonical(directory,await getRun(f.runId));assert.deepEqual(after.files,[file('in.txt','input'),file('out.txt','output'),file('secret.txt','private')]);assert.notEqual(before.ref.revision,after.ref.revision);
 assert.deepEqual(await reconcileTaskMerge(new LocalOperationService(directory,f.service.owner),f.id),receipt);
 assert.equal(readRun(directory,f.runId)!.events.filter(e=>e.type==='task/merge-committed').length,1);
 const own=(await pool.query('SELECT committed_outputs FROM task_attempt_workspaces')).rows[0].committed_outputs;assert.equal(own.length,1);assert.equal(own[0].receipt.beforeWorkRevision,f.scope.workRevision);assert.equal(own[0].receipt.afterWorkRevision,after.ref.revision);
 materializeCommittedCanonical(directory,await getRun(f.runId));assert.equal(readFileSync(join(f.archive.dir,'artifacts/secret.txt'),'utf8'),'private');
 const executor=new LocalRunExecutor(f.archive,{},f.service);const visible=await executor.taskResultSummary(f.id);assert.deepEqual(visible.artifacts.map((r:any)=>r.path),['in.txt','out.txt']);assert.ok(!JSON.stringify(visible).includes('secret.txt'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);
});
test('queued baseline CAS conflict preserves newer complete B and rejects old output',{skip:!isolated},async()=>{
 const f=await fixture(),second=await completedWrite(f,'task-b','B output');
 await commitTaskResult(f.service,second.id,new AbortController().signal);
 const before=readCommittedCanonical(directory,await getRun(f.runId));
 await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal),{code:'TASK_WORKSPACE_CONFLICT'});
 assert.deepEqual(readCommittedCanonical(directory,await getRun(f.runId)),before);
 assert.deepEqual(before.files,[file('b.txt','B output'),file('in.txt','input'),file('secret.txt','private')]);
 assert.equal((await getOp(f.id)).merge_state,'rejected');
});

test('second operation uses durable own output and retains original input ancestry',{skip:!isolated},async()=>{
 const f=await fixture();await commitTaskResult(f.service,f.id,new AbortController().signal);
 const next=await completedWrite(f,'task','revised output');
 assert.deepEqual(next.scope.inputOrigins,f.scope.inputOrigins);
 assert.deepEqual(next.scope.workspace.readPaths,['in.txt','out.txt']);
 assert.equal(next.scope.workspace.importedFiles.find(file=>file.path==='out.txt')?.content,Buffer.from('output').toString('base64'));
 await commitTaskResult(f.service,next.id,new AbortController().signal);
 assert.deepEqual(readCommittedCanonical(directory,await getRun(f.runId)).files,[file('in.txt','input'),file('out.txt','revised output'),file('secret.txt','private')]);
 const own=(await pool.query("SELECT committed_outputs FROM task_attempt_workspaces WHERE task_id='task'")).rows[0].committed_outputs;
 assert.deepEqual(own.map((entry:any)=>entry.receipt.operationId),[f.id,next.id]);
 await reconcileTaskMerge(f.service,f.id);
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/out.txt'),'utf8'),'revised output');
 assert.equal((await pool.query("SELECT committed_outputs FROM task_attempt_workspaces WHERE task_id='task'")).rows[0].committed_outputs.length,2);
});

test('changed plan and revoked device authority cannot publish a completed receipt',{skip:!isolated},async()=>{
 const f=await fixture(),before=readCommittedCanonical(directory,await getRun(f.runId));
 await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);
 await assert.rejects(async()=>assertCurrentRunPermissions(await getRun(f.runId),pool,{requireLocalOnline:false}),{code:'LOCAL_GRANT_CHANGED'});
 await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal));
 assert.deepEqual(readCommittedCanonical(directory,await getRun(f.runId)),before);
 assert.equal((await getOp(f.id)).merge_state,'rejected');
 const changed=await fixture(),old=readCommittedCanonical(directory,await getRun(changed.runId));
 await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[(await getRun(changed.runId)).project_id]);
 await assert.rejects(()=>commitTaskResult(changed.service,changed.id,new AbortController().signal),{code:'RUN_REAPPROVAL_REQUIRED'});
 assert.deepEqual(readCommittedCanonical(directory,await getRun(changed.runId)),old);
});

for(const withdrawal of ['plan','backend'])test(`actual result route validates receipts, deduplicates transmission, and preserves ${withdrawal} withdrawal as late evidence`,{skip:!isolated},async()=>{
 const f=await fixture(),claim=(await getOp(f.id)).claim_token,token='a'.repeat(64);
 await pool.query('UPDATE local_devices SET token_hash=$1 WHERE id=$2',[sha(token),f.deviceId]);
 await pool.query("UPDATE local_operations SET result=NULL,status='started' WHERE id=$1",[f.id]);
 const app=express();app.use(express.json({limit:'32mb'}));app.use('/api',localDeviceRouter(directory));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message,code:error.code}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const send=(id:string,claimToken:string,result:any)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-devices/${f.deviceId}/operations/${id}/result`,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify({claimToken,ok:true,result})});
 try{
  const forged=structuredClone(f.result);forged.artifacts[0].sha256=sha('forged');
  assert.equal((await send(f.id,claim,forged)).status,409);
  assert.equal((await getOp(f.id)).result,null);
  assert.equal((await send(f.id,claim,f.result)).status,200);
  assert.equal((await send(f.id,claim,f.result)).status,200);
  assert.equal((await send(f.id,claim,{...f.result,localWorkspace:'/different'})).status,409);
  await commitTaskResult(f.service,f.id,new AbortController().signal);
  const next=await completedWrite(f,'task','next output'),op=await getOp(next.id),before=readCommittedCanonical(directory,await getRun(f.runId));
  await pool.query("UPDATE local_operations SET result=NULL,status='started' WHERE id=$1",[next.id]);
  if(withdrawal==='plan')await pool.query('UPDATE projects SET version=version+1 WHERE id=$1',[(await getRun(f.runId)).project_id]);
  else await pool.query('UPDATE local_devices SET backend=$1 WHERE id=$2',[{...(await getRun(f.runId)).snapshot.executionTarget.backend,fingerprint:sha('replacement backend')},f.deviceId]);
  assert.equal((await send(next.id,op.claim_token,op.result.result)).status,200);
  const late=await getOp(next.id);assert.equal(late.status,'cancelled');assert.equal(late.result,null);assert.equal(late.late_result.result.sha256,sha('next output'));
  await assert.rejects(()=>commitTaskResult(f.service,next.id,new AbortController().signal),{code:withdrawal==='plan'?'RUN_REAPPROVAL_REQUIRED':'LOCAL_BACKEND_CHANGED'});
  assert.deepEqual(readCommittedCanonical(directory,await getRun(f.runId)),before);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
for(const point of ['intent','blob-fsync','before-sql-commit','after-sql-commit','archive-append','cache-mirror'])test('fault '+point+' never publishes a partial set and reconciliation never executes a command',{skip:!isolated},async()=>{
 const f=await fixture();let fired=false;
 await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal,p=>{if(p===point&&!fired){
  fired=true;
  if(point==='cache-mirror'){writeFileSync(join(f.archive.dir,'artifacts/out.txt'),'partial cache');unlinkSync(join(f.archive.dir,'artifacts/secret.txt'));}
  throw Error('injected '+point);
 }}));assert.equal(fired,true);
 const current=readCommittedCanonical(directory,await getRun(f.runId));const committed=['after-sql-commit','archive-append','cache-mirror'].includes(point);
 assert.deepEqual(current.files,committed?[file('in.txt','input'),file('out.txt','output'),file('secret.txt','private')]:[file('in.txt','input'),file('secret.txt','private')]);
 const receipt=await reconcileTaskMerge(f.service,f.id);assert.equal(receipt.status,'committed');assert.equal((await getOp(f.id)).merge_state,'committed');assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/secret.txt'),'utf8'),'private');
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/out.txt'),'utf8'),'output');
});
test('missing or corrupt object freezes reads, merge and cache recovery with original files retained',{skip:!isolated},async()=>{
 const f=await fixture(),run=await getRun(f.runId),object=join(f.archive.dir,'checkpoint-objects',sha('private'));unlinkSync(object);
 assert.throws(()=>readCommittedCanonical(directory,run));await assert.rejects(()=>commitTaskResult(f.service,f.id,new AbortController().signal));assert.throws(()=>materializeCommittedCanonical(directory,run));assert.equal(readFileSync(join(f.archive.dir,'artifacts/secret.txt'),'utf8'),'private');
 writeFileSync(object,'wrong');assert.throws(()=>readCommittedCanonical(directory,run));
});
test('task profile launch stays closed while prepare only initializes canonical',{skip:!isolated},async()=>{const f=await fixture(),snapshot=(await getRun(f.runId)).snapshot;const executor=new LocalRunExecutor(f.archive,snapshot,f.service);assert.throws(()=>assertExecutionProfile(snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});await executor.prepare(new AbortController().signal);assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);});
