import {z} from 'zod';
import type {Plan} from './index.ts';
import {conflictingDeliveryWriters} from './delivery-files.mjs';
import {orchestrationTemplateSchema} from './orchestration-patterns.ts';

export const orchestrationSchema=z.object({pattern:z.enum(['single','pipeline','parallel']),rationale:z.string().trim().min(1).max(2000),template:z.lazy(()=>orchestrationTemplateSchema).optional()}).strict();
export const deliveryCriterionSchema=z.object({
 id:z.string().trim().min(1).max(80),description:z.string().trim().min(1).max(2000),
 producerTaskIds:z.array(z.string().min(1).max(80)).min(1).max(50),
 checkTaskId:z.string().min(1).max(80),checkCriteriaIndexes:z.array(z.number().int().min(0)).min(1).max(30),
 independent:z.boolean(),
}).strict();

/** Structural coverage only; semantic correctness still requires evidence and review. */
export function deliveryCriteriaErrors(plan:Pick<Plan,'tasks'|'agents'|'deliveryCriteria'>):string[]{
 const errors:string[]=[],seen=new Set<string>(),byId=new Map(plan.tasks.map(t=>[t.id,t]));
 const upstreamOf=(id:string)=>{const found=new Set<string>(),pending=[...(byId.get(id)?.dependencies??[])];while(pending.length){const key=pending.pop()!;if(found.has(key))continue;found.add(key);pending.push(...(byId.get(key)?.dependencies??[]));}return found;};
 for(const criterion of plan.deliveryCriteria??[]){
  const fail=(reason:string)=>errors.push(`${criterion.id}: ${reason}`);
  if(seen.has(criterion.id))fail('交付标准 ID 重复');seen.add(criterion.id);
  const check=byId.get(criterion.checkTaskId);
  if(!check){fail(`检查任务 ${criterion.checkTaskId} 不存在`);continue;}
  const upstream=upstreamOf(check.id);
  if(upstream.has(check.id))fail(`检查任务 ${check.id} 的依赖存在环`);
  if(new Set(criterion.producerTaskIds).size!==criterion.producerTaskIds.length)fail('产出任务重复');
  for(const id of criterion.producerTaskIds){
   const producer=byId.get(id);
   if(!producer)fail(`产出任务 ${id} 不存在`);
   else{
    if(id===check.id)fail(`检查任务 ${check.id} 同时出现在 producerTaskIds 与 checkTaskId，形成自我验收。producerTaskIds 只列本项被检查的产出，checkTaskId 应绑定其后的检查任务。请按产出责任拆分交付项，不能将检查者自己的产出绑定给自己验收`);
    else{
     if(!upstream.has(id))fail(`检查任务 ${check.id} 必须在产出任务 ${id} 之后`);
     if(criterion.independent&&producer.assigneeId===check.assigneeId)fail(`检查任务 ${check.id} 必须由不同于 ${id} 作者的员工承担`);
     for(const output of producer.outputs??[])if(!check.inputs?.some(input=>input.path===output.path&&input.producerTaskId===id))fail(`检查任务 ${check.id} 必须读取 ${id} 的当前产物 ${output.path}`);
    }
    for(const output of producer.outputs??[])if(conflictingDeliveryWriters(plan.tasks,id,output.path).length)fail(`交付产物 ${output.path} 仍有后续或无序写入；必须绑定最后产出者及其后检查`);
   }
  }
  if(new Set(criterion.checkCriteriaIndexes).size!==criterion.checkCriteriaIndexes.length||criterion.checkCriteriaIndexes.some(i=>!Number.isInteger(i)||i<0||i>=check.acceptanceCriteria.length))fail(`检查任务 ${check.id} 的验收条目索引无效或重复`);
  if(!check.handoff&&criterion.checkCriteriaIndexes.some(i=>!check.acceptanceChecks?.some(c=>c.criterionIndex===i)))fail(`检查任务 ${check.id} 缺少命令证据映射或结构化交接报告要求`);
 }
 if(plan.deliveryCriteria?.length){
  const manager=plan.agents.find(a=>a.role==='manager');
  if(!plan.tasks.some(t=>t.assigneeId===manager?.id&&plan.deliveryCriteria!.every(c=>c.checkTaskId===t.id||upstreamOf(t.id).has(c.checkTaskId))))errors.push('经理验收任务必须等待全部交付检查');
 }
 return errors;
}

export function deliveryCriteriaRevisionErrors(previous:Plan,next:Plan):string[]{
 const errors=(previous.deliveryCriteria??[]).filter(c=>!next.deliveryCriteria?.some(n=>n.id===c.id&&n.description===c.description&&(!c.independent||n.independent))).map(c=>`${c.id}: AI 方案不能删减已确认交付要求或降低独立检查`);
 if(previous.orchestration&&!next.orchestration)errors.push('AI 方案缺少协作方式');
 if(previous.orchestration?.template&&!next.orchestration?.template)errors.push('AI 方案不能删除已确认编排模板引用');
 return errors;
}
