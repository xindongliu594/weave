import { z } from 'zod';
import { createGoalContract, assertGoalContract } from '../../../packages/contracts/goal-contract.mjs';
import { AppError } from './provider.ts';
import { policySchema } from '../../../packages/contracts/index.ts';

export const recoveryResourceProposalSchema=z.object({maxBudget:z.number().finite().positive().max(10000),
  maxModelCalls:z.number().int().min(1).max(1000).optional(),
  taskCallLimits:z.record(z.string(),z.number().int().min(1).max(1000)),
  taskBudgetLimits:z.record(z.string(),z.number().finite().positive().max(10000)).optional(),
  taskOutputLimits:z.record(z.string(),z.number().int().min(1).max(32768)).optional(),
  contextBytes:policySchema.shape.contextBytes,
  rationale:z.string().trim().min(5).max(2000)}).strict();
export type RecoveryResourceProposal=z.infer<typeof recoveryResourceProposalSchema>;
export const recoveryCallRequirementVersion='handoff-correction-v1' as const;
type RecoveryHistory={calls:number;tasks:Record<string,{calls:number;cost?:number;reserved?:number;requestOverheadBytes?:number}>};
type CallCeilings={maxModelCalls:number;maxTaskModelCalls:number};
const taskCallCeilingsSchema=z.record(z.string(),z.number().int().min(1).max(1000));
/** A continuation grant is an absolute cap; ordinary resumes must never add it to new history. */
export function recoveryTaskCallLimit(snapshot:any,task:any){
  const limits=snapshot.resourceApproval?.taskCallCeilings;
  return Math.min(task.maxModelCalls??snapshot.policy.maxTaskModelCalls??40,limits&&Object.hasOwn(limits,task.id)?limits[task.id]:Infinity);
}
function validTaskCallCeilings(snapshot:any,value:unknown){
  const parsed=taskCallCeilingsSchema.safeParse(value);
  return parsed.success&&Object.keys(parsed.data).length>0&&Object.entries(parsed.data).every(([id,limit])=>{
    const task=(snapshot.approvedTasks??snapshot.tasks).find((task:any)=>task.id===id);
    return task&&limit<=Math.min(task.maxModelCalls??snapshot.policy.maxTaskModelCalls??40,snapshot.policy.maxModelCalls??100);
  });
}
function taskRoutes(snapshot:any,task:any):any[]{
  const employee=typeof task.assignee==='string'?snapshot.agents?.find((a:any)=>a.id===task.assignee):
    typeof task.assigneeId==='string'?snapshot.agents?.find((a:any)=>a.employeeId===task.assigneeId||a.id===task.assigneeId):undefined;
  return (snapshot.modelRoutes??[]).filter((r:any)=>employee&&[employee.modelId,employee.fallbackModelId].includes(r.id));
}
export function recoveryTaskOutputLimit(snapshot:any,task:any):number{
  const routes=taskRoutes(snapshot,task);
  return Math.max(0,...routes.map(r=>Math.min(task.maxOutputTokens??r.maxOutputTokens,r.maxOutputTokens)));
}
/** The byte allowance is global, so every pinned route must support the full input, output and guard. */
export function recoveryContextSnapshot(original:any,contextBytes?:number,authorizedBytes?:number){
  const snapshot=structuredClone(original);
  if(contextBytes===undefined&&authorizedBytes===undefined)return snapshot;
  const deny=(text:string)=>new AppError(422,text,'RESOURCE_PROPOSAL_INVALID');
  if(contextBytes===undefined||!policySchema.shape.contextBytes.safeParse(contextBytes).success||contextBytes!==authorizedBytes)
    throw deny('上下文调整缺少匹配的明确字节授权');
  if(contextBytes<(original.policy.contextBytes??64000))throw deny('恢复上下文上限不能低于原批准字节数');
  if(!snapshot.modelRoutes?.length)throw deny('上下文调整缺少固定模型路线');
  for(const route of snapshot.modelRoutes){
    if(route.contextBytes!==undefined&&(!Number.isSafeInteger(route.contextBytes)||route.contextBytes<contextBytes))
      throw deny('固定模型路线的字节上限不支持本次上下文调整');
    if(!Number.isSafeInteger(route.contextWindowTokens)||!Number.isSafeInteger(route.maxOutputTokens)||route.maxOutputTokens<1||
      contextBytes+route.maxOutputTokens+1024>route.contextWindowTokens)
      throw deny('固定模型容量未知或不足以容纳完整上下文、原输出和安全余量');
  }
  snapshot.policy.contextBytes=contextBytes;
  return snapshot;
}
/** Adjust only the new snapshot; route caps are request defaults, not model capabilities. */
export function recoveryOutputSnapshot(original:any,limits:Record<string,number>|undefined,completed:string[],ceiling?:number){
  const snapshot=structuredClone(original);snapshot.tasks=structuredClone(original.approvedTasks??original.tasks);
  if(!limits||!Object.keys(limits).length)return snapshot;
  const deny=(text:string)=>new AppError(422,text,'RESOURCE_PROPOSAL_INVALID');
  if(typeof ceiling!=='number'||!Number.isSafeInteger(ceiling)||ceiling<1||ceiling>32768)throw deny('输出调整缺少允许的单次输出上限');
  for(const [id,value] of Object.entries(limits)){
    const task=snapshot.tasks.find((t:any)=>t.id===id),prior=(original.approvedTasks??original.tasks).find((t:any)=>t.id===id);
    if(!task||completed.includes(id))throw deny('只能调整未完成节点的输出额度');
    const routes=taskRoutes(original,prior),oldLimit=recoveryTaskOutputLimit(original,prior);
    if(!routes.length||!Number.isSafeInteger(oldLimit)||oldLimit<1||!Number.isSafeInteger(value)||value<Math.max(oldLimit,prior.maxOutputTokens??0)||value>ceiling)
      throw deny('节点单次输出额度不符合原额度与本次允许上限');
    for(const route of routes){
      if(route.contextWindowTokens!==undefined&&value+1024>=route.contextWindowTokens)throw deny('单次输出额度未给模型上下文保留输入空间');
      if(value>route.maxOutputTokens){
        for(const other of original.approvedTasks??original.tasks){
          if(other.id===id||limits[other.id]!==undefined)continue;
          if(taskRoutes(original,other).some(r=>r.id===route.id)&&(other.maxOutputTokens??Infinity)>route.maxOutputTokens)
            throw deny('共享模型的其他节点缺少独立输出额度，原节点可能返工，请重新制定方案');
        }
        const target=snapshot.modelRoutes.find((r:any)=>r.id===route.id);
        target.maxOutputTokens=Math.max(target.maxOutputTokens,value);
      }
    }
    task.maxOutputTokens=value;
  }
  return snapshot;
}
export function recoveryCallRequirements(snapshot:any,history:RecoveryHistory,completedTaskIds:string[],ceilings:CallCeilings,
  taskContinuationLimits?:Record<string,number>){
  const invalid=()=>new AppError(422,'允许的调用次数不足以覆盖恢复工作与一次正式交接纠正，请重新分配次数','RESOURCE_CALLS_INSUFFICIENT');
  if(![history.calls,ceilings.maxModelCalls,ceilings.maxTaskModelCalls].every(n=>Number.isSafeInteger(n)&&n>=0)||
    ceilings.maxModelCalls<(snapshot.policy.maxModelCalls??100)||ceilings.maxTaskModelCalls<(snapshot.policy.maxTaskModelCalls??40))throw invalid();
  const unfinished=(snapshot.approvedTasks??snapshot.tasks).filter((task:any)=>!completedTaskIds.includes(task.id));
  if(taskContinuationLimits!==undefined){
    const parsed=taskCallCeilingsSchema.safeParse(taskContinuationLimits);
    if(!parsed.success||Object.keys(parsed.data).length!==unfinished.length||unfinished.some((task:any)=>!Object.hasOwn(parsed.data,task.id))||
      history.calls+Object.values(parsed.data).reduce((sum,limit)=>sum+limit,0)>ceilings.maxModelCalls)throw invalid();
  }
  const sealedLimits=snapshot.resourceApproval?.taskCallCeilings;
  if(sealedLimits!==undefined&&!validTaskCallCeilings(snapshot,sealedLimits))throw invalid();
  const tasks:Record<string,{workRequests:number;handoffCorrectionRequests:number;nextRequestCount:number;minimumCallLimit:number}>=Object.create(null);
  for(const task of unfinished){
    const used=history.tasks[task.id]?.calls??0,continuation=taskContinuationLimits?.[task.id]??
      (sealedLimits&&Object.hasOwn(sealedLimits,task.id)?recoveryTaskCallLimit(snapshot,task)-used:undefined),
      workRequests=Math.min(6,ceilings.maxTaskModelCalls-used-1,(continuation??Infinity)-1);
    const minimumCallLimit=Math.max(task.maxModelCalls??snapshot.policy.maxTaskModelCalls??40,used+(taskContinuationLimits?.[task.id]??workRequests+1));
    if(!Number.isSafeInteger(used)||used<0||workRequests<1||minimumCallLimit>ceilings.maxTaskModelCalls||
      continuation!==undefined&&used+continuation>ceilings.maxTaskModelCalls)throw invalid();
    tasks[task.id]={workRequests,handoffCorrectionRequests:1,nextRequestCount:workRequests+1,minimumCallLimit};
  }
  const minimumTotalCalls=Math.max(snapshot.policy.maxModelCalls??100,history.calls+Object.entries(tasks)
    .reduce((sum,[id,task])=>sum+(taskContinuationLimits?.[id]??task.nextRequestCount),0));
  if(!Object.keys(tasks).length||minimumTotalCalls>ceilings.maxModelCalls)throw invalid();
  return {tasks,minimumTotalCalls};
}
/** A conservative single-request floor, using the original pinned routes,
 * bounded messages and actual archived wire schemas/configuration.
 * It is not a forecast for finishing the task; the shared gate still decides. */
