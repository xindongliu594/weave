# Go MVP 工程问题、修复与验收边界（2026-10-06）

本清单依据已保存报告整理，不是一次新增测试或实时状态查询。只写本 NEW 文档；未访问真实 API、模型、原库、服务或员工工作区，未修改源码、冻结 helper、员工文件或快速开始文档。以下测试数对应各报告自己的源码 SHA 与范围，存在重叠，不能相加成一次最终全库验收。

**工程修复已有回归证据，完整 MVP 尚未在本文件获得验收。** 正常 v8 的同版故障续跑成功是有效历史证据，不能替代从头运行的最新正常版本、另一项目的受控停止/重启恢复、知识 v1→v2 与最新成果备份。

## 已修复问题

| 问题与原因 | 修复结果 | 关联本地验证证据 | 实际验证边界 |
| --- | --- | --- | --- |
| 新 Go Chat 模型缺少明确关闭 thinking 的配置，API probe 又不保存推理状态；新工具选择可能与上游协议不兼容。 | 可选 `thinkingMode:disabled` 从保存、预留、API 到运行路线精确透传；只有显式配置才增加 wire 字段，disabled probe 用 auto，nonce/name/count/往返验收不放宽。已知 usage 先登记，忽略关闭而返回非空 reasoning 的 API 响应拒绝继续。 | [thinking 工程报告](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-thinking-mode-2026-10-06.md)：API 4/4，runtime 55/55，缺字段旧 Chat 行为保留。 | [实际阶段记录](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-live-stage-2026-10-06.md) 已记录 DeepSeek 文本和两轮工具成功。GLM 首次 HTTP400 的上游原因未证实，未知预留 `$0.0016958` 保留；不能说 GLM 已修好。 |
| Chat/Responses 请求格式、工具关联与计费预留不能互相套用；无效输出或失败响应可能诱发重复调用/预留丢失。 | 显式协议、完整 stateless function 往返、实际 wire 预留、费用持久化后才处理输出；已发送未知调用保留费用预留，不自动重试或 fallback。 | [API 6/6](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/completion-protocol-api-2026-10-06.md)、[runtime 103/103](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/responses-runtime-2026-10-06.md)。 | 这些是本地 HTTP/内存 fixture；本轮真实 Go DeepSeek 使用 Chat，不能称为真实 Responses 或厂商账单验收。 |
| 同首句新需求与原会话身份不易区分，草稿重置可能改旧 pending 的正文与幂等身份。 | 新对话 UUID、同对话 reload/多轮稳定身份、Go session header 绑定；旧 pending 仍沿用原正文/key，重置先归档未知请求与费用记录。 | [组织 session 17/17](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/organization-session-2026-10-06.md)：UI 7、隔离 API 10。 | 未替用户清空实际浏览器 sessionStorage，也未自动更换旧 Astra；首页仍须明确选择 Go。 |
| 未知费用使重规划无法继续，过期 pending 又可能先被维护逻辑释放；旧需求中的模型选择与新 Go 要求冲突。 | 默认拒绝 unknown；明确保留后仅在净预算内生成，不结算或重放未知动作；锁内在过期处理前检查 pending。原文调整说明绑定 quote/body/key/candidate，确认保存匹配原候选，不派发模型。 | [费用保留 API 16/16、UI 22/22](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/planning-carryover-2026-10-06-final.md)，[调整说明 API 17/17、UI 23/23](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/planning-adjustment-2026-10-06.md)。 | 实际 Go 已有多版确认/生成链。旧 unknown 仍占原预算，pending 不得绕过；隔离 PGlite 不证明所有独立 PostgreSQL 连接的锁时序。 |
| 任务预算错误只给总括信息，AI 和用户看不到哪个任务以及具体缺口。 | 原公式、20% 余量、严格比较保持；逐任务显示 ID、名称、估算与未舍入 cap。不会替 AI 修改预算或候选。 | [费用反馈 8/8 + 既有 33/33](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/task-budget-feedback-2026-10-06.md)。原 QA `$0.1512 > $0.15` 真实无效候选与已付费仍保留。 | 信息更准确不保证下一份 AI 预算充分；单次调用预留与累计运行仍会按实际请求再检查。 |
| v5 QA 在单次输出 cap 3000 截断长工具 JSON，随后默认摘要 cap 1024 也截断。 | 已知 usage 先登记，再识别 cap 达到且工具参数未闭合的 `OUTPUT_TRUNCATED`；不补 JSON、降输出或发送工具。prune 是已有明确策略，实际更换策略须保存新版本并重新批准，旧 Run 不自动迁移。 | [截断回归 62/62](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/output-truncation-runtime-2026-10-06.md)。 | 原失败和原文件保留。后续实际 AI 新版可使用更合适输出 cap；检测错误不保证模型生成质量，不能把新的配置套到旧 accepted 合同上。 |
| v8 `agent_teams_status` 包含冷启动和调度等待，却另带 15 秒短截止，导致未发送的复审被中断。 | status 使用原 job signal；批准的总 deadline 与用户取消仍有效，其他 setup/预算/权限边界保持。 | [status 生命周期 25/25](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/status-lifecycle-runtime-2026-10-06.md)：16 秒冷启动跨 QA→复审、取消和批准 deadline 都覆盖。 | v8 原父 Run 仍 failed。真实同版子 Run 完成有独立审核，见下文；不等于最新 fresh normal 通过。 |
| 只数 wire 会漏掉已登记但未发送的调用，恢复/规划反馈可能少计额度或重复叠加入场历史。 | 每 Run/任务使用持久 admission 与 archived wire 的 max，不相加、不再叠加 budgetHistory；未发送但已登记的调用仍消耗原次数额度，所有权/版本不明不推定 0。 | [36 项计数回归](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/budget-history-admission-2026-10-06.md)、[最终类型检查与 12/12](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/budget-history-admission-2026-10-06-final.md)。 | v8 实际父 23 wire/24 admission，子继承 24、终值 42，与审核吻合。此修复没有清费用或扩大调用上限。 |
| 本机静态网页代理复用一个上游 socket，实际恢复前读取历史 Run 出现 502。 | 仅关闭 http.Agent keepAlive；每个 API 请求建立新上游连接，不增加 GET/POST/PUT 自动重试。 | [代理/launcher 19/19](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/local-static-web-fresh-upstream-2026-10-06.md)：旧 8 请求/1 socket 的红例、新 8/8 socket、响应中断后的单次派发。 | 实际第二次 resume 在 POST 前被拦，0 mutation；502 不能单独证明具体 ECONNRESET。后续 v8 续跑是单独真实证据，未来服务可靠性仍须实际检查。 |
| v9 已 started 的命令等待仍被 15 秒软心跳判定撤权；真实 exit 0 只成为 cancelled 操作的 lateResult。 | 已开始的同一操作在硬授权/claimToken/lease/deadline/取消等条件都有效时，不以软心跳过期取消；认证完整回执登记时刷新心跳。late/cancelled 记录不晋升完成或自动重放。 | [心跳 18/18](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/local-operation-heartbeat-2026-10-06.md)：新增 PGlite/native 4、并发 7、桌面 7。撤权等反例保持。 | v9 `1e91d7d2…` 仍 failed、3941 events；晚到 3/3/exit0 没有被当作 accepted。新 v10 需完整实际验收，见快照边界。42 MB 档案扫描性能没有因此宣称已优化或已证明为根因。 |
| 终态局部刷新不更新 recovery/summary；原生 t1 与批准 dev 编号混用，交接状态和返工可能错位。 | 手动刷新详情合并页且保留 cursor；刷新未知操作后清旧 ACK/检查 key。DAG/状态按实际 mapping 和批准合同显示，最新返工优先，未 accepted completion 不标完成。 | [UI 31/31、tsc 0](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06.md)，15 输入 SHA 稳定。 | 提供的旧截图只覆盖顶部失败，不是完整下载验收。停止后刷新、四节点/测试/五文件实际页面证据仍由最终浏览器报告核实；长终态岗位侧栏依赖事件分页的 P2 未扩大修复。 |
| 大原始 Run JSON 内联可能超过整包限制，旧固定 v5/固定计数/文件哈希脚本不适用于后续实际版本。 | NEW 引用 capture 保存完整原始 Run，离线逐源验证字节 SHA/所有权/版本/完整 seq；动态版本与真实 Go 确认/付费生成链。NEW 网页 helper 从实际 accepted、本机回执、manifest 和 raw bytes 建立期望，不写死旧结果。 | [引用 capture/audit 20/20](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-acceptance-run-references-2026-10-06.md)、[动态 audit 13 项](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-todo-acceptance-audit-2026-10-06-final.md)、[网页 helper 8/8](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/inspect-go-delivery-web-2026-10-06.md)。 | 每原始源仍有 50 MiB 边界，不剪消息/事件来冒充完整。helper 准备和纯测试通过不代表真实捕获、网页五文件下载、知识或最新备份已通过。 |

