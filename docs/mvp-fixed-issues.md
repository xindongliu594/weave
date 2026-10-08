# 为伍 MVP 已修复问题与验证边界

> 最新汇总：[2026-10-07 修复清单](mvp-fixed-issues-2026-10-07.md)与[最终验收报告](mvp-acceptance-2026-10-07.md)。下文保留早期修复记录和当时的验证边界。

2026-10-03，基于 `0befc094953880b6b3ede88506f6fa3e41088e85`。保留原有代码、历史运行、凭据、权限和员工交付。此清单区分代码修复、实际验证和仍受阻的交付，不表示全部 MVP 验收完成。

## 已修复

2026-10-05 补充（原条目和证据继续保留）：

| 问题 | 修复后的行为 | 证据 |
| --- | --- | --- |
| 项目 AI 生成直接保存，用户没有候选确认；规划单次费用与真实输入不清楚 | 同源只读费用检查、独立候选、明确确认后保存一次，生成/丢弃/失败保留原方案和费用；输出上限明示 | [阶段实际验证](validation/project-planning-candidate-stage-2026-10-05.md)，API 47 pass/2 skipped、实际 Edge 交互、0 原项目写入 |
| 规划模型没有原完整方案、完成节点及实际调用历史，可能重复规划已完成开发 | 原完整方案与只读核验历史纳入相同规划请求；包含实际文件 SHA、完整合同和固定资料来源，档案不可用不补零；历史改变使费用检查失效 | [历史模块 11/11](validation/planning-execution-context-2026-10-05.md)、[原 v6 真实只读 GET](test-evidence/project-planning-live-web-2026-10-05.json)，21 调用/dev/四 SHA 保留 |
| 本机完整 filesystem 结果因含 localWorkspace 而无法获得源端读证明 | 接受执行器定义的有界目录字段并纳入完整结果哈希；不同目录、权限、任务、attempt 或内容仍不等价 | [真实 DSH Host/Windows 文件竞争与证据](validation/product-concurrency-2026-10-05.md)，4/4 集成、10/10 上下文回归；[扩展相关回归](validation/concurrency-context-runtime-regression-2026-10-05.txt) 86/86 |
| 用户点击恢复前不能只读检查最新费用/次数/授权/检查点 | 恢复条件检查与 POST 共享门禁；确认条件变化使旧检查失效，发送时再核对；明确未检查具体 native 请求 | [恢复 UI/API](validation/budget-recovery-preflight-ui-review-2026-10-05.md)、[实际 Edge 页面](test-evidence/context-recovery-service-web-2026-10-05.json) |
| 只能付费试探具体请求能否通过预算 | prepareRequest 与发送路径同源，纯检查不创建收据/预留/计数；保留必须证据的最低预留可审查 | [最新恢复原生预检](validation/fresh-recovery-native-preflight-2026-10-05.md)，完整四文件阶段仍阻断，未改预算或冒充 QA 完成 |

已有的文件 SHA、任务凭证、队列和 lease 保护本轮新增 [7/7 API 竞争实测](validation/multi-agent-operation-concurrency-2026-10-05.md)，没有把迟到 HTTP200 留审计误认为完成。多进程/外部编辑器以及独立 PostgreSQL 多连接仍未验收。

