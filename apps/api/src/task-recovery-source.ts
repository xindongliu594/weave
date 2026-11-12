import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {pool} from './db.ts';
import {AppError} from './provider.ts';
import {assertArchiveSourceScope,type ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {readTaskRecoveryArchive} from './task-recovery-archive.ts';
import {summarizeTaskRecoveryHistory} from './task-recovery-history.ts';
import {decodeTaskRecoverySource,decodeTaskRecoveryEvidence} from './task-recovery-state.ts';
import {decodeTaskAcceptedStop} from './task-accepted-stop-state.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {requireResolvedEffectsIn} from './tool-operations.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {assertExecutionBackendBinding,executionBackend} from './execution-backend.ts';
import {requireProjectCostReady} from './cost-control.ts';
import {readRunBounds} from './source-bounds.ts';
import {buildCheckpointContext} from '../../../services/agent-runtime/checkpoint-context.mjs';
import {completedTasks,checkpointTasks} from './handoff-checkpoints.ts';
import {join} from 'node:path';
import {sourceBudgetEvidence} from '../../../services/agent-runtime/run-evidence.mjs';

const locator=z.strictObject({sourceRunId:z.uuid(),checkpointId:z.uuid(),childRunId:z.uuid()});
export type TaskRecoveryLocator=z.infer<typeof locator>;
const denied=(message:string):never=>{throw new AppError(409,message,'TASK_RECOVERY_SOURCE_INVALID');};
const runColumns='id project_id project_version status error created_at started_at finished_at attempt parent_run_id cancel_requested department_ids lease_owner lease_until snapshot canonical_workspace requested_by_user_id authorized_by_user_id authorized_epoch authority_kind authority_department_ids source_bounds'.split(' ');
const scopeColumns='run_id task_id attempt_id generation principal session_id runtime_task_id contract_hash permission_hash capability_hash contract input_origins committed_outputs sandbox_identity scope work_revision phase accepted_stop'.split(' ');
const operationColumns='id run_id device_id grant_id approval_id status started deadline created_at finished_at merge_state payload result late_result merge_record merge_rejection claim_token lease_owner executor_kind effect_intent effect_state effect_version parent_operation_id evidence_records'.split(' ');
const times=new Set(['created_at','started_at','finished_at','lease_until','deadline']);
const projection=(columns:string[])=>columns.map(column=>times.has(column)?`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`:column).join(',');
const key=(row:any)=>({runId:row.run_id,taskId:row.task_id,attemptId:row.attempt_id,generation:row.generation});
const trustedClients=new WeakSet<object>();
const unknownCommits=new WeakSet<object>();
export const isTaskRecoveryCommitUnknown=(error:unknown)=>typeof error==='object'&&error!==null&&unknownCommits.has(error);

function approvedChild(source:any,child:any,input:TaskRecoveryLocator){
 if(!source||!child||source.id===child.id||source.project_id!==child.project_id||source.project_version!==child.project_version||
  !['failed','interrupted','cancelled'].includes(source.status)||!source.finished_at||source.lease_owner!==null||source.lease_until!==null||
  source.parent_run_id!==null||source.snapshot.recovery||source.snapshot.resumedFrom||source.snapshot.handoffCheckpoints?.length||
  source.snapshot.executionProfile!=='task-attempt-openshell-v1'||source.task_evidence_text!==null)denied('来源必须是已停止且已排空的原始任务运行');
 if(child.task_evidence_text!==null&&(typeof child.task_evidence_text!=='string'||Buffer.byteLength(child.task_evidence_text)>512*1024))denied('目标恢复记录超过支持范围');
 const childEvidence=child.task_evidence_text===null?null:decodeTaskRecoveryEvidence(JSON.parse(child.task_evidence_text));
 const initialized=childEvidence?.recoveryInitialization;
 const approval=child.snapshot.approval,checkpoint=child.snapshot.recovery?.workspaceCheckpoint;
 if((!initialized&&(child.status!=='queued'||child.started_at!==null||child.finished_at!==null||child.cancel_requested||child.lease_owner!==null||child.lease_until!==null||child.canonical_workspace!==null))||
  child.parent_run_id!==source.id||child.snapshot.resumedFrom!==source.id||child.snapshot.recovery?.sourceRunId!==source.id||
  approval?.kind!=='resume'||approval.parentRunId!==source.id||!Number.isFinite(Date.parse(approval.approvedAt))||
  checkpoint?.runId!==source.id||checkpoint?.id!==input.checkpointId)denied('目标运行不是此检查点的尚未初始化批准记录');
 // Recovery metadata is server-derived. The executable contract and capabilities
 // cannot silently change while certifying an older employee workspace.
 const omit=new Set(['runtimeArchitecture','approvedTasks','recovery','handoffCheckpoints','completedCheckpoints','resumedFrom','approval','executionBudget','costCarryover','budgetVersion','budgetHistory','departmentBudgets']);
 const core=(snapshot:any)=>Object.fromEntries(Object.entries(snapshot).filter(([field])=>!omit.has(field)));
 if(!isDeepStrictEqual(core(source.snapshot),core(child.snapshot))||
  child.snapshot.approvedTasks&&!isDeepStrictEqual(child.snapshot.approvedTasks,source.snapshot.approvedTasks??source.snapshot.tasks)||
  !Number.isSafeInteger(source.snapshot.resourceRevision)||source.snapshot.resourceRevision<1)denied('来源与目标的批准合同、权限或资源版本不一致');
 if(initialized&&(initialized.childRunId!==child.id||initialized.source.sourceRunId!==source.id||initialized.source.sourceCheckpoint.id!==input.checkpointId))denied('目标已有其他恢复初始化记录');
 return initialized??null;
}

/** The original connection/query must settle even after cancellation. This is
 * read/certification only; no tool, model, object or source mutation is issued. */
async function sourceTransaction<T>(signal:AbortSignal,fn:(db:pg.PoolClient)=>Promise<T>):Promise<T>{
 signal.throwIfAborted();const client=await pool.connect();let released=false,discarded=false,committing=false;
 const raw=client.query.bind(client),db=Object.create(client) as pg.PoolClient,deadline=Date.now()+120000;
 const discard=()=>{discarded=true;if(!released){released=true;client.release(true);}};
 const usable=()=>{if(signal.aborted){discard();signal.throwIfAborted();}if(discarded)denied('来源查询连接已丢弃');};
 const native=async(text:any,values?:any)=>{usable();try{const result=await (raw as any)(text,values);usable();return result;}catch(error){if(signal.aborted||!(error as any)?.severity||['57014','55P03'].includes((error as any)?.code))discard();throw error;}};
 signal.addEventListener('abort',discard,{once:true});
 (db as any).query=async(text:any,values?:any)=>{
  const ms=deadline-Date.now();if(ms<=0){discard();throw new DOMException('Recovery source deadline expired','TimeoutError');}
  await native("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[String(ms)]);
  return native(text,values);
 };
 try{await native('BEGIN');await db.query('SELECT pg_advisory_xact_lock(918275)');trustedClients.add(db);const value=await fn(db);committing=true;await db.query('COMMIT');usable();return value;}
 catch(error){if(committing){if(error&&typeof error==='object')unknownCommits.add(error);discard();}else if(!discarded)try{await native('ROLLBACK');}catch{discard();}throw error;}
 finally{trustedClients.delete(db);signal.removeEventListener('abort',discard);if(!released){released=true;client.release();}}
}

/** Private live SQL provenance, NOT execution admission. Locators are the only
 * caller-supplied facts. All authority, history and files come from original
 * stores under the actual native source fence and SQL locks. */
export async function captureLiveTaskRecoverySource(writers:ArchiveWriterManager,input:TaskRecoveryLocator,signal:AbortSignal){
 const ids=locator.parse(input);if(ids.sourceRunId===ids.childRunId)denied('恢复来源和目标不能相同');
 return writers.withSource(ids.sourceRunId,async()=>{
  return withTaskRecoverySourceTransaction(writers,ids,signal,async facts=>{if(facts.initialized)denied('目标已经初始化，请使用原恢复记录');return facts;});
 },{signal});
}

/** Server-only continuation under the original native guard and original pool
 * client. Never bind this callback seam to an HTTP/tool input. */
export async function withTaskRecoverySourceTransaction<T>(writers:ArchiveWriterManager,input:TaskRecoveryLocator,signal:AbortSignal,body:(facts:Awaited<ReturnType<typeof captureTaskRecoverySourceIn>>,db:pg.PoolClient)=>Promise<T>){
 const ids=locator.parse(input);if(ids.sourceRunId===ids.childRunId)denied('恢复来源和目标不能相同');
 assertArchiveSourceScope(writers,ids.sourceRunId);signal.throwIfAborted();
 return sourceTransaction(signal,async db=>body(await captureTaskRecoverySourceIn(writers,ids,db,signal),db));
}

/** Server-only route seam. Owns the original connection and transaction so a
 * new approved child and its complete source-derived snapshot publish together. */
export async function withTaskRecoveryCreationTransaction<T>(writers:ArchiveWriterManager,sourceRunId:string,signal:AbortSignal,body:(db:pg.PoolClient)=>Promise<T>){
 z.uuid().parse(sourceRunId);assertArchiveSourceScope(writers,sourceRunId);signal.throwIfAborted();
 return sourceTransaction(signal,async db=>{
  const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[sourceRunId])).rows[0];if(!identity)denied('来源运行不存在');
  await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
  const source=(await db.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[sourceRunId])).rows[0];
  if(!source||source.project_id!==identity.project_id)denied('来源项目已变化');
  const operations=(await db.query('SELECT id,device_id FROM local_operations WHERE run_id=$1 ORDER BY id COLLATE "C" LIMIT 4097 FOR UPDATE',[sourceRunId])).rows;
  if(operations.length>4096)denied('来源操作过多');
  const devices=[...new Set([source.snapshot.executionTarget?.deviceId,...operations.map(row=>row.device_id)].filter(Boolean))].sort();
  if(devices.length)await db.query('SELECT id FROM local_devices WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',[devices]);
  const scopes=await db.query('SELECT task_id FROM task_attempt_workspaces WHERE run_id=$1 ORDER BY task_id COLLATE "C",attempt_id COLLATE "C",generation LIMIT 4097 FOR UPDATE',[sourceRunId]);
  if(scopes.rows.length>4096)denied('来源工作区过多');
  // A newly inserted child is invisible to other transactions. Source rows are
  // locked before the route obtains actor/authority locks, as in capture.
  return body(db);
 });
}

