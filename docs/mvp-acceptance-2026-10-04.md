# 为伍 Windows 网页 MVP 验收续报（2026-10-04）

**状态：尚未整体完成。** 保留了历史真实 Todo 成功、网页组队、受控重启恢复、知识授权与固定版本、选定项目的隔离备份成果。新中转站项目 v4 的独立 CLI 测试真实失败；v5 的旧 403 收据已按用户确认经网页人工登记 0，随后一次恢复的第一条模型请求再次 403，留下新的不明费用，完成节点仍为 0，尚无经理完成证据。自动账单重复失败路径已本地修复，相关回归及最新类型/构建通过；实际受控 API 故障、父进程清理、重启与网页连接的 19 项核对通过。主服务重启后现场可访问，历史自然退出根因与长期稳定性仍未证明。

本次代码目录 `C:\Users\JJ\.codex\worktrees\f57c\agent_department`；原数据目录 `C:\Users\JJ\Desktop\la\agent_department\.data\local`。历史报告和原始失败证据保留：[10 月 2 日验收](mvp-acceptance-2026-10-02.md)、[本次阶段记录](new-api-progress-2026-10-04.md)、[使用说明](mvp-quickstart.md)。本报告整理期间仅读取仓库内已有证据，没有模型/外网请求或原数据操作。

## 六项验收状态

| 验收项 | 状态 | 证据与尚缺内容 |
| --- | --- | --- |
| 1. 需求与组队 | **已验证** | 真实网页多轮讨论、失败草案、有效预览及修改 QA 职责均保留。确认前仍为 2 部门 / 6 项目，确认后为 3 / 7；[确认前](test-evidence/new-api-before-confirm-2026-10-04.json)、[确认后](test-evidence/new-api-confirmed-team-2026-10-04.json)、[草案失败界面](test-evidence/screenshots/new-api-draft-failure-2026-10-04.png)。 |
| 2. 真实执行与交付 | **失败（v4、v5及恢复子运行）；后续执行受阻** | 历史正常完成 `99551bf3-94f0-464a-8cd7-6935ad679ab8` 及五份员工交付仍有效，[历史复核](test-evidence/mvp-preserved-real-todo.json)。新接口 v4 独立 QA 退出码 1，复审/经理未完成；v5 及恢复 `a3ce2f05-9048-4967-9b50-f981fecd24ec` 均 403，0 完成节点、四份旧文件未修复。[文件审计](test-evidence/new-api-v5-artifact-sha-audit-2026-10-04.json)、[最新恢复失败](test-evidence/new-api-v5-resume-second-403-2026-10-04.json)。不得以历史成功或本地模型替身替代此次完整验收。 |
| 3. 断点恢复 | **已验证（机制）**；完整续跑交付**失败** | 父 `ba992f48-c16d-4822-83d4-b7429433d30c` → 子 `8ae853c9-248f-45bb-b0bc-28d62fc85879`，安全中断、原 DAG/权限、四文件版本、25 次调用与预算保留，已完成开发未重跑、旧审批未重放。[修正审计](test-evidence/new-api-real-recovery-v4-corrected-audit-2026-10-04.json) 明确机制 passed、最终交付 failed。v5 新恢复已核对 DAG、四文件 SHA、7 次历史与剩余预算，但第一条新请求 403；其无完成节点，不能据此新增“完成节点不重跑”或新知识引用通过结论。 |
| 4. 网页可用性 | **已验证（已走过流程、编号、人工核对和受控重连）**；长期稳定性**未验证** | 网页完成组队确认、执行审批、恢复、失败呈现、文件查看及固定输入 SHA；见[重启前](test-evidence/screenshots/new-api-before-restart-2026-10-04.png)、[QA 失败](test-evidence/screenshots/new-api-independent-test-failure-2026-10-04.png)、[输入 SHA](test-evidence/screenshots/new-api-fixed-input-sha-2026-10-04.png)。完整 ID/HTTP 已显示，[网页人工 0 结算](test-evidence/screenshots/new-api-403-manual-zero-2026-10-04.png) 与[恢复后第二次 403](test-evidence/screenshots/new-api-resume-second-403-2026-10-04.png) 归档。实际[断连界面](test-evidence/screenshots/new-api-health-disconnected-2026-10-04.png) 与[重连界面](test-evidence/screenshots/new-api-health-reconnected-2026-10-04.png) 无需用户手动刷新；开发模式 Vite 可自动重载，不能称全程无文档重载。自然退出原因和长期独立运行仍未证明。 |
| 5. 知识与数据 | **已验证（限定范围）**；凭据迁移/全量恢复**未验证** | [实际授权检索](test-evidence/new-api-knowledge-preflight-2026-10-04.json) 和[恢复后真实 v1 引用](test-evidence/new-api-knowledge-recovered-v1-2026-10-04.json) 通过；[真实业务隔离恢复](validation/mvp-backup-business-2026-10-04.md) 保留 9 文件、5163 事件、72 费用和 9 审批，重开后核对通过。仅为选定项目的无凭据投影，未覆盖原环境。 |
| 6. 工程验证 | **已验证（相关本地测试、类型、构建及实际服务加载/重连）**；真实新接口端到端**失败** | 组织 12/12、产品流 17/17、恢复幂等 2/2、备份尺寸 2/2、扩展备份 3/3 保留；[上下文 JSON 31/31](validation/new-api-context-pruning-2026-10-04.txt)、[健康/用量同步 12/12](validation/new-api-health-sync-2026-10-04.txt)、[账单暂停事务 17/17及既有费用7/7](validation/new-api-billing-auto-pause-2026-10-04.txt)、[查询 helper 17/17](validation/new-api-billing-pause-helper-2026-10-04.txt) 通过，[最新 `npm run build`（含 tsc）](validation/new-api-final-service-reconciliation-build-2026-10-04.txt) exit 0。[实际受控重启 19/19](test-evidence/new-api-controlled-restart-audit-2026-10-04.json) 核对档案、预算、费用和网页连接保持；[输出索引](validation/new-api-fixed-issues-2026-10-04.md) 列出各证据。PGlite/本地 HTTP fixture、纯回放不代替真实员工验收或独立 PostgreSQL 后端锁验证。 |

