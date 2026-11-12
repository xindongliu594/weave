import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import type pg from 'pg';
import type {TaskWorkspaceFile,TaskExecutionScope,TaskWorkspacePlanner,CanonicalRef,TaskMergeReceipt} from '../../../packages/contracts/index.ts';
import type {LocalOperationService} from './local-execution.ts';
import {pool} from './db.ts';
import {shareCostMaintenance} from './cost-control.ts';
import {AppError} from './provider.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {resolveTaskScope} from './task-execution.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';
import {assertExecutionBackendBinding,assertExecutionBackendReceipt,executionBackend} from './execution-backend.ts';
import {checkpointFiles} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {storeArchiveObjects,readArchiveObject} from '../../../services/agent-runtime/archive-objects.mjs';
import {openRunArchive,readRun} from '../../../services/agent-runtime/trace-store.mjs';
const {decodeFiles,canonicalManifest,manifest,revision,mirrorFiles}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const {validateTaskExport,planTaskMerge}=createRequire(import.meta.url)('../../desktop/task-workspace.cjs') as TaskWorkspacePlanner;
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');
const denied=(message:string,code='TASK_MERGE_DENIED'):never=>{throw new AppError(409,message,code);};
export type {CanonicalRef,TaskMergeReceipt} from '../../../packages/contracts/index.ts';
export type TaskMergeFault=(point:'intent'|'blob-fsync'|'before-sql-commit'|'after-sql-commit'|'archive-append'|'cache-mirror')=>void;
function scopeOf(row:any):TaskExecutionScope{
 const scope=row.payload?.taskScope;
 if(scope?.profile!=='task-attempt-openshell-v1'||scope.key?.runId!==row.payload.runId||scope.workRevision!==scope.workspace?.baseCanonicalRevision)denied('操作没有可信任务 scope');
 validateTaskExport(scope.workspace,scope.workspace.importedFiles);return scope;
}
/** Only the stored queued scope is authority. No result-supplied permissions. */
export function validateTaskOperationResult(row:any,result:any){
 const scope=scopeOf(row),work=scope.workspace,device=row.payload.executionScope;
 const expected={profile:scope.profile,key:scope.key,binding:work.binding,scopeHash:work.scopeHash,readPaths:work.readPaths,writePaths:work.writePaths,inputManifest:work.inputManifest,expectedWorkRevision:revision(work.importedFiles)};
 if(!isDeepStrictEqual(device,expected))denied('设备 scope 与可信操作不符');
 const files=result?.files;
 // The planner rejects additional file metadata, including fabricated link types.
 validateTaskExport(work,files);
 if(!isDeepStrictEqual(result.artifacts,manifest(files))||result.workspaceRevision!==revision(files))denied('文件 manifest 或版本与实际内容不符');
 const receipt={profile:scope.profile,key:scope.key,scopeHash:work.scopeHash,operationId:row.id,beforeWorkRevision:device.expectedWorkRevision,afterWorkRevision:revision(files)};
 if(!isDeepStrictEqual(result.taskExecution,receipt))denied('任务执行回执身份或工作版本不符');
 if(typeof result.localWorkspace!=='string'||!result.localWorkspace||result.localWorkspace.length>4096)denied('缺少任务工作位置');
 const {name,arguments:args}=row.payload;
 if(name==='terminal'||name==='terminal_test'){
  if(!Number.isSafeInteger(result.exitCode)||typeof result.output!=='string'||Buffer.byteLength(result.output)>1024*1024)denied('命令执行结果不完整');
 }else if(name==='native_plugin'){
  const binding=row.payload.deviceArguments??args;
  if(result.pluginId!==binding.pluginId||result.toolName!==binding.toolName||typeof result.nativeResult?.isError!=='boolean')denied('插件执行结果与批准工具不符');
 }else if(name==='filesystem'||name==='artifact_write'){
  const file=decodeFiles(files).find((f:any)=>f.path===args.path);
  if(!file||result.path!==args.path||result.sha256!==createHash('sha256').update(file.bytes).digest('hex'))denied('文件业务回执与内容不符');
  if(name==='filesystem'&&(file.bytes.length>1024*1024||result.content!==file.bytes.toString('utf8')))denied('读取业务回执不符');
  if(name==='artifact_write'&&(!file.bytes.equals(Buffer.from(args.content))||result.bytes!==file.bytes.length))denied('写入业务回执不符');
 }else if(name!=='prepare')denied('未知任务操作');
 return files as TaskWorkspaceFile[];
}
function head(ref:CanonicalRef,receipt:TaskMergeReceipt|null){return {version:1,...ref,receipt};}
export function readCommittedCanonical(traceRoot:string,run:any):{ref:CanonicalRef;files:TaskWorkspaceFile[]}{
 const h=run.canonical_workspace;
 if(h?.version!==1||!Array.isArray(h.manifest)||h.manifest.length>128||!('mergeId' in h))denied('完整 canonical head 不存在','TASK_CANONICAL_INVALID');
 // Validate the small manifest before allocating or opening any object. A
 // damaged head must not turn 128 individually bounded blobs into a 640 MiB read.
 try{
  let bytes=0;
  if(h.manifest.some((entry:any)=>!entry||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>5*1024*1024||
    !/^[a-f0-9]{64}$/.test(entry.sha256??'')||(bytes+=entry.size)>20*1024*1024)||
    !isDeepStrictEqual(canonicalManifest(h.manifest),h.manifest)||
    createHash('sha256').update(JSON.stringify(h.manifest)).digest('hex')!==h.revision)throw Error('manifest');
  decodeFiles(h.manifest.map((entry:any)=>({path:entry.path,content:''})));
 }catch{return denied('完整 canonical manifest 不合法或超过限制','TASK_CANONICAL_INVALID');}
 const files=h.manifest.map((entry:any)=>({path:entry.path,content:readArchiveObject(join(traceRoot,run.id,'checkpoint-objects'),entry).toString('base64')}));
 if(!isDeepStrictEqual(manifest(files),h.manifest)||revision(files)!==h.revision||
  (h.mergeId===null?h.receipt!==null:h.receipt?.status!=='committed'||h.receipt.mergeId!==h.mergeId||h.receipt.operationId!==h.mergeId||h.receipt.afterRevision!==h.revision||h.receipt.key?.runId!==run.id))denied('完整 canonical head 或提交回执损坏','TASK_CANONICAL_INVALID');
 return {ref:{revision:h.revision,manifest:h.manifest,mergeId:h.mergeId},files};
}
type Persistence={uncertain:boolean;rolledBack:boolean};
function writerManager(service:Pick<LocalOperationService,'traceRoot'|'writers'>){
 if(!service.writers||service.writers.traceRoot!==service.traceRoot)throw Object.assign(Error('Canonical requires the application writer manager'),{code:'E_ARCHIVE_WRITER_CONFIG'});
 return service.writers;
}
async function transaction<T>(service:LocalOperationService,state:Persistence,runId:string,operationId:string|null,fn:(db:pg.PoolClient,run:any,row:any,device:any)=>Promise<T>){
 writerManager(service).assertWriter(runId);state.rolledBack=false;
 const db=await pool.connect();
 let committing=false,discard=false;
 try{
  await db.query('BEGIN');await shareCostMaintenance(db);const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];if(!identity)denied('运行不存在');
  const project=(await db.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
  const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
  if(!project||!run||run.project_id!==identity.project_id)denied('项目或运行归属已变化');
  const row=operationId?(await db.query('SELECT * FROM local_operations WHERE id=$1 FOR UPDATE',[operationId])).rows[0]:null;
  if(operationId&&(!row||row.run_id!==run.id))denied('操作不属于本运行');
  const device=row?(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[row.device_id])).rows[0]:null;
  const value=await fn(db,run,row,device);committing=true;await db.query('COMMIT');return value;
 }catch(error){
  let rolledBack=false;try{await db.query('ROLLBACK');rolledBack=true;}catch{}
  if(committing||!rolledBack){state.uncertain=true;discard=true;}
  state.rolledBack=!committing&&rolledBack;throw error;
 }finally{db.release(discard);}
}
function persist<T>(state:Persistence,fn:()=>T):T{
 // An interrupted synchronous object/append/mirror operation has no rollback.
 // Restore certainty only when that original operation actually returned.
 state.uncertain=true;const result=fn();state.uncertain=false;return result;
}
async function permissions(db:pg.PoolClient,run:any,service:LocalOperationService){
 if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||run.lease_owner!==service.owner||run.status!=='running'||run.cancel_requested||!(await db.query('SELECT id FROM project_runs WHERE id=$1 AND lease_until>clock_timestamp()',[run.id])).rowCount)denied('任务运行或租约已失效');
 await assertCurrentRunPermissions(run,db,{requireLocalOnline:false});
}
export async function initializeTaskCanonical(service:LocalOperationService,runId:string,signal:AbortSignal){
 const result=await writerManager(service).withWriter([runId],async()=>{
 const state:Persistence={uncertain:false,rolledBack:false};
 try{return {ok:true as const,value:await transaction(service,state,runId,null,async(db,run)=>{
  signal.throwIfAborted();await permissions(db,run,service);
  if(run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length)await assertTaskRecoveryRuntime(db,service.traceRoot,run);
  if(run.canonical_workspace){
   const canonical=readCommittedCanonical(service.traceRoot,run);
   persist(state,()=>materializeCommittedCanonical(service,run));return canonical;
  }
  // Strict scan: no silent omissions, links, unknown file kinds or oversized input.
  const archive=openRunArchive(service.traceRoot,run.id),files=checkpointFiles(join(archive.dir,'artifacts'));
  persist(state,()=>storeArchiveObjects(archive.dir,files));
  const encoded=files.map(f=>({path:f.path,content:f.content.toString('base64')}));
  const ref={revision:revision(encoded),manifest:manifest(encoded),mergeId:null};signal.throwIfAborted();
  await db.query('UPDATE project_runs SET canonical_workspace=$1 WHERE id=$2 AND canonical_workspace IS NULL',[head(ref,null),run.id]);return {ref,files:encoded};
 })};}catch(error){if(!state.uncertain)return {ok:false as const,error};throw error;}
 },{signal});
 if(!result.ok)throw result.error;return result.value;
}
function recordChecked(row:any){
 const record=row.merge_record;
 if(!record||record.version!==1||record.digest!==digest({...record,digest:undefined})||record.operationId!==row.id||record.resultDigest!==digest(row.result)||record.scopeDigest!==digest(scopeOf(row))||record.receipt.mergeId!==row.id||record.receipt.operationId!==row.id||record.after.revision!==record.receipt.afterRevision||record.before.revision!==record.receipt.beforeRevision)denied('持久 merge intent 或回执损坏','TASK_CANONICAL_INVALID');
 return record;
}
const deterministicRejections=new Set(['TASK_MERGE_DENIED','TASK_SCOPE_DENIED','TASK_WORKSPACE_CONFLICT','RUN_REAPPROVAL_REQUIRED','LOCAL_GRANT_CHANGED','LOCAL_BACKEND_CHANGED','LOCAL_COMMAND_DENIED','POLICY_PERMISSION_DENIED','POLICY_DEPARTMENT_DENIED','DEPARTMENT_ARCHIVED','COLLABORATOR_REMOVED','COLLABORATOR_INVALID','KNOWLEDGE_GRANT_INVALID','NATIVE_PLUGIN_DISABLED']);
async function settleRejectedMerge(service:LocalOperationService,state:Persistence,runId:string,operationId:string,reason:string){
 return transaction(service,state,runId,operationId,async(db,run,row)=>{
  if(row.merge_state==='committed'||row.merge_state==='rejected'||row.merge_state==='unknown')return;
  const canonical=readCommittedCanonical(service.traceRoot,run);
  if(canonical.ref.mergeId===operationId)denied('成果 head 与未提交状态不一致','TASK_CANONICAL_INVALID');
  const intent=row.merge_state==='pending'?recordChecked(row):null;
  // Keep the original intent/result immutable. Only a proven uncommitted SQL
  // operation can settle here; storage/commit ambiguity never reaches this path.
  const rejection={version:1,operationId,reason,at:new Date().toISOString(),canonicalRevision:canonical.ref.revision,intentDigest:intent?.digest??null};
  await db.query("UPDATE local_operations SET merge_state='rejected',merge_rejection=$1 WHERE id=$2",[rejection,operationId]);
 });
}
async function admit(db:pg.PoolClient,run:any,row:any,device:any,service:LocalOperationService){
 await permissions(db,run,service);
 if(row.status!=='completed'||row.started!==true||!row.claim_token||!row.result?.ok||row.lease_owner!==run.lease_owner||row.grant_id!==device?.grant_id||!device.enabled||!(await db.query('SELECT id FROM local_operations WHERE id=$1 AND deadline>clock_timestamp()',[row.id])).rowCount)denied('操作执行或设备授权已失效');
 assertExecutionBackendBinding(executionBackend(device.backend),run.snapshot.executionTarget.backend);
 assertExecutionBackendReceipt(executionBackend(device.backend),row.result.result);
 const scope=scopeOf(row),context=row.payload.context;
 if(row.device_id!==run.snapshot.executionTarget.deviceId||row.grant_id!==run.snapshot.executionTarget.grantId||scope.workspace.binding.assigneeId!==context.agentId||!isDeepStrictEqual(scope.key,{runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation}))denied('原操作身份与运行分派不符');
 if((await db.query("SELECT id FROM local_operations WHERE run_id=$1 AND id<>$2 AND merge_state IN ('pending','unknown')",[run.id,row.id])).rowCount)denied('存在未核对的合并，不能继续提交','TASK_MERGE_UNKNOWN');
 const archived=readRun(service.traceRoot,run.id);if(!archived||archived.integrity!=='ok')return denied('可信档案不可用','TASK_CANONICAL_INVALID');run.events=archived.events;
 const task=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active' FOR UPDATE",[run.id,scope.key.taskId,scope.key.attemptId,scope.key.generation])).rows[0];
 if(!task||!isDeepStrictEqual(task.scope,scope))denied('原操作 scope 或分派已过期');
 const canonical=readCommittedCanonical(service.traceRoot,run);
 // Reuse actual trusted resolver for assignment, contract, capability and input ancestry.
 const current=await resolveTaskScope(db,run,{...scope.key,agentId:task.principal,sessionId:task.session_id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash},{files:canonical.files,revision:canonical.ref.revision},scope,service.traceRoot);
 if(!isDeepStrictEqual(current,scope))denied('操作 canonical 基线已变化','TASK_WORKSPACE_CONFLICT');
 validateTaskOperationResult(row,row.result.result);
 return {scope,canonical,task};
}
/** Prepare durable intent, persist all immutable objects, then publish one SQL head.
 * This function never dispatches/enqueues an operation or repeats employee code. */
