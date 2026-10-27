# 上下文预检、恢复入口与调研进度

2026-10-05。本阶段持续原 MVP 目标，同时完成用户提出的 DSH/同类产品调研和多员工冲突机制核查。没有安装新插件、扩大预算、结算不明费用或编辑员工交付物。

## 已实现和验证

- 请求构造与金额检查抽为 `prepareRequest`；在模型发送、费用收据登记和增加调用次数之前，可以用只读的归属信息检查具体请求。发送路径仍重新构造并同步预留，不能拿过期检查结果跳过执行门禁。
- 提供受保护完整上下文的单请求最低预留，保留原 1400 输出上限、费率和预留公式。它不是完成整项任务的费用承诺。
- 成功完整只读结果仅在同一 run/员工/任务/attempt、有源端哈希证明、原生成功 tool-result、完整相同的 assistant/tool 组时合并重复组。仍保留最新真实 call ID、全部正文和保护索引；完整档案不修改。来源失败、改版、混合写入、缺失或冷启动无证明时保留原组。压缩模型输入不应用该去重。
- 恢复入口新增只读条件检查，使用原版本 cap、当前收据、同版本历史费用/调用次数、授权、检查点和未知操作。改变费用或确认条件使旧检查失效；提交时仍再次 GET 并由 POST 在锁内复核。界面明确尚未检查具体 native 请求。

运行器相关本地回归 **81/81**，见[最终输出](request-context-preflight-runtime-final-2026-10-05.txt)。初次两条失败是新增 fixture 的预算边界和消息数量断言，原输出保留在[首次输出](request-context-preflight-runtime-2026-10-05.txt)，修正 fixture 后通过。恢复检查 HTTP **7/7**、网页 **18/18**、既有费用恢复 POST **14/14**，见[子阶段输出](recovery-conditions-local-2026-10-05.txt)。这些使用本地 fixture 验证工程机制，不是模型验收。

类型检查与 Vite 构建通过，**1686 modules**，见[构建输出](context-recovery-build-final-2026-10-05.txt)。首轮文件沙箱阻止 esbuild 遍历工作区父目录，经过自动审批允许本机构建后通过；记录保留在[首轮输出](context-recovery-build-2026-10-05.txt)。存在单个压缩后 JS chunk 超过 500KB 的构建提示。

## 原运行的零费用检查

读取原运行 `5114bb4f-7ac4-413d-a80f-aceeace8bdec` 的真实 `model/request` 第 101 条，重复执行纯 prepare，**0 模型发送、0 新收据**，账本、原档案和员工四文件未变（[证据](../test-evidence/archived-qa-request-pure-preflight-2026-10-05.json)、[可审查脚本](../test-evidence/helpers/preflight-archived-qa-request-2026-10-05.mjs)）。

原 cap $0.48，已记录 $0.3664174，未知预留 $0.0278694，净可用 $0.0857132。归档失败请求精简前预留 $0.150590，保留必须上下文的单请求最低 $0.092392，仍大于净可用 $0.0066788。未付费重试此路径。这里重建的是原归档请求；新恢复会建立新的任务和会话，不能用本检查代表新恢复的全部上下文和剩余交付链费用。

## 服务和浏览器

修复已加载到原数据环境，服务 `http://127.0.0.1:4310/`；新 launcher PID **6752**，API PID **40068**，API port **63984**。重启前精确核对旧 PID、创建时间、源码目录和原数据目录，并确认 0 active runs/calls/pending approvals/active native operations（[加载记录](../test-evidence/context-recovery-service-reload-2026-10-05.json)）。本次是加载工程修复，不算真实执行中的受控中断验收。

Edge headless 实际验证默认未知费用阻断、保留费用选项改变使检查失效、重新检查显示 21/37 次和沿用开发节点、取消选项再次阻断；没有提交恢复/完整重试，0 非只读网页请求，0 页面错误。四个交付文件和原 journal/snapshot SHA 与重启前一致，原项目仍 v6/$0.48，费用状态不变（[浏览器/API 证据](../test-evidence/context-recovery-service-web-2026-10-05.json)）。[默认阻断截图](../test-evidence/screenshots/context-recovery-default-blocked-2026-10-05.png)、[本地条件检查截图](../test-evidence/screenshots/context-recovery-retained-local-check-2026-10-05.png)均已视觉检查。

证据注记：加载脚本的 `usageCountBefore=1` 误计了 PowerShell 返回的数组对象，不代表只有一条 usage；浏览器报告明确标注此字段不能作为行数基线。当前读取到 272 条，并在浏览器操作前后逐行比较不变。项目账本及原档案的重启前后比较独立通过。统一浏览器控制工具因 kernel assets 不存在而不可用，实际浏览器证据沿用仓库的 Edge/Playwright 工程验收方式。

