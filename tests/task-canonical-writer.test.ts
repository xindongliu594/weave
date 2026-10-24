import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {createArchiveWriteFence} from '../services/agent-runtime/archive-write-fence.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
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
let writers:ReturnType<typeof createArchiveWriterManager>;
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
let directory:string;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write','terminal'],name:'Fixture',role:'manager'};
before(async()=>{if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);directory=mkdtempSync(join(tmpdir(),'task-canonical-writer-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;writers=createArchiveWriterManager({traceRoot:directory});process.env.OBSIDIAN_VAULT=join(directory,'vault');await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(!isolated)return;for(const name of ['usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+name)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(directory.startsWith(join(tmpdir(),'task-canonical-writer-')));console.log('CANONICAL_WRITER_EXIT_CLEANUP='+JSON.stringify({directory,pid:process.pid}));});
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
 const service=new LocalOperationService(directory,owner,writers);await initializeTaskCanonical(service,runId,new AbortController().signal);
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

// These tests exercise the complete real SQL/object/archive merge. Interception
// pauses or loses a driver receipt; native contention is checked in a child.
// PGlite does not establish independent PostgreSQL backend/disconnect behavior.
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(done=>release=done);return {promise,release};};
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function reached(promise:Promise<void>){let timer:NodeJS.Timeout|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('canonical producer did not reach gate')),5000);})]);}finally{clearTimeout(timer);}}
async function probe(runId:string){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/archive-admission-probe.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc'],env:{...process.env,ARCHIVE_WRITER_TEST:JSON.stringify({traceRoot:directory,lockRoot:writers.lockRoot,runId})}});
 const exited=once(child,'exit');let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([once(child,'message').then(([value])=>value),exited.then(()=>{throw Error('probe exited early');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('probe timeout')),10000);})]);}
 finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}
}
type Hook=(sql:string,next:()=>Promise<any>)=>Promise<any>;
async function intercept(hook:Hook,work:()=>Promise<void>,released:(value:any)=>void=()=>{}){
 const connect=pool.connect;
 (pool as any).connect=function(callback?:any){
  if(typeof callback==='function')return (connect as any).call(pool,callback);
  return (connect as ()=>Promise<pg.PoolClient>).call(pool).then(client=>{
   const query=client.query,release=client.release;
   (client as any).query=(sql:any,...args:any[])=>hook(typeof sql==='string'?sql:sql.text,()=>Promise.resolve((query as any).call(client,sql,...args)));
   client.release=function(value?:any){client.query=query;client.release=release;released(value);release.call(client,value);};return client;
  });
 };
 try{await work();}finally{pool.connect=connect;}
}

for(const action of ['initialize','commit'] as const)test(action+' waits for native admission before SQL and rechecks cancellation',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),fence=createArchiveWriteFence({traceRoot:directory,lockRoot:writers.lockRoot}),source=await fence.acquireSource(f.runId);
 let pending:Promise<any>|undefined,begins=0,settled=false,released=false;
 try{await intercept(async(sql,next)=>{if(sql==='BEGIN')begins++;return next();},async()=>{
  pending=(action==='initialize'?initializeTaskCanonical(f.service,f.runId,new AbortController().signal):commitTaskResult(f.service,f.id,new AbortController().signal)).catch(error=>error);
  pending.then(()=>settled=true);await pause(120);
  assert.equal(begins,0);assert.equal(settled,false);
  await pool.query('UPDATE project_runs SET cancel_requested=true WHERE id=$1',[f.runId]);source.release();released=true;
  assert.equal((await pending).code,'TASK_MERGE_DENIED');
 });}finally{if(!released)source.release();await pending;}
 assert.deepEqual(await probe(f.runId),{acquired:true});
});

for(const commitNumber of [1,2,3])test('merge retains writer through original COMMIT '+commitNumber,{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),entered=gate(),release=gate();let commits=0,observed:any,pending:Promise<any>|undefined;
 try{await intercept(async(sql,next)=>{if(sql==='COMMIT'&&++commits===commitNumber){entered.release();await release.promise;}return next();},async()=>{
  pending=commitTaskResult(f.service,f.id,new AbortController().signal);await reached(entered.promise);observed=await probe(f.runId);release.release();assert.equal((await pending).status,'committed');
 });}finally{release.release();await pending;}
 assert.deepEqual(observed,{blocked:true});assert.deepEqual(await probe(f.runId),{acquired:true});
 assert.equal(readRun(directory,f.runId)!.events.filter(event=>event.type==='task/merge-committed').length,1);
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/out.txt'),'utf8'),'output');
});

