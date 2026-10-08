# 为伍 MVP 修复清单（2026-10-07）

依据本机已保存证据整理；本文件没有发起新测试或实时 API 查询。**正常执行与受控重启恢复主路径均已通过独立真实审核**；备份和成功收尾修复均通过独立审核；费用仍待核对，源码副本状态以配套交付清单为准。各报告自己的测试范围与源码版本不同，测试数不能相加成一次全库验收。原始未提交修改、费用、失败运行、凭据与员工交付保留。

## 已有服务加载及实际使用证据

| 问题 | 修复/复用 | 已验证范围 |
| --- | --- | --- |
| 中转站协议、thinking 与工具能力不匹配 | 显式 Chat/Responses 配置、thinking disabled 和严格工具往返测试；未知调用保留预留 | Go DeepSeek 实际文本、工具及员工执行已成功；不能据此宣称其他模型全部可用。 |
| 首页新旧需求与 pending 请求易混淆 | 对话身份持久化、原请求幂等读取、候选状态与确认分离 | 已验证多轮修改、确认前不建正式项目；开始新需求不会清未知费用。 |
| 大规划预检 URL 与 JSON/合同错误难定位 | 本地只读 POST 预检、完整 JSON 解析、安全字段级 schema 诊断、动态产物输入校验 | 类型/构建与相关回归通过且已加载；正常 v14 候选由真实 Go 模型生成，原样确认并完成全 DAG。 |
| 冷调度状态查询超时 | status 使用原批准 job signal，保留取消/总截止时间 | 本地 25/25；历史 Go v8 同版续跑完成，有独立审核。 |
| 本机操作软心跳误撤权、原生 lease 失效 | 已启动命令保持硬授权检查；独立协调心跳避免自己的 lease 被回收 | 本地操作回归与协调 30/30；已重启加载。旧失败/迟到结果没有改成成功。 |
| 大档案追加反复全量解析阻塞调度 | 复用完整日志格式，增加受文件身份约束的验证游标；外部变化退回严格扫描 | 45/45；同步 fsync、完整读取和恢复校验保留，实际源码加载有记录。 |
| 本机网页复用失效上游 socket | API 代理改用新连接，不增加写请求自动重试 | 本地代理/启动 19/19；已有真实续跑记录。 |
| DSH JSONL live 缓冲缺少请求/工具前显式屏障 | 直接挂载已安装官方 checkpoint policy 0.1.5-rc.1，captain/member 均在所属 EmployeeHost | 35/35 和 types 0；2026-10-07 受控服务重启审核证明已经加载。无需升级或自写恢复调度器。 |
| 终态刷新、任务 seed 与 native ID 显示错位 | 运行详情合并刷新、恢复条件、DAG 编号映射与 accepted 状态显示 | UI 31/31；仍必须由员工调用正确 native task ID，不替员工提交完成。 |
| 从运行页回到项目页仍缓存 RUNNING，方案操作长期禁用 | 复用既有只读同步方式，统一项目 GET、页面进入刷新、有界轮询及手动刷新；旧请求不能回写新版本 | 23/23、types/build 0，独立审核通过；实际网页恢复项目已显示终态并重新启用规划入口。付费请求不增加重试或取消。 |
| completed 运行主结果错误显示旧 captain 的“未交付”回复，seal 缺失也可能显示完成 | 从实际 accepted 末端经理任务选主结果，全部批准任务都须匹配 completed/seal；原协调回复折叠保留，列表优先展示真实 COMPLETED 状态 | 最终相关 UI **63/63**、types/build 0；实际新浏览器正常 #6999、恢复 #3441 主结果和“已完成”列表均核对。员工报告与原档案未改。 |

正常 v14 Run `88aa22a9-f887-467c-bf12-91bb57d42361` 已独立审核通过：四节点真实 accepted、7011 连续事件、23 个 completed 本机操作、六次真实命令审批，开发初次失败后自修 **12/12**；独立 QA 和只读复核各自 **12/12 + 8/8**。五份员工文件的下载字节 SHA 与 writes/accepted 一致。46 次 wire/usage 匹配，执行登记费用 **$0.5079759**；历史未知费用 `$0.096526` 保留，未清零。见[正常路径真实审核](validation/go-normal-v14-real-acceptance-audit-2026-10-07.md)。报告所列旧摘要矛盾和旧排序口径保留为历史限制，后续修复不改旧证据。

