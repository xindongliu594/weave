# accepted-stop 设备子批次独立审查

结论：**PASS**。本子批次没有发现需要修复的 P0/P1/P2 问题。

审查基线为 `e3374fddeb09c14acaaca65b3b5242f498de45b8`，范围仅为 `apps/desktop/openshell-executor.cjs`、`apps/desktop/openshell-executor.test.cjs` 当前差异。合同为公开 Task5 计划的“accepted-stop 设备子批次冻结裁定”；没有把未接通的 API 历史 verifier/provider、产品三任务容量验收算作此子批次遗漏，也没有据此开放 profile。

## 已核对的关键边界

- 41–61、441–446：expected 的 exact keys、完整 task key、UUID/SHA、三项 true 证明及可信回调均必需；停止身份在入队前复制，随后匹配原 sandboxId 和部分工作版本。排队/回调修改调用方对象不能改变目标。
- 448–457：先原 admit，再可信回调；回调后同步复查 grant、固定 config 指纹与整个持久 journal。没有 await 插入最后检查、原子 fsync intent 和唯一 stop 派发之间。`atomicJson` 先 fsync 临时文件再 rename，非 Windows 同步目录；写入失败不会自动补发 stop。
- 416–435：确认与 reconcile 只调用 mTLS status 和原 sandboxId 的 get；核对 id/name、Stopped、configuration_admission 和固定有效策略，不调用要求 Ready 的 admit，不尝试未经确认的 policy-by-ID 语法。CLI stop 成功但当时仅为 Stopping 也会保守保留 unknown，可由后续只读 reconcile 确认。
- 423–464：同 stopId/同完整身份才可重查；外部应答丢失后 intent 留存，重复 stopAcceptedTask 走原 ID 只读观察，绝不重发 stop。缺少/损坏 journal、Ready、absent、错 ID/name、mTLS 或策略失败均不算停止成功。
- 216–240、268–287：冷实例重新严格读取 acceptedStop。未知/坏记录保留运行容量；只有持久确认 stopped 才释放 running 槽，原 scope 数与磁盘预留继续计数。
- 290–310：所有普通 prepare/filesystem/write/terminal/test/native_plugin 路径在 acceptedStop 下拒绝。native_plugin 在加载 bundle 前拒绝，并在 loader await 之后重新读取 journal 拒绝新出现的 stop intent。
- 390–410、467–505：导出和会启动沙箱的 storage inspect 均拒绝 acceptedStop。retireStorage 必经 inspectStorageNow，因此不能绕过拒绝进入 delete；acceptedStop 与 retirement 也不能同时通过严格读取。reconcileStorage 没有原 retirement 即拒绝，不提供另一个停/删路径。
- 507–514：close 原有 schema-1 行为保持；新增停止记录只用于 schema-2 task。提取 assertGatewayIdentity 保持原 admit 的同一组检查，没有放宽旧执行或复用流程。

## 验证证据与限制

已审阅 `device-stop-final-escalated-green.txt`：相关真实 executor/journal + 有界 transport fixture **55/55，0 skipped**，包括 11 个新增 accepted-stop 用例，以及原有生命周期、身份、容量、文件/CAS 和存储回归。未因已知 managed hardlink EPERM 重跑全套，原失败日志保留；本审查未改生产源码、未付费、未访问 JJ、未安装依赖。

这是设备私有协议与 fixture 证据。API 的真实已验收证明、SQL CAS/fence、provider 接线，物理 OpenShell 停止、原生 PostgreSQL 和真实员工三任务链仍需各自后续实现及验收；当前关闭的 `task-attempt-openshell-v1` launch/recovery 门禁应继续保持关闭。对异步 Stopping 不做成功假设不是本子批次缺陷。

审查时源文件 SHA256：

- executor：`bb51d3c0e03c38b5133eaf9525486e83602962466a6829795d784d0a4f5b643d`
- tests：`7cc165aef4a86a7b51d1db986312c79d613bb335606ba02837fa6f5f907fae35`
