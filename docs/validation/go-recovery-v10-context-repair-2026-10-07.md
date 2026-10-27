# 实际 v10 恢复请求的上下文修复（2026-10-07）

本次只读分析封存的真实 child `559a026b-804c-48ab-b343-9ec2ed102b15`（最终 3193 seq），未调用模型或 live API。原 archive SHA256 `0ef8ed9e2318184a4070aff541f72c1b789502718d07eec050a16c5eae34219b` 保持不变。

## 确切阻断

最后一次请求有 53 条原生消息，实际 Chat 请求 **463491 B**。原门禁下的最低完整受保护请求 **134028 B**，以配置输入 $0.30/M、输出 $1.20/M 和不变的单次输出 10000 tokens 计算，最低预留 **$0.0525156**，超过 QA 剩余 **$0.0452769**。

批准策略是 `contextManagement=prune`，因此没有挂载官方 BasicCompactionEngine，没有发出 summary 请求。已有官方 pruner 的扩展确实运行过一次，缩减旧 terminal 文本 6975 chars；完整文件读取按现有证据保护不裁切。不能直接启用付费摘要：这会改变批准策略，而且摘要输入和预算同样要受门禁约束。

最低请求构成（消息本体统计，另有 JSON/工具模式开销）：

| 内容 | 字节 |
| --- | ---: |
| 完整文件读取 | 62192 |
| 受保护工具组的 assistant 内容 | 22674 |
| 最新批准上下文 | 18685 |
| 最新 assistant 回复 | 8422 |
| system | 8325 |
| 固定知识版本 | 6096 |
| 其他受保护工具结果 | 1098 |

16 次历史批准上下文快照构成膨胀，但原 fitter 只固定最新一份，并非它们全部都不可删除。最新 approved-context 中 requirement 5554 B、task 2454 B、recovery 3041 B、runEvidence 4248 B；它們含合同、预算、文件与原回执，未截断。

真实 `acceptance.test.mjs` 有两次同 SHA、同内容、同工作区、同 task/attempt/scope 的完整读取，各 20581 B。一份在 4 个并行读取的 batch 中，另一份是单读且 assistant 说明不同，原 whole-group 比较不承认它们重复。另外，原 `nativeReadGroup` 错误要求原生 result.role 为 `tool`；实际 DSH result.role 是 `user`，转换到 wire 后才为 `tool`。这让真实原生读取无法获得去重资格。

成功写入的新版 acceptance 测试代码仍完整存在于 native `artifact_write` 调用中（20390 B assistant group），其后没有同版 filesystem read，因此不能删这份唯一新版代码。

## 最小修复与边界

1. 接受官方 DSH `user` + `source.kind=tool` 的 native 结果形态，仍验证 source/call ID、完整 result block 和 `isError=false`。
2. 对经 Host 证明的成功完整只读调用，按精确 arguments/result SHA 和同 scope 跨 batch 去掉重复 call/result 对，保留各自 assistant 说明、其他调用和全部原始档案。不同版本/路径/权限域或不完整、失败结果不去重。
3. 为真实已知成功 CAS 写入增加 source-side write proof。仅本员工当前任务声明的非 input 可写输出，旧完整读 SHA 与 write.expectedSha256 相等，新完整内容算出的 SHA 与真实成功结果相等，且同 run/session/task/attempt/scope 时，旧版本从当前请求的固定保护降为历史。它不是跨 SHA 精确去重。新版完整代码和结果保持受保护；固定 input、知识、失败/未知写入不能走这条路径。

使用同一封存真实请求做无 wire `prepareRequest` 回归，得到 **92403 B**、预留 **$0.0400281**，满足原 192000 B 门禁和原 QA $0.0452769 余额；输出上限仍是 **10000**。原消息没有修改，3 份 dev 输入、知识 v1、当前完整新版 QA 代码均保留。该结果是本地预览，**不代表新的真实员工运行已经完成，也不保证剩余预算足以完成后续多轮调用**。

实际最后 `agent_teams_update_task` 传入的是 `task_id=qa_verify`，而 native 分派 ID 为 `t2`，因此返回 `TASK_NOT_ACTIVE`；QA 随后再请求模型才触发预算门禁。这是员工把合同 seed 当成 native task ID 的具体错误，不可由 Codex 代提交 seal。

## 验证与证据

- 7 个相关测试文件 **69/69 PASS，0 fail、0 skip**，覆盖真实 LocalExecutor 写入证明、固定输入不能失去保护、foreign scope、失败 CAS、原生结果、重复 pair、未知/失败/不匹配/未配对写入、质量 handoff、原预算/output/cold restore。
- 类型检查 `tsc --noEmit` **exit 0**。
- 首轮 68/69 的唯一失败是旧 fixture 对 `0.029999999999999995 === 0.03` 的严格浮点比较，改为 `Number.EPSILON` 级容差；原失败日志保留，产品预算公式没有变化。
- 原请求诊断：`docs/test-evidence/go-recovery-v10-context-analysis-2026-10-07.json`。
- 实际请求修复预览：`docs/test-evidence/go-recovery-v10-context-repair-readonly-2026-10-07.json`。
- 最终日志：`docs/test-evidence/go-recovery-context-repair-tests-2026-10-07-final.txt`、`go-recovery-context-repair-types-2026-10-07.txt`。
- 源码与结果 SHA：`docs/test-evidence/go-recovery-v10-context-repair-manifest-2026-10-07.json`。

未改变项目/任务额度、输出上限、模型价格、知识权限或批准 DAG；未改员工文件、原数据和运行记录。必须由主代理重启加载后继续实际验收。
