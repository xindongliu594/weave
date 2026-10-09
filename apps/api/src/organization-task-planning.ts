import type { Plan } from '../../../packages/contracts/index.ts';

/** A contract example, never a generated candidate or employee deliverable. */
export const organizationPlanningTaskExample: Plan['tasks'] = [
  { id: 'develop', subject: '实现 CLI 与使用说明', objective: '实现用户要求的小型 CLI，并说明使用方法。', assigneeId: 'developer', dependencies: [],
    acceptanceCriteria: ['CLI 满足用户要求，语法检查通过，使用说明完整'], estimatedInputTokens: 60000, estimatedOutputTokens: 6000, maxOutputTokens: 1500,
    kind: 'implementation', inputs: [], outputs: [{ path: 'cli.mjs', format: 'text' }, { path: 'README.md', format: 'text' }], inScope: ['cli.mjs', 'README.md'], verify: ['node --check cli.mjs'] },
  { id: 'verify', subject: '独立测试 CLI', objective: '读取开发交付，另行编写并实际执行独立测试。', assigneeId: 'qa', dependencies: ['develop'],
    acceptanceCriteria: ['独立测试覆盖用户要求及边界，实际命令退出码为 0'], estimatedInputTokens: 45000, estimatedOutputTokens: 4000, maxOutputTokens: 1000,
    kind: 'verification', inputs: [{ path: 'cli.mjs', producerTaskId: 'develop' }], outputs: [{ path: 'cli.test.mjs', format: 'text' }], inScope: ['cli.test.mjs'], verify: ['node --test cli.test.mjs'] },
  { id: 'accept', subject: '经理只读验收', objective: '现有经理读取开发和 QA 交付，核对宿主记录的真实测试证据，通过任务完成回复给出结论。', assigneeId: 'manager', dependencies: ['develop', 'verify'],
    acceptanceCriteria: ['核对用户要求、当前交付版本与真实 QA 结果，明确通过项和未完成项'], estimatedInputTokens: 20000, estimatedOutputTokens: 1500, maxOutputTokens: 800,
    kind: 'review', reviewedTaskId: 'develop', inputs: [{ path: 'cli.mjs', producerTaskId: 'develop' }, { path: 'README.md', producerTaskId: 'develop' }, { path: 'cli.test.mjs', producerTaskId: 'verify' }], outputs: [], maxReworkRounds: 0 },
];

export const organizationTaskPlanningInstructions = [
  '生成 candidate 前逐项自检任务合同；这些字段由你规划，不要让用户填写内部字段。只使用 application_constraints 允许的模型、工具、人数和预算。',
  'implementation/repair：必须显式给出非空 inScope 和 verify，以及 inputs/outputs（无输入用 []）。inScope/outOfScope 只能是工作区相对路径，inScope 覆盖全部 outputs，outOfScope 不得包含 outputs。verify 是实际可执行的精确 shell 命令，不是“运行测试”等说明；执行人必须有 terminal/terminal_test。',
  'repair 还需绑定已知实现/修复的 sourceTaskId 与真实问题编号 sourceFindingIds，并直接依赖 sourceTaskId；不要为新方案虚构返修问题或来源。',
  'verification：独立 QA 可读取开发产物、写自己的测试文件并执行 verify；不能修改开发文件。写入工具权限覆盖 outputs，filesystem 权限覆盖 inputs。产物输入只填 path 与 producerTaskId，来源任务须声明同一路径输出；不要编造 SHA256。',
  'review：只读验收实现或修复，reviewedTaskId 指向被审查的 implementation/repair，并在 dependencies 中直接列出它。还需等待 QA 时同时直接列出 QA；本次任务产物 inputs 的来源都必须是前置任务。审查人与实现者不同，outputs 必须为 []，不得创建 delivery.md 或其它交付文件，结论通过任务完成回复返回。maxReworkRounds 固定 0。',
  '独立审查可以由团队中已有的经理或 QA 承担，不是额外增加一位员工。例如三人团队就是开发、QA、经理；经理可在开发和 QA 完成后承担只读验收。同一 QA 也可负责 verification 与 review 两个节点，节点数不等于员工数。若需要经理编写文件，应另设符合写入权限的 work/integration 任务，不能把写文件放入 review。',
  '未授权执行工具时仅用 requirements/work 做文字讨论，不输出执行合同。以下三节点仅示范合同结构，不是固定方案、预算建议或已生成交付物；任务、路径、验收标准、估算与员工 ID 应按用户需求及当前目录重新规划。不能照抄示例 Token 估算来规避费用校验：',
  JSON.stringify(organizationPlanningTaskExample),
].join('\n');
