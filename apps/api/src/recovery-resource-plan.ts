import { z } from 'zod';
import { createGoalContract, assertGoalContract } from '../../../packages/contracts/goal-contract.mjs';
import { AppError } from './provider.ts';

export const recoveryResourceProposalSchema=z.object({maxBudget:z.number().finite().positive().max(10000),
  taskCallLimits:z.record(z.string(),z.number().int().min(1).max(1000)),rationale:z.string().trim().min(5).max(2000)}).strict();
export type RecoveryResourceProposal=z.infer<typeof recoveryResourceProposalSchema>;
export function applyRecoveryResources(original:any,value:unknown,options:{newRevision:number;completedTaskIds:string[];
  history:{calls:number;tasks:Record<string,{calls:number}>};ceiling:number}) {
  if(!assertGoalContract(original))throw new AppError(409,'原运行没有固定目标，需重新批准方案','RESOURCE_GOAL_REQUIRED');
  const proposal=recoveryResourceProposalSchema.parse(value),tasks=original.approvedTasks??original.tasks;
  const denied=(message:string)=>new AppError(422,message,'RESOURCE_PROPOSAL_INVALID');
  if(proposal.maxBudget<original.policy.maxBudget||proposal.maxBudget>options.ceiling)
    throw denied(`AI项目累计预算 ${proposal.maxBudget} 不在允许范围 ${original.policy.maxBudget}～${options.ceiling} 美元内；本次用量已记录，未启动员工`);
  if(!Number.isFinite(options.ceiling)||options.ceiling<=0||!Number.isSafeInteger(original.resourceRevision??0)||
    !Number.isSafeInteger(options.newRevision)||proposal.maxBudget<original.policy.maxBudget||proposal.maxBudget>options.ceiling||
    options.newRevision!==(original.resourceRevision??0)+1)throw denied('资源额度或审批批次不符合本次确认范围');
  if(options.history.calls>=(original.policy.maxModelCalls??100))throw denied('方案总调用次数已用尽，资源补充不能重置总次数');
  const changes=Object.entries(proposal.taskCallLimits);
  if(!changes.length)throw denied('缺少未完成节点的调用额度');
  const snapshot=structuredClone(original);
  snapshot.tasks=structuredClone(tasks);
  for(const [id,limit] of changes){
    const task=snapshot.tasks.find((task:any)=>task.id===id);
    if(!task||options.completedTaskIds.includes(id))throw denied('只能调整未完成的原节点');
    const prior=task.maxModelCalls??original.policy.maxTaskModelCalls??40,used=options.history.tasks[id]?.calls??0;
    if(limit<prior||limit<=used||limit>(original.policy.maxTaskModelCalls??40))throw denied('节点调用额度不符合原策略或已用次数');
    task.maxModelCalls=limit;
  }
  snapshot.policy.maxBudget=proposal.maxBudget;
  snapshot.approvedTasks=structuredClone(snapshot.tasks);
  snapshot.resourceRevision=options.newRevision;
  snapshot.goalContract=createGoalContract(snapshot);
  return snapshot;
}

export async function approvedRecoveryResources(db:{query:(sql:string,args?:any[])=>Promise<any>},row:any,previewId:string,
  completedTaskIds:string[],history:{calls:number;tasks:Record<string,{calls:number}>}) {
  const preview=(await db.query('SELECT data FROM organization_previews WHERE id=$1 FOR UPDATE',[previewId])).rows[0]?.data;
  if(!preview||preview.kind!=='run-resource-proposal'||preview.sourceRunId!==row.id||preview.projectId!==row.project_id||
    preview.projectVersion!==row.project_version||preview.sourceResourceRevision!==(row.snapshot.resourceRevision??0)||
    JSON.stringify(preview.sourceGoalContract)!==JSON.stringify(row.snapshot.goalContract))
    throw new AppError(409,'资源候选不属于当前原运行或目标已变化，请重新规划','RESOURCE_PREVIEW_STALE');
  const receipt=(await db.query("SELECT id FROM usage WHERE id=$1 AND project_id=$2 AND model_id=$3 AND planning_preview_id=$4 AND purpose='预算补充规划'",
    [preview.usageId,row.project_id,preview.modelId,previewId])).rows[0];
  if(!receipt)throw new AppError(409,'资源候选缺少真实规划用量记录','RESOURCE_PREVIEW_UNVERIFIED');
  const snapshot=applyRecoveryResources(row.snapshot,preview.proposal,{newRevision:(row.snapshot.resourceRevision??0)+1,
    completedTaskIds,history,ceiling:preview.ceiling});
  snapshot.resourceApproval={format:'run-resource-approval-v1',revision:snapshot.resourceRevision,previewId,sourceRunId:row.id,
    sourceGoalContract:row.snapshot.goalContract,ceiling:preview.ceiling,proposal:preview.proposal,
    modelId:preview.modelId,usageId:preview.usageId,approvedAt:new Date().toISOString()};
  snapshot.goalContract=createGoalContract(snapshot);
  return snapshot;
}

/** Only an explicit, sealed resource edge may change the original task caps. */
export function verifiedResourceEdge(child:any,parent:any,parentRunId:string,completedTaskIds:string[]) {
  try{
    const revision=child.resourceRevision??0,prior=parent.resourceRevision??0;
    if(!revision&&!prior)return false;
    assertGoalContract(child);assertGoalContract(parent);
    if(revision===prior)return child.goalContract.sha256===parent.goalContract.sha256;
    const approval=child.resourceApproval;
    if(revision!==prior+1||approval?.format!=='run-resource-approval-v1'||approval.revision!==revision||
      approval.sourceRunId!==parentRunId||approval.sourceGoalContract?.sha256!==parent.goalContract?.sha256||
      !z.uuid().safeParse(approval.previewId).success||!z.uuid().safeParse(approval.usageId).success)return false;
    const expected=applyRecoveryResources(parent,approval.proposal,{newRevision:revision,completedTaskIds,
      history:{calls:0,tasks:{}},ceiling:approval.ceiling});
    expected.resourceApproval=approval;
    return createGoalContract(expected).sha256===child.goalContract.sha256;
  }catch{return false;}
}
