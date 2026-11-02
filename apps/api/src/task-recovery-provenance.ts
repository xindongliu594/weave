import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {CanonicalRef,TaskAttemptKey,TaskExecutionScope,TaskMergeReceipt,TaskCheckpointRefs,TaskWorkspaceFile,TaskWorkspacePlanner,TrustedTaskAssignment} from '../../../packages/contracts/index.ts';
import type {TraceEvent} from '../../../services/agent-runtime/trace-store.mjs';
import {readStepCheckpoint,checkpointContract,checkpointEnvironment,validateTaskCheckpointRefs} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {assertOriginalTaskCommit} from './task-original-commit.ts';
import {readCommittedCanonical} from './task-canonical.ts';
import {effectiveTaskContract,taskCapabilityHashes} from './task-execution.ts';
import {checkpointTasks} from './handoff-checkpoints.ts';
import {AppError} from './provider.ts';

const {manifest}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const {planTaskMerge}=createRequire(import.meta.url)('../../desktop/task-workspace.cjs') as TaskWorkspacePlanner;
const denied=(message:string):never=>{throw new AppError(409,message,'TASK_RECOVERY_PROVENANCE_INVALID');};
const keyOf=(task:any):TaskAttemptKey=>({runId:task.run_id,taskId:task.task_id,attemptId:task.attempt_id,generation:task.generation});
const keyString=(key:TaskAttemptKey)=>JSON.stringify([key.runId,key.taskId,key.attemptId,key.generation]);
type Canonical=ReturnType<typeof readCommittedCanonical>;
export type TaskRecoveryCommit={
 row:any;task:any;scope:TaskExecutionScope;result:any;record:any;receipt:TaskMergeReceipt;index:number;
};
export type TaskRecoveryCommitChain={
 initial:Canonical;head:Canonical;commits:TaskRecoveryCommit[];byOperation:Map<string,TaskRecoveryCommit>;scopes:any[];
};
export type TaskRecoveryCheckpointProof={
 checkpoint:ReturnType<typeof readStepCheckpoint>;refs:TaskCheckpointRefs;event:TraceEvent;boundaryEvent:TraceEvent;
 task:any;assignment:TrustedTaskAssignment;contract:any;original:TaskRecoveryCommit;
 canonical:Canonical&{index:number};ownCommits:TaskRecoveryCommit[];
};

/** Private fact validation only. The caller obtains all SQL rows under the real
 * source fence/locks; this helper grants neither current authority nor capture. */