## 真实恢复通过了什么，失败了什么

v4 中断时无在途模型、已派发命令或结果不明操作，开发已完成，QA 等待命令审批。重启取消旧审批；父运行 25 次请求逐项对上 dev 18 / QA 3 / 协调 4，金额与调用次数未重置。子运行继承剩余执行预算 `$0.2990636`（总 `$0.48` 减去已登记 `$0.1809364`），开发新模型调用、命令和重复验收均为 0；QA 在原任务下继续调用、修订自己的未完成文件并执行测试。[归属/预算核对](test-evidence/new-api-budget-mapping-audit-2026-10-04.json)

只读校验脚本最初为 10 通过 / 4 失败；修正 checkpoint 的 `attempt_id` / `attemptId` 读取后为 **11 通过 / 3 失败**，原采集哈希和其余 13 项未变。三项失败仍是未完成节点、独立测试、经理最终验收；原[失败报告](test-evidence/new-api-real-recovery-v4-failed-2026-10-04.json) 与[校验器回归](test-evidence/new-api-real-recovery-v4-attempt-regression-2026-10-04.json) 均保留。

QA 的真实命令是 1 项测试、0 通过、退出码 1。只读诊断复现员工 `.mjs` 使用 `module.parent` 导致 `ReferenceError: module is not defined in ES module scope`，独立测试还错配启动日志 `Listening on` / `listening at`。这是员工交付的真实缺陷；[Codex 诊断输出](validation/new-api-cli-diagnosis-2026-10-04.txt) 不冒充员工通过结果。

