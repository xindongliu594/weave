import type { ReactNode } from 'react';
import type { Plan } from '../../../packages/contracts/index.ts';

type Task = Plan['tasks'][number];
const money = (value: number) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
function BudgetField({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}<small>{hint}</small></label>;
}

export function PlanTaskBudgetSummary({task,defaultMaxCalls}:{task:Task;defaultMaxCalls:number}) {
  return <div className="lower-small" role="group" aria-label="任务预算与 Token">
    <p className="subcopy">任务费用上限：{task.maxBudget===undefined?'共用项目预算':money(task.maxBudget)} · 调用上限：{task.maxModelCalls??defaultMaxCalls} 次{task.maxModelCalls===undefined?'（策略默认）':''}</p>
    <p className="subcopy">整项任务累计预计 Token：输入 {task.estimatedInputTokens.toLocaleString('zh-CN')} · 输出 {task.estimatedOutputTokens.toLocaleString('zh-CN')}（含多轮、上下文与工具）</p>
    <p className="subcopy">单次最大输出 Token：{task.maxOutputTokens===undefined?'沿用已批准模型路线':`${task.maxOutputTokens.toLocaleString('zh-CN')}（任务显式上限，模型路线或本次请求可能更小）`}</p>
  </div>;
}

export function PlanTaskBudgetFields({task,maxTaskModelCalls,update}:{task:Task;maxTaskModelCalls:number;update:(patch:Partial<Task>)=>void}) {
  return <div className="form-grid">
    <BudgetField label="任务费用上限（USD，可选）" hint="留空共用项目预算；填写后同时受任务和项目上限约束，不为后续阶段锁定额度。"><input name="maxBudget" type="number" min={.000001} max={10000} step="any" value={task.maxBudget??''} onChange={event=>update({maxBudget:event.target.value===''?undefined:event.target.valueAsNumber})}/></BudgetField>
    <BudgetField label="任务调用次数上限（可选）" hint={`留空使用策略上限 ${maxTaskModelCalls} 次；重试不清零。`}><input name="maxModelCalls" type="number" min={1} max={maxTaskModelCalls} value={task.maxModelCalls??''} onChange={event=>update({maxModelCalls:event.target.value===''?undefined:event.target.valueAsNumber})}/></BudgetField>
    <BudgetField label="累计预计输入 Token" hint="整项任务累计，包含多轮请求反复传入的岗位、合同、上下文与工具。"><input name="estimatedInputTokens" required type="number" min={0} value={task.estimatedInputTokens} onChange={event=>update({estimatedInputTokens:event.target.valueAsNumber})}/></BudgetField>
    <BudgetField label="累计预计输出 Token" hint="整项任务所有模型请求的累计输出，用于静态估算，不是单次输出上限。"><input name="estimatedOutputTokens" required type="number" min={1} value={task.estimatedOutputTokens} onChange={event=>update({estimatedOutputTokens:event.target.valueAsNumber})}/></BudgetField>
    <BudgetField label="单次最大输出 Token（可选）" hint="留空沿用已批准模型路线；填写 1–32768 的整数。实际输出还受模型路线和本次请求上限约束；不会保证余下任务可付。"><input name="maxOutputTokens" type="number" min={1} max={32768} step={1} value={task.maxOutputTokens??''} onChange={event=>update({maxOutputTokens:event.target.value===''?undefined:event.target.valueAsNumber})}/></BudgetField>
  </div>;
}
