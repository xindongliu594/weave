import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';
import type pg from 'pg';
import type {TrustedTaskCandidate,TrustedTaskAssignment,TaskExecutionScope,TaskInputOrigin,TaskCanonical,TaskCommittedOutput,TaskWorkspacePlanner} from '../../../packages/contracts/index.ts';
import {checkpointContract} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {ancestors} from '../../../services/agent-runtime/checkpoint-context.mjs';
import {AppError} from './provider.ts';
import {assertNoUnresolvedTaskOperation} from './task-operation-admission.ts';
import {assertTaskAcceptedStopAdmission} from './task-accepted-stop-state.ts';
const {createTaskWorkspace,validateTaskExport}=createRequire(import.meta.url)('../../desktop/task-workspace.cjs') as TaskWorkspacePlanner;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const denied=(message:string):never=>{throw new AppError(409,message,'TASK_SCOPE_DENIED');};
const keys=['runId','taskId','attemptId','agentId','sessionId','runtimeTaskId','contractHash'];
function identity(value:any,bound=false){
 if(!value||keys.some(k=>typeof value[k]!=='string'||!value[k].trim())||Object.keys(value).some(k=>![...keys,'generation'].includes(k))||
  !/^[a-f0-9]{64}$/.test(value.contractHash)||(bound&&(!Number.isSafeInteger(value.generation)||value.generation<1)))denied('任务绑定身份不完整');
}
export function taskCapabilityHashes(snapshot:any,employee:any){
 return {permissionHash:hash({employeeId:employee.employeeId,tools:[...employee.tools].sort(),policy:snapshot.policy,knowledge:snapshot.knowledge??null,imports:(snapshot.importedFiles??[]).map((f:any)=>({path:f.path,snapshotId:f.snapshotId,sha256:f.sha256,agentIds:f.agentIds})),resourceRevision:snapshot.resourceRevision??0}),
  capabilityHash:hash({tools:[...employee.tools].sort(),nativeCapabilities:snapshot.nativeCapabilities??null})};
}
export function taskWritePaths(contract:any):string[]{
 const scoped=(path:string,list:string[])=>list.some(p=>path===p||path.startsWith(p.replace(/\/$/,'')+'/'));
 return contract.outputs.filter((output:any)=>scoped(output.path,contract.inScope)&&!scoped(output.path,contract.outOfScope)).map((output:any)=>output.path);
}
/** Read only trusted archive events. In particular, a model-provided contract is never an input. */
export function effectiveTaskContract(run:any,assignment:TrustedTaskCandidate){
 let task=run.snapshot.tasks?.find((t:any)=>t.id===assignment.taskId);
 for(const e of run.events??[])if(e.type==='quality/rework-created'){
  const binding=e.data.bindings?.find((b:any)=>b.task_id===assignment.runtimeTaskId&&b.seed_id===assignment.taskId);
  if(binding)task=e.data.repairContract?.id===assignment.taskId?e.data.repairContract:e.data.reviewContract?.id===assignment.taskId?e.data.reviewContract:undefined;
 }
 if(!task||task.assignee!==assignment.agentId||checkpointContract(run.snapshot,task)!==assignment.contractHash)denied('任务合同或负责人已变化');
 if(!Array.isArray(task.inputs)||!Array.isArray(task.outputs)||!Array.isArray(task.inScope)||!Array.isArray(task.outOfScope))denied('任务缺少完整文件合同');
 // Native repair contracts retain every delivery output while narrowing permission to modify them.
 if(task.kind!=='repair'&&taskWritePaths(task).length!==task.outputs.length)denied('输出超出批准范围');
 return task;
}
export function activeTaskAssignment(run:any,assignment:TrustedTaskCandidate){
 identity(assignment);
 if(run.id!==assignment.runId)denied('任务跨运行');
 const mappings=new Map<string,string>();for(const e of run.events??[])if(e.type==='run/task-mapping')for(const b of e.data.tasks??[])mappings.set(b.task_id,b.seed_id);
 if(mappings.get(assignment.runtimeTaskId)!==assignment.taskId)denied('原生任务映射不属于批准任务');
 const state=run.events?.findLast((e:any)=>e.type==='team/checkpoint')?.data;
 const task=state?.tasks?.find((t:any)=>t.id===assignment.runtimeTaskId);
 if(!state?.members?.some((m:any)=>m.id===assignment.sessionId&&m.name===assignment.agentId&&m.status!=='removed')||
  !task||task.assignee!==assignment.agentId||task.attemptId!==assignment.attemptId||!['claimed','in_progress'].includes(task.status))denied('任务分派已失效');
 const employee=run.snapshot.agents?.find((a:any)=>a.id===assignment.agentId);
 if(!employee)denied('员工未获授权');
 return {employee,contract:effectiveTaskContract(run,assignment)};
}
async function assertLease(db:pg.PoolClient,run:any){
 if(!(await db.query("SELECT id FROM project_runs WHERE id=$1 AND lease_owner=$2 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp()",[run.id,run.lease_owner])).rowCount)denied('任务租约已失效');
}
/** Call inside the existing project -> run transaction locks, only from trusted Host admission. */
export async function bindTrustedAttempt(db:pg.PoolClient,run:any,candidate:TrustedTaskCandidate&{generation?:number}):Promise<TrustedTaskAssignment>{
 const {employee,contract}=activeTaskAssignment(run,candidate);await assertLease(db,run);
 const hashes=taskCapabilityHashes(run.snapshot,employee);
 const rows=(await db.query('SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 ORDER BY generation DESC FOR UPDATE',[run.id,candidate.taskId])).rows;
 const current=rows.find(r=>r.phase==='active');
 await assertTaskAcceptedStopAdmission(db,run.id,{runId:run.id,taskId:candidate.taskId,attemptId:candidate.attemptId,generation:candidate.generation??(current?.attempt_id===candidate.attemptId?current.generation:(rows[0]?.generation??0)+1)});
 if(current&&current.attempt_id===candidate.attemptId&&current.runtime_task_id===candidate.runtimeTaskId&&current.session_id===candidate.sessionId&&current.principal===candidate.agentId&&current.contract_hash===candidate.contractHash&&current.permission_hash===hashes.permissionHash&&current.capability_hash===hashes.capabilityHash){
  if(candidate.generation!==undefined&&candidate.generation!==current.generation)denied('任务 generation 过期');
  return {...candidate,generation:current.generation};
 }
 if(candidate.generation!==undefined)denied('不能由调用方创建 generation');
 if(rows.some(row=>row.phase==='unknown'))denied('任务存在未知工作区，不能创建 generation');
 if(rows.length)await assertNoUnresolvedTaskOperation(db,run.id);
 if(current)await db.query("UPDATE task_attempt_workspaces SET phase='retired' WHERE run_id=$1 AND task_id=$2 AND phase='active'",[run.id,candidate.taskId]);
 const generation=(rows[0]?.generation??0)+1;
 await db.query('INSERT INTO task_attempt_workspaces(run_id,task_id,attempt_id,generation,principal,session_id,runtime_task_id,contract_hash,permission_hash,capability_hash,contract) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[run.id,candidate.taskId,candidate.attemptId,generation,candidate.agentId,candidate.sessionId,candidate.runtimeTaskId,candidate.contractHash,hashes.permissionHash,hashes.capabilityHash,contract]);
 return {...candidate,generation};
}
export function pinnedInputs(run:any,assignment:TrustedTaskAssignment,contract:any,revision:string):TaskInputOrigin[]{
 const employee=run.snapshot.agents.find((a:any)=>a.id===assignment.agentId);
 return contract.inputs.map((input:any)=>{
  const base={path:input.path,runId:run.id,taskId:assignment.taskId,attemptId:assignment.attemptId,acceptedRevision:revision};
  if(input.producerTaskId){
   const accepted=run.events?.findLast((e:any)=>e.type==='handoff/accepted'&&e.data.taskId===input.producerTaskId)?.data;
   // Recovery ancestry is admitted in Task 5; never relabel a foreign checkpoint as this run.
   const output=accepted?.outputs?.find((o:any)=>o.path===input.path);
   const upstream=ancestors(run.snapshot.tasks,contract.id).has(input.producerTaskId)||contract.kind==='repair'&&contract.sourceTaskId===input.producerTaskId;
   if(accepted?.runId!==run.id||!output||!accepted.attemptId||!/^[a-f0-9]{64}$/.test(accepted.workspaceRevision)||!upstream)denied('输入没有本运行已接受的生产者证据');
   if(input.sha256&&input.sha256!==output.sha256)denied('输入 SHA 与已接受版本不同');
   return {path:input.path,sha256:output.sha256,origin:{...base,taskId:accepted.taskId,attemptId:accepted.attemptId,acceptedRevision:accepted.workspaceRevision},source:{kind:'accepted',runId:run.id,taskId:accepted.taskId,attemptId:accepted.attemptId,revision:accepted.workspaceRevision}};
  }
  const imported=run.snapshot.importedFiles?.find((f:any)=>f.path===input.path);
  if(!imported?.snapshotId||!imported.agentIds?.includes(employee.employeeId)||bytesHash(Buffer.from(imported.content,'utf8'))!==imported.sha256||input.sha256&&input.sha256!==imported.sha256)denied('输入没有获授权的原始资料证据');
  return {path:input.path,sha256:imported.sha256,origin:base,source:{kind:'import',snapshotId:imported.snapshotId,sha256:imported.sha256,agentIds:[...imported.agentIds]}};
 });
}
/** Pure reconstruction only; this does not prove SQL provenance, current authority or live admission. */
export function rebuildTaskScope({run,assignment,contract,hashes,canonical,inputs,committedOutputs}:{run:any;assignment:TrustedTaskAssignment;contract:any;hashes:ReturnType<typeof taskCapabilityHashes>;canonical:TaskCanonical;inputs:TaskInputOrigin[];committedOutputs:TaskCommittedOutput[]}):TaskExecutionScope{
 const writePaths=taskWritePaths(contract);
 const origins=new Map(inputs.map(i=>[i.path,i.origin])),expected=new Map(inputs.map(i=>[i.path,i.sha256]));
 const key={runId:run.id,taskId:assignment.taskId,attemptId:assignment.attemptId,generation:assignment.generation};
 const operations=new Set<string>();
 for(const commit of committedOutputs){
  const r=commit.receipt,s=commit.scope;
  const binding=s?.workspace?.binding;
  if(!s||s.profile!=='task-attempt-openshell-v1'||!isDeepStrictEqual(s.key,key)||s.capabilityHash!==hashes.capabilityHash||!isDeepStrictEqual(s.inputOrigins,inputs)||
   r.profile!=='task-attempt-openshell-v1'||!isDeepStrictEqual(r.key,key)||r.scopeHash!==s.workspace.scopeHash||r.beforeWorkRevision!==s.workRevision||s.workRevision!==s.workspace.baseCanonicalRevision||!r.operationId||!/^[a-f0-9]{64}$/.test(r.afterWorkRevision)||
   operations.has(r.operationId)||!binding||binding.runId!==run.id||binding.taskId!==assignment.taskId||binding.attemptId!==assignment.attemptId||binding.generation!==assignment.generation||binding.assigneeId!==assignment.agentId||binding.projectId!==run.project_id||binding.planVersion!==run.project_version||
   s.workspace.binding.contractHash!==assignment.contractHash||s.workspace.binding.permissionHash!==hashes.permissionHash||!isDeepStrictEqual([...s.workspace.writePaths].sort(),[...writePaths].sort())||
   !isDeepStrictEqual([...s.workspace.readPaths].sort(),[...expected.keys()].sort())||s.workspace.inputManifest.some(i=>i.sha256!==expected.get(i.path)))denied('任务提交链失效');
  validateTaskExport(s.workspace,s.workspace.importedFiles);
  operations.add(r.operationId);
  for(const output of commit.files){
   if(!writePaths.includes(output.path))denied('提交输出超出任务合同');
   expected.set(output.path,output.sha256);origins.set(output.path,{path:output.path,runId:run.id,taskId:assignment.taskId,attemptId:assignment.attemptId,acceptedRevision:r.afterWorkRevision});
  }
 }
 for(const [path,sha] of expected){const file=canonical.files.find(f=>f.path===path);if(!file||bytesHash(Buffer.from(file.content,'base64'))!==sha)denied('固定输入或本任务提交输出已变化');}
 const backend=run.snapshot.executionTarget?.backend;if(run.snapshot.executionTarget?.kind!=='local'||backend?.kind!=='openshell')denied('任务要求本机 OpenShell');
 const workspace=createTaskWorkspace({binding:{projectId:run.project_id,planVersion:run.project_version,runId:run.id,taskId:assignment.taskId,attemptId:assignment.attemptId,assigneeId:assignment.agentId,generation:assignment.generation,contractHash:assignment.contractHash,permissionHash:hashes.permissionHash,backend:{kind:'openshell',version:backend.version,image:backend.image,policyHash:backend.policySha256}},readPaths:[...expected.keys()],writePaths,canonicalFiles:canonical.files,origins:[...origins.values()]});
 if(workspace.baseCanonicalRevision!==canonical.revision)denied('可信工作版本与完整 manifest 不符');
 return {profile:'task-attempt-openshell-v1',key,workspace,workRevision:canonical.revision,capabilityHash:hashes.capabilityHash,inputOrigins:inputs};
}
export async function resolveTaskScope(db:pg.PoolClient,run:any,assignment:TrustedTaskAssignment,canonical:TaskCanonical,previous:TaskExecutionScope|null):Promise<TaskExecutionScope>{
 identity(assignment,true);const {employee,contract}=activeTaskAssignment(run,assignment);await assertLease(db,run);
 await assertTaskAcceptedStopAdmission(db,run.id,{runId:run.id,taskId:assignment.taskId,attemptId:assignment.attemptId,generation:assignment.generation});
 if(run.snapshot.recovery||run.snapshot.handoffCheckpoints?.length)throw new AppError(422,'任务沙箱恢复尚未接通可信 canonical 与检查点来源，请保留原恢复记录','TASK_RECOVERY_UNAVAILABLE');
 const row=(await db.query("SELECT * FROM task_attempt_workspaces WHERE run_id=$1 AND task_id=$2 AND attempt_id=$3 AND generation=$4 AND phase='active' FOR UPDATE",[run.id,assignment.taskId,assignment.attemptId,assignment.generation])).rows[0];
 const hashes=taskCapabilityHashes(run.snapshot,employee);
 if(!row||row.principal!==assignment.agentId||row.session_id!==assignment.sessionId||row.runtime_task_id!==assignment.runtimeTaskId||row.contract_hash!==assignment.contractHash||row.permission_hash!==hashes.permissionHash||row.capability_hash!==hashes.capabilityHash||!isDeepStrictEqual(row.contract,contract))denied('任务未绑定或授权已变化');
 if(previous&&!isDeepStrictEqual(row.scope,previous))denied('操作 scope 已过期');
 const inputs:TaskInputOrigin[]=row.scope?row.input_origins:pinnedInputs(run,assignment,contract,canonical.revision);
 const scope=rebuildTaskScope({run,assignment,contract,hashes,canonical,inputs,committedOutputs:row.committed_outputs});
 await db.query('UPDATE task_attempt_workspaces SET scope=$1,input_origins=$2::jsonb,work_revision=$3 WHERE run_id=$4 AND task_id=$5 AND attempt_id=$6 AND generation=$7',[scope,JSON.stringify(inputs),canonical.revision,run.id,assignment.taskId,assignment.attemptId,assignment.generation]);
 return scope;
}