## 调研、边界和下一步

已完成[DSH 主报告](../research/dsh-plugins-and-agent-products-2026-10-05.md)、[同类产品/费用与质量插件源码比较](../research/comparable-agent-products-2026-10-05.md)、[多员工并发边界](multi-agent-concurrency-boundaries-2026-10-05.md)。候选均未安装或连接本中转站实测。一个上下文实现子 agent 因模型服务 capacity 退出，保留其源文件并由主 agent 完成集成、检查和回归。

真实独立 QA、复审、经理验收及本次混合模型方案的受控重启后完成仍**未验证**；已完成开发节点和原历史验收继续保留。高并发压力、Windows OS 隔离、新版插件的旧数据迁移也未验收。接下来首先为新恢复构造具体请求与有限交接做隔离验证，核对必要上下文和授权；不能因本地条件检查通过而重复消耗已知不足的旧路径。原预算和未知预留继续生效，需要新方案时先形成可审查的费用提议和原历史继承规则，再由用户确认。

## 用户要求继续后的实测（2026-10-05）

已完成上段计划中的隔离新恢复构造，以及用户询问的同文件/数据库冲突验证：

- [产品 Host、文件和读证明](product-concurrency-2026-10-05.md)：4/4 新集成及 10/10 上下文回归。真实 DSH 两员工读取同 SHA、不同权限/证明范围；同任务重叠旧 SHA 写入只成功一次，重新读取显式合并可继续，旧 attempt 与完成后写入拒绝。无序双员工写同文件/写读冲突在创建 worker 前拒绝。
- [本机操作 HTTP 竞争](multi-agent-operation-concurrency-2026-10-05.md)：7/7，涵盖 9 类。16 次并发开始仅一次成功；旧 token 不可提交新操作；迟到回执即使 HTTP200 也只留审计、不成为完成结果。当前本机与测试均使用 PGlite max=1；多连接 PostgreSQL、任意多进程和外部编辑器窗口仍未测试。
- 修复实际本机 filesystem 结果含 localWorkspace 而签名模块拒绝该字段的问题。字段纳入完整结果哈希，目录改变不等价，未知字段仍保守拒绝。它不改变授权、不缩短独有资料，也不使冷档案自动具有源端证明。
- 扩展后相关运行器 [86/86 最终日志](concurrency-context-runtime-regression-2026-10-05.txt)，[tsc 与生产构建](concurrency-context-build-2026-10-05.txt)通过；Vite 1686 modules，仍有 500KB 单 chunk 提示。未写员工交付或增加真实模型费用。
- [新原生恢复请求纯预检](fresh-recovery-native-preflight-2026-10-05.md)：真实 stage/restore/admission 保留开发 completed、21/37、原合同/版本/1400 输出和两条未知占用。首个 QA packet 最低 $0.074996；审计指定 native claim 后最低 $0.080764，之前费用必须 ≤$0.0049492。审计读取四文件的完整真实结果后最低 $0.122908，即使前序零费用仍被 BUDGET_CONTEXT_LIMIT 拒绝。后两步工具决策是审计驱动，不能代替真实模型。未证明全 QA→复审→经理有安全预算路径。

修复再次在空闲原环境加载。当前 launcher **44216**、API **46548**、port **64059**、wrapper **44720**；[精确进程与空闲守卫](../test-evidence/concurrency-context-service-reload-2026-10-05.json)、[加载后只读核对](../test-evidence/concurrency-context-service-check-2026-10-05.json)。这次用 272 条完整 usage 的原响应 SHA 与行数核对，项目账本、档案/四交付 SHA 均不变。首个核对脚本误用了不存在的 GET 单项目路由，随后浮点相等断言也需改为容差；只修正审计工具，保留[路由错误输出](concurrency-context-service-check-initial-2026-10-05.txt)、[浮点断言错误输出](concurrency-context-service-check-float-assertion-2026-10-05.txt)和[最终通过输出](concurrency-context-service-check-final-2026-10-05.txt)，没有据此修改产品数据。

真实验收结论仍不变：本轮 QA、复审、经理及受控重启后完成未通过。当前已具体证实四完整文件路径在原净额内受阻；不是对所有未来模型策略的不可行证明。下一步应先形成保留原历史费用、未知占用及调用次数的可审查剩余预算/任务方案，再按用户确认执行，不能自动调高旧 $0.48 cap 或靠文档代替实际验收。
