# Go 最终隔离备份接续点

本文件是准备记录，尚未执行最新两个场景的全量备份。实际流程沿用 [原只读预案](final-offline-backup-plan-2026-10-05.md)，以下更新优先于旧 SHA 和旧 Run 示例。

- 当前完整正常、受控恢复的最终 Run 尚未产生，不能把失败 v10 或修复续跑 v8 写成这两个最终结果。备份前从真实网页/API 保存最终项目、版本、Run、文件 SHA、完整 DAG、调用和费用/未知预留、知识固定版本。
- 备份器已修复本机 HTTP 测试误拒绝：[12/12 回归及范围](full-offline-backup-loopback-fetch-2026-10-06.md)。实际冻结 `scripts/verify-mvp-full-offline-backup.mjs` SHA 为 `d244812c9139e4df270f1f37cf49a2f1f56540c4f62fdb9b9747128709e6a163`；复制新审计根时核对该 SHA，不再使用旧 `edd2…`。默认和 restore worker 仍禁止全部 fetch；仅全新 execution 副本显式允许本机 HTTP，外部、提供商端点、URL 凭据和重定向仍拒绝。
- 原数据仍为 `C:/Users/JJ/Desktop/la/agent_department/.data/local`。只在准确核对并关闭本轮所属服务、无在途业务后复制；不删除锁、不打开或覆盖原数据库。使用新的 `.data/final-full-backup-audit-20261006-<UUID>`，其 `docs/test-evidence` 与 `docs/validation` 为空，避免旧固定报告名被覆盖。
- 用同一备份器的导出函数对第二个最终 Run 顺序只读核对两次，保存实际数据逐文件清单。原 unknown 费用及 history 不清除，凭据只不透明复制，认证迁移不作推定。
- 使用已确认完整的源码、根及运行器 lockfile、实际 `dist/web`、Windows 启动入口和最终说明形成源码副本。数据恢复和代码清单都须来自实际字节，不用拟定清单替代。
- 两条员工独立测试均在各自新的 execution 副本运行，使用导出的 `executionEnv` 和 `networkGuardCode({allowLoopbackFetch:true})`，保留员工原文件与真实输出，不在原工作区、snapshot、restore artifacts 上运行。该复测证明备份文件可用，不能代替员工真实执行和经理验收。
- 只有备份器报告 `copy-complete-original-can-restart` 后，才重新启动原服务；其后所有恢复审计和文件复测继续使用隔离副本。服务恢复健康不派发模型或重放历史外部动作。

完成后保存新实际报告、正常/恢复两个 Run 的逻辑指纹与文件 SHA、代码/数据 manifest、隔离测试输出、原服务重启健康与费用保留情况，并更新主验收报告。