/** Revalidation within the same original transaction; caller rows cannot stand
 * in for a real connection or native source scope. */
export async function captureTaskRecoverySourceIn(writers:ArchiveWriterManager,ids:TaskRecoveryLocator,db:pg.PoolClient,signal:AbortSignal){
   assertArchiveSourceScope(writers,ids.sourceRunId);if(!trustedClients.has(db))denied('来源必须从原连接取得');signal.throwIfAborted();
   const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[ids.sourceRunId])).rows[0];if(!identity)denied('来源运行不存在');
   const project=(await db.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const runs=(await db.query(`SELECT ${projection(runColumns)},task_evidence::text AS task_evidence_text FROM project_runs WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,[[ids.sourceRunId,ids.childRunId]])).rows;
   const source=runs.find(row=>row.id===ids.sourceRunId),child=runs.find(row=>row.id===ids.childRunId);
   const initialized=approvedChild(source,child,ids);if(!project||project.version!==source.project_version||project.id!==source.project_id||identity.project_id!==source.project_id)denied('项目归属或方案版本已经变化');
   const allOperations=(await db.query(`SELECT ${projection(operationColumns)} FROM local_operations WHERE run_id=ANY($1::text[]) ORDER BY id COLLATE "C" LIMIT 8193 FOR UPDATE`,[[source.id,child.id]])).rows;
   const operations=allOperations.filter(row=>row.run_id===source.id),childOperations=allOperations.filter(row=>row.run_id===child.id);
   if(allOperations.length>8192||childOperations.length>4096)denied('恢复操作历史超过支持范围');
   const target=source.snapshot.executionTarget;
   const devices=(await db.query('SELECT id,grant_id,enabled,backend FROM local_devices WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',[[...new Set([target?.deviceId,...allOperations.map(row=>row.device_id).filter(Boolean)])]])).rows;
   const allScopes=(await db.query(`SELECT ${projection(scopeColumns)} FROM task_attempt_workspaces WHERE run_id=ANY($1::text[]) ORDER BY run_id COLLATE "C",task_id COLLATE "C",attempt_id COLLATE "C",generation LIMIT 8193 FOR UPDATE`,[[source.id,child.id]])).rows;
   const scopes=allScopes.filter(row=>row.run_id===source.id),childScopes=allScopes.filter(row=>row.run_id===child.id);
   if(allScopes.length>8192||childScopes.length>4096)denied('恢复任务历史超过支持范围');
   // Bound the complete history before any verifier expands objects or walks it.
   const history=summarizeTaskRecoveryHistory({run:Object.fromEntries(runColumns.map(column=>[column,source[column]])),scopes,operations});
   // Explicit new domain pins the new nullable column without rewriting the
   // already-tested v1 history projection or collapsing SQL NULL / jsonb null.
   const sourceHistoryDigest=createHash('sha256').update(JSON.stringify({historyDigest:history.digest,kind:'task-live-source-history-with-evidence',taskEvidenceText:source.task_evidence_text,version:2})).digest('hex');
   for(const run of runs)await assertNoUnresolvedTaskOperation(db,run.id);await requireResolvedEffectsIn(db,runs.map(run=>run.id));
   if(allOperations.some(row=>!['completed','failed','cancelled'].includes(row.status)||row.late_result!==null||row.merge_state!==null&&!['committed','rejected'].includes(row.merge_state)))denied('来源或目标存在迟到、未知或未完成的操作');
   for(const task of allScopes){
    if(task.phase==='unknown')denied('来源存在未知工作区');
    if(task.accepted_stop!==null){const marker=decodeTaskAcceptedStop(task.accepted_stop);if(marker.state!=='stopped'||!isDeepStrictEqual(marker.identity.key,key(task)))denied('来源存在未完成或错身份的停止记录');}
   }
   if(!initialized&&(childOperations.length||childScopes.length))denied('目标已有操作或任务工作区');
   const users=[...new Set(runs.map(row=>row.authorized_by_user_id).filter(Boolean))].sort();
   if(users.length)await db.query('SELECT id FROM human_users WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',[users]);
   const namespaces=[...new Set<string>(runs.flatMap(row=>(row.snapshot.nativeCapabilities??[]).map((binding:any)=>binding.manifest?.namespace)))].sort();
   if(namespaces.some(namespace=>typeof namespace!=='string'))denied('插件来源身份缺失');
   if(namespaces.length)await db.query('SELECT namespace FROM native_capabilities WHERE namespace=ANY($1::text[]) ORDER BY namespace COLLATE "C" FOR SHARE',[namespaces]);
   for(const run of runs)await assertCurrentRunPermissions(run,db,{requireLocalOnline:false,authorityLock:true,effect:'resume'});
   const backend=executionBackend(target?.backend),device=devices.find(row=>row.id===target?.deviceId);
   if(target?.kind!=='local'||backend.kind!=='openshell'||!device?.enabled||device.grant_id!==target.grantId||devices.length!==1||
    allOperations.some(row=>row.executor_kind==='local'&&(row.device_id!==target.deviceId||row.grant_id!==target.grantId)))denied('来源或目标操作与批准设备或执行环境不一致');
   assertExecutionBackendBinding(backend,device.backend);assertExecutionBackendBinding(backend,source.snapshot.policy.executionTarget?.backend);assertExecutionBackendBinding(backend,child.snapshot.executionTarget?.backend);
   const bounds=await readRunBounds(db,source.id);if(!isDeepStrictEqual(bounds,child.source_bounds))denied('目标未保留来源资料约束');
   const costs=await requireProjectCostReady(db,source.project_id,child.snapshot.approval.retainUncertainCosts===true,child.snapshot.policy.maxBudget);
   if(!Number.isFinite(costs.availableBudget)||!initialized&&costs.availableBudget<=0)denied('目标没有可用恢复预算');
   const archived=readTaskRecoveryArchive(writers,{id:source.id,project_id:source.project_id,project_version:source.project_version,snapshot:source.snapshot});
   const live={...source,events:archived.events};
   const {verifyRecoveryCommitChain,verifyRecoveryCheckpoint}=await import('./task-recovery-provenance.ts');
   const {verifyRecoveryScope}=await import('./task-recovery-scope.ts');
   const chain=verifyRecoveryCommitChain(writers.traceRoot,live,scopes,operations,backend);
   const selected=verifyRecoveryCheckpoint(writers.traceRoot,live,archived.events,ids.checkpointId,chain);
   if(child.snapshot.recovery.workspaceCheckpoint.sha256!==selected.checkpoint.sha256)denied('目标批准的检查点摘要不符');
   const scope=verifyRecoveryScope({traceRoot:writers.traceRoot,run:live,events:archived.events,chain,selected});
   const retainedIds=scope.retained.map(item=>item.key.taskId).sort();
   if(Object.hasOwn(child.snapshot,'completedCheckpoints')){
    const declared=child.snapshot.completedCheckpoints;
    if(!Array.isArray(declared)||new Set(declared).size!==declared.length||!isDeepStrictEqual([...declared].sort(),retainedIds))denied('目标声明的完成节点与原独立验收不同');
   }
   if(Object.hasOwn(child.snapshot,'handoffCheckpoints')){
    const records=child.snapshot.handoffCheckpoints;
    if(!Array.isArray(records)||records.length!==scope.retained.length||new Set(records.map(item=>item?.taskId)).size!==records.length||
     !records.every(item=>scope.retained.some(known=>isDeepStrictEqual(item,known.accepted))))denied('目标交接记录与原独立验收不同');
   }
   const metadata=child.snapshot.recovery;
   if(Object.keys(metadata).some(field=>!['sourceRunId','workspaceCheckpoint','version','createdAt','completed','reworkRounds','files','nodes','budgetEvidence'].includes(field)))denied('目标恢复上下文含未支持字段');
   if(Object.keys(metadata.workspaceCheckpoint).some(field=>!['id','runId','sha256'].includes(field)))denied('目标检查点定位含未支持字段');
   if(Object.hasOwn(metadata,'version')){
    const prefix=archived.events.filter(event=>event.seq<=selected.event.seq),done=completedTasks(archived.events,source.snapshot);
    const expected=JSON.parse(JSON.stringify(buildCheckpointContext({...source.snapshot,handoffCheckpoints:scope.retained.map(item=>item.accepted)},prefix,checkpointTasks(prefix,source.snapshot),done,join(writers.traceRoot,source.id,'artifacts'),source.id,scope.candidate.manifest)));
    expected.budgetEvidence=sourceBudgetEvidence(source.snapshot,archived.events,source.id);
    const {workspaceCheckpoint:ignored,...context}=metadata;
    if(!Number.isFinite(Date.parse(context.createdAt))||!isDeepStrictEqual({...expected,createdAt:context.createdAt},context))denied('目标上下文与原任务历史或完整候选文件不一致');
   }else if(Object.keys(metadata).some(field=>!['sourceRunId','workspaceCheckpoint'].includes(field)))denied('目标恢复上下文缺少明确版本');
   const approval=decodeTaskRecoverySource({version:1,mode:'live-sql-v1',sourceRunId:source.id,sourceHead:source.canonical_workspace,
    sourceCheckpoint:{key:selected.refs.key,id:selected.checkpoint.id,sha256:selected.checkpoint.sha256,seq:selected.checkpoint.seq},sourceHistoryDigest,sourceArchiveCursor:archived.cursor,
    authority:{projectId:source.project_id,planVersion:source.project_version,taskId:selected.task.task_id,contractHash:selected.task.contract_hash,permissionHash:selected.task.permission_hash,capabilityHash:selected.task.capability_hash,resourceRevision:source.snapshot.resourceRevision,backend}});
   signal.throwIfAborted();assertArchiveSourceScope(writers,source.id);
   if(initialized&&!isDeepStrictEqual(initialized.source,approval))denied('原初始化批准与当前可信来源不一致');
   return {source:approval,selected,scope,costs,child,initialized,childScopes,childOperations};
}