## 可采用的实际历史证据及限制

[v8 同版真实续跑审核](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-v8-real-resume-audit-2026-10-06.md) 验证父 `0947ae05-5c3c-47d0-969b-5c8a739118f1` 失败后，子 `f0f68b82-eeaf-493f-9f54-c932504e430a` completed、1548 连续事件、integrity=ok。dev/qa_verify 的 exact accepted seal 与四文件 SHA 继承，新 dev/qa_verify wire 为 0；复审与经理本次真实 accepted，复审两命令均完整 7/7、exit0，本机/审批/session/call/attempt 对应。未知预留 `$0.096526` 在该保存费用帧继续保留。

该报告同时保留经理把三文件/四文件 workspace revision 混称、SHA 缩写与清单排序差异、负向监听探针强度不足等限制；员工报告原文未修改。这些是如实披露的历史交付精度/测试强度边界，不能省略后改称所有结论完美。父失败不改写；此子 Run 是修复非受控故障后的续跑，不能拿来代替最新从头 normal 或另一项目的受控恢复。

最新读取的 [v10 启动证据](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-run-web-normal-approve-2026-10-06T06-33-37-751Z-986d6325.json) 绑定正常项目 `4938eab8-26ed-4f60-9413-d979f05fa968`、版本 10、Run `17af4ec6-379e-47bc-9b6b-0afd16d49869`，保存状态为 active/not completed。[14:39 保存的 watch](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-normal-v10-watch-2026-10-06T06-39-19-845Z-51bc751f.json) 仍有真实测试审批。这里不查询现在的运行状态，也不把随后可能产生的完成事件自行补成通过；最终以根任务新捕获的完整证据为准。

