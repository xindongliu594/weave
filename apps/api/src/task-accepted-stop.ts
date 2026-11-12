import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import type pg from 'pg';
import {z} from 'zod';
import type {TaskAttemptKey} from '../../../packages/contracts/index.ts';
import {pool} from './db.ts';
import {shareCostMaintenance} from './cost-control.ts';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {AppError} from './provider.ts';
import type {SandboxMaintenance} from './storage-lifecycle.ts';
import {decodeTaskAcceptedStop,type TaskAcceptedStopRecord} from './task-accepted-stop-state.ts';
import {activeTaskAssignment,effectiveTaskContract,pinnedInputs,taskCapabilityHashes} from './task-execution.ts';
import {assertOriginalTaskCommit} from './task-original-commit.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {assertExecutionBackendBinding,executionBackend} from './execution-backend.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {readLiveCanonical} from './live-canonical-reader.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';
import {acceptedVerificationRevision} from './handoff-checkpoints.ts';
import type {TaskCheckpointContext} from './task-checkpoint-state.ts';
import {readRun,redact} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint,checkpointDigest,checkpointContract,checkpointEnvironment,validateTaskCheckpointRefs} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {assertAcceptanceChecks} from '../../../services/agent-runtime/acceptance-checks.mjs';
import {assertHandoffReport} from '../../../packages/contracts/handoff-report.mjs';
import {readArchiveObject} from '../../../services/agent-runtime/archive-objects.mjs';

