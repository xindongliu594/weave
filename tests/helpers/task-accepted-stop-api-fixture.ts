import {createArchiveWriterManager} from '../../services/agent-runtime/archive-writer-scope.mjs';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pool} from '../../apps/api/src/db.ts';
import {LocalOperationService,LocalRunExecutor,localDeviceRouter} from '../../apps/api/src/local-execution.ts';
import {createRunArchive} from '../../services/agent-runtime/trace-store.mjs';
import {checkpointContract,checkpointEnvironment} from '../../services/agent-runtime/step-checkpoints.mjs';
import {HandoffGate} from '../../services/agent-runtime/handoff.mjs';

const {manifest,revision}=createRequire(import.meta.url)('../../apps/desktop/local-executor.cjs');
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
const signal=()=>new AbortController().signal;

/** Real HTTP/SQL commits and Handoff seals; only physical operations/stop effects are fixtures. */
export async function acceptedStopApiFixture(root:string,{producerInput=false}={}){
 const writers=createArchiveWriterManager({traceRoot:root});
 const runId=randomUUID(),projectId=randomUUID(),deviceId=randomUUID(),grantId=randomUUID(),owner=randomUUID(),token='a'.repeat(64);
 const employee={id:'employee',employeeId:'employee',modelId:'unused',tools:['filesystem','artifact_write'],name:'Fixture',role:'manager'};
 const backend={kind:'openshell',version:'0.1.2',gateway:'fixture',image:'node@sha256:'+sha('image'),policySha256:sha('policy'),fingerprint:sha('backend')};
 const target={kind:'local',deviceId,grantId,backend},policy={maxBudget:1,maxAgents:1,maxConcurrentAgents:1,maxModelCalls:10,maxTaskModelCalls:5,deadlineSeconds:180,executionTarget:target};
 const tasks=['a','b','c'].map(id=>({id,kind:'work',assignee:'employee',inputs:[{path:'in.txt',sha256:sha('input')}],outputs:[{path:id+'.txt'}],inScope:[id+'.txt'],outOfScope:[],dependencies:[]}));
 if(producerInput){tasks.unshift({id:'p',kind:'work',assignee:'employee',inputs:[{path:'in.txt',sha256:sha('input')}],outputs:[{path:'p.txt'}],inScope:['p.txt'],outOfScope:[],dependencies:[]});const a=tasks.find(task=>task.id==='a')!;a.inputs=[{path:'p.txt',producerTaskId:'p'} as any];a.dependencies=['p'] as any;}
 let snapshot:any={projectId,planVersion:1,departmentId:'department',executionProfile:'task-attempt-openshell-v1',policy,agents:[employee],tasks,executionTarget:{...target,platform:'linux',allowCommands:true},importedFiles:[{path:'in.txt',content:'input',snapshotId:'snapshot',sha256:sha('input'),agentIds:['employee']}]};
 await pool.query('INSERT INTO departments(id,data) VALUES($1,$2)',['department',{name:'fixture',agents:[employee]}]);
 await pool.query('INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source) VALUES($1,$2,1,$3,$3,$4,$5,$3)',[projectId,'department','fixture',policy,{agents:[employee],tasks}]);
 await pool.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,lease_owner,lease_until) VALUES($1,$2,1,'running',$3,$4,now()+interval '1 hour')",[runId,projectId,snapshot,owner]);
 await pool.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$3,true,$6)',[deviceId,sha(token),'fixture','linux',grantId,backend]);
 snapshot=(await pool.query('SELECT snapshot FROM project_runs WHERE id=$1',[runId])).rows[0].snapshot;
 const archive=createRunArchive(root,snapshot,{id:runId});mkdirSync(join(archive.dir,'artifacts'));writeFileSync(join(archive.dir,'artifacts/in.txt'),'input');writeFileSync(join(archive.dir,'artifacts/private.txt'),'private');
 const bindingRoot=join(archive.dir,'trusted-local-grant');mkdirSync(bindingRoot);const binding=lstatSync(bindingRoot);
 const state:any={members:[{id:'session',name:'employee'}],tasks:tasks.map(task=>({id:'native-'+task.id,assignee:'employee',attemptId:'attempt-'+task.id,status:'in_progress'}))};
 archive.append('run/task-mapping',{tasks:tasks.map(task=>({task_id:'native-'+task.id,seed_id:task.id}))});archive.append('team/checkpoint',state);
 const control:{effects:number;calls:number;reconciles:number;signals:AbortSignal[];beforeCallback?:()=>Promise<void>;afterCallback?:()=>Promise<void>;afterEffect?:()=>Promise<void>}={effects:0,calls:0,reconciles:0,signals:[]};
 const observed=new Map<string,any>();
 const stopExecutor={acceptedStopCapabilities:()=>({version:1 as const,deadline:'shared-abort-v1' as const}),storageScopes:()=>[],inspectStorage:async()=>{},retireStorage:async()=>{},reconcileStorage:async()=>{},stopAcceptedTask:async(_key:any,expected:any,beforeDispatch:()=>Promise<void>,signal?:AbortSignal)=>{
  if(signal)control.signals.push(signal);control.calls++;await control.beforeCallback?.();signal?.throwIfAborted();await beforeDispatch();await control.afterCallback?.();signal?.throwIfAborted();control.effects++;
  const {accepted,checkpointResolved,operationsResolved,...identity}=expected,result={...identity,phase:'stopped',replayed:false};observed.set(identity.stopId,result);await control.afterEffect?.();return result;
 },reconcileAcceptedTaskStop:async(_key:any,identity:any,signal?:AbortSignal)=>{if(signal)control.signals.push(signal);signal?.throwIfAborted();control.reconciles++;const current=lstatSync(bindingRoot);if(current.dev!==binding.dev||current.ino!==binding.ino)throw Error('LOCAL_BINDING_CHANGED');const result=observed.get(identity.stopId);if(!result)throw Object.assign(Error('No original device intent'),{code:'LOCAL_OUTCOME_UNKNOWN'});return result;}};
 let currentExecutor=stopExecutor;
 const maintenance=()=>({deviceId,grantId,fingerprint:backend.fingerprint,executor:currentExecutor});
 const service=new LocalOperationService(root,owner,writers),executor=new LocalRunExecutor(archive,snapshot,service,{sandboxMaintenance:maintenance});
 const app=express();app.use(express.json({limit:'32mb'}));app.use(localDeviceRouter(root,writers));app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code,message:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+(server.address() as any).port+'/local-devices/'+deviceId;
 async function request(path:string,body:any){const response=await fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json','X-Local-Device-Key':token},body:JSON.stringify(body)}),data=await response.json() as any;assert.equal(response.status,200,JSON.stringify(data));return data;}
 const work=new Map<string,{files:any[];sandboxId:string}>(),jobs:any[]=[];
 async function drive<T>(pending:Promise<T>):Promise<T>{
  let finished=false,value:T,failure:unknown;pending.then(result=>{finished=true;value=result;},error=>{finished=true;failure=error;});
  const deadline=Date.now()+10000;
  while(!finished){
   assert.ok(Date.now()<deadline,'HTTP operation deadline');const {job}=await request('/poll',{});if(!job){await new Promise(done=>setTimeout(done,5));continue;}
   await request('/operations/'+job.id+'/start',{claimToken:job.claimToken});const id=job.executionScope.key.taskId;
   if(job.name==='prepare')work.set(id,{files:job.files,sandboxId:randomUUID()});const current=work.get(id)!;
   if(job.name==='artifact_write')current.files=[...current.files.filter(file=>file.path!==job.arguments.path),file(job.arguments.path,job.arguments.content)];
   const result:any={localWorkspace:'/sandbox/'+current.sandboxId,files:current.files,artifacts:manifest(current.files),workspaceRevision:revision(current.files),execution:{...backend,sandboxId:current.sandboxId,sandboxName:'fixture',uid:1000,gid:1000,node:'v24.19.0',cpu:[100000,100000],memory:'536870912',effectivePolicyHash:'27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5'},taskExecution:{profile:job.executionScope.profile,key:job.executionScope.key,scopeHash:job.executionScope.scopeHash,operationId:job.id,beforeWorkRevision:job.executionScope.expectedWorkRevision,afterWorkRevision:revision(current.files)}};
   if(job.name==='artifact_write')Object.assign(result,{path:job.arguments.path,bytes:Buffer.byteLength(job.arguments.content),sha256:sha(job.arguments.content)});
   await request('/operations/'+job.id+'/result',{claimToken:job.claimToken,ok:true,result});jobs.push(job);
  }
  if(failure)throw failure;return value!;
 }
 const contexts=new Map<string,any>();
 async function bind(id:string){const task=snapshot.tasks.find((task:any)=>task.id===id)!,assignment=await executor.bindAttempt({runId,taskId:id,attemptId:'attempt-'+id,agentId:'employee',sessionId:'session',runtimeTaskId:'native-'+id,contractHash:checkpointContract(snapshot,task)},signal());const context={agentId:'employee',sessionId:'session',taskId:id,attemptId:'attempt-'+id,generation:assignment.generation};contexts.set(id,context);return context;}
 async function write(id:string,text:string){const context=contexts.get(id)??await bind(id),scope=await drive(executor.prepareTask(context,signal())),executionScope={profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};await drive(executor.execute('artifact_write',{path:id+'.txt',content:text,expectedWorkspaceRevision:scope.workRevision,executionScope},signal(),{...context,callId:randomUUID(),executionScope}));return context;}
 let handoff:any;
 async function acceptTask(id:string,text:string){
  const context=await write(id,text),scope=await executor.taskScope(context,signal()),refs=await executor.prepareCheckpoint(context,signal(),{phase:'boundary'});
  const operation=(await pool.query('SELECT result FROM local_operations WHERE id=$1',[refs.lastMerge!.operationId])).rows[0];archive.append('local/device-bound',{execution:operation.result.result.execution});
  const gate=handoff??=new HandoffGate({snapshot:{...snapshot,id:runId},sandbox:{root:join(archive.dir,'artifacts')},archive});
  gate.environmentProof=operation.result.result.execution;gate.environment=checkpointEnvironment(snapshot,gate.environmentProof);
  gate.bindExecutionScope(id,'attempt-'+id,scope);gate.bindCheckpoint(id,'attempt-'+id,refs,{sessionId:'session'});
  const accepted=gate.prepare(id,'attempt-'+id,{});state.tasks.find((task:any)=>task.id==='native-'+id).status='completed';archive.append('team/checkpoint',state);gate.commit(accepted);archive.append('team/checkpoint',state);
  return context;
 }
 return {runId,deviceId,grantId,owner,backend,archive,bindingRoot,state,snapshot,service,executor,control,maintenance,jobs,bind,write,acceptTask,acceptA:()=>acceptTask('a','A'),drive,swapProvider:()=>{currentExecutor={...stopExecutor};},swapMethod:()=>{stopExecutor.reconcileAcceptedTaskStop=async()=>{throw Error('replacement maintenance method');};},close:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}
