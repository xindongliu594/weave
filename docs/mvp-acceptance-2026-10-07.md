# 为伍 Windows 网页 MVP 验收报告

日期：2026-10-07。真实正常与受控恢复业务路径、知识授权/固定版本、隔离数据恢复和工程检查均已验证。源码副本的完整性与位置由配套交付清单记录；费用核对与跨机器凭据迁移另列限制。

## 必须项与实际证据

| 必须项 | 当前结论 | 证据 |
| --- | --- | --- |
| 首页持续多轮、修改方案、确认才保存部门/员工/项目 | 已验证并保留 | [确认前 2 部门/6 项目](test-evidence/new-api-before-confirm-2026-10-04.json)、[确认后 3/7](test-evidence/new-api-confirmed-team-2026-10-04.json)、[失败草案截图](test-evidence/screenshots/new-api-draft-failure-2026-10-04.png)；原真实多轮记录见 [10-04 阶段报告](mvp-acceptance-2026-10-04.md)。本轮 Go 规划的未确认/丢弃/确认有独立来源，确认不额外推理。 |
| 真实 Todo 开发、独立 QA、复核及经理验收 | 已验证 | [正常 v14 独立审核](validation/go-normal-v14-real-acceptance-audit-2026-10-07.md)。Run `88aa22a9-f887-467c-bf12-91bb57d42361`：7011 事件、46 次真实请求；开发首次 11/12 失败，员工自行修好后 12/12；QA、复核各 12/12 和 8/8，全部真实命令退出 0；经理接收 #6999，五文件完整。 |
| 受控中断、服务重启、完整 DAG/完成节点/预算/调用/文件/上下文恢复 | 已验证 | [停止/目录/重启审核](validation/go-recovery-v12-stop-catalog-restart-partial-audit-2026-10-07.md)、[最终同版恢复审核](validation/go-recovery-v12-final-controlled-audit-2026-10-07.md)。父 `e789b929-6d6c-4b08-8ff0-d560e69bbc78` v12 在开发 6/6 已接收、QA 第一条命令待审批且无在途操作时停止；重启后子 `6e860c3c-113c-4245-b400-df85b950769e` v12 完成，开发零新增 Host/模型/工具/本机执行。继承 17 次调用，最终累计 52；QA 与复核真实 6/6、4/4，经理接收 #3441。 |
| 网页节点、员工、审批、费用、原因、恢复与交付入口 | 已验证 | 正常与恢复都经网页逐次审批。新构建显示真实已接收经理结果，原协调回复折叠保留；项目“已完成”不会被再次执行预算校验覆盖。见 [UI 独立审核](validation/go-project-lifecycle-result-ui-independent-audit-2026-10-07.md)、[正常完整网页记录](test-evidence/go-normal14-cua-2026-10-07/final-build-full-ax.txt)、[恢复完整网页记录](test-evidence/go-recovery12-cua-2026-10-07/final-build-completed-full-ax.txt)。README 实际网页下载 SHA 吻合，五文件 API 下载字节/SHA 均验证。 |
| 少量知识资料授权、检索、版本固定与恢复后引用 | 已验证 | 两份原测试资料分别共享/QA 私有。批准 pin3 后网页升级目录4；恢复 QA、复核、经理真实检索/读取仍是 pin3，私有只供 QA。旧 v1/v2/v3 历史保留。见 [v3 审核](validation/go-knowledge-v3-independent-audit-2026-10-07.md) 与上述最终恢复审核。 |
| 备份可在隔离目录恢复关键数据与交付文件，原环境不覆盖 | 已验证并独立审核 | [独立备份审核](validation/mvp-full-offline-backup-independent-audit-2026-10-07.md)、[完整备份原始输出](test-evidence/mvp-full-offline-backup-original-output-2026-10-07.json)、[两个最终 Run 恢复核对](test-evidence/mvp-full-offline-both-runs-restored-2026-10-07.json)。1963 文件/752356226 字节；34 表逻辑指纹关闭重开稳定，637 用量、未知预留、知识历史完整；两 Run 十文件精确字节/SHA；恢复出的正常员工自测 12/12。只读打开隔离库，没有打开或覆盖原库。凭据两文件仅透明复制，未读取/散列/解封。 |
| 与变更相关回归、类型检查、构建及可启动交付 | 已验证可启动及工程检查 | checkpoint 35、上下文修复69、冷启动16、统一工作区版本15、项目状态23、最终结果/生命周期63、成功收尾24 项相关回归；各对应源码与日志在修复清单。最终 [类型日志](validation/mvp-final-types-2026-10-07.txt)、[构建日志](validation/mvp-final-build-2026-10-07.txt) 均退出0。原服务备份后恢复健康，637用量/项目/Run/费用原样，见 [服务返回](test-evidence/mvp-final-original-service-return-2026-10-07/sources.json)。 |