恢复后的 QA 有 4 个 `knowledge/citation` 事件、共 6 个来源，两份文档仍固定 v1；当前文档均已是 v2。产品 citation GET 返回原 v1 SHA 与 `WEIWU_QA_PRIVATE_V1` / `WEIWU_TODO_KB_V1`；快照仅允许 QA 读私有文档，开发和经理只有共享文档。[真实引用证据](test-evidence/new-api-knowledge-recovered-v1-2026-10-04.json)

## 当前受阻点与费用边界

网页将四份原员工文件导入不可变快照 `da930e83-eda4-489d-ad25-9e8a0f25a722`，完整 SHA 固定到同项目 v5，再批准运行 `9f389049-95a5-4e51-b40e-6d6415be016f`。Codex 未修改这些员工文件；修复仍分配给员工。总预算保持 `$0.48`，之前 35 次加新版本最多 45 次不超过原 80 次，每员工每任务收紧为 14 次；方案校验通过不代表执行已通过。[v5 方案与四文件 SHA](test-evidence/new-api-repair-plan-v5-2026-10-04.json)

18:31:20 的第七次请求返回 **HTTP 403**，供应方请求 ID `2026100418312058604855307789827`。收据 `5faeb3e4-d837-4d84-b9ee-826cbb7c5188` 的历史 `uncertain` 预留 `$0.0401656` 及三次权限拒绝均保留；不能从查询失败推定零费用。[原 403 收据](test-evidence/new-api-provider-403-receipt-2026-10-04.json) [19:07:59 历史快照](test-evidence/new-api-final-local-state-2026-10-04.json) 已独立核对 7 条 wire / 6 条 billing、v5 登记 `$0.039112`、项目累计登记 `$0.2529672`，以及 0 待审批 / 活动本机操作 / 结果不明操作。金额为配置单价登记，不是供应方实收总额。

用户确认 18:31 请求“未扣费得了”后，主代理于 **22:01:25 经网页人工登记输入 0 / 输出 0 / 费用 0**，该收据现为 `settled`，原预留解除；三次自动查询失败及调用次数仍保留。[实际人工回执](test-evidence/new-api-403-manual-zero-2026-10-04.json)、[网页截图](test-evidence/screenshots/new-api-403-manual-zero-2026-10-04.png) 明确 `automaticSupplierVerification=false`。这是用户确认的人工核对，不能称供应方自动账单验证成功；其他历史未知费用未清除。

网页随后只恢复一次，创建 `a3ce2f05-9048-4967-9b50-f981fecd24ec`，父 `9f389049-95a5-4e51-b40e-6d6415be016f`。恢复完整四节点 DAG 与四份原 SHA、继承该父运行 7 次请求 / `$0.039112` 历史，执行剩余预算 `$0.2270328`（`$0.48 - $0.2529672`），未重置原预算或次数。**22:08:29 第一条新模型请求再次 HTTP 403**，ID `2026100422082931846158376692893`、新收据 `12ebc7bd-bc11-4948-9142-d778f0e22433`，保留未知预留 `$0.0222384`，其后自动账单查询又三次被拒绝。[新恢复与完整收据](test-evidence/new-api-v5-resume-second-403-2026-10-04.json)、[网页失败](test-evidence/screenshots/new-api-resume-second-403-2026-10-04.png) 均保留。当前费用恢复门禁对应 **新 `12eb…`**，不是已人工结算的 `5fa…`；后续模型重试已停止，403 原因和新请求费用仍受阻，四旧文件与 0 完成节点未变。

用户新账单截图精确对应 **18:29:46 已结算**收据 `d37ebfa7-9417-489d-b1f6-e33cb2bcc574`、供应方请求 ID `202610041829442180191970452813`：HTTP 200、19527 输入 / 21 输出，19072 缓存输入在该单据按 0.5 倍计价。供应方 `$0.004030` 与原登记 `$0.0078444` 有差额；该截图**不是**上述 18:31 的 403 请求，不能结算后者。未来全站缓存倍率仍未公开核实，历史账面未静默改价。[精确关联与公式](test-evidence/new-api-bill-detail-match-2026-10-04.json)、[缓存限制](new-api-cache-pricing-audit-2026-10-04.md)