历史 v10 受控恢复的阶段证据已验证：父 Run `0453cd06-caf6-4fee-91f3-cccb55340a68` 停止后，同 v10 子 Run `559a026b-804c-48ab-b343-9ec2ed102b15` 恢复原开发 seal 与三个文件 SHA，开发新增模型/工具/本机操作为零；QA 实际继续执行。知识目录两份 v2 经关闭源库与服务重启保留，QA 实际读取及引用仍为固定 v1。该旧 v10 链完整交付未通过，保留失败，不替代下述已完成的 v12。见 [受控恢复部分审核](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-controlled-partial-audit-2026-10-07.md) 与 [重启审核](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-controlled-restart-audit-2026-10-07.md)。

## 已加载的上下文与版本修复

| 问题 | 最小修复 | 当前证据与边界 |
| --- | --- | --- |
| DSH 原生 user-role 工具结果被 wire-role 校验误拒绝去重 | 按官方原生 source/call/result 形态验证，转换 wire 后才使用 tool role | 本地回归通过；不承认失败/不完整或未经 Host 证明的结果。 |
| 同文件完整读取在不同并行批次重复占用上下文 | 同 scope、完整参数/结果 SHA 的精确 call/result 对去重，保留 assistant 说明及其他 pair | 原档案不变、不同版本/范围不去重；缺少 source proof 的冷 Host 保守保留。 |
| QA 自己已 CAS 修改的旧输出仍被永久固定 | 仅当前员工非 input 输出的真实成功 CAS 写入建立 source proof，旧读版降为历史，新完整代码仍保护 | 固定 input、知识、未知/失败写入不适用。原真实请求本地预览 92403 B、预留 $0.0400281，在原 QA $0.0452769 内，输出仍 10000；0 wire。 |
| 恢复摘要缺少最近命令版本，员工误把合同别名当原生编号 | 保留历史 runId/workspaceRevision/测试统计，说明保留现有文件、当前尝试仍须 verify、task_id 使用最新 runtimeTaskId | checkpoint/handoff/policy 16/16、types 0，已加载；历史回执不自动转成新 seal，不替员工完成任务。 |
| 同一四文件在 native 和 host 算出不同 workspace revision | 复用本机执行器原有确定性排序，固定 path/size/sha256 三字段，host/sandbox/native 共用 canonicalManifest | 15/15、types 0，已在新运行前加载。旧 locale seal 原样恢复，各文件 SHA 仍严格核对；原 v14 的两种历史哈希不改写。 |

上述请求去重/CAS 上下文修复相关 **69/69 PASS、0 skip、types 0**，独立审核未发现 P0。报告[上下文修复](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-recovery-v10-context-repair-2026-10-07.md)、[恢复摘要回归](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-checkpoint-bootstrap-repair-2026-10-07.json)、[统一版本回归](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/workspace-revision-validation-2026-10-07.json)。原修复 manifest 记录的是当时尚未加载；后续[实际服务重启记录](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-owned-service-20261007-113114-89571c2c.json)及[重启后原数据源清单](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-idle-reload-verified-2026-10-07T03-31-49-216Z-ec6ea7b2/sources.json)已补充加载与保留数据证据。工程通过和成功加载均不能证明任务预算充分。

旧 v10 的 `TASK_NOT_ACTIVE` 和之后的 cold-resume 预算失败均保留：QA 当时有真实两测试通过，但未形成 accepted seal，不能提升为完成。该版本 QA 额度已耗尽，不再重试。之后由真实 Go AI 在原总上限内重新分配预算，拒绝偏低未确认候选，最终网页确认正式 v12，再通过以下实际受控恢复验收；没有手工修改 AI 候选或员工交付。

两份知识目录 v3 的完整历史及原授权已经独立审核。新的 v12 父 Run `e789b929-6d6c-4b08-8ff0-d560e69bbc78` 受控停止、目录升 v4、关闭原服务并重启后，子 Run `6e860c3c-113c-4245-b400-df85b950769e` 在 **3475** 个连续事件后 completed。四节点 DAG、原权限、任务用量和开发 seal 保留，开发没有新增模型、工具或本机操作；QA/复核各自真实 **6/6 + 4/4**，经理 accepted **#3441** 并写入 **16175 B** 报告，SHA `9aef7001407cef0ede7bf3e71c3ebd3e9f360632beaa26276ad9c2daf0d5a593`。QA 和经理实际读取的仍为批准的 **pin3**，目录 v4 没有替换固定引用；经理不读取 QA 私有原文。见[最终受控恢复独立审核](validation/go-recovery-v12-final-controlled-audit-2026-10-07.md)。