## 文件、预算与复用

正常五文件位于 `docs/test-evidence/go-normal-v14-completed-2026-10-07/`；恢复五文件位于 `docs/test-evidence/go-recovery-v12-completed-2026-10-07/`。均有 `server.mjs`、`todo.test.mjs`、`acceptance.test.mjs`、`README.md`、`acceptance-report.md`。代码、测试、README、经理报告为员工实际写入/继承，Codex 没有补写员工交付物。Codex 本报告是独立验收与工程说明，不充当员工报告。

正常报告 17620B/SHA `342915788d0570634a86450e650cddefa83115fe85394950f94bbb4f2269c24b`；恢复报告 16175B/SHA `9aef7001407cef0ede7bf3e71c3ebd3e9f360632beaa26276ad9c2daf0d5a593`。完整命令正文、调用与资金记录位于各目录的 `archive.json`、`operations.json`、`usage.json`、`readiness.json`、`sources.json`。

原授权新增总上限 $10、每场景 $5、每日 $20 保持。AI 生成任务金额，Codex 只审核可执行性、拒绝不足方案，不手改候选。正常项目 cap $4.1797、累计已登记 $2.5289537、旧未知 $0.096526、可用 $1.5542203；恢复 cap $4.77489、累计已登记 $1.4527753、新未知 $0.0516951、可用 $3.2704196。初始规划/探针预留与旧未知记录另保留，未退款或重置。登记金额依据模型原生 Token 和配置单价，供应商账单另核对。

复用已有 DSH 0.1.5-rc.1、AgentTeams 0.1.20、JSONL 持久会话、Token meter、现有剪枝与工具/审批机制；直接挂载已安装官方 checkpoint-policy 0.1.5-rc.1。修复主流程适配、文件版本标识、网页状态与完成收尾，没有引入新工作流引擎。全部旧运行、失败候选、未提交修改及凭据保留。

## 限制与未核对项

- **费用待核对**：恢复子 Run 的经理任务已接收后多发尾请求，成功关闭中断了它；收据 `c55a3d36-f662-48ef-a69e-baf1ecf26c40` 预留 $0.0516951 未确认供应商扣费。没有按零结算或重放。未来成功收尾已复用停止入场/最多30秒结算等待，相关真实 Host 与延迟回路测试24项通过；旧收据不随修复消失。见 [诊断与修复](validation/go-delivery-settlement-2026-10-07.md)。
- **员工叙述错误保留**：经理报告有整体版本编号、五份“实读”、合并输出长度等笔误；实际文件 SHA、命令/统计及接收链已逐项核验，精确差异在最终独立审核中。原报告未被 Codex 改写。正常旧版本编号曾因排序不同产生两个字符串，完整文件相同；未来统一确定排序，旧 seal 原样保留。
- 本机 Node 命令使用当前 Windows 账户权限；文件合同、CAS 和逐次审批不等于操作系统隔离。当前用途为本机单用户。
- Todo 使用内存数据、仅回环访问，结束进程会丢失业务 Todo；工作任务与交付恢复已经验证。未提供业务鉴权、数据库、分页或生产并发能力。
- 知识采用关键词检索，语义模型未安装。隔离全量恢复已验证；跨机器凭据迁移、长期连续运行和网页 50MiB 小型加密导出的全历史容量未验证。
- 新收尾修复的相关回归、[独立审核](validation/go-delivery-settlement-independent-audit-2026-10-07.md)和加载已完成；没有为抹掉旧未知费用再重复付费运行。已通过的真实路径与修复回归分别记录。

原服务当前为本机 `http://127.0.0.1:4310/`，备份后没有自动重跑任何项目。使用说明见 [Windows 指南](mvp-windows-quickstart-2026-10-07.md)；源码包上一级的 code-manifest.json 记录 verified-source-copy 状态、字节与 SHA。原工作区的最终路径另记 docs/mvp-delivery-2026-10-07.json。另用本机实际 Node 24.15.0 在新隔离执行副本运行两份员工测试：正常 20/20、恢复 10/10，退出0，见 [运行证据](test-evidence/mvp-windows-default-node-deliverables-2026-10-07.json)。此工程复测不冒充员工模型验收。