for(const failure of ['rollback','commit-before','commit-after'] as const)test(failure+' retains guard and never turns an unknown deterministic-shaped error into rejection',{skip:!isolated},async()=>{
 const f=await fixture(),primary=Object.freeze(new AppError(409,'original unknown '+failure,'TASK_SCOPE_DENIED'));
 let commits=0,rejections=0,error:any,discard:any;
 await intercept(async(sql,next)=>{
  if(sql.includes("merge_state='rejected'"))rejections++;
  if(failure==='rollback'&&sql.includes("merge_state='pending'"))throw primary;
  if(failure==='rollback'&&sql==='ROLLBACK'){await next();throw Error('rollback acknowledgement lost');}
  if(sql==='COMMIT'){commits++;if(failure==='commit-before')throw primary;if(failure==='commit-after'){await next();throw primary;}}
  return next();
 },async()=>{try{await commitTaskResult(f.service,f.id,new AbortController().signal);}catch(caught){error=caught;}},value=>discard=value);
 assert.equal(error,primary);assert.equal(rejections,0);assert.equal(commits,failure==='rollback'?0:1);assert.equal(discard,true);
 assert.notEqual((await getOp(f.id)).merge_state,'rejected');assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('known rollback settles a deterministic rejection and releases only after rejection commit',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),entered=gate(),release=gate();let rejection=false,observed:any,pending:Promise<any>|undefined;
 const reason=new AppError(409,'original known rejection','TASK_SCOPE_DENIED');
 try{await intercept(async(sql,next)=>{if(sql.includes("merge_state='rejected'"))rejection=true;if(sql==='COMMIT'&&rejection){entered.release();await release.promise;}return next();},async()=>{
  pending=commitTaskResult(f.service,f.id,new AbortController().signal,point=>{if(point==='before-sql-commit')throw reason;}).catch(error=>error);
  await reached(entered.promise);observed=await probe(f.runId);release.release();assert.equal(await pending,reason);
 });}finally{release.release();await pending;}
 assert.deepEqual(observed,{blocked:true});assert.equal((await getOp(f.id)).merge_state,'rejected');assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('nested merge failure stays in the original owner even when its caller catches',{skip:!isolated},async()=>{
 const f=await fixture(),owner=await writers.acquireOwner([f.runId]),primary=Error('nested original commit unknown');let error:any;
 await intercept(async(sql,next)=>{if(sql==='COMMIT'){await next();throw primary;}return next();},async()=>{
  await owner.run(async()=>{try{await commitTaskResult(f.service,f.id,new AbortController().signal);}catch(caught){error=caught;}});
 });owner.finish();assert.equal(error,primary);await assert.rejects(owner.writerDrained,caught=>caught===primary);assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('append failure latches original scope after SQL commit without replaying execution',{skip:!isolated},async()=>{
 const f=await fixture();let error:any;
 try{await commitTaskResult(f.service,f.id,new AbortController().signal,point=>{if(point==='archive-append')writeFileSync(join(f.archive.dir,'events.jsonl'),'corrupt\n');});}catch(caught){error=caught;}
 assert.ok(error);assert.equal((await getOp(f.id)).merge_state,'committed');assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,1);assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('direct mirror requires original writer authority',{skip:!isolated},async()=>{
 const f=await fixture(),run=await getRun(f.runId);let error:any;
 try{materializeCommittedCanonical(f.service as any,run);}catch(caught){error=caught;}
 assert.equal(error?.code,'E_ARCHIVE_WRITER_SCOPE');
 await writers.withWriter([f.runId],()=>materializeCommittedCanonical(f.service as any,run));
 assert.equal(readFileSync(join(f.archive.dir,'artifacts/secret.txt'),'utf8'),'private');
});

test('already rejected merge is a known no-change outcome and does not latch source',{skip:!isolated},async()=>{
 const f=await fixture();await pool.query("UPDATE local_operations SET merge_state='rejected' WHERE id=$1",[f.id]);
 await assert.rejects(commitTaskResult(f.service,f.id,new AbortController().signal),{code:'TASK_MERGE_DENIED'});
 assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('failed pool admission with no client cannot latch a new canonical writer',{skip:!isolated},async()=>{
 const f=await fixture(),connect=pool.connect,primary=Error('known connect rejection');let error:any;
 (pool as any).connect=async()=>{throw primary;};
 try{await initializeTaskCanonical(f.service,f.runId,new AbortController().signal);}catch(caught){error=caught;}finally{pool.connect=connect;}
 assert.equal(error,primary);assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('original pending rollback holds source until its actual receipt',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),entered=gate(),release=gate(),primary=Error('known rolled back statement');let pending:Promise<any>|undefined,observed:any;
 try{await intercept(async(sql,next)=>{if(sql.includes("merge_state='pending'"))throw primary;if(sql==='ROLLBACK'){entered.release();await release.promise;}return next();},async()=>{
  pending=commitTaskResult(f.service,f.id,new AbortController().signal).catch(error=>error);await reached(entered.promise);observed=await probe(f.runId);release.release();assert.equal(await pending,primary);
 });}finally{release.release();await pending;}
 assert.deepEqual(observed,{blocked:true});assert.deepEqual(await probe(f.runId),{acquired:true});
});

test('mirror rejects an active manager for another root before touching the cache',{skip:!isolated},async()=>{
 const f=await fixture(),run=await getRun(f.runId),foreign=createArchiveWriterManager({traceRoot:join(directory,'foreign')});
 writeFileSync(join(f.archive.dir,'artifacts/secret.txt'),'unchanged sentinel');let error:any;
 await foreign.withWriter([f.runId],()=>{try{materializeCommittedCanonical({traceRoot:directory,writers:foreign},run);}catch(caught){error=caught;}});
 assert.equal(error?.code,'E_ARCHIVE_WRITER_CONFIG');assert.equal(readFileSync(join(f.archive.dir,'artifacts/secret.txt'),'utf8'),'unchanged sentinel');
});

for(const failure of ['commit-before','commit-after','rollback'] as const)test('rejection settlement '+failure+' preserves first error and latches the original owner',{skip:!isolated},async()=>{
 const f=await fixture(),owner=await writers.acquireOwner([f.runId]),primary=Object.freeze(new AppError(409,'first deterministic rejection','TASK_SCOPE_DENIED'));
 let rejecting=false,rejections=0,error:any,discard:any;
 await intercept(async(sql,next)=>{
  if(sql.includes("merge_state='rejected'")){rejecting=true;rejections++;if(failure==='rollback')throw Error('secondary rejection update failed');}
  if(rejecting&&sql==='COMMIT'){if(failure==='commit-after')await next();throw Error('secondary rejection commit failed');}
  if(rejecting&&sql==='ROLLBACK'&&failure==='rollback'){await next();throw Error('secondary rejection rollback failed');}
  return next();
 },async()=>{await owner.run(async()=>{try{await commitTaskResult(f.service,f.id,new AbortController().signal,point=>{if(point==='before-sql-commit')throw primary;});}catch(caught){error=caught;}});},value=>discard=value);
 owner.finish();assert.equal(error,primary);await assert.rejects(owner.writerDrained,caught=>caught===primary);
 assert.equal(rejections,1);assert.equal(discard,true);assert.equal((await getOp(f.id)).merge_state,failure==='commit-after'?'rejected':'pending');assert.deepEqual(await probe(f.runId),{blocked:true});
});

test('operation reassigned after readonly lookup cannot settle a rejection in another run',{skip:!isolated,timeout:20000},async()=>{
 const f=await fixture(),other=await fixture(),fence=createArchiveWriteFence({traceRoot:directory,lockRoot:writers.lockRoot}),source=await fence.acquireSource(f.runId),discovered=gate(),query=pool.query;
 let pending:Promise<any>|undefined,released=false,rejections=0;
 (pool as any).query=async function(sql:any,...args:any[]){const result=await (query as any).call(pool,sql,...args);if(sql==='SELECT run_id FROM local_operations WHERE id=$1'&&args[0]?.[0]===f.id)discovered.release();return result;};
 try{await intercept(async(sql,next)=>{if(sql.includes("merge_state='rejected'"))rejections++;return next();},async()=>{
  pending=commitTaskResult(f.service,f.id,new AbortController().signal).catch(error=>error);await reached(discovered.promise);
  await pool.query('UPDATE local_operations SET run_id=$1 WHERE id=$2',[other.runId,f.id]);source.release();released=true;
  assert.equal((await pending).code,'TASK_MERGE_DENIED');
 });}finally{pool.query=query;if(!released)source.release();await pending;}
 assert.equal(rejections,0);const moved=await getOp(f.id);assert.equal(moved.run_id,other.runId);assert.equal(moved.merge_state,null);
 assert.deepEqual(await probe(f.runId),{acquired:true});assert.deepEqual(await probe(other.runId),{acquired:true});
});
