import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import type {TaskExecutionScope} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {readCommittedCanonical} from './task-canonical.ts';
import {resolveTaskScope} from './task-execution.ts';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {assertTaskAcceptedStopAdmission} from './task-accepted-stop-state.ts';
import {assertTaskRecoveryRuntime} from './task-recovery-runtime.ts';

export const taskOperationDenied=(message:string,code='TASK_SCOPE_DENIED'):never=>{throw new AppError(409,message,code);};
export function publicTaskScope(scope:TaskExecutionScope){return {profile:scope.profile,key:scope.key,scopeHash:scope.workspace.scopeHash,workRevision:scope.workRevision};}
/** Unknown execution is fenced across attempts and generations, including a
 * contradictory notExecuted flag. A settled rejection is not an unknown merge. */
export async function assertNoUnresolvedTaskOperation(db:Pick<pg.PoolClient,'query'>,runId:string,exceptId:string|null=null){
 const pending=await db.query(`SELECT id FROM local_operations WHERE run_id=$1 AND ($2::text IS NULL OR id<>$2) AND (
  status IN ('queued','claimed','started') OR merge_state IN ('pending','unknown') OR
  (payload->'taskScope'->>'profile'='task-attempt-openshell-v1' AND (
   (status='completed' AND merge_state IS NULL) OR
   (status IN ('failed','cancelled') AND (late_result IS NOT NULL OR result->'error'->>'code'='LOCAL_OUTCOME_UNKNOWN' OR
    (started AND COALESCE(result->'error'->>'notExecuted','false')<>'true')))))) LIMIT 1`,[runId,exceptId]);
 if(pending.rowCount)taskOperationDenied('存在未决任务操作或合并，必须核对原操作','TASK_OPERATION_UNRESOLVED');
}
export function taskDeviceScope(scope:TaskExecutionScope,workRevision:string){const w=scope.workspace;return {profile:scope.profile,key:scope.key,binding:w.binding,scopeHash:w.scopeHash,readPaths:w.readPaths,writePaths:w.writePaths,inputManifest:w.inputManifest,expectedWorkRevision:workRevision};}
/** Per-operation authority for the closed task profile. This does not open the
 * run launch gate: every stored task binding and current permission is proved. */
export async function admitTaskOperation(db:pg.PoolClient,run:any,traceRoot:string,context:any,expected?:TaskExecutionScope,exceptId:string|null=null,{requireLocalOnline=false}={}){
 if(run.snapshot.executionProfile!=='task-attempt-openshell-v1'||
  run.status!=='running'||run.cancel_requested||!context||!Number.isSafeInteger(context.generation)||context.generation<1||
  ['agentId','sessionId','taskId','attemptId'].some(k=>typeof context[k]!=='string'||!context[k]))taskOperationDenied('任务执行身份或运行状态无效');
 await assertCurrentRunPermissions(run,db,{requireLocalOnline});
 if(run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length)await assertTaskRecoveryRuntime(db,traceRoot,run);
 await assertTaskAcceptedStopAdmission(db,run.id,{runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation});
 await assertNoUnresolvedTaskOperation(db,run.id,exceptId);
 const archived=readRun(traceRoot,run.id);if(!archived||archived.integrity!=='ok')taskOperationDenied('可信任务档案不可用');run.events=archived!.events;
 const task=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active' FOR UPDATE",[run.id,context.taskId,context.attemptId,context.generation])).rows[0];
 if(!task||task.principal!==context.agentId||task.session_id!==context.sessionId)taskOperationDenied('任务分派尚未注册或已变化');
 const canonical=readCommittedCanonical(traceRoot,run);
 if(expected&&(!isDeepStrictEqual(task.scope,expected)||expected.workRevision!==canonical.ref.revision))taskOperationDenied('已批准操作 scope 或工作版本已过期');
 const scope=await resolveTaskScope(db,run,{runId:run.id,taskId:context.taskId,attemptId:context.attemptId,generation:context.generation,agentId:context.agentId,sessionId:context.sessionId,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash},{files:canonical.files,revision:canonical.ref.revision},task.scope,traceRoot);
 if(expected&&!isDeepStrictEqual(scope,expected)||!isDeepStrictEqual(context.executionScope,publicTaskScope(scope)))taskOperationDenied('操作未绑定准确的可信 scope');
 return {scope,task,canonical};
}
