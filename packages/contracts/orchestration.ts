import {z} from 'zod';
import type {Plan} from './index.ts';

export const orchestrationSchema=z.object({pattern:z.enum(['single','pipeline','parallel']),rationale:z.string().trim().min(1).max(2000)}).strict();
export const deliveryCriterionSchema=z.object({
 id:z.string().trim().min(1).max(80),description:z.string().trim().min(1).max(2000),
 producerTaskIds:z.array(z.string().min(1).max(80)).min(1).max(50),
 checkTaskId:z.string().min(1).max(80),checkCriteriaIndexes:z.array(z.number().int().min(0)).min(1).max(30),
 independent:z.boolean(),
}).strict();

/** Structural coverage only; semantic correctness still requires evidence and review. */
export function deliveryCriteriaErrors(plan:Pick<Plan,'tasks'|'deliveryCriteria'>):string[]{
 const errors:string[]=[],seen=new Set<string>(),byId=new Map(plan.tasks.map(t=>[t.id,t]));
 for(const criterion of plan.deliveryCriteria??[]){
  const fail=(reason:string)=>errors.push(`${criterion.id}: ${reason}`);
  if(seen.has(criterion.id))fail('交付标准 ID 重复');seen.add(criterion.id);
  const check=byId.get(criterion.checkTaskId);
  if(!check){fail(`检查任务 ${criterion.checkTaskId} 不存在`);continue;}
  const upstream=new Set<string>(),pending=[...check.dependencies];
  while(pending.length){const id=pending.pop()!;if(upstream.has(id))continue;upstream.add(id);pending.push(...(byId.get(id)?.dependencies??[]));}
  if(upstream.has(check.id))fail(`检查任务 ${check.id} 的依赖存在环`);
  if(new Set(criterion.producerTaskIds).size!==criterion.producerTaskIds.length)fail('产出任务重复');
  for(const id of criterion.producerTaskIds){
   const producer=byId.get(id);
   if(!producer)fail(`产出任务 ${id} 不存在`);
   else{
    if(!upstream.has(id)||id===check.id)fail(`检查任务 ${check.id} 必须在产出任务 ${id} 之后`);
    if(criterion.independent&&producer.assigneeId===check.assigneeId)fail(`检查任务 ${check.id} 必须由不同于 ${id} 作者的员工承担`);
   }
  }
  if(new Set(criterion.checkCriteriaIndexes).size!==criterion.checkCriteriaIndexes.length||criterion.checkCriteriaIndexes.some(i=>!Number.isInteger(i)||i<0||i>=check.acceptanceCriteria.length))fail(`检查任务 ${check.id} 的验收条目索引无效或重复`);
 }
 return errors;
}
