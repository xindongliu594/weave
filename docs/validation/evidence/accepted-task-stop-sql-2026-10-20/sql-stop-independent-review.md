# SQL accepted-stop foundation 独立代码审查

结论：**PASS**。当前子批次未发现需要修改的正确性或兼容性问题；无需最小修正。

审查基准是 `docs/superpowers/plans/2026-10-20-task-checkpoint-v2-integration.md` 的 SQL 合同及末尾澄清，范围仅为 codec、nullable migration、普通 admission fence 和相应测试。已独立读取生产 diff、相关真实调用方与 HTTP/merge 接缝，并核对当前 7 个源文件 SHA256 与 `sql-stop-sources.txt` 一致。

重点负面与兼容边界：

- `apps/api/src/task-accepted-stop-state.ts:8–46`：嵌套 exact schema、正安全整数、UUID/SHA/有界文本、32 KiB 上限、两个 domain-separated 递归排序摘要、状态专属字段及 result 完整身份一致性均符合合同。日期先要求 canonical ISO，再按时间值比较；跨 expanded-year 边界不依赖字符串排序。该 codec 没有冒充 acceptance/device 真实性验证。
- `apps/api/src/task-accepted-stop-state.ts:50–58`：校验 run 内全部非 NULL marker 及其所属行的完整 key；损坏/错行 fail closed，非 stopped 挡整个 run，stopped 仅封存自身完整 key，无普通 except 参数。`task-execution.ts:63` 位于同绑定提前返回及首代插入前；`:96` 和 `task-operation-admission.ts:32` 覆盖 scope 与 enqueue/poll/start/result，获准的新 attempt 仍走原校验。
- `apps/api/src/local-execution.ts:85–89,372–378`：新 409 沿既有 executable 4xx→false 路径，使原 claim 的认证回执仍进入 late_result，并保持去重；没有把 stop 状态当作 SQL operation unknown 已决证明。`task-canonical.ts:146,163,188–189` 保留 committed 只读回执重取，pending 在两阶段 admission 中受 guard 阻断；新 stop 错误不会触发 deterministic rejection 清掉原 pending/unknown。
- `apps/api/src/product-schema.ts:92`：以 `ADD COLUMN IF NOT EXISTS accepted_stop jsonb` 升级既有表，旧行保持 NULL，既有 task 历史不改写。

证据：已读取最终 `sql-stop-final-integration-green.txt`，state 10（含 expanded-year）、HTTP 3、bridge 11、canonical 17，共 41/41；`sql-stop-scope-regressions-green.txt` 另 25/25。协调方确认 `tsc --noEmit` exit 0，对应 `sql-stop-typecheck.txt` 无诊断。按委托未重复运行这些套件，也未改应用源码、Git、依赖或 JJ 服务。

验收限制：这些是隔离 PGlite/HTTP 与合成 stop marker 的普通 guard 证据；marker 不证明真实 accepted 资格。历史 producer/verifier/provider、三 distinct task 产品容量链、恢复/backup carrier 及物理 OpenShell/原生 PG/真实付费模型均不属于本子批次的已验证成果，profile 继续封闭。
