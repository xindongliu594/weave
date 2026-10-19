import {z} from 'zod';
import {taskSchema,validatePlan,type Model,type Plan,type Policy} from '../../../packages/contracts/index.ts';
import {organizationCandidateSchema,organizationCandidateV2Schema} from '../../../packages/contracts/organization.ts';
import {taskContractErrors} from '../../../packages/contracts/task-contracts.mjs';
import {plannedAcceptanceErrors} from './execution-prompt.ts';

export function organizationTaskContractErrors(tasks:Plan['tasks'],agents:Plan['agents']):string[]{
 const errors=[...taskContractErrors(tasks,agents),...plannedAcceptanceErrors(tasks)];
 for(const task of tasks){
  if(task.kind==='implementation'&&!tasks.some(review=>review.kind==='review'&&review.reviewedTaskId===task.id&&review.assigneeId!==task.assigneeId))errors.push(`${task.id}: 代码实现必须有另一位员工的独立审查任务`);
  if(task.kind==='review'&&task.outputs?.length)errors.push(`${task.id}: 独立审查应返回结论，不能在验证后再写文件`);
 }
 return [...new Set(errors)];
}

// Only for independent diagnostics after the original strict parse failed.
// Zod clones/strips handoff here; no projected candidate can leave this helper.
const diagnosticTasks=z.array(taskSchema.omit({handoff:true})).min(1).max(50);
const legacyDiagnostic=organizationCandidateSchema.extend({tasks:diagnosticTasks});
const routingDiagnostic=organizationCandidateV2Schema.extend({tasks:diagnosticTasks});
export function organizationDraftDiagnostics(raw:unknown,routing:boolean,policy:Policy,models:Model[]):string[]{
 const parsed=(routing?routingDiagnostic:legacyDiagnostic).safeParse(raw);
 if(!parsed.success)return [];
 const data=parsed.data;
 const department='department' in data?data.department:data.target.kind==='new'?data.target.department:undefined;
 if(!department)return []; // Existing employees require the original authorized/versioned resolver.
 // Template/delivery checks depend on handoff evidence and must wait for a full valid draft.
 const plan:Plan={agents:department.agents,rationale:data.rationale,tasks:data.tasks};
 // validatePlan groups these same file errors; keep the individual findings once.
 const groupedContracts=taskContractErrors(plan.tasks).join('；');
 const validationErrors=validatePlan(plan,policy,models,false).errors.filter(error=>error!==groupedContracts);
 return [...new Set([...validationErrors,...organizationTaskContractErrors(plan.tasks,plan.agents)])];
}
