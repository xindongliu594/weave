# 文件合同与可靠交接

日期：2026-09-30。基于主分支 `fd92595f226b905edce60d764d879b597466739e`，继固定文件测试之后实现的第一阶段交接门禁。

## 当前行为

任务依赖绑定任务 ID，文件输入绑定产出任务及其宿主验收版本。员工只是任务的负责人，换人不会改变依赖关系。每位员工仍使用自己的持久会话，通过 AgentTeams 的消息和任务结果交接；共享工作区中的文件由产品工具访问。

提交 `completed` 时，宿主读取真实文件，检查路径、格式、声明的 JSON 字段及预期值，并记录 SHA256、大小、任务 ID 和 attempt。原生任务更新也必须成功，验收记录才生效；失败时撤销临时记录。后续员工首次模型请求之前核对输入版本，在文件工具和完成提交时再核对。文件操作与完成提交共用互斥锁，避免下游抢在验收提交结束之前执行。

| 情况 | 执行结果 |
|---|---|
| 上游标记完成，但声明的文件不存在 | 拒绝完成提交，下游保持 pending，尝试次数为 0 |
| 已验收文件被修改 | 下游输入校验阻塞，首次业务模型请求不会发出；原生调度可能已领取该任务 |
| JSON 缺字段或预期值不符 | 拒绝完成提交，展示失败字段 |
| 模型声称检查通过，但没有真实成功命令记录 | 拒绝完成提交 |
| 检查之后工作区发生变化 | 原命令证据失效，需要重新检查 |
| 不同任务无先后依赖却写同一路径 | 方案校验拒绝；条件写仍保护实际覆盖冲突 |
| 终端写入声明范围之外的文件 | 记录越界，阻止此 attempt 完成；需要检查产物后重试或重新批准方案 |
| 恢复运行时输入已变化或验收记录缺失 | 拒绝跳过已完成任务，返回明确原因 |

门禁和这些测试不需要模型 API。实际员工自主规划、编写和调用工具仍需要可用模型；固定测试用预设回复替代模型，不能证明真实模型的自主能力。

## 如何配置

项目方案编辑器已提供任务类型、输入、输出、JSON 检查及质量合同字段。选择输入来源任务会加入对应的直接依赖。后端还会检查来源是否属于前置链、是否声明对应输出、工具授权及并行路径冲突。运行详情展示阻塞原因与已核验文件版本。

| 字段 | 用途 |
|---|---|
| `inputs[].path` | 工作区相对文件路径 |
| `inputs[].producerTaskId` | 前置任务 ID；读取宿主记录的该任务输出版本 |
| `inputs[].sha256` | 固定输入的批准版本；也可进一步约束产出任务版本 |
| `outputs[].path` | 本任务承诺交付的文件 |
| `outputs[].format` | 可选 `text` 或 `json`，JSON 会实际解析 |
| `outputs[].requiredKeys` | JSON 对象顶层必需字段 |
| `outputs[].expectedValues` | JSON 顶层字段精确值，支持字符串、数字、布尔和 null |
| `inScope` / `outOfScope` | 允许/禁止修改的文件或目录；按路径前缀匹配，不支持 glob |
| `verify` | 必须通过产品终端工具实际执行成功的完整命令字符串 |

以下是方案的两个任务示例，员工 ID 需换成当前方案的成员 ID：

```json
[
  {
    "id": "prepare",
    "subject": "准备统计结果",
    "objective": "输出两条订单的统计结果",
    "assigneeId": "producer",
    "dependencies": [],
    "acceptanceCriteria": ["统计结果包含 orderCount=2"],
    "estimatedInputTokens": 1000,
    "estimatedOutputTokens": 500,
    "kind": "work",
    "inputs": [],
    "outputs": [{"path": "result.json", "format": "json", "requiredKeys": ["orderCount"], "expectedValues": {"orderCount": 2}}]
  },
  {
    "id": "summarize",
    "subject": "撰写摘要",
    "objective": "读取经核验的统计结果并生成摘要",
    "assigneeId": "writer",
    "dependencies": ["prepare"],
    "acceptanceCriteria": ["摘要文件存在且采用本次统计结果"],
    "estimatedInputTokens": 1000,
    "estimatedOutputTokens": 500,
    "kind": "work",
    "inputs": [{"path": "result.json", "producerTaskId": "prepare"}],
    "outputs": [{"path": "summary.md", "format": "text"}]
  }
]
```

