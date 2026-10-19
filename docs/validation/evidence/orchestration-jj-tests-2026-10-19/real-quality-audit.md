# 七次真实规划输出独立审计

日期：2026-10-19。只读分析原始响应、请求、收据、API 校验结果及相关合同实现；没有修改模型答案或源码，没有联网、访问生产、重试或付费调用。

## 结论

本轮是 **7 次真实请求、7 笔已结算收据、0/7 合法预览**。失败主要发生在 JSON、字段/权限以及跨任务合同绑定；不能解释成“七次协作模式都选错”，也不能将人能读懂或人工修改后的计划计入成功。

原始费用相加为 **$0.0399408**，与 before/after 已登记费用差一致；原六笔未知收据的 ID、状态与金额逐项不变，累计占用为 $3.0484323。完成了真实规划调用与费用核对，不代表任何项目执行通过。

JSON 解析阶段失败 3 题；其余 4 题中，1 题模板 schema 失败、1 题权限拒绝、2 题跨任务合同失败。后续静态检查发现，部分答案在首个错误之后还存在其他错误，修复单一表面字段不能使全部答案有效。

## 逐题判断

| 题目 | 输出 Token / 费用 | 模式意图判断 | 实际失败及后续诊断 | 最小改进方向 |
| --- | --- | --- | --- | --- |
| sequential-report | 2432 / $0.0052938 | `pipeline` 合理。事实表→总结→独立核对→经理，角色和文件交接基本吻合需求。 | `final_acceptance` 把 `acceptance` 同时设为 producer 和 checker，还设 `independent:false`；导致自检、无法先于自身、没有读取自身当前产物。其余任务权限/文件合同本地检查通过。 | 强化“经理结论是检查结果，不把验收报告递归列为检查自己的交付要求”的现有示例；检查应绑定实际业务产出与后续独立检查者。保留原答案失败。 |
| independent-statistics | 2625 / $0.0055251 | `parallel` 合理。甲乙独立产出、独立员工汇总核对、经理验收，依赖和读入完整。 | `totals.independent:false` 触发模板要求所有交付检查独立的规则；该任务实际上由与汇总作者不同的经理检查。本地 schema、deliveryCriteriaErrors、taskContractErrors 均通过，只有模板 independent 标记规则失败。 | 给一个与现有合同一致的独立检查字段例子，说明独立性按 producer/checker 身份判定；不能把本次错误标记偷偷改成 true 后计为成功。 |
| domain-routing | 2145 / $0.0049506 | 先判断办公，再选 `pipeline` 执行整理→核对→验收，是可接受解释；不能因没有硬选 `router` 就判模式错误。 | 完整 JSON 对象之后多 **2 个 `}`**。原对象内 `orchestration`、`deliveryCriteria` 位于顶层而非 candidate；三名员工都缺 `modelId`、`tools`。即便仅去掉尾括号仍不合 schema。 | 路由开启时只呈现 V2 外层结构，明确 candidate 必填字段及员工模型/工具字段；格式诊断应指出尾部位置和层级，不自动搬字段。 |
| goal-decomposition | 2916 / $0.0058761 | 把内容研究、组织事项冻结成两路，再汇总，选 `parallel` 是合理替代，并不要求只能选 `orchestrator_workers`。 | 首个 API 拒绝是擅填 `department.dailyBudget:0.25`。另外 `deliver_acceptance` 要求先完成的 `independent_check` 检查后完成的 `manager_acceptance`，时序相反；content/logistics/independent_check 三个文件输出者只有 `filesystem`，不具备写入权限。独立检查者还参与过上游内容研究，语义上的独立性需说明，不能仅凭与最终汇总作者不同就声称完全独立。 | 新部门规划 schema 与实际禁用字段对齐；明确 filesystem 为读取权限、写文件需对应写入工具；经理验收不递归制造反向检查。 |
| bounded-code-review | 3000 / $0.0061860 | 选择 `review_repair` 符合“独立QA、审查、最多一次修复再审”的业务意图。 | 首个 schema 失败：模板缺 `reviewTaskId`，却填写 pipeline 的 `taskIds`。答案还预造 repair/reverify 节点，`repair.sourceTaskId='review'`、`sourceFindingIds=['review-finding-1']` 没有真实已知问题依据；把语法检查用于数学正确性标准也不足。另有 QA→review 与启用返工后的既有消费者门禁不兼容，详见下文，不能混同为已确认校验实现 bug。 | 复用现有 `review_repair:{reviewTaskId:...}` 合同示例；不在新规划中虚构实际问题编号。先明确现有返工合同允许的 QA/审查顺序及证据更新要求，不为本轮结果放宽门禁。 |
| fixed-shards | 2581 / $0.0055059 | 文字说明识别出 map/reduce，业务方向正确；但没有形成固定分片合同。 | 完整对象之后多 **1 个 `}`**；orchestration/deliveryCriteria 同样在 candidate 外。外层 `template:null` 不符合 optional object schema；所有员工 tools=[]，所有分片任务没有 inputs、outputs，也没有 map_reduce manifest，路径和SHA只写进自然语言目标。模型把“没有终端/只规划”误读成不能规划文件读取和写入，实际 policy 已允许 filesystem/artifact_write。 | 说明“当前只预览”与“为后续批准规划已有授权的文件合同”的区别；复用固定分片 manifest/input 示例。此试验提供的是内联虚构资料与散列，并未验证真实文件导入；文件映射前提可以注明，但不能宣称没有已授予的文件能力。 |
| two-proposals | 3521 / $0.0066033 | 两人独立提案→同步后各批评对方→经理裁定的 `proposal_review` 意图合理。 | 完整对象之后多 **1 个 `}`**。原 candidate 片段通过 schema，但两提案依赖不存在的 `manager_brief`；decision 只有5条标准，绑定索引却用到13；模板 pairs 将 proposal_a 绑定作者A执行的 critique_a_on_b、proposal_b绑定作者B执行的critique_b_on_a，违反“被批评提案由他人批评”的配对语义。自然语言交叉批评与模板引用不是同一回事。 | 用现有 fixture 解释 pair 的 critiqueTaskId 指向“针对该提案、由另一作者执行”的批评；索引绑定本检查任务的0基标准列表，所有依赖必须指向当前任务图已有节点。 |

