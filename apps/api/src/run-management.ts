import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import type pg from 'pg';
import {lockedRun} from './run-state.ts';
import {assertRunAuthorization} from './execution-policy.ts';
import {hasUnplannedTasks,planningRequiredMessage} from '../../../packages/contracts/index.ts';
import { Router } from 'express';
import { z } from 'zod';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { queryKnowledge } from './knowledge-store.ts';
import { requireProjectCostReady,projectCostCarryover,lockCostPolicy,checkDailyBudget,shareCostMaintenance } from './cost-control.ts';
import { budgetHistory } from './budget-history.ts';
import { assertRunModels } from './model-capabilities.ts';
import { resumeHandoff, completedTasks, checkpointTasks } from './handoff-checkpoints.ts';
import { buildCheckpointContext } from '../../../services/agent-runtime/checkpoint-context.mjs';
import { unresolvedOperations } from '../../../services/agent-runtime/recovery.mjs';
import { readRun, openRunArchive } from '../../../services/agent-runtime/trace-store.mjs';
import { listArtifacts, artifactFile, command, SANDBOX_IMAGE, RunSandbox } from '../../../services/agent-runtime/sandbox.mjs';
import { inspectRecoveryConditions, recoveryProjectBudgetIssues, recoveryHistoryBudgetIssues, assertRecoveryBudgetIssues } from './recovery-conditions.ts';
import { assertGoalRecovery } from './goal-recovery.ts';
import { approvedRecoveryResources, recoveryMinimumProjectBudget, recoveryCallRequirementVersion } from './recovery-resource-plan.ts';
import { recoveryResourceRouter } from './recovery-resource-router.ts';
import {selectStepCheckpoint,stepCheckpointError} from './step-checkpoint-recovery.ts';
import {sourceBudgetEvidence} from '../../../services/agent-runtime/run-evidence.mjs';
import {readLiveCanonical} from './live-canonical-reader.ts';
import {httpPrincipal,administrative,requireRunRoute,assertRunArchiveBinding,lockProjectAuthority,lockDepartmentAuthority,lockActiveDepartments,routeAudit} from './project-route-access.ts';
import {resolveRunDepartments} from './resource-authorization.ts';
import {auditActor,type AuditInput} from './audit-events.ts';
import {appendBusinessAudit,recordDeniedAudit} from './human-audit.ts';
import {projectAuditOutbox} from './audit-outbox.ts';
import {readRunBounds} from './source-bounds.ts';
import {requireResolvedProjectEffectsIn} from './tool-operations.ts';
import {assertCurrentRunAuthority,recordRunAuthorityDenial} from './run-current-authority.ts';
import {captureTaskRecoverySourceIn,withTaskRecoveryCreationTransaction} from './task-recovery-source.ts';
import {readStepCheckpoint} from '../../../services/agent-runtime/step-checkpoints.mjs';

