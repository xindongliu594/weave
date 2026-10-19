import type { Plan } from '../../../packages/contracts/index.ts';

/** A contract example, never a generated candidate or employee deliverable. */
export const organizationPlanningTaskExample: Plan['tasks'] = [
  { id: 'develop', subject: '实现 CLI 与使用说明', objective: '实现用户要求的小型 CLI，并说明使用方法。', assigneeId: 'developer', dependencies: [],
    acceptanceCriteria: ['CLI 语法检查通过；功能由后续独立 QA 验证'], acceptanceChecks: [{criterionIndex:0,command:'node --check cli.mjs'}], estimatedInputTokens: 60000, estimatedOutputTokens: 6000, maxOutputTokens: 4096,
    kind: 'implementation', inputs: [], outputs: [{ path: 'cli.mjs', format: 'text' }, { path: 'README.md', format: 'text' }], inScope: ['cli.mjs', 'README.md'], verify: ['node --check cli.mjs'] },
  { id: 'verify', subject: '独立测试 CLI', objective: '读取开发交付，另行编写并实际执行独立测试。', assigneeId: 'qa', dependencies: ['develop'],
    acceptanceCriteria: ['独立测试覆盖用户要求及边界，至少 4 项真实测试通过'], acceptanceChecks: [{criterionIndex:0,command:'node --test cli.test.mjs',minimumTests:4}], estimatedInputTokens: 45000, estimatedOutputTokens: 4000, maxOutputTokens: 4096,
    kind: 'verification', inputs: [{ path: 'cli.mjs', producerTaskId: 'develop' }, { path: 'README.md', producerTaskId: 'develop' }], outputs: [{ path: 'cli.test.mjs', format: 'text' }], inScope: ['cli.test.mjs'], verify: ['node --test cli.test.mjs'] },
  { id: 'accept', subject: '经理只读验收', objective: '现有经理读取开发和 QA 交付，核对宿主记录的真实测试证据，通过任务完成回复给出结论。', assigneeId: 'manager', dependencies: ['develop', 'verify'],
    acceptanceCriteria: ['核对用户要求、当前交付版本与真实 QA 结果，明确通过项和未完成项'], estimatedInputTokens: 20000, estimatedOutputTokens: 1500, maxOutputTokens: 4096,
    kind: 'review', reviewedTaskId: 'develop', inputs: [{ path: 'cli.mjs', producerTaskId: 'develop' }, { path: 'README.md', producerTaskId: 'develop' }, { path: 'cli.test.mjs', producerTaskId: 'verify' }], outputs: [], maxReworkRounds: 0,
    handoff:{sections:[{key:'verdict',requirement:'按需求核对当前实现、说明和独立测试证据，逐项说明通过或缺口。'}]} },
];

const organizationPlanningDeliveryExample:Plan['deliveryCriteria']=[
 {id:'function',description:'QA独立测试开发实现的功能与使用方式',producerTaskIds:['develop'],checkTaskId:'verify',checkCriteriaIndexes:[0],independent:true},
 {id:'package',description:'经理核对包含实现、说明和测试文件的完整交付',producerTaskIds:['develop','verify'],checkTaskId:'accept',checkCriteriaIndexes:[0],independent:true},
];

