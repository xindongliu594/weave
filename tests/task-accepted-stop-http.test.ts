import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import express from 'express';
import {createRunArchive} from '../services/agent-runtime/trace-store.mjs';
import {checkpointContract} from '../services/agent-runtime/step-checkpoints.mjs';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../apps/api/src/local-execution.ts';
import {readCommittedCanonical,commitTaskResult,reconcileTaskMerge} from '../apps/api/src/task-canonical.ts';
import {assertNoUnresolvedTaskOperation} from '../apps/api/src/task-operation-admission.ts';
import {decodeTaskAcceptedStop} from '../apps/api/src/task-accepted-stop-state.ts';
import {pool,migrate} from '../apps/api/src/db.ts';

const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const isolated=process.env.SIMULATED_INTEGRATION==='pglite',signal=new AbortController().signal;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ordered=(value:any):any=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const digest=(value:any)=>sha(JSON.stringify(ordered(value)));
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const scratch=join(process.cwd(),'.superpowers','sdd','2026-10-20-task-checkpoint-v2-integration');
let directory:string,server:any,url:string;
const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write'],name:'Fixture',role:'manager'};
before(async()=>{
 if(!isolated)return;assert.match(process.env.DATABASE_URL??'',/@127\.0\.0\.1:\d+\/postgres$/);
 mkdirSync(scratch,{recursive:true});directory=mkdtempSync(join(scratch,'sql-stop-http-'));process.env.DATA_DIR=directory;process.env.TRACE_ROOT=directory;process.env.OBSIDIAN_VAULT=join(directory,'vault');
 await migrate();await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['stop-department',{name:'fixture',agents:[employee]}]);
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(directory));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 server=app.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+server.address().port;
});
beforeEach(async()=>{if(isolated)await pool.query('TRUNCATE local_operations,local_devices,project_runs,projects,usage,model_reservations,tool_approvals CASCADE');});
afterEach(async()=>{if(isolated)for(const table of ['models','usage','model_reservations'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);});
after(async()=>{if(!isolated)return;if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(done));}await pool.end();assert.ok(resolve(directory).startsWith(resolve(scratch)+sep));rmSync(directory,{recursive:true,force:true});});
const getRun=async(id:string)=>(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
const getOperation=async(id:string)=>(await pool.query('SELECT * FROM local_operations WHERE id=$1',[id])).rows[0];

// Real SQL/API enqueue/claim/start/result/merge, only physical device execution
// and stop markers are fixtures. Synthetic markers prove admission, not acceptance.
async function fixture(){
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token='a'.repeat(64);
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:{kind:'local',deviceId,grantId,backend}};
 const task={id:'a',assignee:'employee',inputs:[{path:'in.txt'}],outputs:[{path:'a.txt'}],inScope:['a.txt'],outOfScope:[],dependencies:[]};
 const snapshot:any={projectId,planVersion:1,departmentId:'stop-department',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks:[task],executionTarget:{...policy.executionTarget,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:sha('input'),agentIds:['employee']}]};
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'stop-department','fixture',policy,{agents:[employee],tasks:[task]}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,sha(token),'fixture','linux',grantId,backend]);
 const stored=(await getRun(runId)).snapshot,archive=createRunArchive(directory,stored,{id:runId});mkdirSync(join(archive.dir,'artifacts'));writeFileSync(join(archive.dir,'artifacts/in.txt'),'input');writeFileSync(join(archive.dir,'artifacts/private.txt'),'private');
 archive.append('run/task-mapping',{tasks:[{task_id:'native-a',seed_id:'a'}]});archive.append('team/checkpoint',{members:[{id:'session',name:'employee'}],tasks:[{id:'native-a',assignee:'employee',attemptId:'attempt-a',status:'in_progress'}]});
 const service=new LocalOperationService(directory,owner),executor=new LocalRunExecutor(archive,stored,service);
 const assignment=await executor.bindAttempt({runId,taskId:'a',attemptId:'attempt-a',agentId:'employee',sessionId:'session',runtimeTaskId:'native-a',contractHash:checkpointContract(stored,stored.tasks[0])},signal);
 const context={agentId:'employee',sessionId:'session',taskId:'a',attemptId:'attempt-a',generation:assignment.generation};
 const key={runId,taskId:'a',attemptId:'attempt-a',generation:assignment.generation};
 async function request(path:string,body:any){const response=await fetch(url+'/local-devices/'+deviceId+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
 const sandboxId=randomUUID();let files:any[]=[];
 const result=(job:any,next=files)=>({localWorkspace:'openshell://fixture/'+sandboxId+'/sandbox',files:next,artifacts:manifest(next),workspaceRevision:revision(next),execution:{...backend,sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(next)}});
 let done=false;const preparing=executor.prepareTask(context,signal);preparing.finally(()=>{done=true;}).catch(()=>{});
 let prepareJob:any;const deadline=Date.now()+15000;
 while(!done&&Date.now()<deadline){const poll=await request('/poll',{});assert.equal(poll.status,200);if(poll.data.job){prepareJob=poll.data.job;assert.equal(prepareJob.name,'prepare');files=prepareJob.files;assert.equal((await request('/operations/'+prepareJob.id+'/start',{claimToken:prepareJob.claimToken})).status,200);assert.equal((await request('/operations/'+prepareJob.id+'/result',{claimToken:prepareJob.claimToken,ok:true,result:result(prepareJob)})).status,200);}else await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(done,'real prepare settles');const scope=await preparing;
 const publicScope={profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};
 async function enqueue(){return service.enqueue(runId,'artifact_write',{path:'a.txt',content:'output',expectedWorkspaceRevision:scope.workRevision,executionScope:publicScope},{...context,executionScope:publicScope,callId:randomUUID()},undefined,signal);}
 async function setStop(state='unknown'){
  const proof={accepted:{seq:4,digest:sha('synthetic accepted')},checkpoint:{id:randomUUID(),sha256:sha('synthetic checkpoint'),seq:5},originalOperationId:prepareJob.id,originalMergeDigest:sha('synthetic merge'),runtimeTaskId:'native-a',principal:'employee',sessionId:'session',contractHash:assignment.contractHash,permissionHash:sha('synthetic permission'),capabilityHash:sha('synthetic capability'),deviceId,grantId,fingerprint:backend.fingerprint};
  const identity={version:1,stopId:randomUUID(),key,sandboxId,workspaceRevision:revision(files),proofDigest:digest({kind:'task-accepted-stop-proof',version:1,proof})};
  const marker:any={version:1,identity,proof,state,preparedAt:'2026-10-20T10:00:00.000Z',digest:digest({kind:'task-accepted-stop',version:1,identity,proof})};
  if(state!=='prepared')marker.dispatchedAt='2026-10-20T10:00:01.000Z';
  if(state==='stopped'){marker.confirmedAt='2026-10-20T10:00:02.000Z';marker.result={...identity,phase:'stopped',replayed:false};}
  decodeTaskAcceptedStop(marker);await pool.query('UPDATE task_attempt_workspaces SET accepted_stop=$1 WHERE run_id=$2',[marker,runId]);
 }
 return {runId,request,service,executor,context,scope,enqueue,setStop,prepareJob,result,files};
}

test('SQL accepted-stop denies queued poll, claimed replay and start without losing the original claim',{skip:!isolated},async()=>{
 for(const stage of ['poll','claimed-replay','start']){
  const f=await fixture(),id=await f.enqueue(),job=stage==='poll'?null:(await f.request('/poll',{})).data.job;
  await f.setStop('prepared');
  if(stage==='poll')assert.equal((await f.request('/poll',{})).data.job,null);
  if(stage==='claimed-replay'){const response=await f.request('/poll',{});assert.equal(response.status,200);assert.equal(response.data.job,undefined);assert.deepEqual(response.data.orphan,{id,claimToken:job.claimToken,started:false});}
  if(stage==='start')assert.equal((await f.request('/operations/'+id+'/start',{claimToken:job.claimToken})).status,409);
  const row=await getOperation(id);assert.equal(row.started,false);if(job)assert.equal(row.claim_token,job.claimToken);
  await assert.rejects(()=>f.enqueue(),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});
 }
});

test('SQL stop fence retains authenticated unknown result once as late evidence and never settles its unknown',{skip:!isolated},async()=>{
 const f=await fixture(),id=await f.enqueue(),job=(await f.request('/poll',{})).data.job;
 assert.equal((await f.request('/operations/'+id+'/start',{claimToken:job.claimToken})).status,200);await f.setStop('unknown');
 const receipt={claimToken:job.claimToken,ok:false,error:{code:'LOCAL_OUTCOME_UNKNOWN',message:'lost actual effect response',notExecuted:false}};
 assert.equal((await f.request('/operations/'+id+'/result',receipt)).status,200);
 const first=await getOperation(id);assert.equal(first.result,null);assert.deepEqual(first.late_result,receipt);assert.equal(first.status,'cancelled');assert.equal(first.started,true);
 assert.equal((await f.request('/operations/'+id+'/result',receipt)).status,200);
 assert.equal((await f.request('/operations/'+id+'/result',{...receipt,error:{...receipt.error,message:'different receipt'}})).status,409);
 await f.setStop('stopped');
 assert.deepEqual((await getOperation(id)).late_result,first.late_result);
 await assert.rejects(()=>assertNoUnresolvedTaskOperation(pool,f.runId),{code:'TASK_OPERATION_UNRESOLVED'});
 assert.equal(readCommittedCanonical(directory,await getRun(f.runId)).files.some(file=>file.path==='a.txt'),false);
});

test('committed receipt reread survives a SQL stop fence while pending merge cannot publish a head',{skip:!isolated},async()=>{
 const committed=await fixture(),before=await getRun(committed.runId),original=await getOperation(committed.prepareJob.id);
 await committed.setStop('unknown');
 assert.equal((await committed.request('/operations/'+original.id+'/result',original.result)).status,200);
 assert.deepEqual(await reconcileTaskMerge(committed.service,original.id),original.merge_record.receipt);
 assert.deepEqual((await getOperation(original.id)).result,original.result);assert.deepEqual((await getRun(committed.runId)).canonical_workspace,before.canonical_workspace);
 const f=await fixture(),id=await f.enqueue(),job=(await f.request('/poll',{})).data.job;
 assert.equal((await f.request('/operations/'+id+'/start',{claimToken:job.claimToken})).status,200);
 const files=[...f.files,file('a.txt','output')],result={...f.result(job,files),path:'a.txt',bytes:6,sha256:sha('output')};
 assert.equal((await f.request('/operations/'+id+'/result',{claimToken:job.claimToken,ok:true,result})).status,200);
 await assert.rejects(()=>commitTaskResult(f.service,id,signal,point=>{if(point==='intent')throw Error('fixture interrupted after durable intent');}),/fixture interrupted/);
 const pending=await getOperation(id),head=(await getRun(f.runId)).canonical_workspace;assert.equal(pending.merge_state,'pending');await f.setStop('prepared');
 await assert.rejects(()=>reconcileTaskMerge(f.service,id),{code:'TASK_ACCEPTED_STOP_UNRESOLVED'});
 const after=await getOperation(id);assert.equal(after.merge_state,'pending');assert.deepEqual(after.merge_record,pending.merge_record);assert.deepEqual(after.result,pending.result);assert.deepEqual((await getRun(f.runId)).canonical_workspace,head);
});