producer 需要 `artifact_write`，writer 需要 `filesystem` 和 `artifact_write`。普通自然语言验收仍是给员工的任务要求，只有显式文件规则及原生质量合同会触发对应的程序检查；摘要是否充分、事实是否准确还需要有意义的检查或独立审查。

固定文件必须先进入本次工作区，再填写实际 SHA256。本阶段没有新增工作区上传入口；`runInputs` 的资料正文属于员工上下文，填写路径不会把它自动转换成工作区文件。

## 原生质量任务

`kind` 支持 work、requirements、implementation、verification、review、repair、integration。实现和修复必须声明 `inScope` 与 `verify`；审查绑定前置实现/修复任务的 `reviewedTaskId`，由另一位员工承担；修复绑定前置 `sourceTaskId` 和 `sourceFindingIds`。

DSH/AgentTeams 依赖版本保持锁定。本产品通过公开工具先创建待批准团队，再按拓扑顺序调用 `agent_teams_create_task` 建立质量任务，映射批准方案的任务 ID，随后批准并锁定范围。没有修改第三方调度器或直接写团队状态文件。

宿主将真实命令的退出码和运行时工作区版本作为验证证据；模型填写的 `commandsRun` 无法替代它。实现/修复声明的 `changedPaths` 必须与宿主观察的修改路径一致。退出码为零只说明批准的命令成功执行，检查本身是否充分仍取决于命令设计和审查。

本阶段阻止 review/requirements 的 `needs_revision` 触发插件内部新增未批准任务。运行会给出 `REPLAN_REQUIRED`，需要更新并重新批准方案。固定订单测试中的诊断、修复和复验是预先批准的普通任务链，可以继续运行。

## 兼容与边界

- 旧方案可以继续运行。未声明文件合同的任务没有自动推断的文件保护；显式 `inputs: []` / `outputs: []` 表示不允许额外文件读/写，省略字段保留旧权限行为。
- 输入版本记录和工作区条件写保护当前执行；尚未实现上游变更后对已经完成的所有下游结果自动标记失效、重新计算。
- `filesystem` / `artifact_write` 在执行前按显式合同检查路径。终端仍能访问批准的共享工作区，修改范围在命令结束后审计，不能视为命令执行前的文件 ACL，也不会自动撤销越界写入。终端审批与 Docker 隔离继续适用。
- 恢复保留精确 completed attempt 的宿主验收记录，并验证剩余任务的输入。若剩余审查/修复仍引用本次被跳过的完成任务，当前原生任务身份无法重建，因此拒绝部分恢复，提示完整重试或重新批准。旧版本有文件输出却没有验收记录的运行同样不能跳过。
- 尚未实现 import/构建依赖分析、自动识别业务语义依赖、自动重规划或自进化发布。前期由人或固定模板声明，模型可以提出建议，程序校验并执行批准的合同。

## 验证记录

本轮通过 38 项非 Docker 运行时测试、14 项纯规则/恢复测试、TypeScript 和 Vite 构建。运行时覆盖实际 DSH 工具链、原生质量任务、回滚、旧 attempt 拒绝、同员工续任务、真实固定程序结果 1798 → 4095、缺文件与过期输入保护。

`npm test` 已尝试：14 项通过，51 项数据库相关测试在准备阶段因 `127.0.0.1:55432` 连接被拒绝而失败。当前环境没有 PostgreSQL/Docker，未完成生产 API/数据库、Docker 沙箱、浏览器 UI 或真实模型的集成验收。

复验命令与机器可读范围见 [本轮测试证据](test-evidence/reliable-handoff-20260930.json)。固定场景使用 [预设资料](../tests/fixtures/offline-handoff/README.md)。此前缺口的历史记录见 [第一轮验证](offline-handoff-testing.md)。