这些都是原始结果的诊断，没有对任何题生成或保存修正版。三份无效 JSON 的后续诊断仅按字符串括号边界读取其原有完整对象/成员片段；整份响应仍按 JSON 无效记分。

## 是否输出 Token 截断

本轮没有支持“4000 Token 上限把答案截断”的证据：七题输出分别为 **2432、2625、2145、2916、3000、2581、3521**，全部低于4000；三份 JSON 错误都是完整对象之后额外闭括号，错误位置分别为4958、5751、8365（JavaScript字符偏移），不属于缺失尾部。七次 broker 均取得 returnedAt/usageId，未记录 `MODEL_OUTPUT_TRUNCATED`。

不能只靠 Token 小于4000证明供应方正常结束。当前 broker 证据没有保存 `finish_reason`，因此本审计不声称供应方明确返回了 `stop`。最小证据补充是下次在既有回执记录中保留 finish_reason 和解析错误位置；没有理由先加 Token、补次数或重试来掩盖此次失败。

请求已实际包含 `response_format:{type:'json_object'}`，但三次收到语法无效内容。当前材料不能区分是网关未执行该选项、模型未遵循，还是供应方兼容实现问题；不能仅凭这七次就宣布某层的 JSON 保证失效原因已查明，更不能未经验证改用另一种结构化接口。

## 提示、模型与校验的责任边界

**已确认的模型输出问题。** 原始答案直接包含多余闭括号、缺必填字段、错误层级、反向/不存在的依赖、越界索引、错误模板参数、越权预算字段和未授权文件写入分工。API 对本次首个错误的拒绝均能在原文及合同规则中找到依据；没有发现证明本轮应当被判通过的校验误拒。

**已确认的提示/schema 不一致。** `organizationCandidateV2Schema` 的 new target 复用完整 departmentSchema，发给模型的 JSON Schema 因而仍允许 dailyBudget 等字段，而自然语言和 `resolveOrganizationCandidate` 又禁止它们。路由规划请求前部仍描述旧的 `candidate.department/rationale/tasks` 结构，后部才要求 V2 target/orchestration/deliveryCriteria。这些是可消除的不一致；本轮不能单独证明它们分别导致多少失败。

