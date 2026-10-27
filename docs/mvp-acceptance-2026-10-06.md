# 为伍 Windows 网页 MVP：Go 实际验收

本报告接续历史成果和失败证据。**当前尚未全部通过。** 最新正常 v12 Run `566c813d-6fc9-409a-b945-ec9d5afea4fe` 已由真实 Go 模型生成、确认并执行：开发 9/9、独立 QA 11/11 已验收，QA 首次失败及员工自行修正记录保留；复审首次调用前因租约失效中断，经理未执行。原 API/启动器进程当时仍在，此次不是主动停止或服务重启验收。完整原件和调用/文件审核见 [v12 独立审核](validation/go-normal-v12-interrupted-audit-2026-10-06.md)。恢复项目已由 AI 重估并真实执行 v10，开发 6/6 已验收，在首个 QA 命令未执行时通过网页唯一 POST 202 受控停止，完整档案、费用、文件和知识 v1 保留；[独立停止核对](validation/go-recovery-v10-controlled-stop-reconciliation-2026-10-06.md)确认派生运行预留正确释放。当前仍须完成员工经理验收、受控服务重启、知识恢复引用及最新隔离备份；工程 fixture 不替代这些证据。

运行器回收自己仍 active 的过期租约已在隔离环境复现，并以独立心跳和锁内活跃判断修复，[30/30](validation/go-live-lease-expiry-investigation-2026-10-06.md) 相关回归通过。档案写入性能修复 [45/45](validation/trace-append-cursor-2026-10-06.md) 已通过，保持逐事件 fsync、完整导出和恢复严格读取。统一类型检查、生产构建通过，19:39 实际精确重载后核对原 496 条用量、项目和 Run metadata 不变。README 宽泛停止全部 Node 的建议按员工原文保留，未执行；下一份 AI 方案要求员工自行提供安全的启动/停止说明。

加载后正常 v13 的首次规划尝试返回已知 422 结构错误；本次真实用量及 $0.0074085 费用已保存，未确认、未批准，原正式 v12 不变。旧诊断丢弃了具体 schema 字段问题，当前正补安全路径与约束信息，避免依赖猜测重复生成。见 [v13 失败封存](validation/go-normal-v13-schema-rejection-2026-10-06.json)。

正常路径旧 v10 已确认 **failed**。五条命令均 completed、started=true、exit0、无 lateResult，开发 6/6、独立 QA 4/4 与复审 accepted 保留；最终经理没有 model wire 或报告。宿主 36 次占用、34 条 wire 的差额未清除，见 [v10 完整核对](validation/go-normal-v10-first-offline-2026-10-06.md)。前置设备准入和方案输出解析修复已通过本地验证并[实际加载](test-evidence/go-planning-parser-loaded-2026-10-06.json)，重启前后 459 条用量及项目、运行 metadata 保持。

恢复路径旧 v8 Run `c92961f2-5573-4299-82c2-daa7ee13dca5` 因已批准的 3600 秒期限 **failed**。四次停止验收尝试均没有转发 POST，不能算受控停止。最终 6800 个连续事件、完整 DAG、四份员工文件及原始字节保留；18 request/wire/usage/host 调用一致，开发测试 3/3 通过，QA、复审和经理未完成。见 [最终来源绑定](test-evidence/go-recovery-v8-timeout-final-binding-2026-10-06.json)。新停止脚本已通过实际离线浏览器的长前置检查和唯一请求测试，但真实重启续跑仍未通过。

