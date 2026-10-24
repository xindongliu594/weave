import {Router} from 'express';
import {z} from 'zod';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {shareCostMaintenance} from './cost-control.ts';
import {assertRunAuthorization,assertCurrentRunPermissions,assertExecutionProfile} from './execution-policy.ts';
import {assertCurrentRunAuthority,recordRunAuthorityDenial} from './run-current-authority.ts';
import {initializeTaskCanonical,readCommittedCanonical,commitTaskResult,validateTaskOperationResult} from './task-canonical.ts';
import {bindTrustedAttempt,resolveTaskScope} from './task-execution.ts';
import {prepareTaskCheckpoint,type TaskCheckpointContext,type TaskCheckpointOptions} from './task-checkpoint-state.ts';
import {TaskAcceptedStopLifecycle,requireTaskStopProvider} from './task-accepted-stop.ts';
import type {SandboxMaintenance} from './storage-lifecycle.ts';
import {admitTaskOperation,assertNoUnresolvedTaskOperation,publicTaskScope,taskDeviceScope,taskOperationDenied} from './task-operation-admission.ts';
import type {TrustedTaskCandidate,TrustedTaskAssignment,TaskExecutionScope,TaskCheckpointRefs} from '../../../packages/contracts/index.ts';
import {withFreshLocalAdmission} from './local-admission.ts';
import {openRunArchive,readRun} from '../../../services/agent-runtime/trace-store.mjs';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {executionBackendSchema} from '../../../packages/contracts/index.ts';
import {executionBackend,assertExecutionBackendBinding,assertExecutionBackendReceipt} from './execution-backend.ts';
import {nativeToolBinding,nativeFileAccess} from '../../../services/agent-runtime/native-capabilities.mjs';
const {decodeFiles,exportFiles,mirrorFiles,revision,manifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const {checkpointTestInvocation}=createRequire(import.meta.url)('../../desktop/checkpoint-test-profile.cjs');
const digest=(value:string)=>createHash('sha256').update(value).digest();
function validateResult(row:any,result:any){
 const files=decodeFiles(result.files),name=row.payload.name,args=row.payload.arguments;
 if(typeof result.localWorkspace!=='string'||!result.localWorkspace||result.localWorkspace.length>4096)throw new AppError(422,'缺少本机工作区位置');
 if(name==='terminal'||name==='terminal_test'){
  if(!Number.isInteger(result.exitCode)||typeof result.output!=='string')throw new AppError(422,'缺少命令退出码或输出');
 }else if(name==='native_plugin'){
  const binding=row.payload.deviceArguments??args;
  if(result.pluginId!==binding.pluginId||result.toolName!==binding.toolName||typeof result.nativeResult?.isError!=='boolean')throw new AppError(422,'原生插件回执版本或工具不匹配');
 }else if(name==='filesystem'||name==='artifact_write'){
  const file=files.find((item:any)=>item.path===args.path);
  if(result.path!==args.path||!file||result.sha256!==createHash('sha256').update(file.bytes).digest('hex'))throw new AppError(422,'文件回执与回传内容不符');
  if(name==='filesystem'&&(file.bytes.length>1024*1024||result.content!==file.bytes.toString('utf8')))throw new AppError(422,'读取回执不正确');
  if(name==='artifact_write'&&(!file.bytes.equals(Buffer.from(args.content))||result.bytes!==file.bytes.length))throw new AppError(422,'写入回执与批准内容不符');
 }
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const publicDevice=(row:any)=>({id:row.id,name:row.name,platform:row.platform,grantId:row.grant_id,label:row.label,allowCommands:row.allow_commands,enabled:row.enabled,lastSeen:row.last_seen,online:row.online,backend:executionBackend(row.backend)});
export async function localTarget(policy:any,agents:any[],db:Pick<pg.PoolClient,'query'>=pool,online=true){
 const target=policy.executionTarget;
 if(target?.kind!=='local')return {kind:'server',platform:'linux'};
 const row=(await db.query("SELECT *,last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices WHERE id=$1",[target.deviceId])).rows[0];
 if(!row?.enabled||row.grant_id!==target.grantId)throw new AppError(422,'本机设备或目录授权已变化，请重新选择设备并批准方案','LOCAL_GRANT_CHANGED');
 const backend=executionBackend(row.backend);assertExecutionBackendBinding(backend,target.backend);
 if(!row.allow_commands&&agents.some(agent=>agent.tools?.some((tool:string)=>tool==='terminal'||tool==='terminal_test')))throw new AppError(422,'此设备没有开放本机命令，请在桌面端授权或移除终端工具','LOCAL_COMMAND_DENIED');
 if(online&&!row.online)throw new AppError(422,'本机执行器状态未刷新，请确认本机服务仍在运行，然后检查恢复条件','LOCAL_DEVICE_OFFLINE');
 return {kind:'local',deviceId:row.id,grantId:row.grant_id,name:row.name,platform:row.platform,label:row.label,allowCommands:row.allow_commands,backend};
}
export async function proveLocalDevice(id:string,key:unknown,db:Pick<pg.PoolClient,'query'>=pool){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new AppError(403,'本机设备凭证无效','LOCAL_DEVICE_DENIED');
 const row=(await db.query('SELECT * FROM local_devices WHERE id=$1',[id])).rows[0];
 if(!row||!timingSafeEqual(Buffer.from(row.token_hash,'hex'),digest(key)))throw new AppError(403,'本机设备凭证无效','LOCAL_DEVICE_DENIED');
 return row;
}
const proof=proveLocalDevice;
function requireWriters(traceRoot:string,writers:ArchiveWriterManager){if(!writers||writers.traceRoot!==traceRoot)throw Error('ARCHIVE_WRITER_CONFIG_REQUIRED');}
function executionFact(error:unknown,notExecuted:boolean){try{Object.assign(error as object,{notExecuted});}catch{/* Preserve immutable original errors; absence of proof remains unknown. */}}
/** These callbacks only mutate SQL, except enqueue's explicitly marked append. */
async function localTransaction<T>(writers:ArchiveWriterManager,runId:string,fn:(db:pg.PoolClient,archiveMutation:()=>void)=>Promise<T>,signal?:AbortSignal,rolledBack?:()=>void):Promise<T>{
 const outcome=await writers.withWriter([runId],async()=>{
  const db=await pool.connect();let committing=false,archiving=false,discard=false;
  try{
   await db.query('BEGIN');await shareCostMaintenance(db);
   const value=await fn(db,()=>{archiving=true;});committing=true;await db.query('COMMIT');return {ok:true as const,value};
  }catch(error){
   try{await db.query('ROLLBACK');}catch{discard=true;}
   if(!committing&&!archiving&&!discard)return {ok:false as const,error};
   discard=true;executionFact(error,false);throw error;
  }finally{db.release(discard);}
 },{signal});
 if(!outcome.ok){rolledBack?.();await recordRunAuthorityDenial(pool,outcome.error);throw outcome.error;}return outcome.value;
}
const withdrawnRunAuthority=Symbol('withdrawnRunAuthority');
async function operationTransaction<T>(writers:ArchiveWriterManager,id:string,fn:(db:pg.PoolClient,row:any,run:any,device:any)=>Promise<T>,rolledBack?:()=>void){
 const discovered=(await pool.query('SELECT run_id FROM local_operations WHERE id=$1',[id])).rows[0];
 if(!discovered)throw new AppError(404,'本机操作不存在');
 let authorityDenied:unknown;
 try{return await localTransaction(writers,discovered.run_id,async db=>{
  const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[discovered.run_id])).rows[0];
  if(!identity)throw new AppError(404,'本机操作不存在');
  await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
  const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[discovered.run_id])).rows[0];
  if(!run||run.project_id!==identity.project_id)throw new AppError(409,'本机操作身份已变化');
  // Actor/membership admission precedes operation/device locks. A withdrawn
  // actor may still contribute its original authenticated receipt, never work.
  try{await assertCurrentRunAuthority(db,run.id,'tool');}
  catch(error){if(!(error instanceof AppError)||error.code!=='RUN_AUTHORITY_REVOKED')throw error;authorityDenied=error;run[withdrawnRunAuthority]=true;}
  const row=(await db.query('SELECT * FROM local_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!run||run.project_id!==identity.project_id||!row||row.run_id!==run.id)throw new AppError(409,'本机操作身份已变化');
  const device=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[row.device_id])).rows[0];
  return fn(db,row,run,device);
 },undefined,rolledBack);}finally{await recordRunAuthorityDenial(pool,authorityDenied);}
}
async function authenticatedOperation<T>(writers:ArchiveWriterManager,id:string,deviceId:string,key:unknown,fn:(db:pg.PoolClient,row:any,run:any,device:any)=>Promise<T>){
 return operationTransaction(writers,id,async(db,row,run,device)=>{
  if(row.device_id!==deviceId)throw new AppError(403,'本机操作不属于此设备','LOCAL_DEVICE_DENIED');
  await proof(deviceId,key,db);return fn(db,row,run,device);
 });
}
/** Cross-run device metadata shares the SQL source gate, not one run's native guard. */
async function deviceTransaction<T>(fn:(db:pg.PoolClient)=>Promise<T>){
 const db=await pool.connect();let committing=false,discard=false;
 try{await db.query('BEGIN');await shareCostMaintenance(db);const result=await fn(db);committing=true;await db.query('COMMIT');return result;}
 catch(error){discard=committing;try{await db.query('ROLLBACK');}catch{discard=true;}throw error;}finally{db.release(discard);}
}
async function executable(db:pg.PoolClient,row:any,run:any,device:any,receiptOnly=false,traceRoot?:string){
 if(run[withdrawnRunAuthority])return false;
 if(!device?.enabled||row.grant_id!==device.grant_id||run.status!=='running'||run.cancel_requested||run.lease_owner!==row.lease_owner||!(await db.query('SELECT id FROM project_runs WHERE id=$1 AND lease_until>clock_timestamp()',[run.id])).rowCount||!(await db.query('SELECT id FROM local_operations WHERE id=$1 AND deadline>clock_timestamp()',[row.id])).rowCount)return false;
 // A started operation can return its authenticated receipt while polling is
 // delayed. Heartbeat freshness is admission evidence, not grant withdrawal;
 // the device, run, lease, deadline and full authorization checks still apply.
 if(run.snapshot.executionProfile==='task-attempt-openshell-v1'){
  try{
   if(!traceRoot)taskOperationDenied('缺少任务档案');
   await admitTaskOperation(db,run,traceRoot!,row.payload.context,row.payload.taskScope,row.id,{requireLocalOnline:row.started!==true});
   if(!isDeepStrictEqual(row.payload.executionScope,taskDeviceScope(row.payload.taskScope,revision(row.payload.taskScope.workspace.importedFiles))))return false;
   if(row.approval_id&&!(await db.query("SELECT id FROM tool_approvals WHERE id=$1 AND run_id=$2 AND agent_id=$3 AND tool=$4 AND arguments=$5::jsonb AND status='approved'",[row.approval_id,run.id,row.payload.context.agentId,row.payload.name,JSON.stringify(row.payload.arguments)])).rowCount)return false;
  }
  catch(error){
   // An authenticated result is still evidence after authority is withdrawn.
   // Keep it in late_result; do not turn it into permission to merge or retry.
   if(error instanceof AppError&&error.status>=400&&error.status<500)return false;
   throw error;
  }
 }else await assertRunAuthorization(run,db,{requireLocalOnline:row.started!==true});return true;
}
/** Never spread private queued payloads into the device protocol. */
function deviceJob(row:any,claimToken:string){
 const p=row.payload;
 if(!p.taskScope)return {id:row.id,...p,claimToken};
 return {id:row.id,runId:p.runId,grantId:p.grantId,deviceId:p.deviceId,name:p.name,arguments:p.deviceArguments,context:{callId:p.context.callId},approvalId:p.approvalId,executionScope:p.executionScope,...(p.verificationProfile?{verificationProfile:p.verificationProfile}:{}),...(p.files?{files:p.files}:{}),claimToken};
}
export class LocalOperationService {
 constructor(public traceRoot:string,public owner:string,public writers:ArchiveWriterManager){requireWriters(traceRoot,writers);}
 async enqueue(runId:string,name:string,args:any,context:any,files?:any[],signal?:AbortSignal){
   let outcome;
   try{outcome=await withFreshLocalAdmission(async()=>{
    let rolledBack=false;
    try{return {ok:true as const,id:await this.enqueueAttempt(runId,name,args,context,files,signal,()=>{rolledBack=true;})};}
    catch(error){if(rolledBack)throw error;return {ok:false as const,error};}
   },signal);}catch(error){executionFact(error,true);throw error;}
   // Only this attempt's confirmed rollback may reach heartbeat retry logic.
   if(!outcome.ok)throw outcome.error;return outcome.id;
 }
  private async enqueueAttempt(runId:string,name:string,args:any,context:any,files?:any[],signal?:AbortSignal,rolledBack?:()=>void){
   const id=randomUUID();
   return localTransaction(this.writers,runId,async(db,archiveMutation)=>{
   signal?.throwIfAborted();
   const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];if(!identity)throw Error('运行不存在');
   await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
   const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
    if(!run||run.project_id!==identity.project_id||run.status!=='running'||run.cancel_requested||run.lease_owner!==this.owner||!(await db.query('SELECT id FROM project_runs WHERE id=$1 AND lease_until>clock_timestamp()',[runId])).rowCount)throw new AppError(409,'本机操作的运行租约已失效','LOCAL_LEASE_DENIED');
   const taskMode=run.snapshot.executionProfile==='task-attempt-openshell-v1';
   if(!taskMode)await assertRunAuthorization(run,db,{requireLocalOnline:false,authorityLock:true,effect:'tool'});
   let taskAdmission:any;
   if(taskMode){
    const bound=(await db.query("SELECT scope FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active'",[run.id,context.taskId??null,context.attemptId??null,context.generation??null])).rows[0]?.scope;
    if(!bound)taskOperationDenied('操作缺少 host 准备的任务 scope');
    taskAdmission=await admitTaskOperation(db,run,this.traceRoot,context,bound);
   }
   const target=await localTarget(run.snapshot.policy,run.snapshot.agents,db,false);
   if(target.kind!=='local')throw new AppError(422,'此运行没有批准本机设备','LOCAL_TARGET_DENIED');
   const employee=run.snapshot.agents.find((agent:any)=>agent.id===context.agentId);
   if(name!=='prepare'&&(!employee?.tools.includes(name==='native_plugin'?args.toolName:name)||!context.callId||!context.sessionId))throw new AppError(422,'本机操作不属于获授权员工','LOCAL_EMPLOYEE_DENIED');
   const approvedArgs=args;let deviceArguments=args;
   if(name==='prepare'){
    decodeFiles(files??[]);
    if(taskMode){
     if(!isDeepStrictEqual(args,{})||!isDeepStrictEqual(files,taskAdmission.scope.workspace.importedFiles))taskOperationDenied('任务初始化只能导入已授权副本');
     if((await db.query("SELECT id FROM local_operations WHERE run_id=$1 AND payload->>'name'='prepare' AND payload->'taskScope'->'key'=$2::jsonb",[run.id,JSON.stringify(taskAdmission.scope.key)])).rowCount)taskOperationDenied('任务已有初始化记录，禁止重复创建','TASK_PREPARATION_UNRESOLVED');
    }
   }
   else if(name==='native_plugin'){
    if(target.backend?.kind!=='openshell')throw new AppError(422,'原生插件需要 OpenShell 隔离','NATIVE_BACKEND_REQUIRED');
    const binding=nativeToolBinding(run.snapshot,args.toolName),tool=binding.manifest.tools.find((item:any)=>item.name===args.toolName);
    const access=nativeFileAccess(tool,args.arguments),task=taskMode?taskAdmission.task.contract:run.snapshot.tasks.find((item:any)=>item.id===context.taskId&&(item.assignee??item.assigneeId)===employee.id);
    if(!task||!Array.isArray(task.inputs)||!Array.isArray(task.outputs))throw new AppError(422,'原生插件必须固定当前任务的输入和输出合同','NATIVE_TASK_REQUIRED');
    const readPaths:string[]=taskMode?taskAdmission.scope.workspace.readPaths:[...new Set<string>([...task.inputs,...task.outputs].map((item:any)=>item.path))],writePaths:string[]=taskMode?taskAdmission.scope.workspace.writePaths:task.outputs.map((item:any)=>item.path);
    if(access.read.some(path=>!readPaths.includes(path))||access.write.some(path=>!writePaths.includes(path)))throw new AppError(422,'原生插件参数超出当前任务文件合同','NATIVE_PATH_DENIED');
    const nativeArgs={toolName:tool.name,pluginId:binding.id,originalName:tool.originalName,arguments:args.arguments,expectedWorkspaceRevision:args.expectedWorkspaceRevision,readPaths,writePaths:access.write.length?writePaths:[]};
    if(taskMode){
     if(args.pluginId!==undefined&&args.pluginId!==binding.id||args.originalName!==undefined&&args.originalName!==tool.originalName||args.readPaths!==undefined&&!isDeepStrictEqual(args.readPaths,readPaths)||args.writePaths!==undefined&&!isDeepStrictEqual(args.writePaths,nativeArgs.writePaths))taskOperationDenied('原生工具绑定或路径范围与可信合同不同');
     deviceArguments=nativeArgs;
    }else args=nativeArgs;
   }else if(!['artifact_write','filesystem','terminal','terminal_test'].includes(name))throw new AppError(422,'未开放此本机工具');
   if(taskMode&&name!=='prepare'){
    if(!taskAdmission.task.sandbox_identity)taskOperationDenied('任务工作区尚未完成初始化');
    const w=taskAdmission.scope.workspace;
    if(name==='filesystem'&&!w.readPaths.includes(args.path)||name==='artifact_write'&&!w.writePaths.includes(args.path))taskOperationDenied('文件操作超出任务合同');
    if(args.expectedWorkspaceRevision!==taskAdmission.scope.workRevision)taskOperationDenied('已批准完整工作版本已变化');
    if(!isDeepStrictEqual(args.executionScope,publicTaskScope(taskAdmission.scope)))taskOperationDenied('操作参数未绑定准确任务 scope');
    deviceArguments={...deviceArguments,expectedWorkspaceRevision:revision(w.importedFiles)};
   }
   let approvalId=null;
   if(name==='terminal'||name==='terminal_test'){
    approvalId=z.uuid().parse(context.approvalId);
    if(!(await db.query("SELECT id FROM tool_approvals WHERE id=$1 AND run_id=$2 AND agent_id=$3 AND tool=$4 AND arguments=$5::jsonb AND status='approved' FOR UPDATE",[approvalId,runId,employee.id,name,JSON.stringify(args)])).rowCount)throw new AppError(422,'本机命令缺少相符的逐次批准','LOCAL_APPROVAL_DENIED');
   }
   signal?.throwIfAborted();
   await localTarget(run.snapshot.policy,run.snapshot.agents,db);
   signal?.throwIfAborted();
   const task=taskMode?taskAdmission.task.contract:run.snapshot.tasks.find((item:any)=>item.id===context.taskId&&(item.assignee??item.assigneeId)===employee?.id);
   let verificationProfile;
   if(name==='terminal_test'&&target.backend?.kind==='openshell'&&task?.verificationReuse==='same-workspace'&&task.verify?.includes(args.command)){
    try{verificationProfile=checkpointTestInvocation(args.command,'/sandbox').profile;}catch{/* Other approved commands still run, with fresh verification required. */}
   }
   const payload={runId,grantId:target.grantId,name,arguments:taskMode?approvedArgs:args,context,approvalId,...(taskMode?{taskScope:taskAdmission.scope,executionScope:taskDeviceScope(taskAdmission.scope,revision(taskAdmission.scope.workspace.importedFiles)),deviceArguments}:{}),...(verificationProfile?{verificationProfile}:{}),...(files?{files}:{}),deviceId:target.deviceId};
   await db.query('INSERT INTO local_operations(id,device_id,run_id,grant_id,lease_owner,payload,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,target.deviceId,runId,target.grantId,this.owner,payload,approvalId]);
   signal?.throwIfAborted();
    archiveMutation();openRunArchive(this.traceRoot,runId).append('local/operation-queued',{operationId:id,name,deviceId:target.deviceId,...context});return id;
   },signal,rolledBack);
 }
 async wait(id:string,signal?:AbortSignal){
   let persistenceFailed=false;
  try{
   while(true){
    signal?.throwIfAborted();
     let rolledBack=false;
     const state=await operationTransaction(this.writers,id,async(db,row,run,device)=>{
     if(row.status==='completed')return await executable(db,row,run,device,true,this.traceRoot)?row:{...row,status:'cancelled'};
     if(['failed','cancelled'].includes(row.status))return row;
     if(!await executable(db,row,run,device,false,this.traceRoot)){
      await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[id]);return {...row,status:'cancelled'};
     }return row;
     },()=>{rolledBack=true;}).catch(error=>{persistenceFailed=!rolledBack;throw error;});
    if(state.status==='completed')return state.result.result;
    if(state.status==='failed')throw Object.assign(Error(state.result.error.message),{code:state.result.error.code,notExecuted:state.result.error.notExecuted});
    if(state.status==='cancelled')throw Object.assign(Error('本机操作已停止；已开始的修改需要核对'),{code:'LOCAL_OPERATION_CANCELLED',notExecuted:!state.started});
    await sleep(100);
   }
   }catch(error){
    if(persistenceFailed)throw error;
    try{
     const cancelled=await operationTransaction(this.writers,id,async(db)=>db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1 AND status IN ('queued','claimed','started') RETURNING started",[id]));
     if(cancelled.rows[0]?.started===false)executionFact(error,true);
    }catch{/* The original transaction keeps an unknown cleanup latched; preserve the first failure. */}
    throw error;
   }
 }
}
export class LocalRunExecutor {
 root:string;preparing?:Promise<void>;private acceptedStops:TaskAcceptedStopLifecycle;
 private pending=new Set<Promise<unknown>>();private closing?:Promise<void>;private closed=false;private failure?:unknown;
 constructor(public archive:any,public snapshot:any,public service:LocalOperationService,private maintenance:{sandboxMaintenance?:()=>SandboxMaintenance|undefined}={}){this.root=join(archive.dir,'artifacts');this.acceptedStops=new TaskAcceptedStopLifecycle(archive.id,service,maintenance.sandboxMaintenance);}
 private perform<T>(fn:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.closed)return Promise.reject(new AppError(409,'本机执行器已关闭','LOCAL_EXECUTOR_CLOSED'));
  if(this.failure||this.acceptedStops.writerFailure)return Promise.reject(this.failure??this.acceptedStops.writerFailure);
  requireWriters(this.service.traceRoot,this.service.writers);
  const work=this.service.writers.withWriter([this.archive.id],async()=>{
   try{return {ok:true as const,value:await fn()};}catch(error){
    // Every effect below has its own nested producer. Only their acknowledged
    // outcomes may leave this orchestration boundary without latching it.
    try{this.service.writers.assertWriter(this.archive.id);}catch{this.failure??=error;throw this.failure;}
    return {ok:false as const,error};
   }
  },{signal}).then(result=>{if(!result.ok)throw result.error;return result.value;});
  this.pending.add(work);work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private physical<T>(fn:()=>T){return this.service.writers.withWriter([this.archive.id],fn);}
 private async waitOperation(id:string,signal:AbortSignal){
  const result=await this.service.writers.withWriter([this.archive.id],async()=>{
   try{return {ok:true as const,value:await this.service.wait(id,signal)};}catch(error){if((error as any)?.notExecuted===true)return {ok:false as const,error};throw error;}
  });if(!result.ok)throw result.error;return result.value;
 }
 revision(){return revision(exportFiles(this.root));}
 /** Source-only trusted terminal boundary; never registered as an employee tool. */
 finalizeAccepted(signal:AbortSignal){
  if(this.closed)return Promise.reject(new AppError(409,'本机执行器已关闭','LOCAL_EXECUTOR_CLOSED'));
  if(this.failure)return Promise.resolve({version:1 as const,state:'pending' as const,reasonCode:'TASK_ACCEPTED_STOP_UNRESOLVED'});
  const work=this.acceptedStops.finalizeAccepted(signal);this.pending.add(work);
  work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
 }
 private async taskTransaction<T,R=T>(signal:AbortSignal,fn:(db:pg.PoolClient,run:any,persist:<V>(fn:()=>V)=>V)=>Promise<T>,publish?:(value:T)=>R):Promise<R>{
  if(this.snapshot.executionProfile!=='task-attempt-openshell-v1')throw new AppError(409,'旧执行器没有可信任务上下文','TASK_SCOPE_DENIED');
  const outcome=await this.service.writers.withWriter([this.archive.id],async()=>{
  let db:pg.PoolClient|undefined,committing=false,committed=false,uncertain=false,discard=false;
  const persist=<V>(fn:()=>V):V=>{uncertain=true;const value=fn();uncertain=false;return value;};
  try{
   db=await pool.connect();signal.throwIfAborted();await db.query('BEGIN');await shareCostMaintenance(db);
   const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[this.archive.id])).rows[0];
   if(!identity)throw new AppError(404,'运行不存在');
   const project=(await db.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[this.archive.id])).rows[0];
   if(!project||!run||run.project_id!==identity.project_id||project.version!==run.project_version)throw new AppError(409,'项目方案已变化，请重新批准','RUN_REAPPROVAL_REQUIRED');
   if(run.lease_owner!==this.service.owner)throw new AppError(409,'运行租约已转移','TASK_SCOPE_DENIED');
   const archive=readRun(this.service.traceRoot,this.archive.id);
   if(!archive||archive.integrity!=='ok')throw new AppError(409,'可信运行记录不可用','TASK_SCOPE_DENIED');
   run.events=archive.events;
   const value=await fn(db,run,persist);signal.throwIfAborted();committing=true;await db.query('COMMIT');committed=true;committing=false;
   return {ok:true as const,value:publish?publish(value):value as unknown as R};
  }catch(error){
   if(db&&!committed)try{await db.query('ROLLBACK');}catch{discard=true;}
   if(committing||uncertain||discard){discard=true;throw error;}return {ok:false as const,error};
  }finally{db?.release(discard);}
  },{signal});if(!outcome.ok)throw outcome.error;return outcome.value;
 }
 /** Trusted in-process Host admission only; not registered as a model tool or HTTP route. */
 bindAttempt(candidate:TrustedTaskCandidate&{generation?:number},signal:AbortSignal):Promise<TrustedTaskAssignment>{return this.perform(()=>this.bindAttemptOwned(candidate,signal),signal);}
 private async bindAttemptOwned(candidate:TrustedTaskCandidate&{generation?:number},signal:AbortSignal):Promise<TrustedTaskAssignment>{
  await this.acceptedStops.reconcileExisting(signal);
  return this.taskTransaction(signal,(db,run)=>bindTrustedAttempt(db,run,candidate));
 }
 /** Private Host boundary: no model DTO, command dispatch or compatibility-cache read. */
 prepareCheckpoint(context:TaskCheckpointContext,signal:AbortSignal,options:TaskCheckpointOptions):Promise<TaskCheckpointRefs>{return this.perform(()=>this.prepareCheckpointOwned(context,signal,options),signal);}
 private async prepareCheckpointOwned(context:TaskCheckpointContext,signal:AbortSignal,options:TaskCheckpointOptions):Promise<TaskCheckpointRefs>{
  return this.taskTransaction(signal,(db,run,persist)=>prepareTaskCheckpoint(db,run,this.service,context,signal,options,persist),publish=>publish());
 }
 taskScope(context:{agentId:string;sessionId:string;taskId:string;attemptId:string;generation:number},signal:AbortSignal):Promise<TaskExecutionScope>{return this.perform(()=>this.taskScopeOwned(context,signal),signal);}
 private async taskScopeOwned(context:{agentId:string;sessionId:string;taskId:string;attemptId:string;generation:number},signal:AbortSignal):Promise<TaskExecutionScope>{
  if(!context||!Number.isSafeInteger(context.generation)||context.generation<1||Object.keys(context).some(k=>!['agentId','sessionId','taskId','attemptId','generation'].includes(k)))throw new AppError(409,'任务 scope 身份不完整','TASK_SCOPE_DENIED');
  return this.taskTransaction(signal,async(db,run,persist)=>{
   const row=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active'",[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
   if(!row)throw new AppError(409,'任务未注册','TASK_SCOPE_DENIED');
   const assignment={...context,runId:run.id,runtimeTaskId:row.runtime_task_id,contractHash:row.contract_hash};
   // The legacy cache is only available to the closed-profile scope fixtures.
   // Once initialized, SQL + verified objects are the sole task baseline.
   const canonical=run.canonical_workspace?readCommittedCanonical(this.service.traceRoot,run):null;
   if(!canonical)persist(()=>mkdirSync(this.root,{recursive:true,mode:0o700}));
   return resolveTaskScope(db,run,assignment,canonical?{files:canonical.files,revision:canonical.ref.revision}:{files:exportFiles(this.root),revision:this.revision()},row.scope);
  });
 }
 prepareTask(context:{agentId:string;sessionId:string;taskId:string;attemptId:string;generation:number},signal:AbortSignal):Promise<TaskExecutionScope>{if(this.snapshot.executionProfile==='task-attempt-openshell-v1')requireTaskStopProvider(this.maintenance.sandboxMaintenance);return this.perform(()=>this.prepareTaskOwned(context,signal),signal);}
 private async prepareTaskOwned(context:{agentId:string;sessionId:string;taskId:string;attemptId:string;generation:number},signal:AbortSignal):Promise<TaskExecutionScope>{
  if(!context||!Number.isSafeInteger(context.generation)||context.generation<1||Object.keys(context).some(k=>!['agentId','sessionId','taskId','attemptId','generation'].includes(k)))taskOperationDenied('任务初始化身份不完整');
  context=Object.freeze({agentId:context.agentId,sessionId:context.sessionId,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation});
  requireTaskStopProvider(this.maintenance.sandboxMaintenance);
  await this.acceptedStops.reconcileExisting(signal);
  await this.physical(()=>mkdirSync(this.root,{recursive:true,mode:0o700}));
  await initializeTaskCanonical(this.service,this.archive.id,signal);
  const previous=await this.taskTransaction(signal,async(db,run)=>{
   const key={runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation};
   const rows=(await db.query("SELECT * FROM local_operations WHERE run_id=$1 AND payload->>'name'='prepare' AND payload->'taskScope'->'key'=$2::jsonb ORDER BY created_at",[run.id,JSON.stringify(key)])).rows;
   if(rows.length>1)taskOperationDenied('同一任务存在多个初始化记录');
   const existing=rows[0];await assertNoUnresolvedTaskOperation(db,run.id,existing?.id??null);
   if(existing&&(!['queued','claimed','started','completed'].includes(existing.status)||existing.merge_state==='unknown'||existing.merge_state==='rejected'))taskOperationDenied('原任务初始化尚未核对，禁止重建','TASK_PREPARATION_UNRESOLVED');
   return existing;
  });
  let id=previous?.id;
  if(!id){await this.taskScope(context,signal);await this.acceptedStops.beforeNewTask(context,signal);const scope=await this.taskScope(context,signal);id=await this.service.enqueue(this.archive.id,'prepare',{}, {...context,callId:'task-prepare-'+randomUUID(),executionScope:publicTaskScope(scope)},scope.workspace.importedFiles,signal);}
  if(previous?.merge_state!=='committed'){
   await this.waitOperation(id,signal);await commitTaskResult(this.service,id,signal);
  }
  await this.taskTransaction(signal,async(db,run)=>{
   const operation=(await db.query("SELECT * FROM local_operations WHERE id=$1 AND merge_state='committed'",[id])).rows[0];
   if(!operation?.result?.ok)taskOperationDenied('任务初始化没有已提交回执');
   const identity={sandboxId:operation.result.result.execution.sandboxId,localWorkspace:operation.result.result.localWorkspace};
   const task=(await db.query('SELECT sandbox_identity FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
   if(task?.sandbox_identity&&!isDeepStrictEqual(task.sandbox_identity,identity))taskOperationDenied('任务沙箱身份已变化');
   await db.query('UPDATE task_attempt_workspaces SET sandbox_identity=$1 WHERE run_id=$2 AND task_id=$3 AND attempt_id=$4 AND generation=$5',[identity,run.id,context.taskId,context.attemptId,context.generation]);
  });
  const scope=await this.taskScope(context,signal);
  await this.taskTransaction(signal,async(db,run)=>{
   const latest=(await db.query("SELECT * FROM local_operations WHERE run_id=$1 AND payload->'taskScope'->'key'=$2::jsonb AND result->>'ok'='true' ORDER BY created_at DESC,id DESC LIMIT 1",[run.id,JSON.stringify(scope.key)])).rows[0];
   const task=(await db.query('SELECT sandbox_identity FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
   if(latest?.merge_state!=='committed'||!task?.sandbox_identity)taskOperationDenied('任务最后执行成果尚未提交，禁止继续使用工作区');
   validateTaskOperationResult(latest,latest.result.result);
   if(latest.result.result.workspaceRevision!==revision(scope.workspace.importedFiles)||latest.result.result.execution?.sandboxId!==task.sandbox_identity.sandboxId||latest.result.result.localWorkspace!==task.sandbox_identity.localWorkspace)taskOperationDenied('任务工作版本或沙箱与最后持久回执不同');
  });
  return scope;
 }
 prepare(signal:AbortSignal):Promise<void>{if(this.snapshot.executionProfile==='task-attempt-openshell-v1')requireTaskStopProvider(this.maintenance.sandboxMaintenance);return this.perform(()=>this.prepareOwned(signal),signal);}
 private async prepareOwned(signal:AbortSignal){
  const selected=this.snapshot.executionProfile==='task-attempt-openshell-v1'?requireTaskStopProvider(this.maintenance.sandboxMaintenance):undefined;
  if(!selected)assertExecutionProfile(this.snapshot);
  return this.preparing??=(async()=>{
   await this.physical(()=>mkdirSync(this.root,{recursive:true,mode:0o700}));
   if(this.snapshot.executionProfile==='task-attempt-openshell-v1'){
    await initializeTaskCanonical(this.service,this.archive.id,signal);
    if(!isDeepStrictEqual(selected,requireTaskStopProvider(this.maintenance.sandboxMaintenance)))throw new AppError(409,'任务准备期间可信停止维护已变化','TASK_STOP_UNAVAILABLE');return;
   }
   const callId='local-prepare-'+this.archive.id,ref={callId};
   await this.physical(()=>this.archive.append('runtime/operation-start',{name:'local_workspace',arguments:{deviceId:this.snapshot.executionTarget.deviceId}},ref));
   try{const id=await this.service.enqueue(this.archive.id,'prepare',{}, {},exportFiles(this.root),signal);const result=await this.waitOperation(id,signal);await this.physical(()=>{mirrorFiles(this.root,result.files);this.archive.append('runtime/operation-finished',{name:'local_workspace'},ref);this.archive.append('local/device-bound',{...this.snapshot.executionTarget,localWorkspace:result.localWorkspace,...(result.execution?{execution:result.execution}:{})});});}
   catch(error){try{await this.physical(()=>{if((error as any).notExecuted)this.archive.append('runtime/operation-finished',{name:'local_workspace'},ref);else this.archive.append('runtime/outcome-unknown',{name:'local_workspace',callId,arguments:{deviceId:this.snapshot.executionTarget.deviceId},message:(error as Error).message},ref);});}catch{/* Preserve the original failure; the nested producer retains the latch. */}throw error;}
  })();
 }
 execute(name:string,args:any,signal:AbortSignal,context:any):Promise<any>{return this.perform(()=>this.executeOwned(name,args,signal,context),signal);}
 private async executeOwned(name:string,args:any,signal:AbortSignal,context:any){
  if(this.snapshot.executionProfile!=='task-attempt-openshell-v1'){assertExecutionProfile(this.snapshot);await this.prepare(signal);}
  else{
   const binding=context?.executionScope,key={runId:this.archive.id,taskId:context?.taskId,attemptId:context?.attemptId,generation:context?.generation};
   if(!context||['agentId','sessionId','taskId','attemptId'].some(k=>typeof context[k]!=='string'||!context[k])||!Number.isSafeInteger(context.generation)||context.generation<1||
    !/^[a-f0-9]{64}$/.test(binding?.scopeHash??'')||!/^[a-f0-9]{64}$/.test(binding?.workRevision??'')||
    !isDeepStrictEqual(binding,{profile:'task-attempt-openshell-v1',key,scopeHash:binding?.scopeHash,workRevision:binding?.workRevision}))taskOperationDenied('执行器缺少 host 准备的任务 scope');
  }
  const id=await this.service.enqueue(this.archive.id,name,args,context,undefined,signal);const result=await this.waitOperation(id,signal);
  if(this.snapshot.executionProfile==='task-attempt-openshell-v1'){
   const merge=await commitTaskResult(this.service,id,signal);const visible=await this.taskResultSummary(id);
   await this.physical(()=>this.archive.append('local/operation-finished',{operationId:id,name,...context,localWorkspace:result.localWorkspace,execution:result.execution,merge},{callId:context.callId}));return visible;
  }
  return this.physical(()=>{const metadata=mirrorFiles(this.root,result.files);const {files:_files,...visible}=result;
  this.archive.append('local/operation-finished',{operationId:id,name,...context,localWorkspace:result.localWorkspace,...(result.execution?{execution:result.execution}:{})});return {...visible,...metadata};});
 }
 /** Public result projection never lists the complete canonical head. */
 async taskResultSummary(id:string){
  const row=(await pool.query('SELECT * FROM local_operations WHERE id=$1 AND run_id=$2',[id,this.archive.id])).rows[0];
  if(row?.merge_state!=='committed'||!row.result?.ok)throw new AppError(409,'任务成果尚未提交','TASK_MERGE_DENIED');
  const {files:_files,artifacts:_artifacts,...visible}=row.result.result;
  return {...visible,artifacts:manifest(row.result.result.files),merge:row.merge_record.receipt};
 }
 close(){if(this.closing)return this.closing;this.closed=true;
  const original=[...this.pending];this.closing=(async()=>{let cleanupError:unknown;try{await localTransaction(this.service.writers,this.archive.id,async db=>{
  const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[this.archive.id])).rows[0];if(!identity)return;
  await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
  const run=(await db.query('SELECT project_id FROM project_runs WHERE id=$1 FOR UPDATE',[this.archive.id])).rows[0];
  if(!run||run.project_id!==identity.project_id)throw new AppError(409,'本机运行身份已变化');
  await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE run_id=$1 AND lease_owner=$2 AND status IN ('queued','claimed','started')",[this.archive.id,this.service.owner]);
 });}catch(error){cleanupError=error;}await Promise.allSettled(original);const failure=this.failure??this.acceptedStops.writerFailure;if(failure)throw failure;if(cleanupError)throw cleanupError;})();return this.closing;}
}
export function localDeviceRouter(traceRoot:string,writers:ArchiveWriterManager){
 requireWriters(traceRoot,writers);
 const router=Router(),registration=z.object({id:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().trim().min(1).max(100),platform:z.enum(['win32','darwin','linux']),grant:z.object({id:z.uuid(),label:z.string().min(1).max(200),allowCommands:z.boolean()}),backend:executionBackendSchema.default({kind:'native'})});
 router.get('/local-devices',async(_req,res)=>res.json((await pool.query("SELECT *,last_seen>clock_timestamp()-interval '15 seconds' AS online FROM local_devices ORDER BY name")).rows.map(publicDevice)));
 router.post('/local-devices/register',async(req,res)=>{
  const input=registration.parse(req.body);
  if(input.backend.kind==='openshell'&&input.platform!=='linux')throw new AppError(422,'当前 OpenShell 执行环境需要 Linux','LOCAL_BACKEND_INVALID');
  await deviceTransaction(async db=>{const existing=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(existing){await proof(input.id,req.get('X-Local-Device-Key'),db);if(!existing.enabled||existing.grant_id!==input.grant.id||existing.label!==input.grant.label||existing.allow_commands!==input.grant.allowCommands||existing.platform!==input.platform||!isDeepStrictEqual(executionBackend(existing.backend),input.backend))throw new AppError(403,'设备授权已撤回或改变，请在启动器中重新启用','LOCAL_GRANT_CHANGED');await db.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[input.id]);}
   else await db.query('INSERT INTO local_devices(id,token_hash,name,platform,grant_id,label,allow_commands,backend) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.id,digest(input.token).toString('hex'),input.name,input.platform,input.grant.id,input.grant.label,input.grant.allowCommands,input.backend]);
  });res.json({ok:true,id:input.id});
 });
 router.post('/local-devices/:id/poll',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),device=await proof(id,req.get('X-Local-Device-Key'));
  if(!device.enabled)throw new AppError(403,'本机设备已被停用','LOCAL_DEVICE_DENIED');
  const input=z.object({active:z.object({id:z.uuid(),claimToken:z.uuid()}).nullable().default(null)}).parse(req.body);
  await deviceTransaction(async db=>{
   await db.query('SELECT id FROM local_devices WHERE id=$1 FOR UPDATE',[id]);const current=await proof(id,req.get('X-Local-Device-Key'),db);
   if(!current.enabled)throw new AppError(403,'本机设备已被停用','LOCAL_DEVICE_DENIED');
   await db.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[id]);
  });
  if(input.active){const cancel=await authenticatedOperation(writers,input.active.id,id,req.get('X-Local-Device-Key'),async(db,row,run,current)=>{if(row.claim_token!==input.active!.claimToken)throw new AppError(403,'操作领取凭证不正确');const valid=['claimed','started'].includes(row.status)&&await executable(db,row,run,current,false,traceRoot);if(!valid&&['claimed','started'].includes(row.status))await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[row.id]);return !valid;});return res.json({cancel});}
  const orphan=(await pool.query("SELECT id,claim_token,started FROM local_operations WHERE device_id=$1 AND status IN ('claimed','started') ORDER BY created_at LIMIT 1",[id])).rows[0];
  if(orphan){
   // A poll reply may be lost after claiming but before the device receives it.
   // Re-offer only an unstarted claim. /start still transitions atomically once;
   // a started operation must keep its unknown-outcome reconciliation path.
   const recovered=await authenticatedOperation(writers,orphan.id,id,req.get('X-Local-Device-Key'),async(db,row,run,current)=>{
    if(row.status==='claimed'&&!row.started&&await executable(db,row,run,current,false,traceRoot))return {job:deviceJob(row,row.claim_token)};
    if(['claimed','started'].includes(row.status))return {orphan:{id:row.id,claimToken:row.claim_token,started:row.started}};
    return {job:null};
   });
   return res.json(recovered);
  }
  const pending=(await pool.query("SELECT id FROM local_operations WHERE device_id=$1 AND status='queued' ORDER BY created_at LIMIT 1",[id])).rows[0];if(!pending)return res.json({job:null});
  const job=await authenticatedOperation(writers,pending.id,id,req.get('X-Local-Device-Key'),async(db,row,run,current)=>{
   if(row.status!=='queued')return null;
   if(!await executable(db,row,run,current,false,traceRoot)){await db.query("UPDATE local_operations SET status='cancelled',finished_at=now() WHERE id=$1",[row.id]);return null;}
   if((await db.query("SELECT id FROM local_operations WHERE device_id=$1 AND status IN ('claimed','started') AND id<>$2",[id,row.id])).rowCount)return null;
   const claimToken=randomUUID();await db.query("UPDATE local_operations SET status='claimed',claim_token=$1 WHERE id=$2",[claimToken,row.id]);return deviceJob(row,claimToken);
  });res.json({job});
 });
 router.post('/local-devices/:id/operations/:operation/start',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await proof(id,req.get('X-Local-Device-Key'));const token=z.uuid().parse(req.body.claimToken);
  await authenticatedOperation(writers,z.uuid().parse(req.params.operation),id,req.get('X-Local-Device-Key'),async(db,row,run,device)=>{
   if(row.device_id!==id||row.claim_token!==token||row.status!=='claimed'||!await executable(db,row,run,device,false,traceRoot))throw new AppError(409,'操作已启动、停止或授权失效','LOCAL_START_DENIED');
   await db.query("UPDATE local_operations SET status='started',started=true WHERE id=$1",[row.id]);
  });res.json({ok:true});
 });
 router.post('/local-devices/:id/operations/:operation/result',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await proof(id,req.get('X-Local-Device-Key'));
  const input=z.object({claimToken:z.uuid(),ok:z.boolean(),result:z.any().optional(),error:z.object({code:z.union([z.string().max(100),z.number()]),message:z.string().max(1000),notExecuted:z.boolean().default(false)}).optional()}).parse(req.body);
  if(input.ok){if(!input.result||typeof input.result!=='object')throw new AppError(422,'操作结果不正确');decodeFiles(input.result.files);if(input.result.output!==undefined&&(typeof input.result.output!=='string'||Buffer.byteLength(input.result.output)>1024*1024))throw new AppError(422,'操作输出超过限制');}
  else if(!input.error)throw new AppError(422,'缺少操作错误详情');
  await authenticatedOperation(writers,z.uuid().parse(req.params.operation),id,req.get('X-Local-Device-Key'),async(db,row,run,device)=>{
   if(row.device_id!==id||row.claim_token!==input.claimToken)throw new AppError(403,'操作领取凭证不正确');
   if(input.ok){
    validateResult(row,input.result);
    const taskReceipt=run.snapshot.executionProfile==='task-attempt-openshell-v1';
    if(taskReceipt)validateTaskOperationResult(row,input.result);
    // Verify the original approved execution. Current backend/grant permission
    // is checked separately below; a changed backend may only retain late evidence.
    const expectedTask=taskReceipt?{profile:row.payload.taskScope.profile,key:row.payload.taskScope.key,scopeHash:row.payload.taskScope.workspace.scopeHash,operationId:row.id,beforeWorkRevision:row.payload.executionScope.expectedWorkRevision,afterWorkRevision:revision(input.result.files)}:undefined;
    assertExecutionBackendReceipt(executionBackend(taskReceipt?run.snapshot.executionTarget.backend:device.backend),input.result,expectedTask);
    if(taskReceipt&&row.payload.name!=='prepare'){
     const key=row.payload.taskScope.key;
     const bound=(await db.query('SELECT sandbox_identity FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[run.id,key.taskId,key.attemptId,key.generation])).rows[0]?.sandbox_identity;
     if(!bound||input.result.execution.sandboxId!==bound.sandboxId||input.result.localWorkspace!==bound.localWorkspace)taskOperationDenied('回执来自不同的任务沙箱');
    }
   }
   if(row.result){if(!isDeepStrictEqual(row.result,input))throw new AppError(409,'已有不同操作回执');return;}
   if(input.ok&&!row.started)throw new AppError(409,'操作尚未确认开始');
   if(!['claimed','started'].includes(row.status)||!await executable(db,row,run,device,true,traceRoot)){
    if(row.late_result&&!isDeepStrictEqual(row.late_result,input))throw new AppError(409,'已有不同迟到回执');
    await db.query("UPDATE local_operations SET status='cancelled',late_result=$1,finished_at=now() WHERE id=$2",[input,row.id]);return;
   }
   await db.query('UPDATE local_operations SET status=$1,result=$2,finished_at=now() WHERE id=$3',[input.ok?'completed':'failed',input,row.id]);
   // Only a valid started claim reaching the durable-result branch proves this
   // device is currently reachable. Cancelled/expired late receipts stay above.
   if(row.started)await db.query('UPDATE local_devices SET last_seen=clock_timestamp() WHERE id=$1',[id]);
  });res.json({ok:true});
 });
 router.delete('/local-devices/:id',async(req,res)=>{const id=z.uuid().parse(req.params.id);await deviceTransaction(db=>db.query('UPDATE local_devices SET enabled=false WHERE id=$1',[id]));res.json({ok:true});});
 router.post('/local-devices/:id/disable',async(req,res)=>{const id=z.uuid().parse(req.params.id);await deviceTransaction(async db=>{await db.query('SELECT id FROM local_devices WHERE id=$1 FOR UPDATE',[id]);await proof(id,req.get('X-Local-Device-Key'),db);await db.query('UPDATE local_devices SET enabled=false WHERE id=$1',[id]);});res.json({ok:true});});
 router.get('/runs/:id/local-operations',async(req,res)=>res.json((await pool.query('SELECT id,status,started,payload,result,late_result AS "lateResult",created_at AS "createdAt" FROM local_operations WHERE run_id=$1 ORDER BY created_at',[z.uuid().parse(req.params.id)])).rows.map(row=>({...row,payload:{name:row.payload.name,context:row.payload.context,arguments:row.payload.arguments},result:row.result?{ok:row.result.ok,error:row.result.error,localWorkspace:row.result.result?.localWorkspace,exitCode:row.result.result?.exitCode,output:row.result.result?.output,...(row.result.result?.execution?{execution:row.result.result.execution}:{})}:null,lateResult:row.lateResult?{ok:row.lateResult.ok,error:row.lateResult.error,localWorkspace:row.lateResult.result?.localWorkspace,exitCode:row.lateResult.result?.exitCode,output:row.lateResult.result?.output,...(row.lateResult.result?.execution?{execution:row.lateResult.result.execution}:{})}:null}))));
 return router;
}