const {manifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');
const denied=(message:string,code='TASK_ACCEPTED_STOP_UNRESOLVED'):never=>{throw new AppError(409,message,code);};
type Provider=()=>SandboxMaintenance|undefined;
type Selected=Readonly<Pick<SandboxMaintenance,'deviceId'|'grantId'|'fingerprint'|'executor'>&{stop:NonNullable<SandboxMaintenance['executor']['stopAcceptedTask']>;reconcile:NonNullable<SandboxMaintenance['executor']['reconcileAcceptedTaskStop']>;capabilities:NonNullable<SandboxMaintenance['executor']['acceptedStopCapabilities']>;capability:Readonly<{version:1;deadline:'shared-abort-v1'}>}>;
type Subject=TaskCheckpointContext&{runId:string;runtimeTaskId:string;contractHash:string};
type Selection={marker:TaskAcceptedStopRecord;recheck:()=>void};
type RecoveryState=Awaited<ReturnType<typeof assertTaskRecoveryRuntime>>;
const rowKey=(row:any):TaskAttemptKey=>({runId:row.run_id,taskId:row.task_id,attemptId:row.attempt_id,generation:row.generation});
const sameKey=(left:any,right:any)=>isDeepStrictEqual(left,right);
const maintenanceMs=120000,deadlines=new WeakMap<AbortSignal,number>();
const remaining=(signal:AbortSignal)=>{signal.throwIfAborted();const ms=(deadlines.get(signal)??Date.now()+maintenanceMs)-Date.now();if(ms<=0)throw new DOMException('Task stop deadline expired','TimeoutError');return Math.max(1,Math.min(maintenanceMs,Math.floor(ms)));};
function budget(parent:AbortSignal){
 const timeout=new AbortController(),deadline=Date.now()+maintenanceMs;
 const signal=AbortSignal.any([parent,timeout.signal]);deadlines.set(signal,deadline);
 const timer=setTimeout(()=>timeout.abort(new DOMException('Task stop deadline expired','TimeoutError')),maintenanceMs);timer.unref?.();
 return {signal,dispose:()=>clearTimeout(timer)};
}
const text=z.string().min(1).max(240).refine(value=>value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value));
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const exactRequest=z.strictObject({key:z.strictObject({runId:uuid,taskId:text,attemptId:text,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),sandboxId:text,workspaceRevision:z.string().regex(/^[a-f0-9]{64}$/),stopId:uuid});
export type TaskStopExactRequest=z.infer<typeof exactRequest>;
export type TaskStopFinalization={version:1;state:'stopped'|'pending';reasonCode?:string};
function checkpointNative(run:any,taskId:string){
 const mappings=new Map<string,string>();
 for(const event of run.events)if(event.type==='run/task-mapping')for(const binding of event.data.tasks??[])mappings.set(binding.task_id,binding.seed_id);
 let nativeId:string|undefined;for(const [native,approved] of mappings)if(approved===taskId)nativeId=native;
 return run.events.findLast((event:any)=>event.type==='team/checkpoint')?.data.tasks?.find((task:any)=>task.id===nativeId);
}

/** Trusted local callback only. Optional device methods preserve legacy storage providers. */
export function requireTaskStopProvider(provider?:Provider):Selected{
 const selected=provider?.();
 if(!selected||typeof selected.executor?.stopAcceptedTask!=='function'||typeof selected.executor?.reconcileAcceptedTaskStop!=='function'||typeof selected.executor?.acceptedStopCapabilities!=='function')return denied('任务停止维护尚未连接可信本机执行器','TASK_STOP_UNAVAILABLE');
 const capabilities=selected.executor.acceptedStopCapabilities,capability=capabilities.call(selected.executor);
 if(!isDeepStrictEqual(capability,{version:1,deadline:'shared-abort-v1'}))return denied('任务停止维护不支持共享截止时间','TASK_STOP_UNAVAILABLE');
 return Object.freeze({deviceId:selected.deviceId,grantId:selected.grantId,fingerprint:selected.fingerprint,executor:selected.executor,stop:selected.executor.stopAcceptedTask,reconcile:selected.executor.reconcileAcceptedTaskStop,capabilities,capability:Object.freeze({...capability})});
}

/** No model/HTTP input can create a selection or recover a fresh dispatch closure. */
export class TaskAcceptedStopLifecycle{
 private producerFailure?:unknown;
 get writerFailure(){return this.producerFailure;}
 constructor(private runId:string,private service:{traceRoot:string;owner:string;writers:ArchiveWriterManager},private provider?:Provider){}
 private async writer<T>(fn:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.producerFailure)throw this.producerFailure;
  const writers=this.service.writers;if(!writers||writers.traceRoot!==this.service.traceRoot)throw Error('ARCHIVE_WRITER_CONFIG_REQUIRED');
  const outcome=await writers.withWriter([this.runId],async()=>{
   try{return {ok:true as const,value:await fn()};}catch(error){
    try{writers.assertWriter(this.runId);}catch{this.producerFailure??=error;throw this.producerFailure;}
    return {ok:false as const,error};
   }
  },{signal});if(!outcome.ok)throw outcome.error;return outcome.value;
 }
 private async produce<T>(fn:()=>Promise<T>,known?:(error:unknown)=>boolean):Promise<T>{
  const result=await this.service.writers.withWriter([this.runId],async()=>{
   try{return {ok:true as const,value:await fn()};}catch(error){
    if(known?.(error)){try{this.service.writers.assertWriter(this.runId);return {ok:false as const,error};}catch{}}
    this.producerFailure??=error;throw this.producerFailure;
   }
  });if(!result.ok)throw result.error;return result.value;
 }
 private dispatch(selected:Selected,key:TaskAttemptKey,expected:any,beforeDispatch:()=>Promise<void>,signal:AbortSignal){
  let refused=false,refusal:unknown,admitted=false;
  const admission=async()=>{try{await beforeDispatch();admitted=true;}catch(error){refused=true;refusal=error;throw error;}};
  // Only the original beforeDispatch rejection can prove that the trusted
  // provider never received permission. Provider errors are not this proof.
  return this.produce(async()=>{
   const result=await selected.stop.call(selected.executor,key,expected,admission,signal);
   const {accepted,checkpointResolved,operationsResolved,...identity}=expected;
   if(!admitted||!isDeepStrictEqual(result,{...identity,phase:'stopped',replayed:false}))denied('可信设备停止回执或派发身份不符');
   return result;
  },error=>!admitted&&refused&&error===refusal);
 }
 private selected(expected?:Selected){
  const selected=requireTaskStopProvider(this.provider);
  if(expected&&(selected.executor!==expected.executor||selected.stop!==expected.stop||selected.reconcile!==expected.reconcile||selected.capabilities!==expected.capabilities||!isDeepStrictEqual(selected.capability,expected.capability)||['deviceId','grantId','fingerprint'].some(k=>selected[k as keyof Selected]!==expected[k as keyof Selected])))denied('任务停止期间可信设备已变化','TASK_STOP_UNAVAILABLE');
  return selected;
 }
 private archive(run:any){
  const archived:any=readRun(this.service.traceRoot,this.runId);
  if(!archived||archived.integrity!=='ok'||archived.id!==run.id||archived.snapshot.projectId!==run.project_id||archived.snapshot.planVersion!==run.project_version||
   archived.snapshot.executionProfile!==run.snapshot.executionProfile||!isDeepStrictEqual(archived.snapshot.executionTarget,run.snapshot.executionTarget))return denied('任务停止可信档案或批准身份已变化');
  if(run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length){
   const initialized=archived.events.filter((event:any)=>event.type==='task/recovery-initialized');
   if(!isDeepStrictEqual(archived.snapshot,{...(redact(run.snapshot) as any),id:run.id,createdAt:archived.snapshot.createdAt,formatVersion:1})||
    !run.task_evidence?.recoveryInitialization||initialized.length!==1||!isDeepStrictEqual(initialized[0].data,{version:1,sourceKey:'task-recovery-initialized:'+run.id,initialization:run.task_evidence.recoveryInitialization}))denied('任务停止恢复快照或初始化档案已变化');
  }
  run.events=archived.events;return archived;
 }
 private async transaction<T>(fn:(db:pg.PoolClient,run:any)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const outcome=await this.service.writers.withWriter([this.runId],async()=>{
  // Pool acquisition itself is an original producer. Abort cannot replace its
  // promise with a race winner and leave a late connection unaccounted for.
  let db:pg.PoolClient;
  try{db=await pool.connect();}catch(error){return {ok:false as const,error};}
  if(signal?.aborted){db.release();return {ok:false as const,error:signal.reason};}
  const raw=db.query.bind(db),bounded=Object.create(db) as pg.PoolClient;
  let released=false,poisoned=false,committing=false;
  // Keep awaiting the original query promise after abort/discard. A client
  // query_timeout callback is not proof that its physical SQL has settled.
  const discard=()=>{poisoned=true;if(!released){released=true;db.release(true);}};
  const usable=()=>{if(signal?.aborted){discard();signal.throwIfAborted();}if(poisoned)denied('任务停止 SQL 连接已丢弃');};
  signal?.addEventListener('abort',discard,{once:true});
  const native=async(...args:any[])=>{
   usable();
   try{
    const request=typeof args[0]==='string'?{text:args[0],values:args[1]}:{...args[0]};
    const result=await (raw as any)(request);
    usable();return result;
   }catch(error){
    if(signal?.aborted||!(error as any)?.severity||['57014','55P03'].includes((error as any)?.code))discard();
    throw error;
   }
  };
  (bounded as any).query=async(...args:any[])=>{
   if(signal)await native("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[String(remaining(signal))]);
   return native(...args);
  };
  try{
   await native('BEGIN');await shareCostMaintenance(bounded);
   const identity=(await bounded.query('SELECT project_id FROM project_runs WHERE id=$1',[this.runId])).rows[0];if(!identity)denied('停止运行不存在');
   const project=(await bounded.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const run=(await bounded.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[this.runId])).rows[0];
   if(!project||!run||run.project_id!==identity.project_id)denied('停止运行不存在');
   const result=await fn(bounded,run);committing=true;await bounded.query('COMMIT');usable();return {ok:true as const,value:result};
  }catch(error){
   if(!poisoned)try{await native('ROLLBACK');}catch{discard();}
   if(committing||poisoned){discard();throw error;}return {ok:false as const,error};
  }finally{signal?.removeEventListener('abort',discard);if(!released){released=true;db.release();}}
  },{signal});if(!outcome.ok)throw outcome.error;return outcome.value;
 }
 private async current(db:pg.PoolClient,run:any,selected:Selected,signal:AbortSignal){
  signal.throwIfAborted();this.selected(selected);this.archive(run);
  if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||run.status!=='running'||run.cancel_requested||run.lease_owner!==this.service.owner)denied('停止运行当前权限或来源无效');
  await assertCurrentRunPermissions(run,db,{requireLocalOnline:false});
  if(!(await db.query("SELECT id FROM project_runs WHERE id=$1 AND lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()",[run.id,this.service.owner])).rowCount)denied('停止运行租约失效');
  const target=run.snapshot.executionTarget;
  if(target?.kind!=='local'||target.deviceId!==selected.deviceId||target.grantId!==selected.grantId||target.backend?.kind!=='openshell'||target.backend.fingerprint!==selected.fingerprint)denied('停止 provider 与批准设备不同');
  return run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length?assertTaskRecoveryRuntime(db,this.service.traceRoot,run):null;
 }
 private async markers(db:pg.PoolClient){
  const rows=(await db.query('SELECT run_id,task_id,attempt_id,generation,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND accepted_stop IS NOT NULL',[this.runId])).rows;
  return rows.map(row=>{const marker=decodeTaskAcceptedStop(row.accepted_stop);if(!sameKey(marker.identity.key,rowKey(row)))denied('停止记录与 SQL 任务身份不同');return marker;});
 }
 private async ownFence(db:pg.PoolClient,own?:TaskAcceptedStopRecord){
  for(const marker of await this.markers(db)){
   if(own&&sameKey(marker.identity.key,own.identity.key)){
    if(!isDeepStrictEqual(marker,own))denied('原停止记录已变化');
   }else if(marker.state!=='stopped')denied('存在其他未决任务停止');
  }
 }
 private async target(db:pg.PoolClient,run:any,context:TaskCheckpointContext){
  const task=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active'",[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
  if(!task||task.principal!==context.agentId||task.session_id!==context.sessionId||task.accepted_stop!==null)denied('下一任务身份或停止状态已变化');
  const assignment={...context,runId:run.id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash};
  const {employee,contract}=activeTaskAssignment(run,assignment),hashes=taskCapabilityHashes(run.snapshot,employee);
  if(checkpointNative(run,context.taskId)?.id!==task.runtime_task_id||!isDeepStrictEqual(task.contract,contract)||task.permission_hash!==hashes.permissionHash||task.capability_hash!==hashes.capabilityHash)denied('下一任务当前合同或分派已变化');
  if((await db.query("SELECT id FROM local_operations WHERE run_id=$1 AND payload->>'name'='prepare' AND payload->'taskScope'->'key'=$2::jsonb",[run.id,JSON.stringify(rowKey(task))])).rowCount)denied('下一任务已存在初始化记录');
  return assignment;
 }
 private authority(run:any,marker:TaskAcceptedStopRecord,target:Subject){
  const key=marker.identity.key,proof=marker.proof,subjects=[{...key,agentId:proof.principal,sessionId:proof.sessionId,runtimeTaskId:proof.runtimeTaskId,contractHash:proof.contractHash},target];
  const state=run.events.findLast((event:any)=>event.type==='team/checkpoint')?.data;
  const accepted=run.events.find((event:any)=>event.seq===proof.accepted.seq),checkpoint=run.events.find((event:any)=>event.seq===proof.checkpoint.seq),boundary=run.events.find((event:any)=>event.seq===checkpoint?.data.boundary?.eventCursor);
  if(!accepted||digest(accepted)!==proof.accepted.digest||checkpoint?.data.id!==proof.checkpoint.id||checkpoint?.data.sha256!==proof.checkpoint.sha256||
   boundary?.type!=='step/boundary'||boundary.taskId!==key.taskId||boundary.attemptId!==key.attemptId||boundary.sessionId!==proof.sessionId||boundary.data.taskId!==key.taskId||boundary.data.attemptId!==key.attemptId||boundary.data.trigger!=='node-accepted'||!(accepted.seq<boundary.seq&&boundary.seq<checkpoint.seq))denied('已冻结验收或检查点事实已变化');
  activeTaskAssignment(run,target);
  return digest({subjects:subjects.map(subject=>{
   const native=checkpointNative(run,subject.taskId),member=state?.members?.find((item:any)=>item.id===subject.sessionId);
   if(native?.id!==subject.runtimeTaskId||native.assignee!==subject.agentId||native.attemptId!==subject.attemptId||!member||member.name!==subject.agentId||member.status==='removed'||subject===subjects[0]&&native.status!=='completed')denied('停止提交后相关任务分派已变化');
   return {subject,native:native&&{id:native.id,assignee:native.assignee,attemptId:native.attemptId,active:subject===subjects[0]?native.status==='completed':['claimed','in_progress'].includes(native.status)},member:member&&{id:member.id,name:member.name,active:member.status!=='removed'},contract:effectiveTaskContract(run,subject)};
  }),accepted,checkpoint,boundary});
 }
 private sync(run:any,selected:Selected,marker:TaskAcceptedStopRecord,target:Subject,authority:string,signal:AbortSignal,recheck:()=>void){
  signal.throwIfAborted();this.selected(selected);
  recheck();
  this.archive(run);
  if(this.authority(run,marker,target)!==authority)denied('停止提交后任务可信授权已变化');
  signal.throwIfAborted();this.selected(selected);
 }
 private async verify(db:pg.PoolClient,run:any,key:TaskAttemptKey,selected:Selected,signal:AbortSignal,own?:TaskAcceptedStopRecord):Promise<Selection>{
  const recovery=await this.current(db,run,selected,signal);await assertNoUnresolvedTaskOperation(db,run.id);
  // Locate without row locks, then follow operations -> device -> exact scope.
  const located=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[run.id,key.taskId,key.attemptId,key.generation])).rows[0];
  if(!located)denied('原停止任务不存在');
  const ids=[...new Set<string>([...(located.committed_outputs??[]).map((entry:any)=>entry.receipt?.operationId),run.canonical_workspace?.mergeId].filter(Boolean))].sort();
  const operations=(await db.query('SELECT * FROM local_operations WHERE run_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[run.id,ids])).rows;
  const device=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[selected.deviceId])).rows[0];
  const task=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 FOR UPDATE',[run.id,key.taskId,key.attemptId,key.generation])).rows[0];
  if(!isDeepStrictEqual(located,task)||task.phase!=='active'||!task.scope||!task.sandbox_identity||!device?.enabled||device.grant_id!==selected.grantId)denied('原任务 scope 或设备授权变化');
  const backend=executionBackend(device.backend);assertExecutionBackendBinding(backend,run.snapshot.executionTarget.backend);
  if(backend.kind!=='openshell'||backend.fingerprint!==selected.fingerprint)denied('原停止设备完整绑定不同');
  this.archive(run);
  const native=checkpointNative(run,key.taskId),state=run.events.findLast((event:any)=>event.type==='team/checkpoint')?.data;
  if(native?.id!==task.runtime_task_id||native.status!=='completed'||native.assignee!==task.principal||native.attemptId!==key.attemptId||!state?.members?.some((member:any)=>member.id===task.session_id&&member.name===task.principal&&member.status!=='removed'))denied('原任务没有当前 native completed 事实');
  const assignment={...key,agentId:task.principal,sessionId:task.session_id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash};
  const contract=effectiveTaskContract(run,assignment),employee=run.snapshot.agents.find((item:any)=>item.id===task.principal),hashes=taskCapabilityHashes(run.snapshot,employee);
  if(!isDeepStrictEqual(contract,task.contract)||task.permission_hash!==hashes.permissionHash||task.capability_hash!==hashes.capabilityHash||!sameKey(task.scope.key,key)||!isDeepStrictEqual(task.scope.inputOrigins,task.input_origins)||task.scope.capabilityHash!==hashes.capabilityHash)denied('原任务有效合同或能力已变化');
  const acceptedEvent=run.events.findLast((event:any)=>event.type==='handoff/accepted'&&event.data.taskId===key.taskId&&event.data.attemptId===key.attemptId&&sameKey(event.data.taskExecution?.key,key));
  const accepted=acceptedEvent?.data;
  if(!acceptedEvent||accepted.runId!==run.id||accepted.taskExecution?.capabilityHash!==hashes.capabilityHash)denied('缺少准确原任务宿主验收');
  const checkedRevision=acceptedVerificationRevision({...run.snapshot,id:run.id},accepted,key.taskId,key.attemptId);
  for(const command of contract.verify??[]){const actual=accepted.commands.findLast((entry:any)=>entry.command===command),exit=contract.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;if(!actual||actual.exitCode!==exit||actual.workspaceRevision!==checkedRevision)denied('原验收缺少准确通过命令');}
  if(contract.acceptanceChecks!==undefined&&!isDeepStrictEqual(assertAcceptanceChecks(contract,accepted.commands,checkedRevision),accepted.acceptanceChecks))denied('原验收逐项检查已变化');
  assertHandoffReport(contract,accepted.employeeReport);
  const cpEvent=run.events.findLast((event:any)=>event.type==='step/checkpoint'&&event.seq>acceptedEvent.seq&&event.data.version===2&&event.data.boundary?.trigger==='node-accepted'&&sameKey(event.data.key,key)&&event.data.boundary.sessionId===task.session_id);
  if(!cpEvent)denied('原验收缺少持久 v2 node-accepted checkpoint');
  const cp=readStepCheckpoint({root:this.service.traceRoot,runId:run.id,checkpointId:cpEvent.data.id});
  const {id,version,runId:checkpointRun,boundary,files,receipts,sha256,seq,at,...refs}=cp;
  validateTaskCheckpointRefs(refs,{runId:run.id,taskId:key.taskId,attemptId:key.attemptId,archiveDir:join(this.service.traceRoot,run.id)});
  const boundaryEvent=run.events.find((event:any)=>event.seq===boundary.eventCursor);
  if(boundaryEvent?.type!=='step/boundary'||boundaryEvent.taskId!==key.taskId||boundaryEvent.attemptId!==key.attemptId||boundaryEvent.data.taskId!==key.taskId||boundaryEvent.data.attemptId!==key.attemptId||boundaryEvent.sessionId!==task.session_id||boundaryEvent.data.trigger!=='node-accepted'||
   !(acceptedEvent.seq<boundaryEvent.seq&&boundaryEvent.seq<cpEvent.seq)||boundary.contractHash!==checkpointContract(run.snapshot,contract,refs)||
   !run.events.some((event:any)=>event.type==='team/checkpoint'&&event.seq>cpEvent.seq&&event.data.tasks?.some((item:any)=>item.id===task.runtime_task_id&&item.status==='completed'&&item.assignee===task.principal&&item.attemptId===key.attemptId)))denied('原验收、边界与完成检查点顺序不完整');
  if(!refs.lastMerge||!isDeepStrictEqual(refs.recoverySeed,task.scope.recoverySeed)||refs.canonical.revision!==accepted.workspaceRevision||checkpointDigest(refs.workManifest)!==accepted.sandboxWorkRevision||refs.scopeHash!==task.scope.workspace.scopeHash||refs.capabilityHash!==task.capability_hash||
   task.scope.workRevision!==refs.canonical.revision||!isDeepStrictEqual(refs.inputOrigins,task.input_origins)||!isDeepStrictEqual(refs.inputManifest,task.scope.workspace.inputManifest)||!isDeepStrictEqual(refs.workManifest,manifest(task.scope.workspace.importedFiles)))denied('原验收工作版本或 scope 与持久检查点不同');
  const fixedInputs=pinnedInputs(run,assignment,contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision,recovery);
  if(!isDeepStrictEqual(fixedInputs,task.input_origins))denied('原固定输入来源已变化');
  const outputPaths=(contract.outputs??[]).map((output:any)=>output.path).sort();
  if(!Array.isArray(accepted.outputs)||!isDeepStrictEqual(accepted.outputs.map((entry:any)=>entry.path).sort(),outputPaths)||!Array.isArray(accepted.inputs)||accepted.inputs.length!==fixedInputs.length)denied('原验收文件合同不完整');
  for(const output of accepted.outputs){const file=refs.workManifest.find((entry:any)=>entry.path===output.path);if(!file||file.sha256!==output.sha256||file.size!==output.size)denied('原验收输出对象不符');}
  for(const input of fixedInputs){const file=accepted.inputs.find((entry:any)=>entry.path===input.path);if(!file||file.sha256!==input.sha256||file.size!==refs.inputManifest.find((entry:any)=>entry.path===input.path)?.size)denied('原验收输入对象不符');}
  const latest=(await db.query("SELECT id FROM local_operations WHERE run_id=$1 AND payload->'taskScope'->'key'=$2::jsonb AND result->>'ok'='true' ORDER BY created_at DESC,id DESC LIMIT 1",[run.id,JSON.stringify(key)])).rows[0];
  if(latest?.id!==refs.lastMerge.operationId)denied('原 checkpoint 后存在更新的成功操作');
  const original=operations.find((operation:any)=>operation.id===refs.lastMerge.operationId);
  for(const commit of task.committed_outputs){
   const operation=operations.find((entry:any)=>entry.id===commit.receipt?.operationId);
   if(!operation||operation.device_id!==selected.deviceId||operation.grant_id!==selected.grantId)denied('提交链原 SQL 操作或设备来源缺失');
   assertOriginalTaskCommit(this.service.traceRoot,run,task,operation,backend);
  }
  const checked=assertOriginalTaskCommit(this.service.traceRoot,run,task,original,backend);
  if(!isDeepStrictEqual(refs.lastMerge,checked.receipt)||boundary.environment!==checkpointEnvironment(run.snapshot,checked.result.execution,refs)||!boundary.environment)denied('原检查点环境或合并回执不符');
  const head=operations.find((operation:any)=>operation.id===run.canonical_workspace?.mergeId),headKey=head?.payload?.taskScope?.key;
  if(!headKey||headKey.runId!==run.id||head.device_id!==selected.deviceId||head.grant_id!==selected.grantId)denied('当前完整 canonical 缺少准确原设备操作');
  const headTask=sameKey(headKey,key)?task:(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 FOR UPDATE',[run.id,headKey.taskId,headKey.attemptId,headKey.generation])).rows[0];
  if(!headTask)denied('当前完整 canonical 原任务不存在');
  assertOriginalTaskCommit(this.service.traceRoot,run,headTask,head,backend);
  await readLiveCanonical(db,this.service.traceRoot,run,this.archive(run));
  // Every original chain row is validated above; the current complete head may belong to B.
  const proof={accepted:{seq:acceptedEvent.seq,digest:digest(acceptedEvent)},checkpoint:{id:cp.id,sha256:cp.sha256,seq:cpEvent.seq},originalOperationId:original.id,originalMergeDigest:checked.record.digest,runtimeTaskId:task.runtime_task_id,principal:task.principal,sessionId:task.session_id,contractHash:task.contract_hash,permissionHash:task.permission_hash,capabilityHash:task.capability_hash,deviceId:selected.deviceId,grantId:selected.grantId,fingerprint:selected.fingerprint};
  const identity={version:1 as const,stopId:own?.identity.stopId??randomUUID(),key,sandboxId:task.sandbox_identity.sandboxId,workspaceRevision:checked.result.workspaceRevision,proofDigest:digest({kind:'task-accepted-stop-proof',version:1,proof})};
  const marker=decodeTaskAcceptedStop({version:1,identity,proof,state:'prepared',preparedAt:own?.preparedAt??new Date().toISOString(),digest:digest({kind:'task-accepted-stop',version:1,identity,proof})});
  if(own&&(!isDeepStrictEqual(marker.identity,own.identity)||!isDeepStrictEqual(marker.proof,own.proof)||marker.digest!==own.digest))denied('原停止证明已变化');
  const originalBoundaryDigest=digest(boundaryEvent),objects=operations.flatMap((operation:any)=>operation.merge_record.after.manifest).concat(run.canonical_workspace.manifest);
  // SQL facts stay private at the commit linearization point; only their
  // immutable archive references are read again, with a fresh per-call set.
  const recheck=()=>{
   this.archive(run);
   const latestAccepted=run.events.findLast((event:any)=>event.type==='handoff/accepted'&&sameKey(event.data.taskExecution?.key,key));
   const latestCheckpoint=run.events.findLast((event:any)=>event.type==='step/checkpoint'&&event.data.version===2&&event.data.boundary?.trigger==='node-accepted'&&sameKey(event.data.key,key)&&event.data.boundary.sessionId===task.session_id);
   if(latestAccepted?.seq!==proof.accepted.seq||digest(latestAccepted)!==proof.accepted.digest||latestCheckpoint?.seq!==proof.checkpoint.seq||latestCheckpoint.data.id!==proof.checkpoint.id||latestCheckpoint.data.sha256!==proof.checkpoint.sha256)denied('停止前原验收或检查点选择已变化');
   const fresh=readStepCheckpoint({root:this.service.traceRoot,runId:run.id,checkpointId:proof.checkpoint.id});
   const currentBoundary=run.events.find((event:any)=>event.seq===fresh.boundary.eventCursor);
   if(fresh.sha256!==proof.checkpoint.sha256||fresh.seq!==proof.checkpoint.seq||!currentBoundary||digest(currentBoundary)!==originalBoundaryDigest||
    !run.events.some((event:any)=>event.type==='team/checkpoint'&&event.seq>fresh.seq&&event.data.tasks?.some((item:any)=>item.id===task.runtime_task_id&&item.status==='completed'&&item.assignee===task.principal&&item.attemptId===key.attemptId)))denied('停止前原边界或完成事实已变化');
   if(!isDeepStrictEqual(pinnedInputs(run,assignment,contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision,recovery),task.input_origins))denied('停止前原固定输入来源已变化');
   const checkedObjects=new Set<string>([...fresh.inputManifest,...fresh.workManifest,...fresh.canonical.manifest].map((file:any)=>file.sha256+':'+file.size));
   for(const file of objects){const objectKey=file.sha256+':'+file.size;if(checkedObjects.has(objectKey))continue;readArchiveObject(join(this.service.traceRoot,run.id,'checkpoint-objects'),file);checkedObjects.add(objectKey);}
  };
  await this.current(db,run,selected,signal);this.archive(run);
  return {marker,recheck};
 }
 private async cas(db:pg.PoolClient,key:TaskAttemptKey,previous:TaskAcceptedStopRecord|null,next:TaskAcceptedStopRecord){
  decodeTaskAcceptedStop(next);
  const result=await db.query('UPDATE task_attempt_workspaces SET accepted_stop=$1::jsonb WHERE run_id=$2 AND task_id=$3 AND attempt_id=$4 AND generation=$5 AND accepted_stop IS NOT DISTINCT FROM $6::jsonb',[JSON.stringify(next),key.runId,key.taskId,key.attemptId,key.generation,previous===null?null:JSON.stringify(previous)]);
  if(result.rowCount!==1)denied('停止记录 CAS 冲突');
 }
 private async recordStopped(selected:Selected,original:TaskAcceptedStopRecord,result:any,reconciled=false,signal?:AbortSignal){
  if(!isDeepStrictEqual(result,{...original.identity,phase:'stopped',replayed:false}))denied('可信设备停止回执身份不符');
  // Fact bookkeeping grants no effect and survives cancellation or lease transfer.
  await this.transaction(async(db,run)=>{
   const key=original.identity.key;
   const row=(await db.query('SELECT accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 FOR UPDATE',[run.id,key.taskId,key.attemptId,key.generation])).rows[0];
   const current=decodeTaskAcceptedStop(row?.accepted_stop);
   if(!isDeepStrictEqual(current.identity,original.identity)||!isDeepStrictEqual(current.proof,original.proof)||current.digest!==original.digest||original.proof.deviceId!==selected.deviceId||original.proof.grantId!==selected.grantId||original.proof.fingerprint!==selected.fingerprint)denied('停止事实与原持久身份不符');
   if(current.state==='stopped'){if(!isDeepStrictEqual(current.result,result))denied('原停止事实不同');return;}
   if(current.state==='prepared'&&!reconciled)denied('新停止没有成功派发提交');
   const now=new Date(Math.max(Date.now(),Date.parse(current.preparedAt),'dispatchedAt' in current&&current.dispatchedAt?Date.parse(current.dispatchedAt):0)).toISOString();
   const {lastError,...base}=current as any;
   await this.cas(db,key,current,{...base,state:'stopped',dispatchedAt:base.dispatchedAt??now,confirmedAt:now,result});
  },signal);
 }
 private async observation(db:pg.PoolClient,run:any,selected:Selected,marker:TaskAcceptedStopRecord,signal:AbortSignal){
  signal.throwIfAborted();this.selected(selected);this.archive(run);
  const {identity,proof}=marker,key=identity.key;
  if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||proof.deviceId!==selected.deviceId||proof.grantId!==selected.grantId||proof.fingerprint!==selected.fingerprint)denied('原停止观察身份或来源不同');
  const recovery=run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length?await assertTaskRecoveryRuntime(db,this.service.traceRoot,run):null;
  const located=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[run.id,key.taskId,key.attemptId,key.generation])).rows[0];
  if(!located)denied('原停止观察 scope 不存在');
  const ids=[...new Set<string>((located.committed_outputs??[]).map((entry:any)=>entry.receipt?.operationId))].sort();
  const operations=(await db.query('SELECT * FROM local_operations WHERE run_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[run.id,ids])).rows;
  const device=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[selected.deviceId])).rows[0];
  const task=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 FOR UPDATE',[run.id,key.taskId,key.attemptId,key.generation])).rows[0];
  if(!isDeepStrictEqual(located,task)||!isDeepStrictEqual(decodeTaskAcceptedStop(task.accepted_stop),marker)||!device?.enabled||device.grant_id!==selected.grantId)denied('原停止观察记录或设备授权变化');
  const backend=executionBackend(device.backend),target=run.snapshot.executionTarget;
  assertExecutionBackendBinding(backend,target?.backend);
  if(backend.kind!=='openshell'||backend.fingerprint!==selected.fingerprint||target?.deviceId!==selected.deviceId||target.grantId!==selected.grantId||
   task.runtime_task_id!==proof.runtimeTaskId||task.principal!==proof.principal||task.session_id!==proof.sessionId||task.contract_hash!==proof.contractHash||task.permission_hash!==proof.permissionHash||task.capability_hash!==proof.capabilityHash||
   task.sandbox_identity?.sandboxId!==identity.sandboxId||checkpointContract(run.snapshot,task.contract)!==proof.contractHash)denied('原停止观察绑定或合同不同');
  this.archive(run);
  const acceptedEvent=run.events.find((event:any)=>event.seq===proof.accepted.seq),accepted=acceptedEvent?.data;
  if(acceptedEvent?.type!=='handoff/accepted'||digest(acceptedEvent)!==proof.accepted.digest||!sameKey(accepted?.taskExecution?.key,key)||accepted?.taskExecution?.capabilityHash!==proof.capabilityHash)denied('原停止观察验收摘要不同');
  const cp=readStepCheckpoint({root:this.service.traceRoot,runId:run.id,checkpointId:proof.checkpoint.id});
  const {id,version,runId:checkpointRun,boundary,files,receipts,sha256,seq,at,...refs}=cp;
  const boundaryEvent=run.events.find((event:any)=>event.seq===boundary.eventCursor);
  if(cp.version!==2||cp.sha256!==proof.checkpoint.sha256||cp.seq!==proof.checkpoint.seq||!sameKey(refs.key,key)||boundary.trigger!=='node-accepted'||boundary.sessionId!==proof.sessionId||boundary.contractHash!==checkpointContract(run.snapshot,task.contract,refs)||
   boundaryEvent?.type!=='step/boundary'||boundaryEvent.taskId!==key.taskId||boundaryEvent.attemptId!==key.attemptId||boundaryEvent.data.taskId!==key.taskId||boundaryEvent.data.attemptId!==key.attemptId||boundaryEvent.sessionId!==proof.sessionId||boundaryEvent.data.trigger!=='node-accepted'||!(acceptedEvent.seq<boundaryEvent.seq&&boundaryEvent.seq<cp.seq)||
   !run.events.some((event:any)=>event.type==='team/checkpoint'&&event.seq>cp.seq&&event.data.tasks?.some((item:any)=>item.id===proof.runtimeTaskId&&item.status==='completed'&&item.assignee===proof.principal&&item.attemptId===key.attemptId)))denied('原停止观察持久边界不完整');
  validateTaskCheckpointRefs(refs,{runId:run.id,taskId:key.taskId,attemptId:key.attemptId,archiveDir:join(this.service.traceRoot,run.id)});
  const checkedRevision=acceptedVerificationRevision({...run.snapshot,id:run.id},accepted,key.taskId,key.attemptId);
  if(checkedRevision!==identity.workspaceRevision||!isDeepStrictEqual(refs.recoverySeed,task.scope?.recoverySeed)||refs.canonical.revision!==accepted.workspaceRevision||checkpointDigest(refs.workManifest)!==identity.workspaceRevision||!refs.lastMerge||refs.lastMerge.operationId!==proof.originalOperationId||
   refs.scopeHash!==task.scope?.workspace.scopeHash||refs.capabilityHash!==proof.capabilityHash||!isDeepStrictEqual(refs.inputOrigins,task.input_origins)||!isDeepStrictEqual(refs.inputManifest,task.scope.workspace.inputManifest)||!isDeepStrictEqual(refs.workManifest,manifest(task.scope.workspace.importedFiles)))denied('原停止观察版本不同');
  for(const command of task.contract.verify??[]){const actual=accepted.commands.findLast((entry:any)=>entry.command===command),exit=task.contract.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;if(!actual||actual.exitCode!==exit||actual.workspaceRevision!==checkedRevision)denied('原停止观察命令验收不同');}
  if(task.contract.acceptanceChecks!==undefined&&!isDeepStrictEqual(assertAcceptanceChecks(task.contract,accepted.commands,checkedRevision),accepted.acceptanceChecks))denied('原停止观察逐项验收不同');assertHandoffReport(task.contract,accepted.employeeReport);
  const historical={...run,events:run.events.filter((event:any)=>event.seq<=cp.seq)},assignment={...key,agentId:proof.principal,sessionId:proof.sessionId,runtimeTaskId:proof.runtimeTaskId,contractHash:proof.contractHash};
  if(!isDeepStrictEqual(pinnedInputs(historical,assignment,task.contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision,recovery),task.input_origins))denied('原停止观察输入来源不同');
  if(!Array.isArray(accepted.outputs)||!isDeepStrictEqual(accepted.outputs.map((entry:any)=>entry.path).sort(),task.contract.outputs.map((entry:any)=>entry.path).sort())||!Array.isArray(accepted.inputs)||accepted.inputs.length!==task.input_origins.length)denied('原停止观察验收文件不完整');
  for(const output of accepted.outputs){const file=refs.workManifest.find((entry:any)=>entry.path===output.path);if(!file||file.sha256!==output.sha256||file.size!==output.size)denied('原停止观察输出不同');}
  for(const input of task.input_origins){const file=accepted.inputs.find((entry:any)=>entry.path===input.path);if(!file||file.sha256!==input.sha256||file.size!==refs.inputManifest.find((entry:any)=>entry.path===input.path)?.size)denied('原停止观察输入不同');}
  for(const commit of task.committed_outputs){const operation=operations.find((row:any)=>row.id===commit.receipt?.operationId);if(!operation||operation.device_id!==selected.deviceId||operation.grant_id!==selected.grantId)denied('原停止观察 SQL 提交来源缺失');assertOriginalTaskCommit(this.service.traceRoot,run,task,operation,backend);}
  const original=operations.find((row:any)=>row.id===proof.originalOperationId),checked=assertOriginalTaskCommit(this.service.traceRoot,run,task,original,backend);
  if(checked.record.digest!==proof.originalMergeDigest||!isDeepStrictEqual(checked.receipt,refs.lastMerge)||checked.result.workspaceRevision!==identity.workspaceRevision||!boundary.environment||boundary.environment!==checkpointEnvironment(run.snapshot,checked.result.execution,refs))denied('原停止观察原提交环境不同');
  signal.throwIfAborted();this.selected(selected);
  return ()=>{
   this.archive(run);
   const event=run.events.find((item:any)=>item.seq===proof.accepted.seq),fresh=readStepCheckpoint({root:this.service.traceRoot,runId:run.id,checkpointId:proof.checkpoint.id});
   if(digest(event)!==proof.accepted.digest||fresh.sha256!==proof.checkpoint.sha256||fresh.seq!==proof.checkpoint.seq||!isDeepStrictEqual(fresh,cp))denied('原停止观察已验证档案发生变化');
   for(const operation of operations)assertOriginalTaskCommit(this.service.traceRoot,run,task,operation,backend);
   signal.throwIfAborted();this.selected(selected);
  };
 }
 /** Only current approved slots participate in fresh authority; retained history stays distinct. */
 private terminalAuthority(run:any,tasks:any[],recovery:RecoveryState=null){
  const archived=this.archive(run);
  if(!isDeepStrictEqual(archived.snapshot.tasks,run.snapshot.tasks)||!isDeepStrictEqual(archived.snapshot.agents,run.snapshot.agents)||!Array.isArray(run.snapshot.tasks)||!run.snapshot.tasks.length||new Set(run.snapshot.tasks.map((task:any)=>task.id)).size!==run.snapshot.tasks.length)denied('终态批准快照不完整');
  const state=run.events.findLast((event:any)=>event.type==='team/checkpoint')?.data;
  return digest(run.snapshot.tasks.map((approved:any)=>{
   const native=checkpointNative(run,approved.id),retained=recovery?.retained.find((record:any)=>record.taskId===approved.id);
   if(retained){
    if(tasks.some(row=>row.task_id===approved.id)||!native||native.status!=='completed'||native.assignee!==approved.assignee||native.attemptId!==retained.attemptId||
     !isDeepStrictEqual(run.snapshot.handoffCheckpoints.find((record:any)=>record.taskId===approved.id),retained)||
     (approved.dependencies??[]).some((id:string)=>!recovery!.retained.some((record:any)=>record.taskId===id)))denied('保留验收与当前完成身份或独立依赖不同');
    const checkedRevision=acceptedVerificationRevision({...run.snapshot,id:retained.runId},retained,approved.id,retained.attemptId);
    const employee=run.snapshot.agents.find((item:any)=>item.id===approved.assignee);
    if(!employee||retained.taskExecution.capabilityHash!==taskCapabilityHashes(run.snapshot,employee).capabilityHash)denied('保留验收当前员工能力已变化');
    for(const command of approved.verify??[]){const actual=retained.commands.findLast((entry:any)=>entry.command===command),exit=approved.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;if(!actual||actual.exitCode!==exit||actual.workspaceRevision!==checkedRevision)denied('保留验收缺少准确通过命令');}
    if(approved.acceptanceChecks!==undefined&&!isDeepStrictEqual(assertAcceptanceChecks(approved,retained.commands,checkedRevision),retained.acceptanceChecks))denied('保留验收逐项检查已变化');
    assertHandoffReport(approved,retained.employeeReport);
    for(const kind of ['inputs','outputs'] as const){
     if(!Array.isArray(retained[kind])||!isDeepStrictEqual(retained[kind].map((file:any)=>file.path).sort(),(approved[kind]??[]).map((file:any)=>file.path).sort()))denied('保留验收文件合同不完整');
     for(const file of retained[kind]){
      const current=recovery!.currentCanonical.ref.manifest.find((entry:any)=>entry.path===file.path),contract=approved[kind].find((entry:any)=>entry.path===file.path);
      if(!current||current.sha256!==file.sha256||current.size!==file.size||contract.sha256&&contract.sha256!==file.sha256)denied('保留验收文件或固定输入已变化');
      if(kind==='inputs'&&contract.producerTaskId&&!recovery!.retained.some((record:any)=>record.taskId===contract.producerTaskId&&record.outputs?.some((output:any)=>output.path===file.path&&output.sha256===file.sha256&&output.size===file.size)))denied('保留验收固定输入没有原独立生产者');
     }
    }
    return {retained,initializationDigest:recovery!.initialization.digest,contract:approved,native:{id:native.id,attemptId:native.attemptId,assignee:native.assignee,completed:true}};
   }
   const task=tasks.find(row=>row.task_id===approved.id&&row.runtime_task_id===native?.id&&row.attempt_id===native?.attemptId);
   const member=state?.members?.find((item:any)=>item.id===task?.session_id);
   if(!task||task.phase!=='active'||native.status!=='completed'||native.assignee!==task.principal||!member||member.name!==task.principal||member.status==='removed')denied('终态批准节点没有当前完成身份');
   const subject={...rowKey(task),agentId:task.principal,sessionId:task.session_id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash};
   return {subject,contract:effectiveTaskContract(run,subject),member:{id:member.id,name:member.name,active:true},completed:true};
  }));
 }
 private async terminalEvidence(db:pg.PoolClient,run:any,selected:Selected,signal:AbortSignal,own?:TaskAcceptedStopRecord){
  const recovery=await this.current(db,run,selected,signal);await this.ownFence(db,own);await assertNoUnresolvedTaskOperation(db,run.id);
  // Prelock the complete operation set before device/scopes; source verifiers
  // below only reacquire locks already held in the original global order.
  await db.query('SELECT id FROM local_operations WHERE run_id=$1 ORDER BY id FOR UPDATE',[run.id]);
  await db.query('SELECT id FROM local_devices WHERE id=$1 FOR UPDATE',[selected.deviceId]);
  const rows=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id,attempt_id,generation FOR UPDATE',[run.id])).rows;
  const authority=this.terminalAuthority(run,rows,recovery),current:any[]=run.snapshot.tasks.filter((approved:any)=>!recovery?.retained.some((record:any)=>record.taskId===approved.id)).map((approved:any)=>{
   const native=checkpointNative(run,approved.id);return rows.find(row=>row.task_id===approved.id&&row.runtime_task_id===native.id&&row.attempt_id===native.attemptId);
  });
  const selections:Selection[]=[];
  for(const row of current){
   const stored=row.accepted_stop===null?undefined:decodeTaskAcceptedStop(row.accepted_stop);
   selections.push(await this.verify(db,run,rowKey(row),selected,signal,stored));
  }
  const candidates:TaskAttemptKey[]=current.filter((row:any)=>row.accepted_stop===null).map(rowKey);
  if(candidates.length>2)denied('终态新停止超过原运行容量上限','TASK_STOP_FINALIZE_LIMIT');
  const retainedPending=rows.some(row=>!current.includes(row)&&(row.accepted_stop===null||decodeTaskAcceptedStop(row.accepted_stop).state!=='stopped'));
  return {run,rows,authority,selections,candidates,retainedPending,recovery};
 }
 private terminalSync(evidence:Awaited<ReturnType<TaskAcceptedStopLifecycle['terminalEvidence']>>,selected:Selected,signal:AbortSignal){
  signal.throwIfAborted();this.selected(selected);
  for(const selection of evidence.selections)selection.recheck();
  if(this.terminalAuthority(evidence.run,evidence.rows,evidence.recovery)!==evidence.authority)denied('终态提交后批准完成证明发生变化');
  signal.throwIfAborted();this.selected(selected);
 }
 /** Trusted source-only acceptance boundary. No target or client proof is accepted. */
 async finalizeAccepted(parent:AbortSignal):Promise<TaskStopFinalization>{
  try{return await this.writer(()=>this.finalizeAcceptedOwned(parent),parent);}
  catch(error){return {version:1,state:'pending',reasonCode:error instanceof AppError&&/^TASK_[A-Z_]+$/.test(error.code??'')?error.code:'TASK_ACCEPTED_STOP_UNRESOLVED'};}
 }
 private async finalizeAcceptedOwned(parent:AbortSignal):Promise<TaskStopFinalization>{
  const shared=budget(parent),signal=shared.signal;
  try{
   signal.throwIfAborted();const selected=this.selected();
   const markers=await this.transaction(async db=>this.markers(db),signal);
   for(const marker of markers.filter(item=>item.state!=='stopped'))await this.observeMarker(selected,marker,signal);
   const initial=await this.transaction((db,run)=>this.terminalEvidence(db,run,selected,signal),signal);this.terminalSync(initial,selected,signal);
   for(const key of initial.candidates){
    const prepared=await this.transaction(async(db,run)=>{
     const evidence=await this.terminalEvidence(db,run,selected,signal),selection=evidence.selections.find(item=>sameKey(item.marker.identity.key,key));
     if(!selection||!evidence.candidates.some(item=>sameKey(item,key)))return denied('终态原候选已变化');
     this.terminalSync(evidence,selected,signal);await this.cas(db,key,null,selection.marker);await this.current(db,run,selected,signal);return {evidence,marker:selection.marker};
    },signal);
    this.terminalSync(prepared.evidence,selected,signal);
    let used=false,committed=false;
    const beforeDispatch=async()=>{
     if(used)denied('终态停止派发回调只能调用一次');used=true;
     const dispatched=await this.transaction(async(db,run)=>{
      const evidence=await this.terminalEvidence(db,run,selected,signal,prepared.marker);
      this.terminalSync(evidence,selected,signal);
      const marker=decodeTaskAcceptedStop({...prepared.marker,state:'dispatching',dispatchedAt:new Date(Math.max(Date.now(),Date.parse(prepared.marker.preparedAt))).toISOString()});
      await this.cas(db,key,prepared.marker,marker);await this.current(db,run,selected,signal);return evidence;
     },signal);
     this.terminalSync(dispatched,selected,signal);committed=true;
    };
    const expected={...prepared.marker.identity,accepted:true,checkpointResolved:true,operationsResolved:true};
    const result=await this.dispatch(selected,key,expected,beforeDispatch,signal);
    if(!committed)denied('终态停止缺少成功提交的派发回调');
    await this.recordStopped(selected,prepared.marker,result,false,signal);
    signal.throwIfAborted();this.selected(selected);
   }
   const final=await this.transaction((db,run)=>this.terminalEvidence(db,run,selected,signal),signal);this.terminalSync(final,selected,signal);
   if(final.retainedPending||final.candidates.length)denied('仍有保留的历史任务 scope 未完成停止核对');
   return {version:1,state:'stopped'};
  }finally{shared.dispose();}
 }
 private async observeMarker(selected:Selected,marker:TaskAcceptedStopRecord,signal:AbortSignal){
  const recheck=await this.transaction((db,run)=>this.observation(db,run,selected,marker,signal),signal);
  recheck();
  const result=await this.produce(async()=>{
   const observed=await selected.reconcile.call(selected.executor,marker.identity.key,marker.identity,signal);
   if(!isDeepStrictEqual(observed,{...marker.identity,phase:'stopped',replayed:false}))denied('可信设备停止观察回执身份不符');
   return observed;
  });
  await this.recordStopped(selected,marker,result,true,signal);
 }
 /** Exact original-ID observation only; callers independently authorize their admin principal. */
 async reconcileExact(request:TaskStopExactRequest,parent:AbortSignal){return this.writer(()=>this.reconcileExactOwned(request,parent),parent);}
 private async reconcileExactOwned(request:TaskStopExactRequest, parent:AbortSignal):Promise<void>{
  const parsed=exactRequest.safeParse(request);
  if(!parsed.success)return denied('原停止请求身份不完整','TASK_STOP_IDENTITY_MISMATCH');
  if(parsed.data.key.runId!==this.runId)return denied('原停止请求跨运行','TASK_STOP_IDENTITY_MISMATCH');
  const exact=parsed.data,shared=budget(parent),signal=shared.signal;
  try{
   signal.throwIfAborted();const selected=this.selected();
   const marker=await this.transaction(async db=>{
    const row=(await db.query('SELECT run_id,task_id,attempt_id,generation,accepted_stop FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4',[this.runId,exact.key.taskId,exact.key.attemptId,exact.key.generation])).rows[0];
    if(!row||row.accepted_stop===null)denied('没有可核对的原停止记录','TASK_STOP_RECONCILIATION_REQUIRED');
    const marker=decodeTaskAcceptedStop(row.accepted_stop),identity=marker.identity;
    if(!sameKey(rowKey(row),identity.key)||!sameKey(identity.key,exact.key)||identity.sandboxId!==exact.sandboxId||identity.workspaceRevision!==exact.workspaceRevision||identity.stopId!==exact.stopId)denied('原停止请求与持久身份不同','TASK_STOP_IDENTITY_MISMATCH');return marker;
   },signal);
   await this.observeMarker(selected,marker,signal);
  }catch(error){throw error;}
  finally{shared.dispose();}
 }
 async reconcileExisting(signal:AbortSignal){return this.writer(()=>this.reconcileExistingOwned(signal),signal);}
 private async reconcileExistingOwned(signal:AbortSignal){
  const markers=await this.transaction(async db=>this.markers(db),signal);
  for(const marker of markers.filter(marker=>marker.state!=='stopped')){
   const selected=this.selected();
   await this.observeMarker(selected,marker,signal);
  }
 }
 async beforeNewTask(context:TaskCheckpointContext,signal:AbortSignal){return this.writer(()=>this.beforeNewTaskOwned(context,signal),signal);}
 private async beforeNewTaskOwned(context:TaskCheckpointContext,signal:AbortSignal){
  const selected=this.selected();await this.reconcileExisting(signal);
  const candidates=await this.transaction(async(db,run)=>{
   await this.current(db,run,selected,signal);await this.target(db,run,context);
   const rows=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND phase='active' AND accepted_stop IS NULL",[run.id])).rows;
   return rows.flatMap(row=>{const key=rowKey(row),accepted=run.events.findLast((event:any)=>event.type==='handoff/accepted'&&sameKey(event.data.taskExecution?.key,key));return accepted&&!sameKey(key,{runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation})?[{key,seq:accepted.seq}]:[];}).sort((a,b)=>a.seq-b.seq||JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
  },signal);
  for(const candidate of candidates){
   const prepared=await this.transaction(async(db,run)=>{
    await this.ownFence(db);const verified=await this.verify(db,run,candidate.key,selected,signal);const target=await this.target(db,run,context);verified.recheck();const authority=this.authority(run,verified.marker,target);
    await this.cas(db,candidate.key,null,verified.marker);await this.current(db,run,selected,signal);
    return {...verified,run,target,authority};
   },signal);
   this.sync(prepared.run,selected,prepared.marker,prepared.target,prepared.authority,signal,prepared.recheck);
   let used=false,dispatchCommitted=false;
   const beforeDispatch=async()=>{
    if(used)denied('停止派发回调只能调用一次');used=true;
    const dispatched=await this.transaction(async(db,run)=>{
     await this.ownFence(db,prepared.marker);const verified=await this.verify(db,run,candidate.key,selected,signal,prepared.marker);const target=await this.target(db,run,context);verified.recheck();const authority=this.authority(run,prepared.marker,target);
     const marker=decodeTaskAcceptedStop({...prepared.marker,state:'dispatching',dispatchedAt:new Date(Math.max(Date.now(),Date.parse(prepared.marker.preparedAt))).toISOString()});
     await this.cas(db,candidate.key,prepared.marker,marker);await this.current(db,run,selected,signal);
     return {...verified,run,marker,target,authority};
    },signal);
    this.sync(dispatched.run,selected,dispatched.marker,dispatched.target,dispatched.authority,signal,dispatched.recheck);
    dispatchCommitted=true;
   };
   const expected={...prepared.marker.identity,accepted:true,checkpointResolved:true,operationsResolved:true};
   const result=await this.dispatch(selected,candidate.key,expected,beforeDispatch,signal);
   if(!dispatchCommitted)denied('停止 provider 缺少成功提交的派发回调');
   // A trusted device may only reconcile its prior intent; it cannot invent a fresh effect.
   await this.recordStopped(selected,prepared.marker,result,false,signal);
   signal.throwIfAborted();this.selected(selected);
  }
 }
}
