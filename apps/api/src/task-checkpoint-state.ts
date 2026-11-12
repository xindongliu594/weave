import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import type {TaskCheckpointRefs,TaskWorkspaceFile} from '../../../packages/contracts/index.ts';
import {readCommittedCanonical} from './task-canonical.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {assertExecutionBackendBinding,executionBackend} from './execution-backend.ts';
import {assertNoUnresolvedTaskOperation,taskOperationDenied} from './task-operation-admission.ts';
import {resolveTaskScope} from './task-execution.ts';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {storeArchiveObjects} from '../../../services/agent-runtime/archive-objects.mjs';
import {validateTaskCheckpointRefs} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {assertOriginalTaskCommit} from './task-original-commit.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';

const {manifest,revision,decodeFiles}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
export type TaskCheckpointContext={agentId:string;sessionId:string;taskId:string;attemptId:string;generation:number};
export type TaskCheckpointOptions={phase:'before-tool'|'after-tool'|'boundary';operationId?:string};
function immutable<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;
}
function assignmentAuthority(run:any,events:any[],task:any,context:TaskCheckpointContext){
 const mappings=new Map();let contract=run.snapshot.tasks?.find((item:any)=>item.id===context.taskId);
 for(const event of events){
  if(event.type==='run/task-mapping')for(const binding of event.data.tasks??[])mappings.set(binding.task_id,binding.seed_id);
  if(event.type==='quality/rework-created'&&event.data.bindings?.some((binding:any)=>binding.task_id===task.runtime_task_id&&binding.seed_id===context.taskId))contract=event.data.repairContract?.id===context.taskId?event.data.repairContract:event.data.reviewContract?.id===context.taskId?event.data.reviewContract:undefined;
 }
 const state=events.findLast(event=>event.type==='team/checkpoint')?.data;
 const member=state?.members?.find((item:any)=>item.id===context.sessionId),assigned=state?.tasks?.find((item:any)=>item.id===task.runtime_task_id);
 return {mapping:mappings.get(task.runtime_task_id),contract,member:member&&{id:member.id,name:member.name,active:member.status!=='removed'},task:assigned&&{id:assigned.id,assignee:assigned.assignee,attemptId:assigned.attemptId,active:['claimed','in_progress'].includes(assigned.status)}};
}