/** Pure context assembly after source capture; this function grants no authority. */
export function buildTaskRecoveryChildContext(run:{id:string;snapshot:any;events:any[]},facts:Awaited<ReturnType<typeof captureTaskRecoverySourceIn>>,traceRoot:string){
 const states=completedTasks(run.events,run.snapshot),done=new Map<string,any>();
 for(const retained of facts.scope.retained){
  const id=retained.key.taskId,state=states.get(id);
  if(done.has(id)||!state||(state.attemptId??state.attempt_id)!==retained.key.attemptId)throw new AppError(409,'保留验收与原生完成任务身份不一致','TASK_RECOVERY_SOURCE_INVALID');
  done.set(id,state);
 }
 const handoffCheckpoints=facts.scope.retained.map(item=>item.accepted),prefix=run.events.filter(event=>event.seq<=facts.selected.event.seq);
 const recovery=buildCheckpointContext({...run.snapshot,handoffCheckpoints},prefix,checkpointTasks(prefix,run.snapshot),done,join(traceRoot,run.id,'artifacts'),run.id,facts.scope.candidate.manifest);
 recovery.workspaceCheckpoint={id:facts.source.sourceCheckpoint.id,runId:run.id,sha256:facts.source.sourceCheckpoint.sha256};
 recovery.budgetEvidence=sourceBudgetEvidence(run.snapshot,run.events,run.id);
 return {handoffCheckpoints,completedCheckpoints:[...done.keys()],recovery};
}
export function runManagementRouter(traceRoot:string,writers:ArchiveWriterManager){
 if(!writers||writers.traceRoot!==traceRoot)throw Error('ARCHIVE_WRITER_CONFIG_REQUIRED');
 const router=Router();
 const authorizedArchive=async(id:string,res:import('express').Response)=>{
  const principal=httpPrincipal(res);await requireRunRoute(pool,principal,id,'viewer');
  const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0],archive=readRun(traceRoot,id);
  assertRunArchiveBinding(principal,row,archive);return {row,archive:archive!};
 };
 router.use(recoveryResourceRouter(traceRoot));
 router.get('/approvals',async(req,res)=>res.json((await pool.query('SELECT id,run_id AS "runId",agent_id AS "agentId",tool,arguments,status,created_at AS "createdAt" FROM tool_approvals WHERE ($1::text IS NULL OR run_id=$1) ORDER BY created_at DESC LIMIT 200',[req.query.runId??null])).rows));
 router.post('/approvals/:id',async(req,res)=>{
  const input=z.object({decision:z.enum(['approved','denied'])}).strict().parse(req.body),id=z.uuid().parse(req.params.id),principal=httpPrincipal(res);
  const requestId=randomUUID(),eventId=randomUUID(),policyVersion='human-approval-v1';
  const identity=(await pool.query('SELECT a.run_id,r.project_id FROM tool_approvals a JOIN project_runs r ON r.id=a.run_id WHERE a.id=$1',[id])).rows[0];
  if(!identity)throw new AppError(404,'资源不存在或不可访问','RESOURCE_NOT_FOUND');
  let commitStarted=false,failure:unknown;
  try{
   const outcome=await writers.withWriter([identity.run_id],async()=>{
    const client=await pool.connect();let discard=false,transactionError:unknown;
    try{
   await client.query('BEGIN');
   const project=(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const run=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[identity.run_id])).rows[0];
   const approval=(await client.query('SELECT * FROM tool_approvals WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!project||!run||!approval||run.project_id!==project.id||approval.run_id!==run.id)throw new AppError(409,'审批来源已变化');
   const departments=await resolveRunDepartments(client,run.id);
   const authority={...await lockDepartmentAuthority(client,principal,departments??[],'operator',true),policyVersion,approvalId:id};
   await lockActiveDepartments(client,authority.departmentIds);
   await requireRunRoute(client,principal,run.id,'operator',true);
   if(run.status!=='running'||run.cancel_requested||approval.status!=='pending')throw new AppError(409,'审批已处理或运行已停止');
   await appendBusinessAudit(client,{eventId,action:'tool.approval',actor:auditActor(principal),authority,
    correlation:{correlationId:requestId,requestId,projectId:project.id,runId:run.id,approvalId:id},resource:{type:'tool_operation',id,departmentIds:authority.departmentIds},
    outcome:'success',changes:{decision:input.decision,policyVersion}});
   await client.query(`UPDATE tool_approvals SET status=$1,decided_at=now(),decided_by_user_id=$2,decided_epoch=$3,
     decision_actor_kind=$4,decision_request_id=$5,decision_reason=$6,decision_audit_id=$7 WHERE id=$8`,
    [input.decision,principal.kind==='human'?principal.userId:null,principal.kind==='human'?principal.sessionEpoch:null,principal.kind,requestId,input.decision+'-by-current-authority',eventId,id]);
   commitStarted=true;await client.query('COMMIT');
    }catch(error){transactionError=error;discard=commitStarted;try{await client.query('ROLLBACK');}catch{discard=true;}}
    finally{try{client.release(discard);}catch(error){discard=true;transactionError??=error;}}
    // Only a confirmed rollback may leave the writer scope normally. Unknown persistence retains its failure latch.
    if(transactionError&&discard)throw transactionError;
    return {error:transactionError};
   });failure=outcome.error;
  }catch(error){failure=error;}
  if(failure){
   const denied=failure instanceof AppError&&failure.status>=400&&failure.status<500;
   const event:AuditInput={eventId:randomUUID(),action:'tool.approval',actor:auditActor(principal),
    correlation:{correlationId:requestId,requestId,projectId:identity.project_id,runId:identity.run_id,approvalId:id},resource:{type:'tool_operation',id,departmentIds:[]},
    outcome:commitStarted?'unknown':denied?'denied':'failure',reasonCode:commitStarted?'result-unknown':denied?'forbidden':'storage-unavailable',changes:{decision:input.decision,policyVersion}};
   try{await recordDeniedAudit(pool,event);}catch{/* Preserve the original denial/failure even if independent audit storage is unavailable. */}
   throw failure;
  }
  // The coordinator polls this committed DB decision. Projection never acquires an active archive writer.
  try{await projectAuditOutbox(pool,{limit:20,now:new Date()});}catch{/* Durable outbox remains retryable; do not report a committed approval as failed. */}
  res.json({ok:true});
 });
 router.get('/runs/:id/artifacts',async(req,res)=>{const id=z.uuid().parse(req.params.id),{row,archive}=await authorizedArchive(id,res),canonical=await readLiveCanonical(pool,traceRoot,row,archive);res.json(canonical?canonical.ref.manifest:listArtifacts(join(traceRoot,id,'artifacts')));});
 router.get('/runs/:id/artifact',async(req,res)=>{const id=z.uuid().parse(req.params.id),path=z.string().parse(req.query.path),{row,archive}=await authorizedArchive(id,res),canonical=await readLiveCanonical(pool,traceRoot,row,archive);let file:string|undefined,bytes:Buffer|undefined;
  if(canonical){const found=canonical.files.find(file=>file.path===path);if(!found)throw new AppError(404,'交付物不存在或路径不允许');bytes=Buffer.from(found.content,'base64');}
  else try{file=artifactFile(join(traceRoot,id,'artifacts'),path);}catch{throw new AppError(404,'交付物不存在或路径不允许');}
  res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream');res.attachment(path.split('/').at(-1));if(bytes)res.send(bytes);else res.sendFile(file!,{dotfiles:'allow'});
 });
 router.get('/runs/:id/export',async(req,res)=>{const {archive:run}=await authorizedArchive(z.uuid().parse(req.params.id),res);res.attachment('run-'+run.id+'.json').json(run);});
 router.get('/runs/:id/citations/:chunkId',async(req,res)=>{
  const {archive:run}=await authorizedArchive(z.uuid().parse(req.params.id),res);
  if(run.integrity!=='ok')throw new AppError(409,'运行档案不完整，无法核对引用');
  const chunkId=z.string().min(1).max(200).parse(req.params.chunkId);
  const event=run.events.find(e=>e.type==='knowledge/citation'&&e.data.sources?.some((c:any)=>c.chunkId===chunkId));
  if(!event)throw new AppError(404,'此切片不在该运行的引用记录中');
  const expected=event.data.sources.find((c:any)=>c.chunkId===chunkId);
  const chunk=await queryKnowledge(run.snapshot.knowledge,event.data.agentId,'read',chunkId);
  if(!chunk||chunk.documentId!==expected.documentId||chunk.version!==expected.version||chunk.sha256!==expected.sha256)
   throw new AppError(409,'知识引用与运行快照不一致');
  res.json(chunk);
 });
 router.get('/runs/:id/recovery-check',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),booleanQuery=z.enum(['true','false']).default('false').transform(value=>value==='true');
  const choices={retainUncertainCosts:booleanQuery.parse(req.query.retainUncertainCosts),acknowledgeUnknownOperations:booleanQuery.parse(req.query.acknowledgeUnknownOperations),...(req.query.checkpointId?{checkpointId:z.uuid().parse(req.query.checkpointId)}:{})};
  const client=await pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await requireRunRoute(client,httpPrincipal(res),id,'viewer');
   const result=await inspectRecoveryConditions(client,traceRoot,id,choices);
   await client.query('COMMIT');res.setHeader('Cache-Control','no-store');res.json(result);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 });
 router.post('/runs/:id/retry',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),input=z.object({resume:z.boolean().default(true),acknowledgeUnknownOperations:z.boolean().default(false),retainUncertainCosts:z.boolean().default(false),
    checkpointId:z.uuid().optional(),budgetPreviewId:z.uuid().optional(),confirmation:z.literal('APPROVE_RESOURCES_AND_RESUME').optional()}).parse(req.body);
  if(input.checkpointId&&(!input.resume||input.budgetPreviewId))throw new AppError(409,'步骤恢复须沿用原方案与资源；请先核对预算，再选择恢复点','CHECKPOINT_RESUME_ONLY');
  if(input.budgetPreviewId&&input.confirmation!=='APPROVE_RESOURCES_AND_RESUME')throw new AppError(400,'请明确确认资源额度与续跑','RESOURCE_CONFIRMATION_REQUIRED');
  if(input.budgetPreviewId&&!input.resume)throw new AppError(409,'资源补充只允许续跑未完成节点','RESOURCE_RESUME_ONLY');
  const newId=randomUUID();
  // This lookup chooses the native fence only. Every source fact is re-read
  // under that fence and the authoritative transaction before admission.
  const taskMode=!!input.checkpointId&&(await pool.query("SELECT snapshot->>'executionProfile' AS execution_profile FROM project_runs WHERE id=$1",[id])).rows[0]?.execution_profile==='task-attempt-openshell-v1';
  const process=async(client:pg.PoolClient)=>{
   const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[id])).rows[0];if(!identity)throw new AppError(404,'运行不存在');
   const project=(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
   const old=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw new AppError(404,'运行不存在');
   const taskProfile=old.snapshot.executionProfile==='task-attempt-openshell-v1';
   if(taskProfile&&(!input.resume||!input.checkpointId||input.budgetPreviewId))throw new AppError(409,'任务恢复必须选定原始任务检查点并沿用原资源','CHECKPOINT_RESUME_ONLY');
   if(taskProfile!==taskMode)throw new AppError(409,'运行执行方式已变化，请重新核对恢复点','RUN_REAPPROVAL_REQUIRED');
   if(taskMode&&(old.parent_run_id!==null||old.snapshot.recovery||old.snapshot.resumedFrom||old.snapshot.handoffCheckpoints?.length))throw new AppError(409,'任务恢复仅支持原始停止运行','TASK_RECOVERY_SOURCE_INVALID');
   const principal=httpPrincipal(res);
   // Recovery checks two people. Lock their rows in one order before either
   // person's memberships, then recheck original authority in this transaction.
   const actors=[...new Set([old.authorized_by_user_id,principal.kind==='human'?principal.userId:undefined].filter((value):value is string=>typeof value==='string'))].sort();
   if(actors.length)await client.query('SELECT id FROM human_users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[actors]);
   await assertCurrentRunAuthority(client,id,'retry');
   const authority=await lockProjectAuthority(client,principal,project,'operator',true);
   await requireRunRoute(client,principal,id,'operator',true);
   if(input.budgetPreviewId&&!administrative(principal))throw new AppError(403,'补充资源与预算需要管理员批准','RESOURCE_BUDGET_ADMIN_REQUIRED');
   if(!input.resume&&old.snapshot.resourceRevision)throw new AppError(409,'资源补充只批准未完成节点，完整重试需要另外批准方案','RESOURCE_RESUME_ONLY');
   if(!['failed','interrupted','cancelled'].includes(old.status))throw new AppError(409,'仅能恢复或重试已停止的运行');
   // A repeated recovery request returns its committed child even while that
   // child is active. The project lock still fences creation of a new child.
   const already=(await client.query('SELECT id,snapshot FROM project_runs WHERE parent_run_id=$1',[id])).rows[0];
   if(already){
    if((already.snapshot.recovery?.workspaceCheckpoint?.id??undefined)!==input.checkpointId)throw new AppError(409,'此运行已有不同恢复点的续跑，请打开已有运行','CHECKPOINT_CHILD_EXISTS');
    if(input.budgetPreviewId&&(already.snapshot.approval?.kind!=='resume-resources'||already.snapshot.resourceApproval?.previewId!==input.budgetPreviewId||
       already.snapshot.resourceApproval?.sourceRunId!==id||already.snapshot.resourceRevision!==(old.snapshot.resourceRevision??0)+1))
      throw new AppError(409,'此运行已有其他续跑记录，请打开已有运行后重新核对资源方案','RESOURCE_PREVIEW_STALE');
    return {ok:true as const,status:200,data:{id:already.id,existing:true}};
   }
   if((await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[old.project_id])).rowCount)throw new AppError(409,'此项目已有运行');
   await requireResolvedProjectEffectsIn(client,old.project_id);
   if(hasUnplannedTasks({tasks:old.snapshot.approvedTasks??old.snapshot.tasks}))throw new AppError(422,planningRequiredMessage+'旧运行不能直接重试，请修改项目方案后重新批准。','PLAN_NOT_READY');
   const run=readRun(traceRoot,id);if(run&&run.integrity!=='ok')throw new AppError(409,'档案不完整，先导出并检查，不能自动恢复');
   assertGoalRecovery(old.snapshot,run);
   const unknown=run?unresolvedOperations(run.events):[];
   if(unknown.length&&!input.acknowledgeUnknownOperations)throw new AppError(409,'存在结果未知的修改操作，请核对操作和产物后确认重试，避免重复执行','OPERATION_RECONCILIATION_REQUIRED');
   let snapshot=structuredClone(old.snapshot);snapshot.runtimeArchitecture='employee-host-v1';let done=new Map<string,any>();
   snapshot.approvedTasks??=structuredClone(snapshot.tasks);
   if(!input.resume){snapshot.tasks=structuredClone(snapshot.approvedTasks);delete snapshot.handoffCheckpoints;delete snapshot.completedCheckpoints;delete snapshot.recovery;}
   if(taskMode&&run){
    done=completedTasks(run.events,snapshot);
    try{
     const checkpoint=readStepCheckpoint({root:traceRoot,runId:id,checkpointId:input.checkpointId!});
     if(checkpoint.version!==2||checkpoint.profile!=='task-attempt-openshell-v1')throw Error('CHECKPOINT_MANIFEST_INVALID');
     snapshot.recovery={sourceRunId:id,workspaceCheckpoint:{id:checkpoint.id,runId:id,sha256:checkpoint.sha256}};
     delete snapshot.handoffCheckpoints;delete snapshot.completedCheckpoints;
    }catch(error){throw new AppError(409,stepCheckpointError(error),'CHECKPOINT_RESTORE_BLOCKED');}
   }else if(input.resume&&run){
    done=completedTasks(run.events,snapshot);
    snapshot.tasks=structuredClone(snapshot.approvedTasks);
    let selected:ReturnType<typeof selectStepCheckpoint>|undefined;
    try {if(input.checkpointId)selected=selectStepCheckpoint(traceRoot,run,input.checkpointId);}
    catch(error){throw new AppError(409,stepCheckpointError(error),'CHECKPOINT_RESTORE_BLOCKED');}
    try { snapshot.handoffCheckpoints=resumeHandoff(snapshot,run.events,done,join(traceRoot,id,'artifacts'),selected?.checkpoint.files); }
    catch(error) { throw new AppError(409,(error as Error).message,'HANDOFF_CHECKPOINT_INVALID'); }
    snapshot.recovery=buildCheckpointContext(snapshot,selected?.events??run.events,checkpointTasks(selected?.events??run.events,snapshot),done,join(traceRoot,id,'artifacts'),id,selected?.checkpoint.files);
    if(selected){snapshot.recovery.workspaceCheckpoint=selected.reference;snapshot.recovery.budgetEvidence=sourceBudgetEvidence(snapshot,run.events,id);}
   }
   if(input.resume&&!run)throw new AppError(409,'运行档案缺失，无法恢复上下文和核对调用上限；请先恢复备份','BUDGET_HISTORY_MISSING');
   const history=await budgetHistory(client,traceRoot,old.project_id,old.project_version);
   if(input.budgetPreviewId){
     const resourceSnapshot=await approvedRecoveryResources(client,old,input.budgetPreviewId,[...done.keys()],history);
     snapshot={...resourceSnapshot,runtimeArchitecture:snapshot.runtimeArchitecture,handoffCheckpoints:snapshot.handoffCheckpoints,recovery:snapshot.recovery};
   }
   if(!snapshot.tasks.some((task:any)=>!done.has(task.id)))throw new AppError(409,'所有任务已有完成记录，请查看交付结果，无需重跑');
   const costReadiness=await requireProjectCostReady(client,old.project_id,input.retainUncertainCosts,snapshot.policy.maxBudget);
   if(input.budgetPreviewId&&snapshot.resourceApproval?.callRequirementVersion===recoveryCallRequirementVersion&&
      recoveryMinimumProjectBudget(snapshot,history,[...done.keys()],snapshot.resourceApproval.callCeilings??
       {maxModelCalls:snapshot.policy.maxModelCalls??100,maxTaskModelCalls:snapshot.policy.maxTaskModelCalls??40},costReadiness)>snapshot.policy.maxBudget)
     throw new AppError(422,'确认时项目净额不足工作与交接纠正的完整请求预留，请重新规划','RESOURCE_BUDGET_INSUFFICIENT');
   await assertRunAuthorization(old,client);
   snapshot.executionBudget=costReadiness.availableBudget;snapshot.costCarryover=projectCostCarryover(costReadiness,input.retainUncertainCosts);
   assertRecoveryBudgetIssues(recoveryProjectBudgetIssues(costReadiness,snapshot.policy.maxBudget));
   snapshot.budgetVersion=1;snapshot.budgetHistory=history;
   assertRecoveryBudgetIssues(recoveryHistoryBudgetIssues(snapshot,snapshot.budgetHistory,new Set(done.keys())));
   await assertRunModels(snapshot,client);
   const previousBudgets=snapshot.departmentBudgets??{[snapshot.departmentId]:snapshot.executionBudget},previousTotal=Object.values(previousBudgets).reduce((n:number,value:any)=>n+Number(value),0);
   snapshot.departmentBudgets=Object.fromEntries(Object.entries(previousBudgets).map(([departmentId,value])=>[departmentId,previousTotal>0?snapshot.executionBudget*Number(value)/previousTotal:(departmentId===snapshot.departmentId?snapshot.executionBudget:0)]));
   const config=await lockCostPolicy(client);await checkDailyBudget(client,config,snapshot.departmentId,snapshot.departmentBudgets[snapshot.departmentId]??0,snapshot.executionBudget);
   for(const departmentId of snapshot.departmentIds??[snapshot.departmentId])if(departmentId!==snapshot.departmentId)await checkDailyBudget(client,config,departmentId,snapshot.departmentBudgets[departmentId]??0,0);
   snapshot.resumedFrom=id;if(!taskMode)snapshot.completedCheckpoints=[...done.keys()];snapshot.approval={kind:input.budgetPreviewId?'resume-resources':input.resume?'resume':'retry',approvedAt:new Date().toISOString(),parentRunId:id,retainUncertainCosts:input.retainUncertainCosts,...(unknown.length?{reconciledOperations:unknown}: {})};
   const attempt=Number((await client.query('SELECT COALESCE(max(attempt),0)+1 AS next FROM project_runs WHERE project_id=$1 AND project_version=$2',[old.project_id,old.project_version])).rows[0].next);
   const sourceBounds=await readRunBounds(client,id),departments=old.department_ids??snapshot.departmentIds??[snapshot.departmentId];
   if(sourceBounds.requiredDepartmentIds.some(department=>!departments.includes(department)))throw new AppError(422,'目标运行必须保留全部来源部门','SOURCE_BOUNDS_INVALID');
   await client.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id,department_ids,requested_by_user_id,authorized_by_user_id,authorized_epoch,authority_kind,authority_department_ids,source_bounds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13)',[newId,old.project_id,old.project_version,'queued',snapshot,attempt,id,departments,principal.kind==='human'?principal.userId:null,principal.kind==='human'?principal.sessionEpoch:null,principal.kind==='human'?'human':'local-owner',authority.departmentIds,sourceBounds]);
   if(taskMode){
    const facts=await captureTaskRecoverySourceIn(writers,{sourceRunId:id,checkpointId:input.checkpointId!,childRunId:newId},client,recoverySignal);
    Object.assign(snapshot,buildTaskRecoveryChildContext({id:old.id,snapshot:old.snapshot,events:run!.events},facts,traceRoot));
    done=new Map([...completedTasks(run!.events,old.snapshot)].filter(([taskId])=>snapshot.completedCheckpoints.includes(taskId)));
    assertRecoveryBudgetIssues(recoveryHistoryBudgetIssues(snapshot,history,new Set(done.keys())));
    await client.query('UPDATE project_runs SET snapshot=$1 WHERE id=$2',[snapshot,newId]);
   }
   await client.query("UPDATE projects SET status='QUEUED' WHERE id=$1 AND version=$2",[old.project_id,old.project_version]);
   await routeAudit(client,principal,authority,'run.recover',newId,{state:'requested',...(input.checkpointId?{checkpointId:input.checkpointId}:{})},{projectId:old.project_id,runId:newId});
   if(taskMode)await captureTaskRecoverySourceIn(writers,{sourceRunId:id,checkpointId:input.checkpointId!,childRunId:newId},client,recoverySignal);
   return {ok:true as const,status:202,data:{id:newId,completedCheckpoints:[...done.keys()]}};
  };
  const recoverySignal=AbortSignal.timeout(120000);
  let admission;
  try{
   admission=taskMode?await writers.withRecoverySource(id,newId,()=>withTaskRecoveryCreationTransaction(writers,id,recoverySignal,process),{signal:recoverySignal}):await writers.withWriter([newId],async()=>{
    const client=await pool.connect();let commitDispatched=false,discard=false;
    try{
     await client.query('BEGIN');await shareCostMaintenance(client);const result=await process(client);
     commitDispatched=true;await client.query('COMMIT');return result;
    }catch(error){
     try{await client.query('ROLLBACK');}catch{discard=true;throw error;}
     if(commitDispatched)throw error;return {ok:false as const,error};
    }finally{client.release(discard);}
   });
  }catch(error){await recordRunAuthorityDenial(pool,error);throw error;}
  if(!admission.ok){await recordRunAuthorityDenial(pool,admission.error);throw admission.error;}
  res.status(admission.status).json(admission.data);
 });
 router.get('/diagnostics',async(_req,res)=>{let sandbox=false;try{await RunSandbox.assertReady(AbortSignal.timeout(5000));sandbox=true;}catch{}res.json({sandbox,sandboxImage:SANDBOX_IMAGE,worker:(await pool.query("SELECT status,count(*)::int FROM project_runs GROUP BY status")).rows,knowledge:(await pool.query('SELECT count(*)::int FROM knowledge_documents WHERE deleted_at IS NULL')).rows[0].count,node:process.versions.node,platform:process.platform});});
 router.post('/sandbox/install',async(_req,res)=>{await command(['pull',SANDBOX_IMAGE],{signal:AbortSignal.timeout(180000),limit:2000000});res.json({ok:true});});
 return router;
}
