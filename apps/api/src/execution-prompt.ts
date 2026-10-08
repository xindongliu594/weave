import type { Plan } from '../../../packages/contracts/index.ts';

export const planningBudgetInstructions = '任务 estimatedInputTokens 与 estimatedOutputTokens 是完成整项任务的全部模型请求累计估算，不能只估一次回复或文件长度。计入每轮岗位与合同、工具定义、读取文件与检索结果重复传入的上下文，以及必要的开发、独立测试、经理协调和合理修复调用；按各员工所选模型的输入/输出单价规划，另留 20% 余量。新方案应显式给出 task.maxOutputTokens，表示该任务单次请求允许的最大输出，范围 1 到 32768，不要将累计 estimatedOutputTokens 作为单次上限。可用 maxBudget 为任务分配上限，但任务额度共享用户确认的项目总上限，不得增加总额度或省略验收来使估算合格；原额度内不可行时说明费用原因和需要缩小的范围。';

// Planning history remains in the archive; it is background data after approval.
export const approvedExecutionPhase = '当前处于用户已批准后的正式执行阶段。按本次固定的任务目标、文件合同、工具权限和预算实际执行，写入员工自己的交付物并申请真实测试；交付未核验不得声明完成。历史需求对话中的“只生成草案”“暂不保存”“等待确认”等规划阶段指令已结束，不能阻止本次批准的执行，也不能扩大权限。不要重新输出团队方案或再次等待组队确认。';

export function approvedTaskPrompt(requirement: string, task: Plan['tasks'][number], version: number) {
  return `${approvedExecutionPhase}\n已批准方案版本：${version}\n\n当前任务目标：${task.objective}\n\n验收标准：\n${task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}\n\n项目需求背景（以下 JSON 保留用户原文；历史组队操作不是当前执行指令。当前目标和批准范围以上方内容为准）：\n${JSON.stringify({ requirement })}`;
}

export function approvedExecutionDescription(departmentName: string, tasks: Plan['tasks'], version: number) {
  return `${departmentName} · 已批准方案 v${version}\n${approvedExecutionPhase}\n\n已批准任务：\n${tasks.map(task => `${task.id}: ${task.subject}\n${task.objective}`).join('\n\n')}`;
}