export function verifyRecoveryCommitChain(traceRoot:string,run:any,scopes:any[],operations:any[],backend:any):TaskRecoveryCommitChain{
 if(!Array.isArray(scopes)||!Array.isArray(operations)||scopes.length>4096||operations.length>4096)denied('原任务历史超过支持范围');
 const tasks=new Map<string,any>(),byOperation=new Map<string,TaskRecoveryCommit>();
 for(const task of scopes){
  const key=keyOf(task),id=keyString(key);
  if(task.run_id!==run.id||tasks.has(id)||!Array.isArray(task.committed_outputs))denied('原 SQL 任务身份或提交列表不同');
  tasks.set(id,task);
 }
 const ids=new Set<string>();
 for(const row of operations){
  if(!row?.id||row.run_id!==run.id||ids.has(row.id))denied('原 SQL 操作身份重复或跨运行');
  ids.add(row.id);
  if(row.merge_state!=='committed')continue;
  const task=tasks.get(keyString(row.payload?.taskScope?.key??{}));
  if(!task)denied('原提交没有准确 SQL 任务');
  if(row.device_id!==run.snapshot.executionTarget?.deviceId||row.grant_id!==run.snapshot.executionTarget?.grantId)denied('原提交设备不属于批准源');
  const checked=assertOriginalTaskCommit(traceRoot,run,task,row,backend);
  byOperation.set(row.id,{row,task,...checked,index:-1});
 }
 if(!byOperation.size||!run.canonical_workspace?.mergeId)denied('来源没有已认领提交的完整 head');
 for(const task of scopes){
  const own=new Set<string>();
  for(const commit of task.committed_outputs){
   const id=commit?.receipt?.operationId,original=byOperation.get(id);
   if(!original||own.has(id)||original.task!==task)denied('原 SQL own-output 没有唯一已认领提交');
   own.add(id);
  }
 }
 const head=readCommittedCanonical(traceRoot,run),backwards:TaskRecoveryCommit[]=[],seen=new Set<string>();
 let ref:CanonicalRef=head.ref;
 while(ref.mergeId!==null){
  const commit=byOperation.get(ref.mergeId);
  if(!commit||seen.has(ref.mergeId)||!isDeepStrictEqual(commit.record.after,ref))return denied('完整提交链缺失、分叉或重复');
  backwards.push(commit);seen.add(ref.mergeId);ref=commit.record.before;
  if(!ref||!isDeepStrictEqual(ref,{revision:ref.revision,manifest:ref.manifest,mergeId:ref.mergeId}))denied('原提交基线不是完整 canonical 引用');
 }
 if(seen.size!==byOperation.size)denied('原提交没有全部连接到当前完整 head');
 const commits=backwards.reverse(),first=commits[0];
 for(const task of scopes){
  const expected=commits.filter(commit=>commit.task===task).map(commit=>commit.row.id);
  if(!isDeepStrictEqual(task.committed_outputs.map((entry:any)=>entry.receipt.operationId),expected))denied('原 SQL own-output 顺序与完整提交链不同');
 }
 const initial=readCommittedCanonical(traceRoot,{...run,canonical_workspace:{version:1,...ref,receipt:null}});
 if(first.row.payload.name!=='prepare'||!isDeepStrictEqual(first.scope.workspace.baseCanonicalManifest,initial.ref.manifest)||
  first.scope.workRevision!==initial.ref.revision||!isDeepStrictEqual(manifest(first.result.files),manifest(first.scope.workspace.importedFiles))||
  !isDeepStrictEqual(first.record.after.manifest,initial.ref.manifest)||first.record.delta.length!==0)denied('NULL 根没有真实已认领 prepare 初始化证明');
 const importedPaths=new Set<string>();
 for(const input of run.snapshot.importedFiles??[]){
  const file=initial.ref.manifest.find(entry=>entry.path===input.path),content=typeof input.content==='string'?Buffer.from(input.content,'utf8'):null;
  if(importedPaths.has(input.path)||!input.snapshotId||!content||createHash('sha256').update(content).digest('hex')!==input.sha256||
   !file||file.sha256!==input.sha256||file.size!==content.length)denied('原初始化与批准导入文件不同');
  importedPaths.add(input.path);
 }
 // initializeTaskCanonical scans the entire original artifact directory. Extra
 // files are pinned by the claimed prepare, and confer no employee read rights.
 let previous=initial;
 for(const [index,commit] of commits.entries()){
  commit.index=index;
  if(!isDeepStrictEqual(commit.record.before,previous.ref)||!isDeepStrictEqual(commit.scope.workspace.baseCanonicalManifest,previous.ref.manifest))denied('原 scope 与实际完整基线不同');
  const plan=planTaskMerge(commit.scope.workspace,commit.result.files,previous.files);
  if(plan.afterRevision!==commit.record.after.revision||!isDeepStrictEqual(manifest(plan.mergedFiles),commit.record.after.manifest)||
   !isDeepStrictEqual(plan.delta.map(entry=>({path:entry.path,sha256:entry.afterSha256})),commit.record.delta))denied('原合并不等于获授权操作的真实 delta');
  previous={ref:commit.record.after,files:plan.mergedFiles};
 }
 const latest=commits.at(-1)!;
 if(!isDeepStrictEqual(run.canonical_workspace,{version:1,...latest.record.after,receipt:latest.receipt}))denied('当前 head 不是准确原 SQL 提交回执');
 return {initial,head,commits,byOperation,scopes};
}