经理 accepted 后的额外尾请求 `c55a3d36-f662-48ef-a69e-baf1ecf26c40` 被本地成功关闭流程中断；这是 **manager_accept 员工请求**，不能误称为 captain 请求或推定未扣费。`$0.0516951` 保持未知预留，不重放、不清零。未来收尾复用 `stopAdmission` 和最多 30 秒 `drain`，相关 **24** 项测试及类型检查通过，备份后的原服务已加载修复；[独立收尾审核](validation/go-delivery-settlement-independent-audit-2026-10-07.md)通过，原未知费用不变。

## 验收与交付状态

| 必须项 | 当前状态 |
| --- | --- |
| 最新正常路径开发、独立 QA、复核与经理全 DAG | 已通过。正常 v14 新工作区真实完整执行、五员工文件、46 调用及独立 raw 审核通过，首次失败如实保留。 |
| 受控恢复后的完整交付 | v12 已通过：父开发 6/6 不重跑，子 QA/复核 6/6+4/4、经理报告和全部 seal 完整；旧 v10 失败仍保留。 |
| 受控停止/重启/固定版本/完成节点不重放 | v12 最终独立审核通过；pin3/catalog4、开发零重放、DAG/费用/次数/文件恢复均有实际证据。 |
| 网页交付文件、运行说明和经理真实结果 | 两最终 Run 的文件证据及实际新浏览器经理结果已核对；原员工报告叙述误差由独立宿主审核明确纠正，不代改报告。 |
| 完成结果的全部任务 seal 门禁、项目列表 COMPLETED 优先显示 | 最终 63/63、types/build 0，并以正常/恢复新浏览器主结果及完成列表实际验证。 |
| 最新全量关键数据与交付文件隔离备份恢复 | 已实际复制 1963 文件、752356226 B，在隔离目录恢复并重复只读打开，34 表业务指纹稳定；两最终 Run 十份文件 byte/SHA 相符，正常隔离开发测试12/12。独立备份审核已通过。原库没有直接打开或覆盖。 |
| 完成收尾重复模型请求造成未知费用 | 原额外请求不追改；未来 stopAdmission/drain 修复24测试/types通过并已加载，独立审核已通过。c55 未知费用及旧 hold 保留。 |
| 最终源码包、简明说明、完整验收报告 | 指南、修复清单与最终总报告均已保存；源码复制状态与位置由配套 code-manifest.json / mvp-delivery-2026-10-07.json 记录，推荐清单不充当源码包。 |

最新备份实际原始证据：[原库停止后的复制与隔离恢复](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/mvp-full-offline-backup-original-output-2026-10-07.json)、[两个最终 Run 文件及数据复查](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/mvp-full-offline-both-runs-restored-2026-10-07.json)。其中两份敏感凭据仅作不透明复制，没有读取/哈希内容或解密使用；跨机器凭据迁移未测试。

限制保持明确：供应方费用不是已经核实的 invoice，历史 unknown 与新 `$0.0516951` 预留不按 0 结算。本机 Node 执行器使用当前 Windows 用户权限，独立目录和逐次审批不等于独立操作系统沙箱。知识库实测关键词检索，语义模型未安装。经理报告包含工作区版本、五文件实读与输出长度等叙述错误：例如恢复报告称五份均实读，实际只读四输入，自己报告由 write/accepted 证明；原报告保留，准确文件 SHA/回执/字节长度以配套独立宿主审核为准。

## 安装复用核对

只读核对 `start-local-production.cmd`、`scripts/local.mjs` 以及两份 package-lock：锁格式均为 v3，固定依赖及 integrity 存在。根锁含 PGlite 0.5.8、pgvector 0.0.9、socket 0.2.11；runtime 锁含 DSH/base/JSONL/checkpoint policy 0.1.5-rc.1 和 AgentTeams 0.1.20。官方 checkpoint policy 由 dsh-base 的固定传递依赖提供，现有 `baseRequire.resolve` 在本机实际成功解析。用户只需根目录及 runtime 各运行 `npm ci`，不需要另装或升级插件。本次未执行安装。

新版用户说明见 [Windows 快速开始](mvp-windows-quickstart-2026-10-07.md)。
# 追加：首页需求对话不再占执行预算

按用户要求，首页需求对话移除发送前费用估算、预留及单次/每日额度拦截；新候选确认不采用聊天费用进项目执行预算。实际中转站 Token 回执仍留存，未知费用仍待核对；旧记录、旧预览、幂等请求、权限与执行预算保留。网页把项目预算注明为确认后执行，并单列对话实记费用。74项不同本地回归、类型、构建及实际网页/原服务重启核对通过，未发新的真实模型请求。详情见 [追加验证](validation/conversation-budget-2026-10-07.md)。
