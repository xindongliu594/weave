import { z } from 'zod';
import { departmentSchema, taskSchema, type DepartmentInput, type Plan } from './index.ts';
import {orchestrationSchema,deliveryCriterionSchema} from './orchestration.ts';
export const organizationCandidateSchema=z.object({department:departmentSchema,rationale:z.string().trim().min(1).max(5000),tasks:z.array(taskSchema).min(1).max(50)});
export const organizationCandidateV2Schema=z.object({
 schemaVersion:z.literal(2),
 target:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('existing'),departmentId:z.string().min(1).max(100),departmentVersion:z.number().int().positive(),primaryAgentIds:z.array(z.string().min(1).max(180)).min(1).max(6),collaboratingAgents:z.array(z.object({departmentId:z.string().min(1).max(100),departmentVersion:z.number().int().positive(),agentId:z.string().min(1).max(180)}).strict()).max(5)}).strict(),
  z.object({kind:z.literal('new'),department:departmentSchema}).strict(),
 ]),
 rationale:z.string().trim().min(1).max(5000),tasks:z.array(taskSchema).min(1).max(50),
 orchestration:orchestrationSchema,deliveryCriteria:z.array(deliveryCriterionSchema).min(1).max(50),
}).strict();
export type OrganizationCandidateV2=z.infer<typeof organizationCandidateV2Schema>;
/** A reviewable template DAG; it is not presented as model planning. */
export function templatePlan(department:DepartmentInput,requirement:string):Plan {
 const manager=department.agents.find(a=>a.role==='manager')!;
 const members=department.agents.filter(a=>a.role!=='manager');
 const tasks:Plan['tasks']=members.map((agent,index)=>({
  id:'work-'+(index+1),subject:agent.title+'交付',objective:requirement+'\n本任务只完成 '+agent.title+' 的职责范围，并交接已验证的结果。',assigneeId:agent.id,
  dependencies:index?['work-'+index]:[],acceptanceCriteria:[agent.outputFormat||'交付与岗位职责对应的材料','说明依据、实际验证结果和未完成事项'],estimatedInputTokens:4000,estimatedOutputTokens:2000,
 }));
 tasks.push({id:'deliver',subject:'经理验收与汇总',objective:requirement,assigneeId:manager.id,dependencies:tasks.length?[tasks.at(-1)!.id]:[],acceptanceCriteria:['逐项核对用户需求和成员交付物','汇总可核验的结果、引用及剩余问题'],estimatedInputTokens:6000,estimatedOutputTokens:3000});
 return {rationale:'模板草案：按成员职责顺序交接，最后由经理验收。请按实际依赖调整后批准。',agents:department.agents,tasks};
}