function recoveryRequestReservation(snapshot:any,task:any,requestOverheadBytes=13){
  const employee=typeof task.assignee==='string'?snapshot.agents?.find((agent:any)=>agent.id===task.assignee):
    typeof task.assigneeId==='string'?snapshot.agents?.find((agent:any)=>agent.employeeId===task.assigneeId||agent.id===task.assigneeId):undefined;
  const routes=(snapshot.modelRoutes??[]).filter((route:any)=>employee&&[employee.modelId,employee.fallbackModelId].includes(route.id));
  let reservation=0;
  for(const route of routes){
    const bytes=Math.min(snapshot.policy.contextBytes??64000,route.contextBytes??Infinity);
    const output=Math.min(task.maxOutputTokens??route.maxOutputTokens,route.maxOutputTokens);
    if(![bytes,output,route.inputRate,route.outputRate].every(value=>Number.isFinite(value)&&value>=0))continue;
    reservation=Math.max(reservation,((bytes+Math.max(13,requestOverheadBytes)+1024)*route.inputRate+output*route.outputRate)/1e6);
  }
  return reservation;
}
export function recoveryTaskMinimumBudget(snapshot:any,task:any,spent=0,reserved=0,requestOverheadBytes=13,requestCount=1) {
  return Math.max(task.maxBudget??snapshot.policy.maxBudget,Math.ceil((spent+reserved+recoveryRequestReservation(snapshot,task,requestOverheadBytes)*requestCount)*1e8)/1e8);
}
/** Price output choices using the same snapshot rules as confirmation, without granting them. */
export function recoveryTaskOutputBudgets(snapshot:any,task:any,completed:string[],ceiling:number,
  used:{cost?:number;reserved?:number;requestOverheadBytes?:number},requestCount:number,contextBytes?:number){
  const prior=Math.max(recoveryTaskOutputLimit(snapshot,task),task.maxOutputTokens??0);
  const limits=Object.fromEntries((snapshot.approvedTasks??snapshot.tasks).filter((t:any)=>!completed.includes(t.id))
    .map((t:any)=>[t.id,Math.max(recoveryTaskOutputLimit(snapshot,t),t.maxOutputTokens??0)]));
  return [...new Set([prior,8192,16384,ceiling])].filter(n=>n>=prior&&n<=ceiling).sort((a,b)=>a-b).flatMap(maxOutputTokens=>{
    let adjusted;
    try{adjusted=recoveryOutputSnapshot(snapshot,{...limits,[task.id]:maxOutputTokens},completed,ceiling);
      if(contextBytes!==undefined)adjusted=recoveryContextSnapshot(adjusted,contextBytes,contextBytes);}
    catch(error){if(error instanceof AppError&&error.code==='RESOURCE_PROPOSAL_INVALID')return [];throw error;}
    return [{maxOutputTokens,minimumBudget:recoveryTaskMinimumBudget(adjusted,adjusted.tasks.find((t:any)=>t.id===task.id),
      used.cost,used.reserved,used.requestOverheadBytes,requestCount)}];
  });
}
export function recoveryMinimumProjectBudget(snapshot:any,history:RecoveryHistory,completedTaskIds:string[],ceilings:CallCeilings,
  costs:{recordedCost:number;reserved:number},taskContinuationLimits?:Record<string,number>){
  if(![costs.recordedCost,costs.reserved].every(n=>Number.isFinite(n)&&n>=0))throw new AppError(422,'此前项目费用无法核对','RESOURCE_BUDGET_INSUFFICIENT');
  const requirements=recoveryCallRequirements(snapshot,history,completedTaskIds,ceilings,taskContinuationLimits);
  const nextCost=(snapshot.approvedTasks??snapshot.tasks).reduce((sum:number,task:any)=>sum+(requirements.tasks[task.id]?
    recoveryRequestReservation(snapshot,task,history.tasks[task.id]?.requestOverheadBytes)*requirements.tasks[task.id].nextRequestCount:0),0);
  return Math.ceil((costs.recordedCost+costs.reserved+nextCost)*1e8)/1e8;
}
export function applyRecoveryResources(original:any,value:unknown,options:{newRevision:number;completedTaskIds:string[];
  history:RecoveryHistory;ceiling:number;callRequirementVersion?:typeof recoveryCallRequirementVersion;
  callCeilings?:CallCeilings;maxTaskOutputTokens?:number;taskContinuationLimits?:Record<string,number>;contextBytes?:number}) {
  if(!assertGoalContract(original))throw new AppError(409,'原运行没有固定目标，需重新批准方案','RESOURCE_GOAL_REQUIRED');
  const proposal=recoveryResourceProposalSchema.parse(value),tasks=original.approvedTasks??original.tasks;
  const denied=(message:string)=>new AppError(422,message,'RESOURCE_PROPOSAL_INVALID');
  if(proposal.maxBudget<original.policy.maxBudget||proposal.maxBudget>options.ceiling)
    throw denied(`AI项目累计预算 ${proposal.maxBudget} 不在允许范围 ${original.policy.maxBudget}～${options.ceiling} 美元内；本次用量已记录，未启动员工`);
  if(!Number.isFinite(options.ceiling)||options.ceiling<=0||!Number.isSafeInteger(original.resourceRevision??0)||
    !Number.isSafeInteger(options.newRevision)||proposal.maxBudget<original.policy.maxBudget||proposal.maxBudget>options.ceiling||
    options.newRevision!==(original.resourceRevision??0)+1)throw denied('资源额度或审批批次不符合本次确认范围');
  const totalCalls=proposal.maxModelCalls??original.policy.maxModelCalls??100,
    ceilings=options.callCeilings??{maxModelCalls:original.policy.maxModelCalls??100,maxTaskModelCalls:original.policy.maxTaskModelCalls??40};
  if(![ceilings.maxModelCalls,ceilings.maxTaskModelCalls].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1000)||
    totalCalls<(original.policy.maxModelCalls??100)||totalCalls>ceilings.maxModelCalls||options.history.calls>=totalCalls)
    throw denied('方案总调用次数不在本次允许范围内；旧次数继续计入');
  const changes=Object.entries(proposal.taskCallLimits);
  const moneyChanges=Object.entries(proposal.taskBudgetLimits??{});
  const snapshot=recoveryContextSnapshot(recoveryOutputSnapshot(original,proposal.taskOutputLimits,options.completedTaskIds,options.maxTaskOutputTokens),
    proposal.contextBytes,options.contextBytes);
  if(options.callRequirementVersion!==undefined){
    if(options.callRequirementVersion!==recoveryCallRequirementVersion)throw denied('不支持此恢复资源规则版本');
    const requirements=recoveryCallRequirements(original,options.history,options.completedTaskIds,ceilings,options.taskContinuationLimits);
    if(totalCalls<requirements.minimumTotalCalls||Object.keys(proposal.taskCallLimits).length!==Object.keys(requirements.tasks).length)
      throw denied('项目次数不足下一段工作与交接纠正，或缺少未完成节点额度');
    for(const [id,requirement] of Object.entries(requirements.tasks)){
      if((proposal.taskCallLimits[id]??0)<requirement.minimumCallLimit)throw denied('节点次数不足下一段工作与交接纠正');
      const task=snapshot.tasks.find((task:any)=>task.id===id),used=options.history.tasks[id];
      const floor=recoveryTaskMinimumBudget(snapshot,task,used?.cost??0,used?.reserved??0,used?.requestOverheadBytes,requirement.nextRequestCount);
      if((proposal.taskBudgetLimits?.[id]??task.maxBudget??original.policy.maxBudget)<floor)throw denied('节点净额不足下一段工作与交接纠正的完整请求预留');
    }
  }
  if(!changes.length&&!moneyChanges.length&&!Object.keys(proposal.taskOutputLimits??{}).length&&proposal.contextBytes===undefined)throw denied('缺少未完成节点的资源额度');
  for(const [id,limit] of changes){
    const task=snapshot.tasks.find((task:any)=>task.id===id);
    if(!task||options.completedTaskIds.includes(id))throw denied('只能调整未完成的原节点');
    const prior=task.maxModelCalls??original.policy.maxTaskModelCalls??40,used=options.history.tasks[id]?.calls??0;
    if(limit<prior||limit<=used||limit>ceilings.maxTaskModelCalls)throw denied('节点调用额度不符合本次允许上限或已用次数');
    task.maxModelCalls=limit;
  }
  for(const [id,limit] of moneyChanges){
    const task=snapshot.tasks.find((task:any)=>task.id===id);
    if(!task||options.completedTaskIds.includes(id))throw denied('只能调整未完成的原节点');
    const prior=task.maxBudget??original.policy.maxBudget,used=options.history.tasks[id]?.cost??0,
      reserved=options.history.tasks[id]?.reserved??0;
    if(!Number.isFinite(used)||used<0||!Number.isFinite(reserved)||reserved<0||limit<prior||limit<=used+reserved||limit>proposal.maxBudget)
      throw denied('节点费用额度不符合原上限、已用费用与预留或项目累计上限');
    if(limit<recoveryTaskMinimumBudget(snapshot,task,used,reserved,options.history.tasks[id]?.requestOverheadBytes))throw denied('节点净额不足一次完整请求预留，请重新规划节点费用');
    task.maxBudget=limit;
  }
  const requestChanges=proposal.contextBytes===undefined?Object.keys(proposal.taskOutputLimits??{}):
    snapshot.tasks.filter((task:any)=>!options.completedTaskIds.includes(task.id)).map((task:any)=>task.id);
  for(const id of requestChanges){
    const task=snapshot.tasks.find((t:any)=>t.id===id),used=options.history.tasks[id];
    if((task.maxBudget??proposal.maxBudget)<recoveryTaskMinimumBudget(snapshot,task,used?.cost??0,used?.reserved??0,used?.requestOverheadBytes))
      throw denied('新请求额度下节点净额不足一次完整请求预留');
  }
  snapshot.policy.maxBudget=proposal.maxBudget;
  if(proposal.maxModelCalls!==undefined)snapshot.policy.maxModelCalls=totalCalls;
  const largestTaskLimit=Math.max(original.policy.maxTaskModelCalls??40,...changes.map(([,limit])=>limit));
  if(largestTaskLimit>(original.policy.maxTaskModelCalls??40))snapshot.policy.maxTaskModelCalls=largestTaskLimit;
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
  if(preview.callRequirementVersion!==recoveryCallRequirementVersion)
    throw new AppError(409,'资源候选尚未计入交接纠正余量，请重新规划','RESOURCE_PREVIEW_STALE');
  const receipt=(await db.query("SELECT id FROM usage WHERE id=$1 AND project_id=$2 AND model_id=$3 AND planning_preview_id=$4 AND purpose='预算补充规划'",
    [preview.usageId,row.project_id,preview.modelId,previewId])).rows[0];
  if(!receipt)throw new AppError(409,'资源候选缺少真实规划用量记录','RESOURCE_PREVIEW_UNVERIFIED');
  const snapshot=applyRecoveryResources(row.snapshot,preview.proposal,{newRevision:(row.snapshot.resourceRevision??0)+1,
    completedTaskIds,history,ceiling:preview.ceiling,callCeilings:preview.callCeilings,callRequirementVersion:preview.callRequirementVersion,
    maxTaskOutputTokens:preview.maxTaskOutputTokens,taskContinuationLimits:preview.taskContinuationLimits,contextBytes:preview.contextBytes});
  let taskCallCeilings=row.snapshot.resourceApproval?.taskCallCeilings;
  if(preview.taskContinuationLimits!==undefined){
    const limits=taskCallCeilingsSchema.parse(preview.taskContinuationLimits),requirements=recoveryCallRequirements(row.snapshot,history,completedTaskIds,
      preview.callCeilings??{maxModelCalls:row.snapshot.policy.maxModelCalls??100,maxTaskModelCalls:row.snapshot.policy.maxTaskModelCalls??40},limits);
    if(Object.keys(limits).length!==Object.keys(requirements.tasks).length||
      Object.entries(requirements.tasks).some(([id,requirement])=>(limits[id]??0)<requirement.nextRequestCount)||
      history.calls+Object.values(limits).reduce((sum,limit)=>sum+limit,0)>(snapshot.policy.maxModelCalls??100))
      throw new AppError(422,'本段调用授权不足或超过批准的累计上限','RESOURCE_PROPOSAL_INVALID');
    taskCallCeilings={...taskCallCeilings,...Object.fromEntries(Object.entries(limits).map(([id,limit])=>[id,(history.tasks[id]?.calls??0)+limit]))};
  }
  if(taskCallCeilings!==undefined&&!validTaskCallCeilings(snapshot,taskCallCeilings))
    throw new AppError(422,'恢复阶段的累计调用上限无效','RESOURCE_PROPOSAL_INVALID');
  snapshot.resourceApproval={format:'run-resource-approval-v1',revision:snapshot.resourceRevision,previewId,sourceRunId:row.id,
    sourceGoalContract:row.snapshot.goalContract,ceiling:preview.ceiling,proposal:preview.proposal,...(preview.callCeilings?{callCeilings:preview.callCeilings}:{}),
    ...(preview.maxTaskOutputTokens===undefined?{}:{maxTaskOutputTokens:preview.maxTaskOutputTokens}),
    ...(preview.contextBytes===undefined?{}:{contextBytes:preview.contextBytes}),
    ...(taskCallCeilings===undefined?{}:{taskCallCeilings}),
    callRequirementVersion:preview.callRequirementVersion,modelId:preview.modelId,usageId:preview.usageId,approvedAt:new Date().toISOString()};
  snapshot.goalContract=createGoalContract(snapshot);
  return snapshot;
}

