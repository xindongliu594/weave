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
import { extractPlanningObject } from './planning-output.ts';
import { applyRecoveryResources, recoveryResourceProposalSchema } from './recovery-resource-plan.ts';

export function recoveryResourceRouter(traceRoot:string) {
  const router=Router(),planning=new Set<string>();
  router.post('/runs/:id/resource-proposal',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),input=z.object({modelId:z.string().min(1),maxBudget:z.number().finite().positive().max(10000),
      maxPlanningCost:z.number().finite().positive().max(1),retainUncertainCosts:z.boolean().default(false)}).strict().parse(req.body);
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
      assertPlanningModel(input.modelId,row.snapshot.policy);
      const item=(await pool.query("SELECT id,data,version,status,capabilities FROM models WHERE id=$1 AND deleted_at IS NULL",[input.modelId])).rows[0];
      if(!item||item.status!=='available')throw new AppError(422,'请先测试规划模型连接','RESOURCE_MODEL_REQUIRED');
      const model={...item.data,id:item.id,version:item.version,status:item.status,capabilities:item.capabilities};
      const done=[...completedTasks(run!.events,row.snapshot).keys()],history=await budgetHistory(pool,traceRoot,row.project_id,row.project_version);
      const tasks=(row.snapshot.approvedTasks??row.snapshot.tasks).map((task:any)=>({id:task.id,subject:task.subject,completed:done.includes(task.id),
        usedCalls:history.tasks[task.id]?.calls??0,originalCallLimit:task.maxModelCalls??row.snapshot.policy.maxTaskModelCalls??40}));
      const taskMaximum=row.snapshot.policy.maxTaskModelCalls??40;
      const callLimits=z.object(Object.fromEntries(tasks.filter((task:any)=>!task.completed).map((task:any)=>[task.id,z.number().int()
        .min(Math.max(task.originalCallLimit,task.usedCalls+Math.min(6,taskMaximum-task.usedCalls))).max(taskMaximum)]))).strict();
      const boundedSchema=recoveryResourceProposalSchema.extend({maxBudget:z.number().finite().min(row.snapshot.policy.maxBudget).max(input.maxBudget),taskCallLimits:callLimits});
      const costs=await projectCostReadiness(pool,row.project_id,row.snapshot.policy.maxBudget);
      const messages=[{role:'system',content:'只规划续跑的资源，不改变任务、验收、权限，不生成交付物。返回一个简短JSON对象：'+JSON.stringify(z.toJSONSchema(boundedSchema))+
        `\nmaxBudget是项目累计总额，包含已用费用和预留，不是新增费用；必须在 ${row.snapshot.policy.maxBudget} 到 ${input.maxBudget} 美元之间。taskCallLimits只填未完成任务。恢复后仍需读取、逐次审批真实测试、处理结果和正式交接，尽量给每个未完成节点至少6次剩余调用；不减少旧额度，且不超过原maxTaskModelCalls。rationale用一两句说明。`},
        {role:'user',content:JSON.stringify({requirement:row.snapshot.requirement,ceiling:input.maxBudget,originalBudget:row.snapshot.policy.maxBudget,
          costs:{recordedCost:costs.recordedCost,reserved:costs.reserved,availableAtOriginal:costs.availableBudget,
            availableAtCeiling:input.maxBudget-costs.recordedCost-costs.reserved},
          budgetInstruction:'旧费用和预留不会清零。请核对原净额能否容纳恢复与正式验收；净额很少时应在用户ceiling内提高预算，不能只保留原费用与原调用次数。',
          maxTaskModelCalls:row.snapshot.policy.maxTaskModelCalls??40,totalCallLimit:row.snapshot.policy.maxModelCalls??100,usedTotalCalls:history.calls,tasks})}];
      // The small proposal still uses the original project cap. Confirmation,
      // not a planning request, grants the new execution ceiling.
      const response=await completeBudgeted(model,messages,512,{purpose:'预算补充规划',projectId:row.project_id,
        projectVersion:row.project_version,maxCost:input.maxPlanningCost,retainUncertainCosts:input.retainUncertainCosts});
      let proposal;
      try{proposal=boundedSchema.parse(extractPlanningObject(response.choices[0].message.content));}
      catch{throw new AppError(422,'AI没有返回有效资源方案，旧运行和额度未改变；本次用量已记录','RESOURCE_PROPOSAL_INVALID');}
      applyRecoveryResources(row.snapshot,proposal,{newRevision:(row.snapshot.resourceRevision??0)+1,completedTaskIds:done,history,ceiling:input.maxBudget});
      const previewId=randomUUID(),data={kind:'run-resource-proposal',sourceRunId:id,projectId:row.project_id,projectVersion:row.project_version,
        sourceGoalContract:row.snapshot.goalContract,sourceResourceRevision:row.snapshot.resourceRevision??0,ceiling:input.maxBudget,
        modelId:model.id,usageId:response.usageId,proposal};
      const client=await pool.connect();
      try{await client.query('BEGIN');await client.query('INSERT INTO organization_previews(id,data,project_id) VALUES($1,$2,$3)',[previewId,data,row.project_id]);
        await client.query('UPDATE usage SET planning_preview_id=$1 WHERE id=$2',[previewId,response.usageId]);await client.query('COMMIT');}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      res.json({previewId,...data,completedTaskIds:done});
    }finally{planning.delete(id);}
  });
  return router;
}
