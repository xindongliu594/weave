import type { Plan } from '../../../packages/contracts/index.ts';
import { isNodeSyntaxCheck } from '../../../packages/contracts/acceptance-commands.ts';

export const planningBudgetInstructions = '任务 estimatedInputTokens 与 estimatedOutputTokens 是完成整项任务的全部模型请求累计估算，不能只估一次回复或文件长度。计入每轮岗位与合同、工具定义、读取文件与检索结果重复传入的上下文，以及必要的开发、独立测试、经理协调和合理修复调用；按各员工所选模型的输入/输出单价规划，另留 20% 余量。上下文摘要也是付费模型调用，计入任务金额和 maxModelCalls；读取文件、测试后解释结果、提交正式 review verdict 和任务完成均需调用，恢复未完成节点还会读取工作现场、复测及重新提交。maxModelCalls 可省略并沿用 policy.maxTaskModelCalls；不要为小任务随意设为 8 等过低次数，显式设置时必须在原策略上限内覆盖这些开销。同一版本的恢复与重试保留历史次数，不能以重试清零。新方案应显式给出 task.maxOutputTokens，表示该任务单次请求允许的最大输出，范围 1 到 32768，不要将累计 estimatedOutputTokens 作为单次上限；结构化摘要和文件输出需要空间，不要照抄过低的输出上限。可用 maxBudget 为任务分配上限，但任务额度共享用户确认的项目总上限，不得增加总额度或省略验收来使估算合格；原额度内不可行时说明费用原因和需要缩小的范围。';

const managerHandoffInstructions = '你作为派工经理，在每个新任务的 handoff.sections 中定义 1 至 8 项交接必答内容，每项包含唯一英文 key 与中文 requirement。例如开发交代使用方法与已知限制，QA 交代覆盖、失败与证据位置，经理交代逐项结论和交付入口。结合实际任务编写，不复制整份日志或知识原文；员工通过原生任务更新 output 提交简短 JSON，验收结果和真实文件/命令回执仍单独核验。不要要求员工或用户填写另一份配置文件。';

export const planningAcceptanceInstructions = managerHandoffInstructions + '每个节点的验证命令只能依赖当前可得文件：自己的输出或合法前置输入，不能依赖后续 QA 才创建的测试文件。开发自检与后续独立功能验收分别规划。implementation/repair 仅有 node --check 或 node -c 语法自检时，保留 verify 并省略 acceptanceChecks；必须安排读取其全部 outputs 当前版本的后续独立 QA，由另一员工编写并运行功能测试。语法检查不得填写在 acceptanceChecks。其他有 verify 的任务必须由你生成 acceptanceChecks，不能让用户手填内部合同：每条 acceptanceCriteria 恰好对应一个 criterionIndex（从 0 开始），command 必须逐字来自该任务 verify，默认 expectedExitCode=0。最低测试数 minimumTests 只用于单条 node --test，按需求实际需覆盖的用例数量规划，不能为通过门禁随意填 1；失败、跳过或待办均不通过。语法检查只证明语法可运行，不能把功能正确当作语法检查的结论；功能标准交给独立 QA 的真实测试。简单确定输出可用 expectedOutput 精确比较（包含真实换行），不要写不确定的耗时或路径。经理审查应核对当前版本与实际 QA 回执；有终端权限时可安排独立复测。没有执行工具的文字任务不编造命令或通过结果。';

