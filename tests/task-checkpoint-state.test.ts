import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import express from 'express';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {assertExecutionProfile} from '../apps/api/src/execution-policy.ts';
import {pool,migrate} from '../apps/api/src/db.ts';
import {inProgressTaskMaintenance} from './helpers/task-stop-maintenance.ts';

const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const signal=()=>new AbortController().signal;
const scratch=join(process.cwd(),'.superpowers','sdd','2026-10-20-task-checkpoint-v2-integration');
let directory:string;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write'],name:'Fixture',role:'manager'};
before(async()=>{
 if(!isolated)return;
 assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);
 mkdirSync(scratch,{recursive:true});directory=mkdtempSync(join(scratch,'task-refs-'));
 process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');
 await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;await pool.end();assert.ok(resolve(directory).startsWith(resolve(scratch)+sep));rmSync(directory,{recursive:true,force:true});});
const getRun=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
const getOp=async(id:string)=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];

// Only the physical device is a fixture. The real API service queues, authenticates,
// claims, starts, persists and CAS-merges every successful operation below.
async function fixture(){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token='a'.repeat(64);
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:{kind:'local',deviceId,grantId,backend}};
 const tasks=['a','b'].map(id=>({id,assignee:'employee',inputs:[{path:'in.txt'}],outputs:[{path:id+'.txt'}],inScope:[id+'.txt'],outOfScope:[],dependencies:[]}));
 let snapshot:any={projectId,planVersion:1,departmentId:'department',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks,executionTarget:{...policy.executionTarget,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:sha('input'),agentIds:['employee']}]};
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents:[employee],tasks}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,sha(token),'fixture','linux',grantId,backend]);
 snapshot=(await getRun(runId)).snapshot;
 const archive=createRunArchive(directory,snapshot,{id:runId});mkdirSync(join(archive.dir,'artifacts'));
 writeFileSync(join(archive.dir,'artifacts/in.txt'),'input');writeFileSync(join(archive.dir,'artifacts/private.txt'),'private');
 const state={members:[{id:'session',name:'employee'}],tasks:tasks.map(t=>({id:'native-'+t.id,assignee:'employee',attemptId:'attempt-'+t.id,status:'in_progress'}))};
 archive.append('run/task-mapping',{tasks:tasks.map(t=>({task_id:'native-'+t.id,seed_id:t.id}))});archive.append('team/checkpoint',state);
 const service=new LocalOperationService(directory,owner),executor=new LocalRunExecutor(archive,snapshot,service,inProgressTaskMaintenance(deviceId,grantId,backend.fingerprint));
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(directory));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const endpoint='http://127.0.0.1:'+(server.address() as any).port+'/local-devices/'+deviceId;
 async function request(path:string,body:any){const response=await fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify(body)});const value=await response.json() as any;assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;}
 const work=new Map<string,{files:any[];sandboxId:string}>(),jobs:any[]=[];
 async function drive<T>(pending:Promise<T>):Promise<T>{
  let finished=false;let failure:unknown;let value:T;
  pending.then(result=>{value=result;finished=true;},error=>{failure=error;finished=true;});
  const deadline=Date.now()+10000;
  while(!finished){
   assert.ok(Date.now()<deadline,'real operation finishes within fixture deadline');
   const {job}=await request('/poll',{});
   if(!job){await new Promise(done=>setTimeout(done,5));continue;}
   assert.equal(JSON.stringify(job).includes('private.txt'),false);
   await request('/operations/'+job.id+'/start',{claimToken:job.claimToken});
   const taskId=job.executionScope.key.taskId;
   if(job.name==='prepare'){assert.equal(work.has(taskId),false);work.set(taskId,{files:job.files,sandboxId:randomUUID()});}
   const current=work.get(taskId)!;assert.ok(current);assert.equal(revision(current.files),job.executionScope.expectedWorkRevision);
   if(job.name==='artifact_write')current.files=[...current.files.filter(f=>f.path!==job.arguments.path),file(job.arguments.path,job.arguments.content)];
   const files=current.files,result:any={localWorkspace:'openshell://fixture/'+current.sandboxId+'/sandbox',files,artifacts:manifest(files),workspaceRevision:revision(files),execution:{...backend,sandboxId:current.sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
   if(job.name==='artifact_write')Object.assign(result,{path:job.arguments.path,bytes:Buffer.byteLength(job.arguments.content),sha256:sha(job.arguments.content)});
   await request('/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:true,result});jobs.push(job);
  }
  if(failure)throw failure;return value!;
 }
 const contexts=new Map<string,any>();
 async function prepare(taskId:string){
  let context=contexts.get(taskId);
  if(!context){const assignment=await executor.bindAttempt({runId,taskId,attemptId:'attempt-'+taskId,agentId:'employee',sessionId:'session',runtimeTaskId:'native-'+taskId,contractHash:checkpointContract(snapshot,snapshot.tasks.find((t:any)=>t.id===taskId))},signal());context={agentId:assignment.agentId,sessionId:assignment.sessionId,taskId,attemptId:assignment.attemptId,generation:assignment.generation};contexts.set(taskId,context);}
  const scope=await drive(executor.prepareTask(context,signal()));return {context,scope};
 }
 async function write(taskId:string,text:string){
  const {context,scope}=await prepare(taskId),executionScope={profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};
  await drive(executor.execute('artifact_write',{path:taskId+'.txt',content:text,expectedWorkspaceRevision:scope.workRevision,executionScope},signal(),{...context,callId:randomUUID(),executionScope}));
  return {context,id:jobs.at(-1).id,scope};
 }
 return {runId,projectId,deviceId,archive,snapshot,state,service,executor,work,jobs,prepare,write,close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}

test('checkpoint refs preserve A work and original merge while canonical advances to independent B',{skip:!isolated},async()=>{
 const f=await fixture();try{
  assert.throws(()=>assertExecutionProfile(f.snapshot),{code:'TASK_EXECUTION_UNAVAILABLE'});
  const a=await f.write('a','A committed');const b=await f.write('b','B committed');
  const before=(await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n;
  // Poison and omit cache files: authoritative refs must read SQL and objects.
  writeFileSync(join(f.archive.dir,'artifacts/a.txt'),'wrong cache');unlinkSync(join(f.archive.dir,'artifacts/private.txt'));
  const refs=await f.executor.prepareCheckpoint(a.context,signal(),{phase:'after-tool',operationId:a.id});
  assert.deepEqual(refs.key,{runId:f.runId,taskId:'a',attemptId:'attempt-a',generation:1});
  assert.deepEqual(refs.workManifest.map(v=>v.path),['a.txt','in.txt']);
  assert.deepEqual(refs.canonical.manifest.map(v=>v.path),['a.txt','b.txt','in.txt','private.txt']);
  assert.equal(refs.lastMerge?.operationId,a.id);assert.equal(refs.canonical.mergeId,b.id);
  assert.notEqual(refs.lastMerge?.afterRevision,refs.canonical.revision);
  assert.equal(refs.lastMerge?.workRevision,revision([file('a.txt','A committed'),file('in.txt','input')]));
  assert.equal(refs.workManifest.find(v=>v.path==='a.txt')?.sha256,sha('A committed'));
  assert.equal(refs.inputOrigins[0].source.kind,'import');assert.equal((refs.inputOrigins[0].source as any).snapshotId,'snapshot');
  assert.ok(Object.isFrozen(refs)&&Object.isFrozen(refs.canonical.manifest)&&Object.isFrozen(refs.inputOrigins[0].source));
  assert.throws(()=>{refs.workManifest[0].sha256=sha('forged');});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM local_operations')).rows[0].n,before,'checkpoint preparation never queues device work');
  assert.equal(readFileSync(join(f.archive.dir,'checkpoint-objects',sha('A committed')),'utf8'),'A committed');
  const publicResult=await f.executor.taskResultSummary(a.id);assert.equal(JSON.stringify(publicResult).includes('private.txt'),false);assert.equal((publicResult as any).canonical,undefined);
 }finally{await f.close();}
});

test('before-tool checkpoint uses imported task bytes rather than full canonical revision',{skip:!isolated},async()=>{
 const f=await fixture();try{
  const {context,scope}=await f.prepare('a');const refs=await f.executor.prepareCheckpoint(context,signal(),{phase:'before-tool'});
  assert.deepEqual(refs.workManifest.map(v=>v.path),['in.txt']);assert.equal(refs.lastMerge?.operationId,f.jobs[0].id);
  assert.equal(refs.lastMerge?.workRevision,revision(scope.workspace.importedFiles));assert.notEqual(refs.lastMerge?.workRevision,scope.workRevision);
 }finally{await f.close();}
});

test('after-tool checkpoint refuses a missing, other-task, stale or nonexistent operation identity',{skip:!isolated},async()=>{
 const f=await fixture();try{
  const a=await f.write('a','first');const old=a.id;const newer=await f.write('a','second');const b=await f.write('b','B');
  for(const options of [{phase:'after-tool'}, {phase:'after-tool',operationId:b.id},{phase:'after-tool',operationId:old},{phase:'after-tool',operationId:randomUUID()}])await assert.rejects(()=>f.executor.prepareCheckpoint(newer.context,signal(),options as any));
  for(const patch of [{generation:2},{taskId:'b'},{attemptId:'foreign'},{sessionId:'foreign'},{agentId:'foreign'}])await assert.rejects(()=>f.executor.prepareCheckpoint({...newer.context,...patch},signal(),{phase:'boundary'}));
 }finally{await f.close();}
});

test('SQL unknown blocks checkpoint despite finished events and human acknowledgment',{skip:!isolated},async()=>{
 const f=await fixture();try{
  const a=await f.write('a','A');f.archive.append('runtime/operation-finished',{operationId:a.id});f.archive.append('run/unknown-acknowledged',{acknowledged:true});
  await pool.query("UPDATE local_operations SET merge_state='unknown' WHERE id=$1",[a.id]);
  await assert.rejects(()=>f.executor.prepareCheckpoint(a.context,signal(),{phase:'boundary'}),{code:'TASK_OPERATION_UNRESOLVED'});
 }finally{await f.close();}
});

for(const damage of ['missing','corrupt'])test(`checkpoint refuses ${damage} referenced objects without cache repair`,{skip:!isolated},async()=>{
 const f=await fixture();try{
  const a=await f.write('a','A'),object=join(f.archive.dir,'checkpoint-objects',sha('A'));
  if(damage==='missing')unlinkSync(object);else writeFileSync(object,'X');
  await assert.rejects(()=>f.executor.prepareCheckpoint(a.context,signal(),{phase:'after-tool',operationId:a.id}));
  assert.equal(readFileSync(join(f.archive.dir,'artifacts/a.txt'),'utf8'),'A');
 }finally{await f.close();}
});

for(const withdrawal of ['lease','authority','assignment','capability','recovery'])test(`checkpoint refuses changed ${withdrawal}`,{skip:!isolated},async()=>{
 const f=await fixture();try{
  const a=await f.write('a','A');
  if(withdrawal==='lease')await pool.query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[f.runId]);
  if(withdrawal==='authority')await pool.query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);
  if(withdrawal==='assignment')f.archive.append('team/checkpoint',{...f.state,tasks:f.state.tasks.map(t=>({...t,attemptId:'changed'}))});
  if(withdrawal==='capability')await pool.query("UPDATE task_attempt_workspaces SET capability_hash=$1 WHERE run_id=$2",[sha('changed'),f.runId]);
  if(withdrawal==='recovery')await pool.query("UPDATE project_runs SET snapshot=jsonb_set(snapshot,'{recovery}','{}') WHERE id=$1",[f.runId]);
  await assert.rejects(()=>f.executor.prepareCheckpoint(a.context,signal(),{phase:'boundary'}));
 }finally{await f.close();}
});

test('checkpoint independently authenticates the task merge record after a newer canonical commit',{skip:!isolated},async()=>{
 const f=await fixture();try{
  const a=await f.write('a','A');await f.write('b','B');const op=await getOp(a.id);op.merge_record.receipt.workRevision=sha('forged');
  await pool.query('UPDATE local_operations SET merge_record=$1 WHERE id=$2',[op.merge_record,a.id]);
  await assert.rejects(()=>f.executor.prepareCheckpoint(a.context,signal(),{phase:'after-tool',operationId:a.id}));
  assert.equal(readCommittedCanonical(directory,await getRun(f.runId)).ref.mergeId,f.jobs.at(-1).id);
 }finally{await f.close();}
});

for(const change of ['lease','authority','assignment','object'])test(`checkpoint revalidates ${change} after asynchronous preparation`,{skip:!isolated},async(t)=>{
 const f=await fixture();try{
  const a=await f.write('a','A');
  const db=await pool.connect(),query=db.query.bind(db);let leaseChecks=0;
  // Inject an actual state/storage change while the real SQL work awaits. The
  // device, resolver, canonical reader and every query result remain real.
  t.mock.method(db,'query',async(...args:any[])=>{
   const text=args[0],result=await (query as any)(...args);
   if(typeof text==='string'&&text.startsWith('UPDATE task_attempt_workspaces SET scope=')){
    if(change==='lease')await query("UPDATE project_runs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[f.runId]);
    if(change==='authority')await query('UPDATE local_devices SET enabled=false WHERE id=$1',[f.deviceId]);
    if(change==='assignment')f.archive.append('team/checkpoint',{...f.state,tasks:f.state.tasks.map(task=>({...task,attemptId:'revoked-during-preparation'}))});
   }
   if(change==='object'&&typeof text==='string'&&text.includes("lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()")&&++leaseChecks===3){
    writeFileSync(join(f.archive.dir,'checkpoint-objects',sha('A')),'X');
   }
   return result;
  });
  db.release();
  await assert.rejects(()=>f.executor.prepareCheckpoint(a.context,signal(),{phase:'after-tool',operationId:a.id}));
 }finally{await f.close();}
});

for(const change of ['assignment','object','abort','progress'])test(`checkpoint publication fences ${change} at the real COMMIT response`,{skip:!isolated},async(t)=>{
 const f=await fixture();try{
  const a=await f.write('a','A'),abort=new AbortController();
  const db=await pool.connect(),query=db.query.bind(db);
  // COMMIT really completes; only its promise delivery is extended to change
  // archive/object state at the API's final await, without faking SQL success.
  t.mock.method(db,'query',async(...args:any[])=>{
   const result=await (query as any)(...args);
   if(args[0]==='COMMIT'){
    if(change==='assignment')f.archive.append('team/checkpoint',{...f.state,members:f.state.members.map(member=>({...member,status:'removed'}))});
    if(change==='object')writeFileSync(join(f.archive.dir,'checkpoint-objects',sha('A')),'X');
    if(change==='abort')abort.abort(Error('checkpoint publication cancelled'));
    if(change==='progress')f.archive.append('team/checkpoint',{...f.state,tasks:f.state.tasks.map(task=>({...task,progress:'ordinary progress after SQL commit',updatedAt:new Date().toISOString()}))});
   }
   return result;
  });
  db.release();
  const pending=f.executor.prepareCheckpoint(a.context,abort.signal,{phase:'after-tool',operationId:a.id});
  if(change==='progress'){
   const refs=await pending;assert.equal(refs.lastMerge?.operationId,a.id);assert.equal(refs.workManifest.find(file=>file.path==='a.txt')?.sha256,sha('A'));
  }else await assert.rejects(()=>pending);
 }finally{await f.close();}
});