| 问题 | 修复后的行为 | 证据 |
| --- | --- | --- |
| 有效草案后补充需求，模型只追问时旧方案重新可确认 | 保留旧草案并锁定确认；只有新草案可解除。接收草案不会创建或更新正式团队 | `tests/organization-draft.test.ts`；`docs/validation/ui-regression.txt`；组织 API 回归 11 + 7 项见 `docs/validation/web/organization-api.txt` |
| 无方案、生成失败和待确认状态不够明确 | 首页分别显示尚未生成、当轮方案未成功、待确认／已保存；失败保留自然回复，可继续讨论 | 同上；真实网页四轮对话记录见 `docs/mvp-validation-progress.md` |
| 模型把任务说明写进文件范围，旧校验放行后员工被 `OUT_OF_SCOPE` 阻断 | 提示词和 Schema 明确相对路径语义；共享合同提前检查输出在允许范围且不在禁止范围。原失败费用保留 | 原失败 Run `a79b1893-3c69-43f2-8439-094593148e82`；`tests/task-contracts.test.ts`；网页已拒绝旧方案，见主进度 |
| `verification` 等非实现任务已有范围却不能网页编辑 | 有范围或交付文件就显示编辑入口；实现／修复仍必填，其余可选。编辑器不自动放宽或改写范围 | `tests/task-contract-editor.test.ts`；用户通过网页纠正方案后保存 v3 |
| 运行页只显示本次费用，恢复前支出隐藏 | 显示项目累计、预算、剩余、本次和启动前费用；缺少历史预算证据时只显示已知费用。按配置单价核算，待核对费用不伪装成零或实际账单 | `tests/run-cost.test.ts`；`docs/validation/ui-regression.txt` |
| 当前节点、任务状态、员工及审批不易读，历史内容挤占页面 | 中文任务／工具状态、员工和依赖名称、当前或停止时节点、待审批数；处理过的审批和长需求折叠，停止后的员工状态明确标为历史记录 | `tests/run-status.test.ts`；`docs/validation/ui-regression.txt`；最终网页复验由主报告记录 |
| 切换运行可能短暂显示上次审批、引用或交付 | `RunExtras` 按 Run ID 重建，不共用前次页面状态；交付列表读取失败明确提示 | `apps/web/src/RunCenter.tsx`、`RunExtras.tsx`；网页切换与下载证据见主报告 |
| 重叠轮询／手动分页产生重复事件和 React keys | 运行详情自动轮询使用串行调度；合并事件按 `seq` 去重并排序，分页不丢旧事件 | `tests/run-events.test.ts`；`docs/validation/ui-regression.txt` |
| 动态 GET 缓存与悬挂导致审批或本机回执无法正常更新 | JSON 读取禁用缓存并有 10 秒超时、中文提示；审批、文件、回执各自更新，提供手动刷新 | `apps/web/src/api.ts`、`RunExtras.tsx`；真实浏览器恢复读操作由主任务复验 |
| 员工文字总结中的命令可能有笔误，真实测试结果难找 | 新区域展示本机回执的准确命令、退出码与输出，包含失败及最终复测。保留员工原文，不冒充修改其交付 | 正常真实 Run `99551bf3-94f0-464a-8cd7-6935ad679ab8`；恢复子 Run `c9b1f703-b2a6-4bf0-8318-ad2b15ce911e`；[真实运行汇总](test-evidence/mvp-real-runs.json)、[实际原回执，含失败及复测](validation/real-todo-native-tests.txt) |
| 有未知模型费用时网页仍允许点击恢复再收到拒绝 | 详情返回原有 `COST_PENDING` 原因，两种恢复按钮都禁用并链接核对入口；费用页展示本机调用 ID 和对应运行 | `tests/cost.test.ts`；`docs/validation/cost-gate.txt` 5 / 5；UI 费用门禁回归通过 |
| 较窄桌面窗口的恢复提示框使用横向 flex，说明、费用提示及按钮挤成窄竖列 | 恢复框改用 `run-recovery` 块布局，长文字换行、费用提示独立一块，按钮正常排列；确认及费用禁用条件保持原样 | 主任务实际浏览器发现；源码 `RunExtras.tsx`、`styles.css` 已复核。[修后截图，两个恢复按钮仍禁用](test-evidence/screenshots/recovery-cost-gate-controls.jpg) |
| Windows 文件占用使本机回执持久化失败 | 仅有限重试原子回执重命名，不重跑命令或写入；持续失败仍保留结果未知状态并拒绝自动重放 | `docs/validation/local-receipts.txt` 7 / 7 |
| 已批准运行时限的实际停止原因被工具包装错误遮蔽 | 保持原时限；明确记录截止事件及停止原因，保留已完成任务和文件 | `docs/validation/deadline-receipts.txt`；未把新项目 1800 秒截止提高 |
| 异步预留期间中断仍可能被当作已发送未知请求 | 持久预留后再次检查中断；未发送的请求不记作已发送未知调用，不盲目重试 | `services/agent-runtime/openai-compatible.test.mjs`；截止／适配器回归合计 7 / 7 |
| 最新代码不能直接沿用另一检出的原本机数据目录 | 启动器支持唯一绝对 `--data-dir`，沿用原配置和已有授权、保留双开锁；检查模式拒绝覆盖指定目录 | `tests/local-launcher.test.ts`；`docs/validation/local-check.txt`；真实原目录受控重启 |
| 页面／备份／知识提示仍假设 Mac | 改为本机、当前目录或连接中的后端说明，符合 Windows 部署 | `apps/web/src/App.tsx`、`apps/api/src/backup.ts`、`obsidian.ts`；`docs/mvp-data-progress.md` |