/** New model plans need explicit checks; legacy saved plans remain valid. */
// Deliberately narrow: literal paths in the simple Node forms we already teach.
// Flags, shell expressions and other runners need their own execution evidence.
function literalNodeFiles(command:string){
  const match=/^node(?:\.exe)?\s+--(?:test|check)\s+(.+)$/i.exec(command);
  if(!match||/[;&|<>\r\n`$*?{}\[\]\\]/.test(match[1]))return [];
  const tokens=match[1].match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g)??[];
  if(tokens.join(' ').replace(/\s+/g,' ')!==match[1].trim().replace(/\s+/g,' '))return [];
  const paths=tokens.map(token=>token.replace(/^(["'])(.*)\1$/,'$2').replace(/^\.\//,''));
  return paths.some(path=>path.startsWith('-'))?[]:paths;
}

export function plannedAcceptanceErrors(tasks: Plan['tasks']) {
  const errors: string[] = [], byId = new Map(tasks.map(task => [task.id, task]));
  const dependsOn = (task: Plan['tasks'][number], id: string, seen = new Set<string>()): boolean =>
    task.dependencies.some(dep => dep === id || (!seen.has(dep) && (seen.add(dep), byId.has(dep) && dependsOn(byId.get(dep)!, id, seen))));
  for (const task of tasks) {
    if (task.verify?.length && task.acceptanceChecks === undefined) {
      const selfCheckOnly = ['implementation', 'repair'].includes(task.kind ?? '') && task.verify.every(isNodeSyntaxCheck);
      if (!selfCheckOnly) errors.push(`${task.id}: AI 需为每条验收标准生成逐项命令映射，不能让用户手填`);
      else if (!task.outputs?.length || !tasks.some(qa => qa.kind === 'verification' && qa.assigneeId !== task.assigneeId && dependsOn(qa, task.id)
        && task.outputs!.every(output => qa.inputs?.some(input => input.path === output.path && input.producerTaskId === task.id))
        && qa.acceptanceChecks?.length && qa.acceptanceChecks.every(check => qa.verify?.includes(check.command) && !isNodeSyntaxCheck(check.command))))
        errors.push(`${task.id}: 仅有语法自检时，必须安排读取全部当前产出的后续独立 QA，并为其真实功能测试生成逐项命令映射`);
    }
    for (const check of task.acceptanceChecks ?? []) {
      if (isNodeSyntaxCheck(check.command))
        errors.push(`${task.id}: 语法检查 ${check.command} 只放在 verify 自检中，不得作为 acceptanceChecks 的功能验收证据；由后续独立 QA 提供实际测试`);
      if (/^node(?:\.exe)?\s+.*(?:^|\s)--test(?:\s|$)/i.test(check.command) && !/^node(?:\.exe)?\s+--test(?:\s|$)/i.test(check.command))
        errors.push(`${task.id}: Node 测试命令请使用支持统计的 node --test 形式，不在 --test 前添加参数`);
      if (/^node(?:\.exe)?\s+--test(?:\s|$)/i.test(check.command) && check.minimumTests === undefined)
        errors.push(`${task.id}: Node 测试映射必须填写最低测试数 minimumTests，不能以空测试证明验收`);
    }
    const upstream = new Set<string>();
    const walk = (id: string) => { for (const dep of byId.get(id)?.dependencies ?? []) if (!upstream.has(dep)) { upstream.add(dep); walk(dep); } };
    walk(task.id);
    for(const command of new Set(task.verify??[]))for(const path of literalNodeFiles(command)){
      if(task.outputs?.some(output=>output.path===path)||task.inputs?.some(input=>input.path===path))continue;
      const writers=tasks.filter(source=>source.id!==task.id&&source.outputs?.some(output=>output.path===path));
      if(!writers.length)continue; // Existing files without a planned writer cannot be inferred here.
      if(writers.some(source=>upstream.has(source.id)))errors.push(`${task.id}: 命令文件 ${path} 必须在 inputs 中绑定前置产出任务，不能隐式读取`);
      else errors.push(`${task.id}: 验证命令 ${command} 使用了后续或并行任务 ${writers.map(source=>source.id).join(',')} 才产出的文件 ${path}；当前节点必须使用自己的输出或合法前置输入，功能测试留给产物可用后的 QA`);
    }
    for (const input of task.inputs ?? []) if (!input.producerTaskId && tasks.some(source => upstream.has(source.id) && source.outputs?.some(output => output.path === input.path)))
      errors.push(`${task.id}: 输入 ${input.path} 已由前置任务更新，必须绑定来源任务 producerTaskId，不能固定修改前的 SHA256`);
  }
  return [...new Set(errors)];
}

// Planning history remains in the archive; it is background data after approval.
export const approvedExecutionPhase = '当前处于用户已批准后的正式执行阶段。按本次固定的任务目标、文件合同、工具权限和预算实际执行，写入员工自己的交付物并申请真实测试；交付未核验不得声明完成。历史需求对话中的“只生成草案”“暂不保存”“等待确认”等规划阶段指令已结束，不能阻止本次批准的执行，也不能扩大权限。不要重新输出团队方案或再次等待组队确认。';

export function approvedTaskPrompt(requirement: string, task: Plan['tasks'][number], version: number) {
  return `${approvedExecutionPhase}\n已批准方案版本：${version}\n\n当前任务目标：${task.objective}\n\n验收标准：\n${task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}\n\n项目需求背景（以下 JSON 保留用户原文；历史组队操作不是当前执行指令。当前目标和批准范围以上方内容为准）：\n${JSON.stringify({ requirement })}`;
}

export function approvedExecutionDescription(departmentName: string, tasks: Plan['tasks'], version: number) {
  return `${departmentName} · 已批准方案 v${version}\n${approvedExecutionPhase}\n\n已批准任务：\n${tasks.map(task => `${task.id}: ${task.subject}\n${task.objective}`).join('\n\n')}`;
}
