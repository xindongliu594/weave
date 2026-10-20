import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import {join} from 'node:path';
import type pg from 'pg';
import type {TaskAttemptKey} from '../../../packages/contracts/index.ts';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import type {SandboxMaintenance} from './storage-lifecycle.ts';
import {decodeTaskAcceptedStop,type TaskAcceptedStopRecord} from './task-accepted-stop-state.ts';
import {activeTaskAssignment,effectiveTaskContract,pinnedInputs,taskCapabilityHashes} from './task-execution.ts';
import {assertOriginalTaskCommit} from './task-original-commit.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {assertExecutionBackendBinding,executionBackend} from './execution-backend.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {readLiveCanonical} from './live-canonical-reader.ts';
import {acceptedVerificationRevision} from './handoff-checkpoints.ts';
import type {TaskCheckpointContext} from './task-checkpoint-state.ts';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint,checkpointDigest,checkpointContract,checkpointEnvironment,validateTaskCheckpointRefs} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {assertAcceptanceChecks} from '../../../services/agent-runtime/acceptance-checks.mjs';
import {assertHandoffReport} from '../../../packages/contracts/handoff-report.mjs';
import {readArchiveObject} from '../../../services/agent-runtime/archive-objects.mjs';

const {manifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');
const denied=(message:string,code='TASK_ACCEPTED_STOP_UNRESOLVED'):never=>{throw new AppError(409,message,code);};
type Provider=()=>SandboxMaintenance|undefined;
type Selected=Readonly<Pick<SandboxMaintenance,'deviceId'|'grantId'|'fingerprint'|'executor'>&{stop:NonNullable<SandboxMaintenance['executor']['stopAcceptedTask']>;reconcile:NonNullable<SandboxMaintenance['executor']['reconcileAcceptedTaskStop']>}>;
type Subject=TaskCheckpointContext&{runId:string;runtimeTaskId:string;contractHash:string};
type Selection={marker:TaskAcceptedStopRecord;recheck:()=>void};
const rowKey=(row:any):TaskAttemptKey=>({runId:row.run_id,taskId:row.task_id,attemptId:row.attempt_id,generation:row.generation});
const sameKey=(left:any,right:any)=>isDeepStrictEqual(left,right);
function checkpointNative(run:any,taskId:string){
 const mappings=new Map<string,string>();
 for(const event of run.events)if(event.type==='run/task-mapping')for(const binding of event.data.tasks??[])mappings.set(binding.task_id,binding.seed_id);
 let nativeId:string|undefined;for(const [native,approved] of mappings)if(approved===taskId)nativeId=native;
 return run.events.findLast((event:any)=>event.type==='team/checkpoint')?.data.tasks?.find((task:any)=>task.id===nativeId);
}

/** Trusted local callback only. Optional device methods preserve legacy storage providers. */
export function requireTaskStopProvider(provider?:Provider):Selected{
 const selected=provider?.();
 if(!selected||typeof selected.executor?.stopAcceptedTask!=='function'||typeof selected.executor?.reconcileAcceptedTaskStop!=='function')return denied('任务停止维护尚未连接可信本机执行器','TASK_STOP_UNAVAILABLE');
 return Object.freeze({deviceId:selected.deviceId,grantId:selected.grantId,fingerprint:selected.fingerprint,executor:selected.executor,stop:selected.executor.stopAcceptedTask,reconcile:selected.executor.reconcileAcceptedTaskStop});
}

/** No model/HTTP input can create a selection or recover a fresh dispatch closure. */
export class TaskAcceptedStopLifecycle{
 constructor(private runId:string,private service:{traceRoot:string;owner:string},private provider?:Provider){}
 private selected(expected?:Selected){
  const selected=requireTaskStopProvider(this.provider);
  if(expected&&(selected.executor!==expected.executor||selected.stop!==expected.stop||selected.reconcile!==expected.reconcile||['deviceId','grantId','fingerprint'].some(k=>selected[k as keyof Selected]!==expected[k as keyof Selected])))denied('任务停止期间可信设备已变化','TASK_STOP_UNAVAILABLE');
  return selected;
 }
 private archive(run:any){
  const archived:any=readRun(this.service.traceRoot,this.runId);
  if(!archived||archived.integrity!=='ok'||archived.id!==run.id||archived.snapshot.projectId!==run.project_id||archived.snapshot.planVersion!==run.project_version||
   archived.snapshot.executionProfile!==run.snapshot.executionProfile||!isDeepStrictEqual(archived.snapshot.executionTarget,run.snapshot.executionTarget))return denied('任务停止可信档案或批准身份已变化');
  run.events=archived.events;return archived;
 }
 private async transaction<T>(fn:(db:pg.PoolClient,run:any)=>Promise<T>):Promise<T>{
  const db=await pool.connect();
  try{
   await db.query('BEGIN');
   const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[this.runId])).rows[0];if(!identity)denied('停止运行不存在');
   const project=(await db.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const run=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[this.runId])).rows[0];
   if(!project||!run)denied('停止运行不存在');
   const result=await fn(db,run);await db.query('COMMIT');return result;
  }catch(error){try{await db.query('ROLLBACK');}catch{}throw error;}finally{db.release();}
 }
 private async current(db:pg.PoolClient,run:any,selected:Selected,signal:AbortSignal){
  signal.throwIfAborted();this.selected(selected);this.archive(run);
  if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length||run.status!=='running'||run.cancel_requested||run.lease_owner!==this.service.owner)denied('停止运行当前权限或来源无效');
  await assertCurrentRunPermissions(run,db,{requireLocalOnline:false});
  if(!(await db.query("SELECT id FROM project_runs WHERE id=$1 AND lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()",[run.id,this.service.owner])).rowCount)denied('停止运行租约失效');
  const target=run.snapshot.executionTarget;
  if(target?.kind!=='local'||target.deviceId!==selected.deviceId||target.grantId!==selected.grantId||target.backend?.kind!=='openshell'||target.backend.fingerprint!==selected.fingerprint)denied('停止 provider 与批准设备不同');
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
  await this.current(db,run,selected,signal);await this.ownFence(db,own);await assertNoUnresolvedTaskOperation(db,run.id);
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
  if(!refs.lastMerge||refs.canonical.revision!==accepted.workspaceRevision||checkpointDigest(refs.workManifest)!==accepted.sandboxWorkRevision||refs.scopeHash!==task.scope.workspace.scopeHash||refs.capabilityHash!==task.capability_hash||
   task.scope.workRevision!==refs.canonical.revision||!isDeepStrictEqual(refs.inputOrigins,task.input_origins)||!isDeepStrictEqual(refs.inputManifest,task.scope.workspace.inputManifest)||!isDeepStrictEqual(refs.workManifest,manifest(task.scope.workspace.importedFiles)))denied('原验收工作版本或 scope 与持久检查点不同');
  const fixedInputs=pinnedInputs(run,assignment,contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision);
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
   if(!isDeepStrictEqual(pinnedInputs(run,assignment,contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision),task.input_origins))denied('停止前原固定输入来源已变化');
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
 private async recordStopped(selected:Selected,original:TaskAcceptedStopRecord,result:any,reconciled=false){
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
  });
 }
 private async observation(db:pg.PoolClient,run:any,selected:Selected,marker:TaskAcceptedStopRecord,signal:AbortSignal){
  signal.throwIfAborted();this.selected(selected);this.archive(run);
  const {identity,proof}=marker,key=identity.key;
  if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length||proof.deviceId!==selected.deviceId||proof.grantId!==selected.grantId||proof.fingerprint!==selected.fingerprint)denied('原停止观察身份或来源不同');
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
  if(checkedRevision!==identity.workspaceRevision||refs.canonical.revision!==accepted.workspaceRevision||checkpointDigest(refs.workManifest)!==identity.workspaceRevision||!refs.lastMerge||refs.lastMerge.operationId!==proof.originalOperationId||
   refs.scopeHash!==task.scope?.workspace.scopeHash||refs.capabilityHash!==proof.capabilityHash||!isDeepStrictEqual(refs.inputOrigins,task.input_origins)||!isDeepStrictEqual(refs.inputManifest,task.scope.workspace.inputManifest)||!isDeepStrictEqual(refs.workManifest,manifest(task.scope.workspace.importedFiles)))denied('原停止观察版本不同');
  for(const command of task.contract.verify??[]){const actual=accepted.commands.findLast((entry:any)=>entry.command===command),exit=task.contract.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;if(!actual||actual.exitCode!==exit||actual.workspaceRevision!==checkedRevision)denied('原停止观察命令验收不同');}
  if(task.contract.acceptanceChecks!==undefined&&!isDeepStrictEqual(assertAcceptanceChecks(task.contract,accepted.commands,checkedRevision),accepted.acceptanceChecks))denied('原停止观察逐项验收不同');assertHandoffReport(task.contract,accepted.employeeReport);
  const historical={...run,events:run.events.filter((event:any)=>event.seq<=cp.seq)},assignment={...key,agentId:proof.principal,sessionId:proof.sessionId,runtimeTaskId:proof.runtimeTaskId,contractHash:proof.contractHash};
  if(!isDeepStrictEqual(pinnedInputs(historical,assignment,task.contract,task.input_origins.find((input:any)=>input.source.kind==='import')?.origin.acceptedRevision??task.scope.workRevision),task.input_origins))denied('原停止观察输入来源不同');
  if(!Array.isArray(accepted.outputs)||!isDeepStrictEqual(accepted.outputs.map((entry:any)=>entry.path).sort(),task.contract.outputs.map((entry:any)=>entry.path).sort())||!Array.isArray(accepted.inputs)||accepted.inputs.length!==task.input_origins.length)denied('原停止观察验收文件不完整');
  for(const output of accepted.outputs){const file=refs.workManifest.find((entry:any)=>entry.path===output.path);if(!file||file.sha256!==output.sha256||file.size!==output.size)denied('原停止观察输出不同');}
  for(const input of task.input_origins){const file=accepted.inputs.find((entry:any)=>entry.path===input.path);if(!file||file.sha256!==input.sha256||file.size!==refs.inputManifest.find((entry:any)=>entry.path===input.path)?.size)denied('原停止观察输入不同');}
  for(const commit of task.committed_outputs){const operation=operations.find((row:any)=>row.id===commit.receipt?.operationId);if(!operation||operation.device_id!==selected.deviceId||operation.grant_id!==selected.grantId)denied('原停止观察 SQL 提交来源缺失');assertOriginalTaskCommit(this.service.traceRoot,run,task,operation,backend);}
  const original=operations.find((row:any)=>row.id===proof.originalOperationId),checked=assertOriginalTaskCommit(this.service.traceRoot,run,task,original,backend);
  if(checked.record.digest!==proof.originalMergeDigest||!isDeepStrictEqual(checked.receipt,refs.lastMerge)||checked.result.workspaceRevision!==identity.workspaceRevision||!boundary.environment||boundary.environment!==checkpointEnvironment(run.snapshot,checked.result.execution,refs))denied('原停止观察原提交环境不同');
  signal.throwIfAborted();this.selected(selected);
 }
 async reconcileExisting(signal:AbortSignal){
  const markers=await this.transaction(async db=>this.markers(db));
  for(const marker of markers.filter(marker=>marker.state!=='stopped')){
   const selected=this.selected();
   await this.transaction(async(db,run)=>{await this.observation(db,run,selected,marker,signal);});
   signal.throwIfAborted();this.selected(selected);
   const result=await selected.reconcile.call(selected.executor,marker.identity.key,marker.identity);
   await this.recordStopped(selected,marker,result,true);
  }
 }
 async beforeNewTask(context:TaskCheckpointContext,signal:AbortSignal){
  const selected=this.selected();await this.reconcileExisting(signal);
  const candidates=await this.transaction(async(db,run)=>{
   await this.current(db,run,selected,signal);await this.target(db,run,context);
   const rows=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND phase='active' AND accepted_stop IS NULL",[run.id])).rows;
   return rows.flatMap(row=>{const key=rowKey(row),accepted=run.events.findLast((event:any)=>event.type==='handoff/accepted'&&sameKey(event.data.taskExecution?.key,key));return accepted&&!sameKey(key,{runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation})?[{key,seq:accepted.seq}]:[];}).sort((a,b)=>a.seq-b.seq||JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
  });
  for(const candidate of candidates){
   const prepared=await this.transaction(async(db,run)=>{
    const verified=await this.verify(db,run,candidate.key,selected,signal);const target=await this.target(db,run,context);verified.recheck();const authority=this.authority(run,verified.marker,target);
    await this.cas(db,candidate.key,null,verified.marker);await this.current(db,run,selected,signal);
    return {...verified,run,target,authority};
   });
   this.sync(prepared.run,selected,prepared.marker,prepared.target,prepared.authority,signal,prepared.recheck);
   let used=false,dispatchCommitted=false;
   const beforeDispatch=async()=>{
    if(used)denied('停止派发回调只能调用一次');used=true;
    const dispatched=await this.transaction(async(db,run)=>{
     const verified=await this.verify(db,run,candidate.key,selected,signal,prepared.marker);const target=await this.target(db,run,context);verified.recheck();const authority=this.authority(run,prepared.marker,target);
     const marker=decodeTaskAcceptedStop({...prepared.marker,state:'dispatching',dispatchedAt:new Date(Math.max(Date.now(),Date.parse(prepared.marker.preparedAt))).toISOString()});
     await this.cas(db,candidate.key,prepared.marker,marker);await this.current(db,run,selected,signal);
     return {...verified,run,marker,target,authority};
    });
    this.sync(dispatched.run,selected,dispatched.marker,dispatched.target,dispatched.authority,signal,dispatched.recheck);
    dispatchCommitted=true;
   };
   const expected={...prepared.marker.identity,accepted:true,checkpointResolved:true,operationsResolved:true};
   const result=await selected.stop.call(selected.executor,candidate.key,expected,beforeDispatch);
   if(!dispatchCommitted)denied('停止 provider 缺少成功提交的派发回调');
   // A trusted device may only reconcile its prior intent; it cannot invent a fresh effect.
   await this.recordStopped(selected,prepared.marker,result);
   signal.throwIfAborted();this.selected(selected);
  }
 }
}