## 本次审查补充，已落盘并复核

- 文本预览原裸 `fetch` 缺少 JSON 读取入口已有的缓存／超时保护，挂起会占用共享 `busy` 并禁用审批或恢复。现也使用 `no-store`、10 秒超时，`act` 捕获超时并给中文说明，`finally` 解除忙碌。只读代码复核通过。
- 刷新原使用 `Promise.all`，单项失败提前返回时，剩余慢请求未完成就开始下一轮。现用 `allSettled` 等所有读取结束再报告失败；每项成功仍独立更新，下一轮只在等待结束后调度。只读代码复核通过。

最后两项没有额外进行浏览器故障注入；不把静态复核写成已实测超时／失败注入。最新类型检查和构建由主任务的最终工程验证确认。

## 已有能力的实际验证

- 原正常真实 Todo：Run `99551bf3-94f0-464a-8cd7-6935ad679ab8`，3 节点完成、45 次真实请求、5 份员工交付。原档案完整，哈希一致，开发与独立 Windows CLI／HTTP 测试复测通过；证据 `.data/mvp-evidence/preserved-real-todo.json`、`preserved-todo-tests.txt`。未手工补齐员工代码或文档。
- 真实恢复：父 Run `1cc083f3-1ca0-4eec-8230-29a2fe7617f3` → 子 Run `c9b1f703-b2a6-4bf0-8318-ad2b15ce911e`。完整 4 节点 DAG、25 次旧调用、费用及 4 个精确文件版本继承；完成开发节点没有重跑；未完成 QA 验证及独立审查继续并真实测试通过。机制证据 `docs/test-evidence/mvp-recovery-2026-10-02.json`。
- 知识与隔离备份：授权检索与读取、固定 v1、更新后引用、恢复后引用、错误口令拒绝、关键数据和嵌套交付哈希保留及再次重启均通过。证据 `docs/test-evidence/mvp-data-2026-10-02.json`。实验只用隔离资料、两个独立持久 PGlite 数据库；合成记账不当作真实付费模型验收，也未验证独立 PostgreSQL 后端锁竞争。
- 回归输出分别见 `docs/validation/ui-regression.txt`（18 / 18）、`cost-gate.txt`（5 / 5）、`runtime-portable.txt`（74 / 74）、`local-receipts.txt`（7 / 7）、`deadline-receipts.txt`（7 / 7）；类型检查及标准构建输出在 `typecheck.txt`、`final-build.txt`。本地模型替身测试不代替上面的真实模型记录。

## 仍存在的限制

- 新恢复项目最终经理交付未完成：子 Run 达到原 1800 秒截止，真实调用 `f9752aa6-f045-4b96-9edb-43be3087b2ed` 的账单／用量尚未核对，保留 $0.0102812 预留。未手动清零、重放或继续付费调用；未提高 $0.48 / 80 总调用 / 35 默认任务调用 / 单并发。**恢复机制通过，整条恢复后最终交付仍受阻。**
- 原正常 Run 的经理总摘要有 `acceptance.test.js` 笔误；实际回执和任务输出使用 `node --test acceptance.test.mjs`。新增回执区域提供准确命令，原员工总结保持原样，不声称已修复员工原文。
- 本次只读源代码审核未发现团队确认、文件范围或费用门禁被绕过。浏览器操作和真实验收由主任务记录；本审查不操作浏览器、不发起模型请求、不修改源代码或原数据。
