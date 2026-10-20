# Accepted-stop API 综合同步清单最终独立复审

结论：**PASS（仅针对已冻结的 accepted-stop API 综合清单）**。原 API-STOP-01～06 及原 target context 固定均 CLOSED；本 scoped 复审未发现该清单内剩余必改。此结论取代本目录先前 API 预审/窄复审对这些已修项的 CHANGES REQUIRED，不代表 Task 5/Task 6、恢复/carrier 或整产品上线门禁完成。

本次只读最终源码、测试实现及现有 RED/GREEN/exit/SHA 记录；没有运行测试、Git、网络、JJ、设备、安装或模型调用，没有修改生产/测试源码。

## 已冻结集合实际落实

1. **来源固定与同步核对。** `Selection` 仅增加私有同步 `recheck` closure。它以实际验过的 accepted/proof、CP id/seq/SHA、原 boundary digest 为基线；fresh exact-key latest accepted 与 matching node-accepted CP 必须仍是原选择。`readStepCheckpoint` 重新核对实际 CP checksum 与对象，因此末 await 改 CP body、保留旧 sha 不会变成新 baseline。
2. **边界、持久见证和相关输入。** 唯一 boundary 的原 envelope digest 在 closure 中比较，`authority` 也核对其 type/links/data task/attempt/session/trigger/seq 并纳入语义摘要。closure 同步要求 CP 之后准确 native completed witness 仍存在，并重用 `pinnedInputs` 对齐实际 fixed origins。未 hash 全部 events 或整份 team/checkpoint。
3. **原 A 与当前 B 引用对象。** 原 A SQL commit chain、当前 B head operation/task 都先由各自的 pure positive helper在原锁序中验真。closure 捕获这些已验 `record.after.manifest` 及原完整 head manifest；fresh CP reader验证 CP refs，对其他 SHA/size 对象使用本次新建的去重集合及 `readArchiveObject`。历史 A-only 和 current B-only 对象均覆盖，不只重复读 CP partial；未重复解码多份 full base64 canonical，也未给 marker 塞入 bytes/token。
4. **正确调用时机。** prepared 和 beforeDispatch 两个事务在 CAS 前调用 `verified.recheck()`，随后建立 authority baseline；COMMIT 返回后 `sync(..., recheck)` 再同步检查来源/对象、archive semantic authority、signal/provider。失败保留原 unresolved marker，未增加 COMMIT 后 async SQL 或 stop 重发。
5. **原目标身份。** `LocalRunExecutor.prepareTask` 在首 await 前复制并冻结 exact 五字段 context，后续 previous/scope/stop/enqueue/identity 写入都继续用该内部副本。caller 对象原地改成另一个合法 task 不会改派本 invocation。
6. **先前已修边界保留。** provider 两方法引用和 executor/scalars仍冻结比较，调用固定函数并保留 this；原 raw claim exact、完整 binding/backend 投影及 A/B 各自 provenance 保留。existing-marker observation 没有增加 current lease/cancel/native mapping 资格，不授新 effect；真实 Stopped 仍用独立窄事务补记。active status、普通 stop guard 和 profile launch gate 未放宽。

## 证据核对

- `api-stop-sync-red-corrected.txt` 同一九 case 矩阵 **0 pass / 9 fail / 0 skip**，`api-stop-sync-red-corrected.exit.txt` 为 `exitCode=1`。逐项失败为 Missing expected rejection、实际 effect `1 != 0`、caller 被改派 `c != b` 等行为断言；不是导入/依赖/fixture gate 失败。
- 最初 `api-stop-sync-red.txt` 的 producer-origin case 出现 `UNACCEPTED_INPUT: p:p.txt`，不能作为该 case 的有效 RED。该原始记录已保留；最终裁定使用修正 fixture 持久 Handoff 接受内存后的 corrected 日志，没有把初次环境性失败混入行为证明。
- `api-stop-sync-green.txt` 是修后完整 delivery **39/39 PASS**、fail/cancel/skip/todo 均为 0；`api-stop-sync-green.exit.txt` 为 `exitCode=0`。包含上述九项、原四项和 boundary 两项、COMMIT ack lost、cold observation、provider/lease/target，以及无关 progress 正例。
- 本次重新计算 `api-stop-sync-final-source-sha.json` 全部 **16 项**，均与当前文件一致；另读到 `api-stop-sync-source-stable.json` 的 sourceStable=true、checkedFiles=16、changedPaths=[]。主要摘要：
  - task-accepted-stop.ts：`79ba4d74b5f65d550e13e18962f5543c629c30c260e4f648b4cad7d6bc839c91`
  - local-execution.ts：`3be24a67d8fe33570955cf76e1f33ea76643f13c3e73cacb25ca208ac88fa9f3`
  - task-original-commit.ts：`3c1e451672502951a812a8b668342bc19e1248e361593a6ac98ee1d12bd33b75`

## 明确限制

dispatching 成功 COMMIT 仍是 SQL effect 授权线性化点；同步复核可继续否决，但不承诺 SQL、文件系统和远端 CLI 的原子事务，或任意外部进程在最后一次读取后继续篡改都被瞬时检测。设备 callback 后的同步 grant/config/journal 检查及唯一 intent/stop 协议保持原职责。

本报告只认证上述源码及 API delivery 证据。先前 scope 文件 V8 Zone OOM 不会因 delivery 39/39 自动转为 PASS；后续 scope/类型/构建、产品三任务 matching/loss、terminal C 和其他整批门禁由 root 的独立记录收口。本次未重新认证这些结果，也未认证原生 PostgreSQL 并发锁、物理 JJ/OpenShell、真实模型、恢复/carrier、Task 6 或企业上线；profile 继续关闭。

已冻结综合清单到此关闭，无需为本 scoped 结论继续改源码或扩大测试范围。后续若源码摘要变化，应按实际变更另行定位，而非把本 PASS 迁移到未复核版本。
