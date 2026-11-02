import {createRequire} from 'node:module';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {TaskAttemptKey,TaskCanonical,TaskCommittedOutput,TaskExecutionScope,TaskWorkspaceFile,TaskWorkspaceManifestEntry,TaskWorkspacePlanner} from '../../../packages/contracts/index.ts';
import {assertAcceptanceChecks,observeAcceptanceChecks} from '../../../services/agent-runtime/acceptance-checks.mjs';
import {commandEvidence} from '../../../services/agent-runtime/run-evidence.mjs';
import {validateCheckpointReceipts} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {assertHandoffReport} from '../../../packages/contracts/handoff-report.mjs';
import {effectiveTaskContract,pinnedInputs,rebuildTaskScope,taskCapabilityHashes} from './task-execution.ts';
import {acceptedVerificationRevision,completedTasks,resumeHandoff} from './handoff-checkpoints.ts';
import {recoveryOwnCommits,verifyRecoveryAcceptedCheckpoint} from './task-recovery-provenance.ts';
import type {TaskRecoveryCommit,TaskRecoveryCommitChain,TaskRecoveryCheckpointProof} from './task-recovery-provenance.ts';
import {AppError} from './provider.ts';

const {manifest,revision}=createRequire(import.meta.url)('../../desktop/local-executor.cjs');
const {planTaskMerge}=createRequire(import.meta.url)('../../desktop/task-workspace.cjs') as TaskWorkspacePlanner;
const denied=(message:string):never=>{throw new AppError(409,message,'TASK_RECOVERY_SCOPE_INVALID');};
const keyOf=(task:any):TaskAttemptKey=>({runId:task.run_id,taskId:task.task_id,attemptId:task.attempt_id,generation:task.generation});
const assignmentOf=(task:any)=>({...keyOf(task),agentId:task.principal,sessionId:task.session_id,runtimeTaskId:task.runtime_task_id,contractHash:task.contract_hash});
const ownOutputs=(task:any,commits:TaskRecoveryCommit[]):TaskCommittedOutput[]=>commits.map(commit=>{
 const matches=task.committed_outputs.filter((entry:any)=>entry.receipt.operationId===commit.row.id);
 if(matches.length!==1)denied('历史任务提交没有唯一 own-output');
 return matches[0];
});

/** Pure reconstruction of previously proven facts. It does not authenticate SQL,
 * acquire a source fence, grant authority or invoke the live scope resolver. */
export function reconstructHistoricalTaskScope({run,task,canonical,committedOutputs}:{run:any;task:any;canonical:TaskCanonical;committedOutputs:TaskCommittedOutput[]}):TaskExecutionScope{
 const assignment=assignmentOf(task),employee=run.snapshot.agents?.find((item:any)=>item.id===task.principal);
 if(task.run_id!==run.id||!employee||!Array.isArray(task.input_origins)||!Array.isArray(committedOutputs))denied('历史任务身份或固定输入不完整');
 const contract=effectiveTaskContract(run,assignment),hashes=taskCapabilityHashes(run.snapshot,employee);
 if(!isDeepStrictEqual(contract,task.contract)||hashes.permissionHash!==task.permission_hash||hashes.capabilityHash!==task.capability_hash)denied('历史任务合同或权限已变化');
 return rebuildTaskScope({run,assignment,contract,hashes,canonical,inputs:task.input_origins,committedOutputs});
}

function checkpointScope(run:any,events:any[],proof:TaskRecoveryCheckpointProof){
 const {task,refs,canonical,ownCommits,original}=proof;
 const scope=reconstructHistoricalTaskScope({run:{...run,events:events.filter(event=>event.seq<=proof.event.seq)},task,canonical:{revision:canonical.ref.revision,files:canonical.files},committedOutputs:ownOutputs(task,ownCommits)});
 if(!isDeepStrictEqual(scope.inputOrigins,refs.inputOrigins)||!isDeepStrictEqual(scope.workspace.inputManifest,refs.inputManifest)||
  !isDeepStrictEqual(manifest(scope.workspace.importedFiles),refs.workManifest)||scope.capabilityHash!==refs.capabilityHash)denied('历史检查点固定输入或工作文件与原提交不同');
 if(proof.checkpoint.boundary.trigger==='tool-result'){
  if(refs.scopeHash!==original.scope.workspace.scopeHash||!isDeepStrictEqual(manifest(original.result.files),refs.workManifest))denied('tool-result 检查点不是原操作 scope 与结果');
  return original.scope;
 }
 if(refs.scopeHash!==scope.workspace.scopeHash)denied('历史边界 scopeHash 与当时完整 canonical 不同');
 return scope;
}