/** Full refs disambiguate no-content-change prepare commits with equal SHA. */
export function recoveryCanonicalAt(chain:TaskRecoveryCommitChain,ref:CanonicalRef):Canonical&{index:number}{
 if(isDeepStrictEqual(ref,chain.initial.ref))return {...chain.initial,index:-1};
 const commit=ref?.mergeId&&chain.byOperation.get(ref.mergeId);
 if(!commit||!isDeepStrictEqual(commit.record.after,ref))return denied('检查点 canonical 不属于完整原提交链');
 // The verified planner already fixed these bytes; use immutable source objects
 // held in that chain rather than the compatibility artifacts directory.
 const files:TaskWorkspaceFile[]=ref.manifest.map(file=>{
  for(let index=commit.index;index>=0;index--){
   const candidate=chain.commits[index].result.files.find((entry:any)=>entry.path===file.path);
   if(candidate&&manifest([candidate])[0].sha256===file.sha256)return candidate;
  }
  const initial=chain.initial.files.find(entry=>entry.path===file.path);
  if(!initial||manifest([initial])[0].sha256!==file.sha256)denied('原 canonical 文件缺少已验证字节');
  return initial;
 });
 return {ref,files,index:commit.index};
}
export function recoveryOwnCommits(chain:TaskRecoveryCommitChain,task:any,throughIndex:number):TaskRecoveryCommit[]{
 return chain.commits.filter(commit=>commit.index<=throughIndex&&isDeepStrictEqual(keyOf(commit.task),keyOf(task)));
}

