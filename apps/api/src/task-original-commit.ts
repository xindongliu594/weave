import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import type {TaskExecutionScope} from '../../../packages/contracts/index.ts';
import {readCommittedCanonical,validateTaskOperationResult} from './task-canonical.ts';
import {assertExecutionBackendReceipt} from './execution-backend.ts';
import {taskOperationDenied} from './task-operation-admission.ts';

const {manifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(ordered(v))).digest('hex');

/** Pure positive provenance only; callers separately prove current assignment and authority. */
export function assertOriginalTaskCommit(traceRoot:string,run:any,task:any,row:any,backend:any){
 if(!row?.claim_token||row.result?.claimToken!==row.claim_token)taskOperationDenied('原操作来源与准确任务绑定不符');
 return validateArchivedTaskCommit(traceRoot,run,task,row,backend);
}

/** History/backup integrity only. The live claim secret is deliberately absent
 * from portable rows; this cannot replace assertOriginalTaskCommit, current
 * authority or restore admission when executing/recovering an operation. */
export function validateArchivedTaskCommit(traceRoot:string,run:any,task:any,row:any,backend:any){
 const key={runId:run.id,taskId:task.task_id,attemptId:task.attempt_id,generation:task.generation};
 const scope:TaskExecutionScope=row?.payload?.taskScope,result=row?.result?.result,record=row?.merge_record,receipt=record?.receipt;
 const context={agentId:task.principal,sessionId:task.session_id,taskId:task.task_id,attemptId:task.attempt_id,generation:task.generation};
 if(!row||row.run_id!==run.id||row.status!=='completed'||!row.started||typeof row.result?.claimToken!=='string'||!row.result.claimToken||!row.lease_owner||!row.result?.ok||row.merge_state!=='committed'||
  !isDeepStrictEqual(scope?.key,key)||!isDeepStrictEqual(scope.inputOrigins,task.input_origins)||scope.capabilityHash!==task.capability_hash||
  scope.workspace.binding.permissionHash!==task.permission_hash||scope.workspace.binding.contractHash!==task.contract_hash||
  scope.workspace.binding.runId!==key.runId||scope.workspace.binding.taskId!==key.taskId||scope.workspace.binding.attemptId!==key.attemptId||scope.workspace.binding.generation!==key.generation||
  scope.workspace.binding.projectId!==run.project_id||scope.workspace.binding.planVersion!==run.project_version||scope.workspace.binding.assigneeId!==task.principal||
  backend?.kind!=='openshell'||!isDeepStrictEqual(scope.workspace.binding.backend,{kind:'openshell',version:backend.version,image:backend.image,policyHash:backend.policySha256})||
  Object.entries(context).some(([k,v])=>row.payload.context?.[k]!==v)||row.payload.runId!==run.id||row.payload.deviceId!==row.device_id||row.payload.grantId!==row.grant_id)
  taskOperationDenied('原操作来源与准确任务绑定不符');
 validateTaskOperationResult(row,result);assertExecutionBackendReceipt(backend,result,result.taskExecution);
 if(result.execution?.sandboxId!==task.sandbox_identity?.sandboxId||result.localWorkspace!==task.sandbox_identity?.localWorkspace)taskOperationDenied('原操作来自不同任务沙箱');
 const commits=task.committed_outputs?.filter((entry:any)=>entry.receipt?.operationId===row.id)??[];
 const own={scope,receipt:{profile:scope.profile,key,scopeHash:scope.workspace.scopeHash,operationId:row.id,beforeWorkRevision:record?.before?.revision,afterWorkRevision:record?.after?.revision},files:record?.delta};
 if(!record||record.version!==1||record.digest!==digest({...record,digest:undefined})||record.operationId!==row.id||record.resultDigest!==digest(row.result)||record.scopeDigest!==digest(scope)||
  receipt?.status!=='committed'||receipt.mergeId!==row.id||receipt.operationId!==row.id||!isDeepStrictEqual(receipt.key,key)||receipt.scopeHash!==scope.workspace.scopeHash||
  receipt.beforeRevision!==record.before?.revision||receipt.afterRevision!==record.after?.revision||receipt.workRevision!==result.workspaceRevision||
  record.before?.revision!==scope.workRevision||record.after?.mergeId!==row.id||commits.length!==1||!isDeepStrictEqual(commits[0],own))taskOperationDenied('原提交与输出链缺少完整正向证明');
 const after=readCommittedCanonical(traceRoot,{...run,canonical_workspace:{version:1,...record.after,receipt}});
 for(const file of manifest(result.files)){
  const stored=after.ref.manifest.find((entry:any)=>entry.path===file.path);
  if(!isDeepStrictEqual(stored,file))taskOperationDenied('原任务部分文件与提交对象不同');
 }
 return {scope,result,record,receipt};
}