**明确提示仍未被遵循。** 办公提示已经写了“最终经理结论是检查结果，不额外生成需要检查自身的标准”，仍出现自检和反向检查；模板目录已经提供正确 reviewTaskId 示例，模型仍输出 taskIds。因此不能把0/7全部归因于“提示没有说”。复杂字段合同的单次稳定生成能力在本轮确实不足，不能据此推断其他模型、更长输出或新架构必然解决。

**工具语义需减少误读。** 当前说明突出“无 artifact_write 不能写 JSON”，但宿主合同对任何文件 outputs 都要求写入能力；只配 filesystem 写Markdown同样会被拒绝。最小措辞应直接对应实际授权规则。只生成预览不等于 allowedTools=[]；代码评审题的 terminal 也只是候选计划权限，未授权测试工具去执行项目。

**返工顺序是尚需澄清的兼容边界。** 用独立的本地最小图 `implement → qa_before_review → review` 检查：review.maxReworkRounds=1 时，现有 taskContractErrors 返回 `qa_before_review: 使用返工成果必须等待独立审查 review`；同一合成图设为0则无该错误。这只证明先QA后review与有返工消费者门禁不兼容。`tests/task-contracts.test.ts` 明确测试 “gates all consumers”，现有固定示例也将审查置于后续消费者之前；它可能是防止修复后继续使用旧测试/旧产物证据的保守语义。未证明可以安全豁免审查祖先QA，不建议跳过校验；应先澄清审查前证据与返工后验收的语义。这不是本次 bounded-code-review 的首个拒绝原因。

## 建议的最小后续改动与验收

1. **保留这七份失败作为离线回归材料。** 增加/完善错误阶段和字段位置诊断，并保存 finish_reason；验证原错误仍被拒绝，不对非法JSON自动删括号、搬字段、补任务或提高成功率。
2. **只对齐当前规划提示与 schema。** 路由开启时仅说明V2结构，新部门规划schema移除实际禁止的字段；工具说明直接对应员工各自的读写授权。沿用产品现有schema与注册机制，不增加另一套规划器。
3. **复用既有 `tests/fixtures/orchestration-patterns.ts` 的小型合法关系示例。** 重点是业务产出→独立检查→经理、0基验收索引、reviewTaskId、跨作者批评配对、固定分片manifest/inputs。不要在提示中堆七份完整大计划；示例要与生产合同同源且本地可验证。
4. **返工兼容边界单独记录和确认。** 先增加只针对“审查前QA证据/审查后消费者”的本地用例与规则说明；任何调整都必须继续阻止修复后的旧文件消费和未经复验的交付。本审计不提出绕过门禁的补丁。

以上可先用原响应和合成小合同做无模型回归。若以后再次比较真实规划质量，应另外列明批准的次数/金额与固定模型配置，报告原始一次通过率及每题模式；本报告没有启动该后续试验。由于领域路由和目标拆分选择了合理替代，本轮也不能宣传成“七种模板全部已被真实模型生成并验证”。

## 证据来源与本地检查

- 原始请求、内容、收据：`.superpowers/sdd/orchestration-test-2026-10-19/real-broker-result.json`。
- 产品第一层拒绝结果：`docs/validation/evidence/orchestration-jj-tests-2026-10-19/real-planning-results.json`；需求：`scripts/validation/orchestration-planning-pilot/cases.mjs`。
- 对完整可解析候选，直接调用现有 `organizationCandidateV2Schema`、`deliveryCriteriaErrors`、`orchestrationPatternErrors`、`taskContractErrors`、`validatePlan` 的纯本地函数复核；对三份语法无效答案，只诊断原有对象/成员片段，不将片段当成通过的回答。
- 对照 `apps/api/src/organization-chat.ts`、`organization-routing.ts`、`organization-task-planning.ts`、`execution-prompt.ts` 及 contracts 中现有规则；参考现有合法fixture，不重跑网络/生产测试。
- 没有修改源码、原模型输出或既有账本证据；唯一新增产物为本审计报告。