// Rework gates every consumer of the implementation, including QA. Keep this
// example separate from the historical no-rework develop → QA → review layout.
const reviewRepairTaskExample: Plan['tasks'] = [
  structuredClone(organizationPlanningTaskExample[0]),
  {...structuredClone(organizationPlanningTaskExample[2]),id:'review',subject:'独立审查并按问题限定返工',assigneeId:'qa',dependencies:['develop'],
    objective:'只读审查当前实现与说明；记录真实问题，最多允许一轮有范围的修复与复审。后续 QA 等审查完成再读取产物。',
    acceptanceCriteria:['按需求核对实现及说明，逐项报告依据、具体问题和结论'],
    handoff:{sections:[{key:'findings',requirement:'逐项提供需求、当前实现版本、核对依据、真实问题和审查结论；不能把尚未运行的 QA 写成已通过。'}]},
    inputs:[{path:'cli.mjs',producerTaskId:'develop'},{path:'README.md',producerTaskId:'develop'}],maxReworkRounds:1},
  {...structuredClone(organizationPlanningTaskExample[1]),dependencies:['develop','review']},
  {id:'accept',subject:'经理汇总验收',objective:'等待独立审查和 QA，读取当前实现、使用说明和测试证据后给出验收结论。',assigneeId:'manager',dependencies:['review','verify'],
    acceptanceCriteria:['逐项核对需求、当前文件版本、审查结论和真实测试证据，说明通过项与缺口'],
    kind:'work',inputs:[{path:'cli.mjs',producerTaskId:'develop'},{path:'README.md',producerTaskId:'develop'},{path:'cli.test.mjs',producerTaskId:'verify'}],outputs:[],
    handoff:{sections:[{key:'verdict',requirement:'按验收要求给出结论、文件版本和实际测试证据；未验证的明确列出。'}]},estimatedInputTokens:20000,estimatedOutputTokens:1500,maxOutputTokens:4096},
];

const outputPermissionInstructions='按每位员工各自授权选择工作：filesystem 仅提供读取能力，不授予写文件权限；所有 outputs（包括 Markdown）都要求该员工有适用写入工具。普通文本/JSON 可使用 artifact_write 或已授权且合同允许写入的 terminal/terminal_test；其他原生工具按已展示元数据所支持的格式工作，不能根据工具名称猜测写入能力。有文档创建工具不代表可以写 JSON。仅预览方案不等于没有工具授权，可以规划 allowedTools 已允许的文件合同，但本轮不执行。能力不足可以选择其他获授权员工或清楚说明缺口，不能凭部门总工具清单扩大个人权限。';
const handoffShapeInstructions='handoff 只含 sections:[{key,requirement}]；estimatedInputTokens、estimatedOutputTokens、maxOutputTokens、maxBudget、maxModelCalls 都属于任务，与 handoff 同级，不能放入 handoff 内。';
function taskPlanningInstructions(templatePreview=false){return [
  '生成 candidate 前逐项自检任务合同；这些字段由你规划，不要让用户填写内部字段。只使用 application_constraints 允许的模型、工具、人数和预算。',
  outputPermissionInstructions,handoffShapeInstructions,
  'implementation/repair：必须显式给出非空 inScope 和 verify，以及 inputs/outputs（无输入用 []）。inScope/outOfScope 只能是工作区相对路径，inScope 覆盖全部 outputs，outOfScope 不得包含 outputs。verify 是实际可执行的精确 shell 命令，不是“运行测试”等说明；执行人必须有 terminal/terminal_test。',
  'repair 还需绑定已知实现/修复的 sourceTaskId 与真实问题编号 sourceFindingIds，并直接依赖 sourceTaskId；不要为新方案虚构返修问题或来源。',
  'verification：独立 QA 可读取开发产物、写自己的测试文件并执行 verify；不能修改开发文件。写入工具权限覆盖 outputs，filesystem 权限覆盖 inputs。产物输入只填 path 与 producerTaskId，来源任务须声明同一路径输出；不要编造 SHA256。',
  'review：只读验收实现或修复，reviewedTaskId 指向被审查的 implementation/repair，并在 dependencies 中直接列出它。maxReworkRounds=0 且需要先等 QA 时同时直接列出 QA；本次任务产物 inputs 的来源都必须是前置任务。审查人与实现者不同，outputs 必须为 []，不得创建 delivery.md 或其它交付文件，结论通过任务完成回复返回。'+(templatePreview?'无 orchestration.template 的旧方案：maxReworkRounds=0；选择 orchestration.template.id=review_repair 时，绑定的独立审查任务 maxReworkRounds 必须为 1..2，仅预览、不授予执行权。':'maxReworkRounds 固定 0。'),
  '独立审查可以由团队中已有的经理或 QA 承担，不是额外增加一位员工。例如三人团队就是开发、QA、经理；零返工时经理可在开发和 QA 完成后承担只读验收。同一 QA 也可负责 verification 与 review 两个节点，节点数不等于员工数。若需要经理编写文件，应另设符合写入权限的 work/integration 任务，不能把写文件放入 review。',
  'deliveryCriteria 的 producerTaskIds 是本条标准被检查的产出，不是全部参与节点。QA 自己编写并运行测试是正常工作：功能标准绑定 develop→verify，不能把 verify 也放进这条的 producerTaskIds；若用户要求最终交付包含测试文件，可另绑 develop+verify→accept，由现有经理读取完整产物和QA证据后验收。不要仅因QA生成日志就新增用户未要求的交付标准，也不要为经理自己的结论递归安排验收。每项检查者仍须读取全部绑定产出，并满足独立性、依赖与证据要求。',
  ...(templatePreview?['启用有界返工时，review.maxReworkRounds>0；所有消费该实现产物的下游（包括 QA）必须等待此 review，不能让 QA→review 再用同一 review 触发返工。示例为 review_repair 的 develop→review→verify→accept，审查与 QA 由同一独立员工分两节点承担，最后经理验收；只规划原始节点，不虚构 repair/sourceFindingIds。其它模板与旧布局仍可使用零返工的开发→QA→经理审查。']:[]),
  '未授权执行工具时仅用 requirements/work 做文字讨论，不输出执行合同。以下节点仅示范合同结构，不是固定方案、预算建议或已生成交付物；任务、路径、验收标准、估算与员工 ID 应按用户需求及当前目录重新规划。不能照抄示例 Token 估算来规避费用校验：',
  '以下配套交付映射假设用户要求实现、说明和测试文件。它与后面的任务示例对应；实际交付项须按用户要求生成，不得直接替换真实方案：',
  JSON.stringify({deliveryCriteria:organizationPlanningDeliveryExample}),
  JSON.stringify(templatePreview?reviewRepairTaskExample:organizationPlanningTaskExample),
].join('\n');}
export const organizationTaskPlanningInstructions = taskPlanningInstructions();