常规访问继续使用用户保存的 `newapi` 连接与现有 Key。兼容额度能读授权上限和原始累计值，但累计单位未知、无限上限不是可用余额；余额变化不能证明单请求结果。没有扩大备用模型、工具、目录或后台账单权限，没有因拒绝切换其他 Key/站点或猜更多接口。

网页费用页新增安全编号投影后，主代理通过 AX 实际核对了原待核对行的 HTTP 403 / 完整 ID `2026100418312058604855307789827`、最近已结算详情的 HTTP 200 / 完整 ID `202610041829442180191970452813`；原 403 后来已人工结算，新 403 的完整编号继续显示。编号也在人工表单展示并可选中复制。接口仅增加已持久化的安全响应元数据，不透出原 context、Key 或固定路由；[本地事务与 HTTP 回归](validation/new-api-provider-id-cost-2026-10-04.txt) 及上述网页截图保留。

22:58 重启后的[实际费用页复核](test-evidence/new-api-latest-403-fee-web-after-restart-2026-10-04.json) 与[截图](test-evidence/screenshots/new-api-latest-403-fee-after-restart-2026-10-04.png) 继续显示新 `12eb…` 的 HTTP 403、选中的完整 ID `2026100422082931846158376692893`、约 `$0.022238` 未知预留及原 22:10:05 查询失败；旧 `5fa…` 的 0/0 用量仍在。该复核没有点击查询或结算，没有新增供应方请求。

已修复同一账单拒绝路径的自动重复探测：结构化权限拒绝/固定接口不支持在首个结果后暂停，按 `gatewayId + 配置版本 + baseUrl` 跨收据持久保留；精确识别历史固定 helper 消息，不猜供应方任意正文。明确手动查询可重新探测，仍拒绝则再暂停；手动 0 结算不会丢暂停依据。临时网络/读取失败、429/5xx、暂未匹配日志仍每收据最多三次，无未知费用自动置 0，也不修改模型调用次数、预算或恢复门禁。[17/17 事务及并发回归](validation/new-api-billing-auto-pause-2026-10-04.txt)、[17/17 helper](validation/new-api-billing-pause-helper-2026-10-04.txt) 为本地验证。原数据的两次已知拒绝各已尝试三次；[实际重启前后核对](test-evidence/new-api-controlled-restart-audit-2026-10-04.json) 确认这些查询历史及费用不变、**未新增重复查询**。已有次数上限也会阻止它们再查询，因此新跨收据暂停与手动重探的边界仍由本地 HTTP/事务回归证明，不能称供应方查询成功。

PTY `27058` 与后台 `8524` 曾无正常退出记录地消失；换启动方式尚未证明根因修复。[宿主边界审查](validation/new-api-launcher-host-2026-10-04.md) 的 `KillOnClose` 观测对象是工具创建的 PowerShell，**不能证明已退出旧进程的 Job 属性或实际结束者**。[原生续审](validation/new-api-launcher-native-followup-2026-10-04.md) 已归档：19:20 的 `35540` / `17032` 后遭遇 19:23:36 实际系统重启，可解释该组消失；21:31/32、重启后启动的 `28328` / API `33852` 消失原因仍未知，不能推广为全部退出的根因。