## 未完结的交付判定

- 最新 normal 必须有同版真实 dev、独立 QA、复审、经理全 DAG 和当前文件 SHA/真实命令/五文件网页下载证明；旧失败、v8 修复续跑、fixture 或生成 HTTP200 都不能替代。
- 另一恢复项目承担受控停止、精确服务重启、同版 child、已完成节点不重复、原预算与次数继承、未知外部动作不重放。NEW [停止守卫 58/58](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-funded-stop-2026-10-06.md) 是工程证据，真实流程须由最终 capture 核实。
- 根任务明确：正常项目本轮没有知识授权，知识验收范围放在恢复项目 v8。原审计的“正常 Run 也必须有 QA 私有知识”及对应 capture gaps 是范围误配，正在准备独立 NEW final-scope variants；不能通过删掉全部知识检查处理。正常仅在完整确认/快照/员工/当前部门 grants 全部明确为零且无工具/PIN/citation/活动时可不适用；缺字段或任一授权/活动继续严格阻断。恢复项目的固定 v1、当前 v2、真实引用、授权及拒绝证据全部保留。
- [知识 v2 helper 34/34](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-funded-knowledge-upgrade-2026-10-06.md) 和 capture/audit 准备记录不是知识更新与员工实际引用证明。职责范围与实际完成各自记录，不据此提前通过总审计。
- 原 Astra `$0.7603`、GLM 400 `$0.0016958` 与其他 unknown/orphan receipt 按原账本保留。功能与财务分别判定；provider bill 未核对继续 blocked，不能以本机配置价格或成功下载推定清零。最终需核对全局原 `$10` 净余额规则和各项目 cap；本文不给新的累计金额。
- 最新成果代码/全部数据备份、原始字节 manifest、准确停服身份与两侧重启/恢复证据仍须最终报告；旧备份或脚本通过不能当最新备份验收。本文不宣布完整 MVP 成功。

## 快速开始文档只读建议（交根任务决定）

已审阅 [docs/mvp-go-quickstart-2026-10-06.md](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/mvp-go-quickstart-2026-10-06.md)，阅读时 SHA256 `7cacb4ecdf96f95bf73df5bcdc455c618631e60419f4b50c4f251697a44e7ed8`。该文已明确当前代码/原数据绝对路径、沿用数据目录、待最终两 Run/备份报告、逐次命令审批与保留未知费用；本任务没有修改它。

1. 在确认步骤补“需求对话与生成候选已调用模型并计费；确认只保存方案，批准后开始员工执行”。“确认前不保存正式团队”容易被理解成确认前免费。
2. 选择 Go 会保留已有 allowedModelIds；本轮只用 Go 时，明确取消旧 Astra/Luna/Sol。旧 pending 锁定模型与设置时，使用“继续获取回复”或归档未知请求后“开始新需求”；不能改旧正文/key。
3. “当前文件版本上运行”改成审批绑定请求的 expectedWorkspaceRevision；最终以当前 accepted SHA 对应完整回执为准，历史 exit0/lateResult 不自动晋升完成。
4. 通用启动示例使用 `start-local-production.cmd "--data-dir=绝对路径"`，含空格路径不会拆参数。“现有账号”可改“模型配置”，避免被理解为产品有登录账号体系。最终备份/交付位置定稿后再补其对应路径，当前路径不冒充新备份地址。
5. 截断/上下文/任务费用错误后，在项目中让 AI 按具体反馈调整输出、任务范围或预算分配并确认新版本；旧 Run 的恢复仍使用原 policy/cap。不要自动降低输出或把新规划用于旧检查点。

建议已通过团队消息交根任务；不新增确认流程，不修改原使用说明、员工 README 或任何运行数据。