工作台：[http://127.0.0.1:4310/](http://127.0.0.1:4310/)。源码目录 `C:/Users/JJ/.codex/worktrees/f57c/agent_department`；原数据目录 `C:/Users/JJ/Desktop/la/agent_department/.data/local`。使用步骤见 [Windows 简明说明](mvp-go-quickstart-2026-10-06.md)。

## 按优先级继续执行

| 优先级 | 必须项 | 当前实际状态与证据 |
| --- | --- | --- |
| P0 | 多轮需求、候选修改、确认才保存 | 既有真实网页流程保留，见 [10-04 报告](mvp-acceptance-2026-10-04.md)，组织 session 隔离 [17/17](validation/organization-session-2026-10-06.md)。正常 v12、恢复 v9 的真实生成与缓存确认均有独立来源链；确认不新增推理，不把本地回归算成模型验收。当前首页空需求/禁用发送/无确认入口另有实际浏览器截图，仅证明初始状态。 |
| P0 | 正常项目开发、独立 QA、复审、经理 | **未完成**。项目 `4938eab8-26ed-4f60-9413-d979f05fa968` 的 v12 已真实执行至开发及 QA 验收通过，复审租约中断、经理未执行；[完整原件](test-evidence/go-normal-v12-lease-interrupted-2026-10-06T11-11-46-796Z-fdac107a/sources.json)及[独立审核](validation/go-normal-v12-interrupted-audit-2026-10-06.md)保留 26 宿主调用、25 wire/usage 与四文件。旧 v11 的 producer 输入固定历史 SHA 导致 QA VERSION_MISMATCH 失败，已修新方案门禁，不能把其启动前 0 POST 误写成最终状态。旧 v10 的实际范围继续保留。 |
| P1 | 受控停止、服务重启、同版恢复 | **部分已验证、全程未完成**。项目 `3e101c24-87e6-43ea-80f9-a2c4b0b410f4` 的旧 v8 期限失败保留。最新 v10 父 Run `0453cd06-caf6-4fee-91f3-cccb55340a68` 已在开发 accepted1102/6项测试通过、首 QA 命令待审批未执行时，通过实际网页唯一 POST202 停止；最终 cancelled、2432 连续事件、18 次调用、四文件及原知识 v1 完整。旧脚本误要求每日活动运行预留前后相等而报 unverified，原件不改；[98项独立原件核对](validation/go-recovery-v10-controlled-stop-reconciliation-2026-10-06.md)确认只释放应释放的运行预留、收据不变。真实网页恢复检查显示保留1节点、已用18/100、可用$4.150841；尚未进行此父 Run 停止后的服务重启、续跑和开发零重复调用验证。 |
| P1 | 知识授权、检索、固定版本、恢复后引用 | 原两份样本的授权、QA 私有资料正向和开发拒绝已有真实证据。本轮运行先固定 v1，停止后网页编辑为 v2，再检验恢复员工继续引用 v1。当前尚未执行 v2 编辑或恢复后引用，不能提前标通过。正常项目无知识授权，知识实验在恢复项目进行。 |
| P1 | 当前两项目全量隔离备份恢复 | **未验证最新版本**。旧隔离备份成功保留，见 [旧备份](test-evidence/my-gateway-full-backup-2026-10-05.json)，不能代替本轮新 Run。最终停服核对后复制到新 snapshot/restore；原目录不覆盖、不打开做恢复实验。本机 HTTP/fetch 守卫修复已通过 [12/12](validation/full-offline-backup-loopback-fetch-2026-10-06.md)，实际最新备份仍未执行。 |
| P2 | 网页 DAG、员工、审批、费用、失败、恢复与交付 | 已有主流程修复及类型/构建证据；当前正修自动验收重复读取历史造成的阻断和运行列表性能。最终 completed Run 的五文件网页下载、SHA、测试输出、追溯和截图仍须实际核对；恢复页按实际父子 Run 验证。 |
| P2 | 可启动代码、最终报告、修复清单、限制 | 原 Windows 生产入口与静态网页已运行，最新修复已加载。简明说明已保存；最终代码与数据清单、两 Run 证据、报告结果在完成后冻结。 |

## 真实模型与预算

用户已批准两个场景各不超过 $5、新增总上限 $10；每日 $20 和审批规则保留。规划、开发、独立 QA、经理均通过已配置的 `https://opencode.ai/zen/go/v1` 使用 `deepseek-v4.1-flash`，Chat Completions，显式关闭 thinking。真实文本和两轮工具能力测试已通过，GLM 的已发生拒绝记录保留，不把目录可见当作可调用。

AI 生成任务预算；本轮正常项目净上限 $4.17970，恢复项目 $4.77489。差额用于原已发生规划费用、未知预留及能力验证，仍计入各 $5 与合计 $10。已有未知费用继续占用预算，未按零处理。实际 Token 按已配置峰时费率保守登记，**不宣称已独立核对提供商订阅账单**。

v10 真实链：[生成](test-evidence/go-heartbeat-normal-generate-2026-10-06T06-31-05-736Z-a029de67.json)、[确认](test-evidence/go-heartbeat-normal-confirm-2026-10-06T06-32-35-063Z-4926d956.json)、[批准](test-evidence/funded-run-web-normal-approve-2026-10-06T06-33-37-751Z-986d6325.json)、[原生测试回执](test-evidence/go-normal-v10-terminal-observation-2026-10-06T06-45-48-668Z-b8b6a9da.json)。Todo 代码、测试、README 和经理报告均须由员工产生；Codex 只编写工作台修复、验收工具及产品报告。

## 保留的失败及成功范围

- v9 Run `1e91d7d2-d99d-45f7-90a8-bb9bb2c80ff0` 因已开始本机操作误受软心跳过期而失败。该测试迟到结果为真实 exit0，但原操作保持 cancelled/OUTCOME_UNKNOWN，不晋升成功、不重放；[原始证据](test-evidence/go-normal-v9-outcome-unknown-20261006-135406-aeb07003/sources.json)。[最小修复与 18/18 回归](validation/local-operation-heartbeat-2026-10-06.md)已加载。
- v8 的真实故障修复后续跑 Run `f0f68b82-eeaf-493f-9f54-c932504e430a` 已完成：保留已完成开发/QA，继承 24 次调用，新 18 次，共 42 次；复审两套 7/7 与员工经理 PASS 报告真实。原四文件 SHA 未变。[独立只读核对](validation/go-v8-real-resume-audit-2026-10-06.md)。这是已有故障恢复成功范围，不能替代本轮全新正常路径、受控中断与知识 v1/v2 实验。
- 本机执行器受工具、文件版本、审批、设备授权与租约约束，实际使用同一 Windows 用户权限，未提供独立 OS 沙箱。Todo 的内存记录随 Todo 进程退出丢失；工作台的项目追溯、文件与预算持久化。

## 工程证据

已完成的相关验证分别见 [已开始操作心跳](validation/local-operation-heartbeat-2026-10-06.md)、[原生状态生命周期](validation/status-lifecycle-runtime-2026-10-06.md)、[恢复调用次数](validation/budget-history-admission-2026-10-06-final.md)、[静态 API 连接](validation/local-static-web-fresh-upstream-2026-10-06.md)、[网页刷新与任务映射](validation/go-run-refresh-mapping-2026-10-06.md)。最终类型检查 [exit0](validation/go-heartbeat-final-typecheck-2026-10-06.txt)，网页 [构建 exit0](validation/go-run-refresh-final-build-2026-10-06.txt)。Vite 保留约 531 KB bundle 提示，运行器员工命令使用系统 Node 24.15.0；本轮 API 为 Node 24.19.0。

最终结论以实际正常、受控恢复、隔离备份和网页交付证据为准。尚未验证项、原失败项、提供商未知费用分别记录，不以本文步骤说明代替实际验收。
