import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from './db.ts';
import { AppError } from './provider.ts';
import { completeBudgeted,projectCostReadiness } from './cost-control.ts';
import { assertPlanningModel, assertRunAuthorization } from './execution-policy.ts';
import { readRun } from '../../../services/agent-runtime/trace-store.mjs';
import { assertGoalRecovery } from './goal-recovery.ts';
import { completedTasks } from './handoff-checkpoints.ts';
import { budgetHistory } from './budget-history.ts';
import { extractPlanningObject, PlanningOutputError, planningOutputDiagnostic, planningSchemaMessage } from './planning-output.ts';
import { applyRecoveryResources, recoveryResourceProposalSchema, recoveryTaskMinimumBudget, recoveryCallRequirements,
  recoveryCallRequirementVersion, recoveryMinimumProjectBudget, recoveryTaskOutputLimit } from './recovery-resource-plan.ts';

export function recoveryResourceRouter(traceRoot:string) {
  const router=Router(),planning=new Set<string>();
  router.post('/runs/:id/resource-proposal',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),input=z.object({modelId:z.string().min(1),maxBudget:z.number().finite().positive().max(10000),
      maxPlanningCost:z.number().finite().positive().max(1),retainUncertainCosts:z.boolean().default(false),
      maxModelCalls:z.number().int().min(1).max(1000).optional(),maxTaskModelCalls:z.number().int().min(1).max(1000).optional(),
      maxTaskOutputTokens:z.number().int().min(1).max(32768).optional()}).strict().parse(req.body);
    if(planning.has(id))throw new AppError(409,'此运行正在规划资源补充');
    planning.add(id);
    try{
      const row=(await pool.query('SELECT * FROM project_runs WHERE id=$1',[id])).rows[0];
      if(!row||!['failed','interrupted','cancelled'].includes(row.status))throw new AppError(409,'仅能为已停止运行补充资源');
      if((await pool.query('SELECT id FROM project_runs WHERE parent_run_id=$1',[id])).rowCount)
        throw new AppError(409,'此运行已有续跑记录，请在最新运行规划资源','RESOURCE_SOURCE_SUPERSEDED');
      const run=readRun(traceRoot,id);assertGoalRecovery(row.snapshot,run);
      await assertRunAuthorization(row,pool,{requireLocalOnline:false});
      if(input.maxBudget<row.snapshot.policy.maxBudget)throw new AppError(422,'资源补充不能降低原预算');
      const callCeilings={maxModelCalls:input.maxModelCalls??row.snapshot.policy.maxModelCalls??100,
        maxTaskModelCalls:input.maxTaskModelCalls??row.snapshot.policy.maxTaskModelCalls??40};
      if(callCeilings.maxModelCalls<(row.snapshot.policy.maxModelCalls??100)||callCeilings.maxTaskModelCalls<(row.snapshot.policy.maxTaskModelCalls??40))
        throw new AppError(422,'允许的累计调用上限不能小于原批准策略','RESOURCE_PROPOSAL_INVALID');
      assertPlanningModel(input.modelId,row.snapshot.policy);
      const item=(await pool.query("SELECT id,data,version,status,capabilities FROM models WHERE id=$1 AND deleted_at IS NULL",[input.modelId])).rows[0];
      if(!item||item.status!=='available')throw new AppError(422,'请先测试规划模型连接','RESOURCE_MODEL_REQUIRED');
      const model={...item.data,id:item.id,version:item.version,status:item.status,capabilities:item.capabilities};
      const done=[...completedTasks(run!.events,row.snapshot).keys()],history=await budgetHistory(pool,traceRoot,row.project_id,row.project_version);
      const tasks=(row.snapshot.approvedTasks??row.snapshot.tasks).map((task:any)=>({id:task.id,subject:task.subject,completed:done.includes(task.id),
        kind:task.kind,objective:task.objective,acceptanceCriteria:task.acceptanceCriteria,
        usedCalls:history.tasks[task.id]?.calls??0,originalCallLimit:task.maxModelCalls??row.snapshot.policy.maxTaskModelCalls??40,
        originalBudget:task.maxBudget??row.snapshot.policy.maxBudget,usedCost:history.tasks[task.id]?.cost??0,
        reserved:history.tasks[task.id]?.reserved??0}));
      const taskMaximum=callCeilings.maxTaskModelCalls;
      const requirements=recoveryCallRequirements(row.snapshot,history,done,callCeilings);
      for(const task of tasks){
        Object.assign(task,requirements.tasks[task.id]??{minimumCallLimit:task.originalCallLimit,nextRequestCount:0,workRequests:0,handoffCorrectionRequests:0});
        const original=(row.snapshot.approvedTasks??row.snapshot.tasks).find((item:any)=>item.id===task.id);
        task.minimumBudget=recoveryTaskMinimumBudget(row.snapshot,original,task.usedCost,task.reserved,history.tasks[task.id]?.requestOverheadBytes,task.nextRequestCount);
        if(!task.completed&&task.minimumBudget>input.maxBudget)throw new AppError(422,'节点完整请求所需累计上限超过本次允许额度，请先重新分配预算','RESOURCE_BUDGET_INSUFFICIENT');
      }
      const minimumTotalCalls=requirements.minimumTotalCalls;
      const costs=await projectCostReadiness(pool,row.project_id,row.snapshot.policy.maxBudget);
      const minimumProjectBudget=Math.max(row.snapshot.policy.maxBudget,
        Math.ceil((recoveryMinimumProjectBudget(row.snapshot,history,done,callCeilings,costs)+input.maxPlanningCost)*1e8)/1e8);
      if(minimumProjectBudget>input.maxBudget)throw new AppError(422,'项目净额不足本次规划与所有未完成节点的工作及交接纠正，请重新分配预算','RESOURCE_BUDGET_INSUFFICIENT');
      const callLimits=z.object(Object.fromEntries(tasks.filter((task:any)=>!task.completed).map((task:any)=>[task.id,z.number().int()
        .min(task.minimumCallLimit).max(taskMaximum)]))).strict();
      const budgetLimits=z.object(Object.fromEntries(tasks.filter((task:any)=>!task.completed).map((task:any)=>[task.id,z.number().finite()
        .min(task.minimumBudget).positive().max(input.maxBudget)]))).strict();
      const outputLimits=input.maxTaskOutputTokens===undefined?z.undefined():z.object(Object.fromEntries(tasks.filter((t:any)=>!t.completed).map((t:any)=>{
        const original=(row.snapshot.approvedTasks??row.snapshot.tasks).find((item:any)=>item.id===t.id);
        const prior=recoveryTaskOutputLimit(row.snapshot,original);
        if(!Number.isSafeInteger(prior)||prior<1||Math.max(prior,original.maxOutputTokens??0)>input.maxTaskOutputTokens!)
          throw new AppError(422,'原输出额度缺失或超过允许上限，请检查方案','RESOURCE_PROPOSAL_INVALID');
        t.originalOutputLimit=prior;
        return [t.id,z.number().int().min(Math.max(prior,original.maxOutputTokens??0)).max(input.maxTaskOutputTokens!)];
      }))).strict();
      const boundedSchema=recoveryResourceProposalSchema.extend({maxBudget:z.number().finite().min(minimumProjectBudget).max(input.maxBudget),
        maxModelCalls:input.maxModelCalls===undefined?z.number().int().min(minimumTotalCalls).max(callCeilings.maxModelCalls).optional():
          z.number().int().min(minimumTotalCalls).max(callCeilings.maxModelCalls),
        taskCallLimits:callLimits,taskBudgetLimits:budgetLimits,...(input.maxTaskOutputTokens===undefined?{}:{taskOutputLimits:outputLimits})});
      const messages=[{role:'system',content:'只规划续跑的资源，不改变任务、验收、权限，不生成交付物。返回一个简短JSON对象：'+JSON.stringify(z.toJSONSchema(boundedSchema))+
        `\nmaxBudget是项目累计总额，包含已用费用和预留，不是新增费用；必须在 ${minimumProjectBudget} 到 ${input.maxBudget} 美元之间。maxModelCalls是含已用次数与所有未完成节点下一段调用的项目累计上限，不能只提高节点次数而保留不足的总次数。taskCallLimits和taskBudgetLimits只填未完成任务。调用次数也是累计上限，包含usedCalls，不是新增或剩余次数；每个节点必须至少为minimumCallLimit，不超过本次允许的maxTaskModelCalls。节点金额也是累计上限，至少为minimumBudget，扣除usedCost与reserved后才是节点净额；minimumBudget覆盖nextRequestCount次完整请求，包含workRequests（最多6次工作，含认领、读取、验收、正式交接）和handoffCorrectionRequests（1次已有交接提醒后的纠正），不代表足以完成任务。不能只给工作段额度而使提醒触发后无法提交交接。各节点共享项目门禁，不得把节点额度当成额外预算。不要重复已核对的读取或重跑完成节点；按真实结果提交原生agent_teams_update_task及必需证据。允许上限内仍无法完成时明确说明，不编造通过。不减少旧额度、不超过本次允许上限。rationale用一两句说明。`},
        {role:'user',content:JSON.stringify({requirement:row.snapshot.requirement,ceiling:input.maxBudget,originalBudget:row.snapshot.policy.maxBudget,
          ...(input.maxTaskOutputTokens===undefined?{}:{maxTaskOutputTokens:input.maxTaskOutputTokens,
            outputInstruction:'taskOutputLimits只填全部未完成节点，表示单次输出上限，不是累计消耗。按任务考虑8192或16384；代码、正式报告及推理输出需要空间，原2048不应机械照抄。允许额度不代表实际用满。上调后按固定模型输出单价增加每次预留，同时提高节点费用分配，项目累计金额不得超限。',
            outputRates:row.snapshot.modelRoutes.map((r:any)=>({modelId:r.id,outputRate:r.outputRate})),
            outputTruncated:run!.events.some((e:any)=>e.data?.code==='MAX_TOKENS'||e.data?.code==='OUTPUT_TRUNCATED')}),
          costs:{recordedCost:costs.recordedCost,reserved:costs.reserved,availableAtOriginal:costs.availableBudget,
            availableAtCeiling:input.maxBudget-costs.recordedCost-costs.reserved},
          budgetInstruction:'旧费用和预留不会清零。请核对原净额能否容纳恢复与正式验收；净额很少时应在用户ceiling内提高预算，不能只保留原费用与原调用次数。',
          maxTaskModelCalls:taskMaximum,totalCallLimit:callCeilings.maxModelCalls,minimumProjectBudget,planningCostAllowance:input.maxPlanningCost,
          originalTotalCallLimit:row.snapshot.policy.maxModelCalls??100,usedTotalCalls:history.calls,tasks})}];
      // The small proposal still uses the original project cap. Confirmation,
      // not a planning request, grants the new execution ceiling.
      const response=await completeBudgeted(model,messages,512,{purpose:'预算补充规划',projectId:row.project_id,
        projectVersion:row.project_version,resourcePlanningRunId:id,maxCost:input.maxPlanningCost,retainUncertainCosts:input.retainUncertainCosts});
      let proposal;
      try{proposal=boundedSchema.parse(extractPlanningObject(response.choices[0].message.content));}
      catch(error){
        const reason=error instanceof PlanningOutputError?error:new PlanningOutputError('PLAN_SCHEMA_INVALID',null,error instanceof z.ZodError?error.issues:undefined);
        throw Object.assign(new AppError(422,'AI没有返回有效资源方案，旧运行和额度未改变；本次用量已记录。'+planningSchemaMessage(reason.schema),'RESOURCE_PROPOSAL_INVALID'),
          {outputDiagnostic:planningOutputDiagnostic(response.choices[0].message.content,response.choices[0].finish_reason,reason)});
      }
      const adjusted=applyRecoveryResources(row.snapshot,proposal,{newRevision:(row.snapshot.resourceRevision??0)+1,completedTaskIds:done,history,ceiling:input.maxBudget,callCeilings,callRequirementVersion:recoveryCallRequirementVersion,maxTaskOutputTokens:input.maxTaskOutputTokens});
      const settledCosts=await projectCostReadiness(pool,row.project_id,row.snapshot.policy.maxBudget);
      if(recoveryMinimumProjectBudget(adjusted,history,done,callCeilings,settledCosts)>proposal.maxBudget)
        throw new AppError(422,'规划用量已记录，项目净额不足工作与交接纠正，旧运行未改变','RESOURCE_BUDGET_INSUFFICIENT');
      const previewId=randomUUID(),data={kind:'run-resource-proposal',sourceRunId:id,projectId:row.project_id,projectVersion:row.project_version,
        sourceGoalContract:row.snapshot.goalContract,sourceResourceRevision:row.snapshot.resourceRevision??0,ceiling:input.maxBudget,
        modelId:model.id,usageId:response.usageId,proposal,callCeilings,callRequirementVersion:recoveryCallRequirementVersion,
        ...(input.maxTaskOutputTokens===undefined?{}:{maxTaskOutputTokens:input.maxTaskOutputTokens})};
      const client=await pool.connect();
      try{await client.query('BEGIN');await client.query('INSERT INTO organization_previews(id,data,project_id) VALUES($1,$2,$3)',[previewId,data,row.project_id]);
        await client.query('UPDATE usage SET planning_preview_id=$1 WHERE id=$2',[previewId,response.usageId]);await client.query('COMMIT');}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      res.json({previewId,...data,completedTaskIds:done});
    }finally{planning.delete(id);}
  });
  return router;
}