async function commitTaskMerge(service:LocalOperationService,state:Persistence,runId:string,operationId:string,signal:AbortSignal,fault?:TaskMergeFault):Promise<TaskMergeReceipt>{
 const intent=await transaction(service,state,runId,operationId,async(db,run,row,device)=>{
  signal.throwIfAborted();
  if(row.merge_state==='committed'){recordChecked(row);readCommittedCanonical(service.traceRoot,run);return {committed:true,record:row.merge_record};}
  if(row.merge_state==='rejected')return {rejected:true,record:row.merge_record};
  const {scope,canonical}=await admit(db,run,row,device,service);
  const plan=planTaskMerge(scope.workspace,row.result.result.files,canonical.files);
  const receipt:TaskMergeReceipt={mergeId:row.id,operationId:row.id,key:scope.key,scopeHash:scope.workspace.scopeHash,beforeRevision:plan.beforeRevision,afterRevision:plan.afterRevision,workRevision:row.result.result.workspaceRevision,status:'committed'};
  const record:any={version:1,operationId:row.id,resultDigest:digest(row.result),scopeDigest:digest(scope),before:canonical.ref,after:{revision:plan.afterRevision,manifest:manifest(plan.mergedFiles),mergeId:row.id},receipt,delta:plan.delta.map(d=>({path:d.path,sha256:d.afterSha256}))};record.digest=digest(record);
  if(row.merge_state){const old=recordChecked(row);if(!isDeepStrictEqual(old,record))denied('重试合并与原 intent 不符');}
  else await db.query("UPDATE local_operations SET merge_state='pending',merge_record=$1 WHERE id=$2",[record,row.id]);
  return {record,files:plan.mergedFiles};
 });
 if(intent.rejected)denied('该操作成果已拒绝');
 if(!intent.committed){
  fault?.('intent');signal.throwIfAborted();
  persist(state,()=>storeArchiveObjects(join(service.traceRoot,runId),decodeFiles(intent.files).map((f:any)=>({sha256:createHash('sha256').update(f.bytes).digest('hex'),size:f.bytes.length,content:f.bytes})),{afterFsync:()=>fault?.('blob-fsync')}));
  await transaction(service,state,runId,operationId,async(db,run,row,device)=>{
   signal.throwIfAborted();const record=recordChecked(row);
   if(row.merge_state==='committed'){readCommittedCanonical(service.traceRoot,run);return;}
   const {scope,canonical,task}=await admit(db,run,row,device,service);
   if(row.merge_state!=='pending'||canonical.ref.revision!==record.before.revision)denied('canonical CAS 冲突','TASK_WORKSPACE_CONFLICT');
   const next=head(record.after,record.receipt);readCommittedCanonical(service.traceRoot,{...run,canonical_workspace:next});
   fault?.('before-sql-commit');
   const updated=await db.query('UPDATE project_runs SET canonical_workspace=$1 WHERE id=$2 AND canonical_workspace=$3::jsonb RETURNING id',[next,run.id,run.canonical_workspace]);if(!updated.rowCount)denied('canonical CAS 冲突','TASK_WORKSPACE_CONFLICT');
   const own={scope,receipt:{profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,operationId:row.id,beforeWorkRevision:record.before.revision,afterWorkRevision:record.after.revision},files:record.delta};
   await db.query('UPDATE task_attempt_workspaces SET committed_outputs=$1::jsonb WHERE run_id=$2 AND task_id=$3 AND attempt_id=$4 AND generation=$5',[JSON.stringify([...task.committed_outputs,own]),run.id,scope.key.taskId,scope.key.attemptId,scope.key.generation]);
   await db.query("UPDATE local_operations SET merge_state='committed' WHERE id=$1",[row.id]);
  });fault?.('after-sql-commit');
 }
 // Re-read under the same project/run fence used by writers. Replaying an old
 // receipt may repair the latest cache, but must never materialize an old head
 // over a newer commit from another process.
 await transaction(service,state,runId,operationId,async(_db,run,row)=>{
  const record=recordChecked(row);
  if(row.merge_state!=='committed')denied('成果提交尚未确认','TASK_MERGE_UNKNOWN');
  readCommittedCanonical(service.traceRoot,run);
  persist(state,()=>{fault?.('archive-append');openRunArchive(service.traceRoot,runId).append('task/merge-committed',record.receipt,{sourceKey:'task-merge:'+operationId});});
  persist(state,()=>materializeCommittedCanonical(service,run,fault));
 });
 return intent.record.receipt;
}
export async function commitTaskResult(service:LocalOperationService,operationId:string,signal:AbortSignal,fault?:TaskMergeFault):Promise<TaskMergeReceipt>{
 const identity=(await pool.query('SELECT run_id FROM local_operations WHERE id=$1',[operationId])).rows[0];if(!identity)denied('操作不存在');
 const result=await writerManager(service).withWriter([identity.run_id],async()=>{
  const state:Persistence={uncertain:false,rolledBack:false};
  try{return {ok:true as const,value:await commitTaskMerge(service,state,identity.run_id,operationId,signal,fault)};}
  catch(error){
   if(!state.uncertain){
    if(state.rolledBack&&deterministicRejections.has((error as AppError)?.code)){
     try{await settleRejectedMerge(service,state,identity.run_id,operationId,(error as AppError).code);}
     catch{if(state.uncertain)throw error;} // Keep the first failure, including an immutable Error.
    }
    return {ok:false as const,error};
   }
   throw error;
  }
 },{signal});
 if(!result.ok)throw result.error;return result.value;
}
export async function reconcileTaskMerge(service:LocalOperationService,operationId:string){return commitTaskResult(service,operationId,new AbortController().signal);}
/** Caller must hold the project's run write fence. SQL/object head stays authoritative. */
export function materializeCommittedCanonical(service:Pick<LocalOperationService,'traceRoot'|'writers'>,run:any,fault?:TaskMergeFault){
 const {traceRoot}=service;writerManager(service).assertWriter(run.id);
 const {files}=readCommittedCanonical(traceRoot,run);
 fault?.('cache-mirror');mirrorFiles(join(traceRoot,run.id,'artifacts'),files);
 const actual=checkpointFiles(join(traceRoot,run.id,'artifacts')).map(f=>({path:f.path,content:f.content.toString('base64')}));
 if(revision(actual)!==run.canonical_workspace.revision)denied('兼容缓存重建未完成','TASK_CANONICAL_INVALID');
}