/** Code-review examples are misleading when the granted tools only produce documents. */
export function organizationTaskInstructionsFor(tools:readonly string[],templatePreview=false){
 if(tools.some(tool=>['terminal','terminal_test'].includes(tool)))return taskPlanningInstructions(templatePreview);
 return [
  '当前没有终端授权。文字分析、文档制作、独立内容核对及经理验收都使用 kind=work；不要将普通办公验收标成 review（review 专指对 implementation/repair 的代码审查），不要编造 verify 命令。没有文件工具时仅规划文字内容，不承诺写文件。',
  outputPermissionInstructions,handoffShapeInstructions,
  '实际文件任务必须显式声明 outputs:[{path:"相对路径"}]。每个 inputs 的 path 必须与来源任务 outputs 的 path 完全一致，producerTaskId 必须是声明该输出的前置任务 ID；不能写来源员工ID或不存在任务。DOCX 等二进制产物省略 format；JSON 写 format:"json"。',
  '独立核对者读取作者当前产物，填写可核验 acceptanceCriteria，并用 handoff.sections 要求事实、结论和证据。deliveryCriteria 绑定作者任务与其后的检查任务，禁止自检或循环依赖；最终经理结论是检查结果，不额外生成需要检查自身的标准。经理应等必要检查结束，读取所需原产物与QA证据。',
  '例如来源任务 id=produce 的 outputs:[{path:"result.json",format:"json"}]，下游输入必须是 inputs:[{path:"result.json",producerTaskId:"produce"}]、dependencies:["produce"]。例子只说明字段关系，不能照抄为本次方案或已生成交付物。',
 ].join('\n');
}