/** Only an explicit, sealed resource edge may change the original task caps. */
export function verifiedResourceEdge(child:any,parent:any,parentRunId:string,completedTaskIds:string[]) {
  try{
    const revision=child.resourceRevision??0,prior=parent.resourceRevision??0;
    if(!revision&&!prior)return false;
    assertGoalContract(child);assertGoalContract(parent);
    const taskCallCeilings=child.resourceApproval?.taskCallCeilings;
    if(taskCallCeilings!==undefined&&!validTaskCallCeilings(child,taskCallCeilings))return false;
    if(parent.resourceApproval?.taskCallCeilings!==undefined&&taskCallCeilings===undefined)return false;
    if(revision===prior)return child.goalContract.sha256===parent.goalContract.sha256;
    const approval=child.resourceApproval;
    if(revision!==prior+1||approval?.format!=='run-resource-approval-v1'||approval.revision!==revision||
      approval.sourceRunId!==parentRunId||approval.sourceGoalContract?.sha256!==parent.goalContract?.sha256||
      !z.uuid().safeParse(approval.previewId).success||!z.uuid().safeParse(approval.usageId).success)return false;
    if(approval.callRequirementVersion!==undefined&&approval.callRequirementVersion!==recoveryCallRequirementVersion)return false;
    // Edges prove the sealed proposal; live history is checked at confirmation,
    // never reconstructed from fabricated zero-use counters during lineage reads.
    const expected=applyRecoveryResources(parent,approval.proposal,{newRevision:revision,completedTaskIds,
      history:{calls:0,tasks:{}},ceiling:approval.ceiling,callCeilings:approval.callCeilings,maxTaskOutputTokens:approval.maxTaskOutputTokens,contextBytes:approval.contextBytes});
    if(taskCallCeilings!==undefined){
      const oldLimits=parent.resourceApproval?.taskCallCeilings??{};
      if(Object.keys(oldLimits).some(id=>!Object.hasOwn(taskCallCeilings,id))||
        completedTaskIds.some(id=>taskCallCeilings[id]!==oldLimits[id]))return false;
      const changed=Object.keys(taskCallCeilings).length!==Object.keys(oldLimits).length||
        Object.entries(taskCallCeilings).some(([id,limit])=>limit!==oldLimits[id]);
      if(changed){
        const expectedIds=new Set([...Object.keys(oldLimits),...expected.tasks.filter((task:any)=>!completedTaskIds.includes(task.id)).map((task:any)=>task.id)]);
        if(Object.keys(taskCallCeilings).length!==expectedIds.size||[...expectedIds].some(id=>!Object.hasOwn(taskCallCeilings,id)))return false;
      }
    }
    expected.resourceApproval=approval;
    return createGoalContract(expected).sha256===child.goalContract.sha256;
  }catch{return false;}
}
