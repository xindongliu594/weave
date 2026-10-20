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
export function runManagementRouter(traceRoot:string){
 const router=Router();
 router.use(recoveryResourceRouter(traceRoot));
 router.get('/approvals',async(req,res)=>res.json((await pool.query('SELECT id,run_id AS "runId",agent_id AS "agentId",tool,arguments,status,created_at AS "createdAt" FROM tool_approvals WHERE ($1::text IS NULL OR run_id=$1) ORDER BY created_at DESC LIMIT 200',[req.query.runId??null])).rows));
 router.post('/approvals/:id',async(req,res)=>{const input=z.object({decision:z.enum(['approved','denied'])}).parse(req.body);const r=await pool.query("UPDATE tool_approvals SET status=$1,decided_at=now() WHERE id=$2 AND status='pending' AND EXISTS(SELECT 1 FROM project_runs WHERE id=tool_approvals.run_id AND status='running' AND NOT cancel_requested) RETURNING run_id,agent_id",[input.decision,req.params.id]);if(!r.rowCount)throw new AppError(409,'审批已处理或运行已停止');openRunArchive(traceRoot,r.rows[0].run_id).append('approval/decided',{id:req.params.id,decision:input.decision,agentId:r.rows[0].agent_id});res.json({ok:true});});
 router.get('/runs/:id/artifacts',async(req,res)=>{const id=z.uuid().parse(req.params.id),archive=readRun(traceRoot,id);if(!archive)throw new AppError(404,'运行不存在');const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0],canonical=await readLiveCanonical(pool,traceRoot,row,archive);res.json(canonical?canonical.ref.manifest:listArtifacts(join(traceRoot,id,'artifacts')));});
 router.get('/runs/:id/artifact',async(req,res)=>{const id=z.uuid().parse(req.params.id),path=z.string().parse(req.query.path),archive=readRun(traceRoot,id);if(!archive)throw new AppError(404,'运行不存在');const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0],canonical=await readLiveCanonical(pool,traceRoot,row,archive);let file:string|undefined,bytes:Buffer|undefined;
  if(canonical){const found=canonical.files.find(file=>file.path===path);if(!found)throw new AppError(404,'交付物不存在或路径不允许');bytes=Buffer.from(found.content,'base64');}
  else try{file=artifactFile(join(traceRoot,id,'artifacts'),path);}catch{throw new AppError(404,'交付物不存在或路径不允许');}
  res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.setHeader('X-Content-Type-Options','nosniff');res.type('application/octet-stream');res.attachment(path.split('/').at(-1));if(bytes)res.send(bytes);else res.sendFile(file!,{dotfiles:'allow'});
 });
 router.get('/runs/:id/export',async(req,res)=>{const run=readRun(traceRoot,z.uuid().parse(req.params.id));if(!run)throw new AppError(404,'运行不存在');res.attachment('run-'+run.id+'.json').json(run);});
 router.get('/runs/:id/citations/:chunkId',async(req,res)=>{
  const run=readRun(traceRoot,z.uuid().parse(req.params.id));
  if(!run)throw new AppError(404,'运行不存在');
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
  const client=await pool.connect();
  try{await client.query('BEGIN');await shareCostMaintenance(client);
   const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[id])).rows[0];if(!identity)throw new AppError(404,'运行不存在');
   await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
   const old=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!old)throw new AppError(404,'运行不存在');
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
    await client.query('COMMIT');return res.json({id:already.id,existing:true});
   }
   if((await client.query("SELECT id FROM project_runs WHERE project_id=$1 AND status IN ('queued','running')",[old.project_id])).rowCount)throw new AppError(409,'此项目已有运行');
   if(hasUnplannedTasks({tasks:old.snapshot.approvedTasks??old.snapshot.tasks}))throw new AppError(422,planningRequiredMessage+'旧运行不能直接重试，请修改项目方案后重新批准。','PLAN_NOT_READY');
   const run=readRun(traceRoot,id);if(run&&run.integrity!=='ok')throw new AppError(409,'档案不完整，先导出并检查，不能自动恢复');
   assertGoalRecovery(old.snapshot,run);
   const unknown=run?unresolvedOperations(run.events):[];
   if(unknown.length&&!input.acknowledgeUnknownOperations)throw new AppError(409,'存在结果未知的修改操作，请核对操作和产物后确认重试，避免重复执行','OPERATION_RECONCILIATION_REQUIRED');
   let snapshot=structuredClone(old.snapshot);snapshot.runtimeArchitecture='employee-host-v1';let done=new Map<string,any>();
   snapshot.approvedTasks??=structuredClone(snapshot.tasks);
   if(!input.resume){snapshot.tasks=structuredClone(snapshot.approvedTasks);delete snapshot.handoffCheckpoints;delete snapshot.completedCheckpoints;delete snapshot.recovery;}
   if(input.resume&&run){
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
   snapshot.resumedFrom=id;snapshot.completedCheckpoints=[...done.keys()];snapshot.approval={kind:input.budgetPreviewId?'resume-resources':input.resume?'resume':'retry',approvedAt:new Date().toISOString(),parentRunId:id,retainUncertainCosts:input.retainUncertainCosts,...(unknown.length?{reconciledOperations:unknown}: {})};
   const newId=randomUUID(),attempt=Number((await client.query('SELECT COALESCE(max(attempt),0)+1 AS next FROM project_runs WHERE project_id=$1 AND project_version=$2',[old.project_id,old.project_version])).rows[0].next);
   await client.query('INSERT INTO project_runs(id,project_id,project_version,status,snapshot,attempt,parent_run_id,department_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId,old.project_id,old.project_version,'queued',snapshot,attempt,id,old.department_ids??snapshot.departmentIds??[snapshot.departmentId]]);
   await client.query("UPDATE projects SET status='QUEUED' WHERE id=$1 AND version=$2",[old.project_id,old.project_version]);await client.query('COMMIT');res.status(202).json({id:newId,completedCheckpoints:[...done.keys()]});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 router.get('/diagnostics',async(_req,res)=>{let sandbox=false;try{await RunSandbox.assertReady(AbortSignal.timeout(5000));sandbox=true;}catch{}res.json({sandbox,sandboxImage:SANDBOX_IMAGE,worker:(await pool.query("SELECT status,count(*)::int FROM project_runs GROUP BY status")).rows,knowledge:(await pool.query('SELECT count(*)::int FROM knowledge_documents WHERE deleted_at IS NULL')).rows[0].count,node:process.versions.node,platform:process.platform});});
 router.post('/sandbox/install',async(_req,res)=>{await command(['pull',SANDBOX_IMAGE],{signal:AbortSignal.timeout(180000),limit:2000000});res.json({ok:true});});
 return router;
}