此前 wrapper `35568` / launcher `37372` / API `11128` 曾连续现场可访问至少 34 分钟，[原生观察器](test-evidence/new-api-controlled-native-observer-2026-10-04-2207.jsonl) 持有实际目标句柄并正常结束、三个进程仍被观察；实际 `inAnyJob=true` 不是已取得目标 Job 的 `KillOnClose` flags，也不算长期稳定性通过。**22:43:41.972** 确认无活动运行/调用/查询后，主代理只故意终止身份已核验的 API `11128`。另一个持有原生句柄的[观察器](test-evidence/new-api-controlled-stop-restart-observer-2026-10-04.jsonl) 捕获三个旧进程实际退出码均为 `0xFFFFFFFF`；父日志为 `api-unexpected-exit` → `launcher-stopped` → `launcher-exit(-1)`，锁被清理。这是强制 API 子进程故障与父清理验证，**不是 API 优雅停止**。

**22:46:27 仅重启一次**，新 wrapper `32924` / launcher `11292` / API `37112` 就绪，网页仍为 4310，API 为 55745。[重启前](test-evidence/new-api-controlled-restart-before-2026-10-04.json) 与[重启后](test-evidence/new-api-controlled-restart-after-2026-10-04.json) 核对 89 条事件摘要、完整快照、DAG、7 次预算历史、四文件实际下载 SHA、费用合计、旧人工 0 及三次失败历史、新 `12eb…` 不明预留及三次查询、四条更早未知费用、操作和审批均保留；没有新增付费调用或员工文件修改。[总审计 19/19](test-evidence/new-api-controlled-restart-audit-2026-10-04.json) 通过。实际网页[断连 AX](test-evidence/new-api-health-disconnected-web-2026-10-04.json) 与[重连 AX](test-evidence/new-api-health-reconnected-web-2026-10-04.json) 无人工导航或手动刷新，仍展示同一运行、89 事件、四文件及费用门禁。Vite 在 22:46:34 再次 connecting，开发模式可能自动重载页面；此证据只证明无需手动刷新，不证明全程没有文档重载。原生观察器 22:58:33 正常结束时仍观察到新三个进程；自然退出根因和长期稳定性仍未解决。

## 完成前仍须补齐

实际服务受控故障、清理、重启加载、页面连接和原数据保持证据已补齐。仍须取得新 `12eb…` 请求的费用与 403 拒绝依据，沿既有网页核对规则处理；不得复用旧收据的人工 0 确认。随后完成员工自己的 CLI 修复、开发与独立测试、复审和经理真实验收，补齐续跑中的知识固定版本与完成节点不重跑证据。服务自然退出的原因和长期独立运行仍须继续验证；后续若改源码，再验证相关测试和类型/构建。当前不能标为六项全部通过。

## 2026-10-05 用户中转站切换续报

“我的中转站” `http://localhost:50240/v1` 已恢复实际访问。目录 11 模型，Astra 文本、Luna/Sol 文本及真实随机工具往返验证通过；7 次模型调用全部有用量，按现有价格本地登记 `$0.0064631`。通过产品接口保存部门 v3 与同项目 v6 草案，执行校验通过：部门经理 Astra，项目开发和运行经理 Luna，独立 QA Sol，项目模型范围包含 Astra 供规划时选择。当前没有全局默认规划器，也没有本次 Astra 新生成的完整方案。

全分页审计项目此前真实已发 43 次，v6 最大 37 次，保留原总 80 次与 `$0.48` 预算。旧 Run 快照、89 事件、四份文件和费用保留；`12eb…` 仍未知，扣住 `$0.0222384` 后预算内余 `$0.2047944`，现有费用硬门禁继续阻止批准。Astra 整份规划的输出预留下限 `$0.25` 超过单次 `$0.048`，未发该调用，没有扩额。未创建新项目规避历史预算、未启动员工或补写交付文件。

本次实际网页复验受浏览器工具初始化/诊断失败阻塞，产品 API 的验证不计作新的网页点击证据。原 10 月 4 日浏览器证据保留；当前正常交付与切站后受控恢复仍未完成。[切换续报与完整证据索引](my-gateway-switch-2026-10-05.md)保存了连接、调用、方案和保全结果。