/** Prepare under project -> run locks; invoke the private synchronous publisher after COMMIT. */
export async function prepareTaskCheckpoint(db:pg.PoolClient,run:any,service:{traceRoot:string;owner:string},context:TaskCheckpointContext,signal:AbortSignal,options:TaskCheckpointOptions,persist:<T>(fn:()=>T)=>T=fn=>fn()):Promise<()=>TaskCheckpointRefs>{
 signal.throwIfAborted();
 if(!context||['agentId','sessionId','taskId','attemptId'].some(k=>typeof (context as any)[k]!=='string'||!(context as any)[k])||!Number.isSafeInteger(context.generation)||context.generation<1||Object.keys(context).some(k=>!['agentId','sessionId','taskId','attemptId','generation'].includes(k))||
  !options||!['before-tool','after-tool','boundary'].includes(options.phase)||Object.keys(options).some(k=>!['phase','operationId'].includes(k))||options.operationId!==undefined&&(typeof options.operationId!=='string'||!options.operationId)||options.phase==='after-tool'&&!options.operationId)taskOperationDenied('检查点缺少准确任务或原操作身份');
 if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||run.status!=='running'||run.cancel_requested||run.lease_owner!==service.owner)taskOperationDenied('检查点运行身份或恢复来源无效');
 await assertCurrentRunPermissions(run,db,{requireLocalOnline:false});
 if(run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length)await assertTaskRecoveryRuntime(db,service.traceRoot,run);
 await assertNoUnresolvedTaskOperation(db,run.id);
 const key={runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation};
 const row=(await db.query("SELECT * FROM local_operations WHERE run_id=$1 AND payload->'taskScope'->'key'=$2::jsonb AND result->>'ok'='true' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[run.id,JSON.stringify(key)])).rows[0];
 if(!row||options.operationId!==undefined&&row.id!==options.operationId||row.status!=='completed'||!row.started||!row.claim_token||row.merge_state!=='committed'||row.lease_owner!==service.owner)taskOperationDenied('检查点原任务操作没有完整已提交证据');
 const device=(await db.query('SELECT * FROM local_devices WHERE id=$1 FOR UPDATE',[row.device_id])).rows[0];
 const task=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active' FOR UPDATE",[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
 if(!task||task.principal!==context.agentId||task.session_id!==context.sessionId||!task.sandbox_identity||!device?.enabled||row.device_id!==run.snapshot.executionTarget?.deviceId||row.grant_id!==run.snapshot.executionTarget?.grantId||row.grant_id!==device.grant_id)taskOperationDenied('检查点分派、沙箱或设备授权已变化');
 assertExecutionBackendBinding(executionBackend(device.backend),run.snapshot.executionTarget.backend);
 const canonical=readCommittedCanonical(service.traceRoot,run);
 const scope=await resolveTaskScope(db,run,{...key,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash},{files:canonical.files,revision:canonical.ref.revision},task.scope,service.traceRoot);
 const {scope:original,result,receipt}=assertOriginalTaskCommit(service.traceRoot,run,task,row,executionBackend(device.backend));
 if(!isDeepStrictEqual(original.inputOrigins,scope.inputOrigins)||!isDeepStrictEqual(original.recoverySeed,scope.recoverySeed)||original.capabilityHash!==scope.capabilityHash)taskOperationDenied('检查点原操作与当前任务不符');
 const workFiles:TaskWorkspaceFile[]=options.phase==='after-tool'?result.files:scope.workspace.importedFiles;
 if(revision(workFiles)!==receipt.workRevision||!isDeepStrictEqual(manifest(workFiles),manifest(result.files)))taskOperationDenied('检查点任务文件与原沙箱工作版本不符');
 persist(()=>storeArchiveObjects(join(service.traceRoot,run.id),decodeFiles(workFiles).map((file:any)=>({sha256:createHash('sha256').update(file.bytes).digest('hex'),size:file.bytes.length,content:file.bytes}))));
 const refs:TaskCheckpointRefs={profile:scope.profile,key:scope.key,inputManifest:scope.workspace.inputManifest,inputOrigins:scope.inputOrigins,workManifest:manifest(workFiles),canonical:canonical.ref,lastMerge:receipt,scopeHash:options.phase==='after-tool'?original.workspace.scopeHash:scope.workspace.scopeHash,capabilityHash:scope.capabilityHash,...(scope.recoverySeed?{recoverySeed:scope.recoverySeed}:{})};
 // DSH may publish progress during an await. Resolve the latest semantic
 // assignment rather than requiring the complete checkpoint event to stay equal.
 const archived=readRun(service.traceRoot,run.id);
 if(!archived||archived.integrity!=='ok')return taskOperationDenied('检查点准备期间可信档案失效');
 run.events=archived.events;
 const current=await resolveTaskScope(db,run,{...key,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash},{files:canonical.files,revision:canonical.ref.revision},scope,service.traceRoot);
 if(!isDeepStrictEqual(current,scope))taskOperationDenied('检查点准备期间当前任务 scope 已变化');
 // Recheck time-sensitive authority after asynchronous work and object fsyncs.
 await assertCurrentRunPermissions(run,db,{requireLocalOnline:false});
 if(!(await db.query("SELECT id FROM project_runs WHERE id=$1 AND lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()",[run.id,service.owner])).rowCount)taskOperationDenied('检查点运行租约已失效');
 const trustedRefs=immutable(structuredClone(refs)),publicationContext={...context},traceRoot=service.traceRoot;
 const authority=assignmentAuthority(run,run.events,task,publicationContext);
 const publish=()=>{
  signal.throwIfAborted();
  const latest=readRun(traceRoot,run.id);
  if(!latest||latest.integrity!=='ok'||!isDeepStrictEqual(assignmentAuthority(run,latest.events,task,publicationContext),authority))taskOperationDenied('检查点准备期间任务授权已变化');
  validateTaskCheckpointRefs(trustedRefs,{runId:run.id,taskId:publicationContext.taskId,attemptId:publicationContext.attemptId,archiveDir:join(traceRoot,run.id)});
  return trustedRefs;
 };
 publish();return publish;
}