type Retained={key:TaskAttemptKey;accepted:any;checkpoint:any};
type RecoveryScopeOptions={traceRoot:string;run:any;events:any[];chain:TaskRecoveryCommitChain;selected:TaskRecoveryCheckpointProof};

/** Internal fact composition only. The SQL collector owns locking, fence and
 * current authorization; no JSON flag or callback can replace those checks. */
export function verifyRecoveryScope({traceRoot,run,events,chain,selected}:RecoveryScopeOptions){
 const view={...run,events},task=selected.task;
 const acceptedCache=new Map<number,{proof:TaskRecoveryCheckpointProof;accepted:any}>(),visiting=new Set<number>();

 function fixedInputs(subject:any,contextEvents:any[]){
  const first=recoveryOwnCommits(chain,subject,chain.commits.length-1)[0];
  if(!first||first.row.payload.name!=='prepare')return denied('固定输入缺少真实首次 prepare');
  const queued=contextEvents.filter(event=>event.type==='local/operation-queued'&&event.data.operationId===first.row.id);
  const event=queued[0],assignment=assignmentOf(subject);
  if(queued.length!==1||event.data.name!==first.row.payload.name||event.data.deviceId!==first.row.device_id||
   ['agentId','sessionId','taskId','attemptId','generation'].some(key=>event.data[key]!==first.row.payload.context[key]))return denied('固定输入缺少准确首次操作历史边界');
  const prefix=contextEvents.filter(item=>item.seq<event.seq),historical={...run,events:prefix},contract=effectiveTaskContract(historical,assignment);
  const pinned=pinnedInputs(historical,assignment,contract,first.scope.workRevision);
  if(!isDeepStrictEqual(pinned,subject.input_origins)||!isDeepStrictEqual(pinned,first.scope.inputOrigins))return denied('历史固定输入与原 SQL origins 不同');
  for(const input of pinned){
   if(input.source.kind!=='accepted')continue;
   const source=input.source,rows=chain.scopes.filter(row=>row.run_id===source.runId&&row.task_id===source.taskId&&row.attempt_id===source.attemptId);
   if(rows.length!==1)return denied('输入来源缺少唯一准确 producer generation');
   const candidates=prefix.filter(item=>item.type==='handoff/accepted'&&item.data.runId===source.runId&&item.data.taskId===source.taskId&&item.data.attemptId===source.attemptId&&item.data.workspaceRevision===source.revision);
   const producer=candidates[0];
   if(candidates.length!==1||!isDeepStrictEqual(producer.data.taskExecution?.key,keyOf(rows[0])))return denied('输入来源缺少唯一准确 producer accepted');
   const checked=acceptedEvidence(producer,prefix);
   const output=checked.accepted.outputs.find((entry:any)=>entry.path===input.path);
   if(!output||output.sha256!==input.sha256)return denied('输入来源与 producer 原验收输出不同');
  }
  return pinned;
 }

 function acceptedEvidence(event:any,contextEvents:any[]):{proof:TaskRecoveryCheckpointProof;accepted:any}{
  const cached=acceptedCache.get(event.seq);if(cached)return cached;
  if(visiting.has(event.seq))return denied('输入验收依赖循环');visiting.add(event.seq);
  const accepted=event.data,key=accepted.taskExecution?.key;
  const checkpoints=contextEvents.filter(item=>item.type==='step/checkpoint'&&item.seq>event.seq&&item.data.boundary?.trigger==='node-accepted'&&isDeepStrictEqual(item.data.key,key));
  // A later re-acceptance cannot lend its checkpoint to this historical seal.
  const nextAccepted=contextEvents.find(item=>item.seq>event.seq&&item.type==='handoff/accepted'&&isDeepStrictEqual(item.data.taskExecution?.key,key));
  const candidates=checkpoints.filter(item=>!nextAccepted||item.seq<nextAccepted.seq);
  if(candidates.length!==1)return denied('原验收缺少唯一 node-accepted 检查点');
  const proof=verifyRecoveryAcceptedCheckpoint(traceRoot,run,contextEvents,candidates[0].data.id,chain),{refs,contract}=proof;
  if(!isDeepStrictEqual(key,keyOf(proof.task))||accepted.runId!==run.id||accepted.taskId!==key.taskId||accepted.attemptId!==key.attemptId||
   !(event.seq<proof.boundaryEvent.seq&&proof.boundaryEvent.seq<proof.event.seq)||accepted.taskExecution.capabilityHash!==refs.capabilityHash||
   accepted.workspaceRevision!==refs.canonical.revision||accepted.sandboxWorkRevision!==revision(proof.original.result.files))return denied('原验收与准确任务检查点不同');
  checkpointScope(run,contextEvents,proof);
  const checkedRevision=acceptedVerificationRevision({...run.snapshot,id:run.id},accepted,key.taskId,key.attemptId);
  if(!isDeepStrictEqual(proof.checkpoint.receipts,accepted.commands))return denied('原验收命令与检查点收据不同');
  try{validateCheckpointReceipts(new Map([[run.id,{...run,events:contextEvents}]]),proof.checkpoint);}catch{return denied('原命令收据缺少准确宿主观察');}
  for(const command of accepted.commands){
   const original=chain.byOperation.get(command.mergeId),observed=contextEvents.find(item=>item.seq===command.observationSeq&&item.type==='handoff/command-observed');
   if(!original||!['terminal','terminal_test'].includes(original.row.payload.name)||original.index>proof.original.index||
    !isDeepStrictEqual(original.scope.key,key)||original.row.payload.arguments.command!==command.command||original.result.exitCode!==command.exitCode||
    !isDeepStrictEqual(original.result.taskExecution,command.taskExecution)||command.scopeHash!==original.scope.workspace.scopeHash||
    command.canonicalRevision!==original.receipt.afterRevision||command.workspaceRevision!==original.result.workspaceRevision||command.inheritedFrom||
    !original.row.approval_id||original.row.payload.approvalId!==original.row.approval_id||original.row.payload.context.approvalId!==original.row.approval_id||
    !observed||observed.seq>=event.seq)return denied('原命令收据缺少准确已批准 SQL terminal 提交');
   const {observationSeq,...observation}=command;
   if(!isDeepStrictEqual(observed.data,{taskId:key.taskId,attemptId:key.attemptId,...observation}))return denied('原命令收据与宿主观察事件不同');
   const expected=commandEvidence({archive:{dir:join(traceRoot,run.id),id:run.id},name:original.row.payload.name,taskId:key.taskId,attemptId:key.attemptId,args:original.row.payload.arguments,result:original.result,context:original.row.payload.context});
   const {observedAt:computedAt,...computed}=expected,{observedAt,...evidence}=command.evidence??{};
   if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||expected.operation.status!=='available'||
    expected.operation.finishedSeq>=observed.seq||!isDeepStrictEqual(computed,evidence))return denied('原命令审批、输出摘要或操作观察链不同');
   if(contract.acceptanceChecks!==undefined&&!isDeepStrictEqual(observeAcceptanceChecks(contract,command.command,original.result),command.acceptanceChecks))return denied('原命令逐项检查与实际 SQL 结果不同');
  }
  for(const command of contract.verify??[]){
   const actual=accepted.commands.findLast((entry:any)=>entry.command===command),expected=contract.acceptanceChecks?.find((entry:any)=>entry.command===command)?.expectedExitCode??0;
   if(!actual||actual.exitCode!==expected||actual.workspaceRevision!==checkedRevision)return denied('原验收缺少准确通过命令');
  }
  if(contract.acceptanceChecks!==undefined&&!isDeepStrictEqual(assertAcceptanceChecks(contract,accepted.commands,checkedRevision),accepted.acceptanceChecks))return denied('原验收逐项检查已变化');
  assertHandoffReport(contract,accepted.employeeReport);
  if(!Array.isArray(accepted.outputs)||!isDeepStrictEqual(accepted.outputs.map((entry:any)=>entry.path).sort(),contract.outputs.map((entry:any)=>entry.path).sort()))return denied('原验收输出合同不完整');
  for(const output of accepted.outputs){const file=refs.workManifest.find(entry=>entry.path===output.path);if(!file||file.sha256!==output.sha256||file.size!==output.size)return denied('原验收输出对象不符');}
  const inputs=fixedInputs(proof.task,contextEvents.filter(item=>item.seq<event.seq));
  if(!Array.isArray(accepted.inputs)||accepted.inputs.length!==inputs.length)return denied('原验收固定输入数量不同');
  for(const input of inputs){
   const actual=accepted.inputs.find((entry:any)=>entry.path===input.path),source=refs.inputManifest.find(entry=>entry.path===input.path);
   if(!actual||!source||actual.sha256!==input.sha256||actual.size!==source.size)return denied('原验收固定输入对象不符');
  }
  const checked={proof,accepted};visiting.delete(event.seq);acceptedCache.set(event.seq,checked);return checked;
 }

 fixedInputs(task,events.filter(event=>event.seq<=selected.event.seq));
 const historicalScope=checkpointScope(run,events,selected);
 const currentScope=reconstructHistoricalTaskScope({run:view,task,canonical:{revision:chain.head.ref.revision,files:chain.head.files},committedOutputs:ownOutputs(task,recoveryOwnCommits(chain,task,chain.commits.length-1))});
 const workPaths=currentScope.workspace.importedFiles.map(entry=>entry.path),oldPaths=selected.refs.workManifest.map(entry=>entry.path);
 if(!isDeepStrictEqual(workPaths,oldPaths))denied('A 历史与当前工作区路径集合不同');
 const cpFiles:TaskWorkspaceFile[]=oldPaths.map(path=>{
  const file=selected.canonical.files.find(entry=>entry.path===path);if(!file)return denied('历史工作区路径缺少已验证字节');return file;
 });
 const currentManifest=manifest(currentScope.workspace.importedFiles) as TaskWorkspaceManifestEntry[];
 for(const entry of currentManifest)if(!currentScope.workspace.writePaths.includes(entry.path)&&!isDeepStrictEqual(entry,selected.refs.workManifest.find(file=>file.path===entry.path)))denied('A 只读固定输入发生变化');
 const planned=planTaskMerge(currentScope.workspace,cpFiles,chain.head.files),candidateManifest=manifest(planned.mergedFiles) as TaskWorkspaceManifestEntry[];
 for(const entry of planned.delta)if(entry.beforeSha256===null||!currentScope.workspace.writePaths.includes(entry.path))denied('回退仅允许获准同路径内容变化');
 const changed=new Set(planned.delta.map(entry=>entry.path));
 for(const before of chain.head.ref.manifest)if(!changed.has(before.path)&&!isDeepStrictEqual(before,candidateManifest.find(entry=>entry.path===before.path)))denied('候选改变了 A delta 以外的文件');
 const done=completedTasks(events,run.snapshot);
 if(done.has(task.task_id))denied('所选 A 已完成');
 const records=resumeHandoff({...run.snapshot,id:run.id},events,done,join(traceRoot,run.id,'artifacts'),candidateManifest),retained:Retained[]=[];
 for(const accepted of records){
  const key=accepted.taskExecution?.key,row=chain.scopes.find(item=>isDeepStrictEqual(keyOf(item),key));
  if(!row||row.phase!=='active'||chain.scopes.some(item=>item.task_id===row.task_id&&item.generation>row.generation))denied('保留验收不是当前准确任务 generation');
  const matches=events.filter(event=>event.type==='handoff/accepted'&&isDeepStrictEqual(event.data,accepted));
  if(matches.length!==1)denied('保留验收缺少唯一原事件');
  const checked=acceptedEvidence(matches[0],events),latest=recoveryOwnCommits(chain,row,chain.commits.length-1).at(-1);
  if(latest!==checked.proof.original)denied('保留验收之后存在更新任务提交');
  for(const input of accepted.inputs){const actual=candidateManifest.find(entry=>entry.path===input.path);if(!actual||actual.sha256!==input.sha256||actual.size!==input.size)denied('保留任务固定输入依赖被回退版本');}
  retained.push({key,accepted,checkpoint:checked.proof.checkpoint});
 }
 return {historicalScope,currentScope,candidate:{files:planned.mergedFiles,manifest:candidateManifest,revision:planned.afterRevision,delta:planned.delta},retained};
}