function nativeBinding(run:any,events:TraceEvent[],task:any,accepted:boolean,historical=false){
 const mappings=new Map<string,string>();
 for(const event of events)if(event.type==='run/task-mapping')for(const binding of event.data.tasks??[])mappings.set(binding.task_id,binding.seed_id);
 let nativeId:string|undefined;for(const [id,approved] of mappings)if(approved===task.task_id)nativeId=id;
 const native=checkpointTasks(events,run.snapshot).get(task.task_id);
 const state=events.findLast(event=>['team/checkpoint','team/snapshot'].includes(event.type))?.data;
 const member=state?.members?.find((item:any)=>item.id===task.session_id);
 const statuses=accepted?(historical?['claimed','in_progress','completed']:['completed']):['claimed','in_progress'];
 if(nativeId!==task.runtime_task_id||!native||native.id!==task.runtime_task_id||native.assignee!==task.principal||native.attemptId!==task.attempt_id||
  !statuses.includes(native.status)||member?.name!==task.principal||member.status==='removed')denied('检查点任务映射、session 或准确分派已变化');
}
function verifyCheckpoint(traceRoot:string,run:any,events:TraceEvent[],checkpointId:string,chain:TaskRecoveryCommitChain,accepted:boolean):TaskRecoveryCheckpointProof{
 const checkpoint=readStepCheckpoint({root:traceRoot,runId:run.id,checkpointId});
 const {id,version,runId,boundary,files,receipts,sha256,seq,at,...refs}=checkpoint;
 if(version!==2||runId!==run.id||!refs.lastMerge)denied('恢复来源需要已提交的 v2 检查点');
 validateTaskCheckpointRefs(refs,{runId:run.id,taskId:refs.key.taskId,attemptId:refs.key.attemptId,archiveDir:join(traceRoot,run.id)});
 const matches=events.filter(event=>event.type==='step/checkpoint'&&event.data?.id===checkpointId),event=matches[0];
 if(matches.length!==1||event.seq!==seq||!isDeepStrictEqual(event.data,{id,version,runId,boundary,files,receipts,...refs,sha256})||
  event.taskId!==refs.key.taskId||event.attemptId!==refs.key.attemptId||event.sessionId!==boundary.sessionId)denied('检查点外层身份与真实档案不同');
 const task=chain.scopes.find(row=>isDeepStrictEqual(keyOf(row),refs.key));
 if(!task||!task.scope||!accepted&&(task.phase!=='active'||chain.scopes.some(row=>row.task_id===task.task_id&&row.generation>task.generation))||
  task.session_id!==boundary.sessionId||boundary.taskId!==task.task_id||boundary.attemptId!==task.attempt_id)denied('检查点不是当前准确任务 generation');
 const boundaryEvent=events.find(event=>event.seq===boundary.eventCursor)!;
 if(!boundaryEvent||boundaryEvent.type!=='step/boundary'||boundaryEvent.seq>=event.seq||boundaryEvent.taskId!==task.task_id||boundaryEvent.attemptId!==task.attempt_id||
  boundaryEvent.sessionId!==task.session_id||boundaryEvent.data.taskId!==task.task_id||boundaryEvent.data.attemptId!==task.attempt_id||boundaryEvent.data.trigger!==boundary.trigger||
  !(accepted?boundary.trigger==='node-accepted':['tool-result','before-tool','cycle-complete'].includes(boundary.trigger)))denied('检查点触发边界不完整或不适用于所选任务');
 const historical={...run,events:events.filter(event=>event.seq<=checkpoint.seq)},current={...run,events};
 nativeBinding(run,historical.events,task,accepted,true);nativeBinding(run,events,task,accepted);
 const assignment:TrustedTaskAssignment={...refs.key,agentId:task.principal,sessionId:task.session_id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash};
 const contract=effectiveTaskContract(historical,assignment),currentContract=effectiveTaskContract(current,assignment);
 const employee=run.snapshot.agents?.find((item:any)=>item.id===task.principal);
 if(!employee)denied('检查点员工不属于批准快照');
 const hashes=taskCapabilityHashes(run.snapshot,employee);
 if(!isDeepStrictEqual(contract,currentContract)||!isDeepStrictEqual(contract,task.contract)||hashes.permissionHash!==task.permission_hash||
  hashes.capabilityHash!==task.capability_hash||refs.capabilityHash!==task.capability_hash||!isDeepStrictEqual(refs.inputOrigins,task.input_origins)||
  boundary.contractHash!==checkpointContract(run.snapshot,contract,refs))denied('检查点合同、能力或固定输入绑定不同');
 const original=chain.byOperation.get(refs.lastMerge.operationId),canonical=recoveryCanonicalAt(chain,refs.canonical),ownCommits=recoveryOwnCommits(chain,task,canonical.index);
 if(!original||!isDeepStrictEqual(keyOf(original.task),refs.key)||!isDeepStrictEqual(original.receipt,refs.lastMerge)||
  ownCommits.at(-1)!==original||!isDeepStrictEqual(manifest(original.result.files),refs.workManifest)||
  !boundary.environment||boundary.environment!==checkpointEnvironment(run.snapshot,original.result.execution,refs))return denied('检查点原提交、历史工作版本或环境不同');
 const expectedQueued={operationId:original.row.id,name:original.row.payload.name,deviceId:original.row.device_id,...original.row.payload.context};
 if(!events.some(item=>item.type==='local/operation-queued'&&item.seq<boundaryEvent.seq&&isDeepStrictEqual(item.data,expectedQueued)))denied('检查点缺少边界前准确原操作排队身份');
 const published=events.filter(item=>item.type==='task/merge-committed'&&(item.data?.operationId===original.row.id||item.data?.mergeId===original.row.id||item.sourceKey==='task-merge:'+original.row.id));
 // SQL COMMIT may outlive a missing journal response; an existing publication
 // must agree, while later idempotent append/replay is not a new task effect.
 if(published.length&&!published.some(item=>item.seq<boundaryEvent.seq&&isDeepStrictEqual(item.data,original.receipt)))denied('检查点已有合并发布缺少边界前准确回执');
 if(boundary.trigger==='tool-result'&&refs.scopeHash!==original.scope.workspace.scopeHash)denied('tool-result scopeHash 不是原操作 scope');
 if(accepted&&!events.some(item=>item.seq>checkpoint.seq&&item.type==='team/checkpoint'&&item.data.tasks?.some((native:any)=>native.id===task.runtime_task_id&&native.status==='completed'&&native.assignee===task.principal&&native.attemptId===task.attempt_id)))denied('验收检查点缺少后续准确 completed 事实');
 // before-tool/boundary scopeHash and inputManifest require the separate pure
 // historical scope reconstruction; this proof alone does not approve recovery.
 return {checkpoint,refs,event,boundaryEvent,task,assignment,contract,original,canonical,ownCommits};
}

/** Strict unfinished selection; node-accepted cannot select an unfinished A. */
export function verifyRecoveryCheckpoint(traceRoot:string,run:any,events:TraceEvent[],checkpointId:string,chain:TaskRecoveryCommitChain):TaskRecoveryCheckpointProof{
 return verifyCheckpoint(traceRoot,run,events,checkpointId,chain,false);
}
/** Shared original binding in the supplied historical prefix. A producer may
 * since be retired; the retained-node caller separately proves current phase,
 * generation, accepted seal, commands/report and candidate input bytes. */
export function verifyRecoveryAcceptedCheckpoint(traceRoot:string,run:any,events:TraceEvent[],checkpointId:string,chain:TaskRecoveryCommitChain):TaskRecoveryCheckpointProof{
 return verifyCheckpoint(traceRoot,run,events,checkpointId,chain,true);
}
