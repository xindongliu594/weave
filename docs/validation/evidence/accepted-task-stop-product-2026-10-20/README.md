# Accepted-stop 产品工程证据候选

本目录是供 root 审核的有界历史证据，不是最终交付报告。三次隔离产品验收对应 `task-accepted-stop.ts` SHA `cd98427bff283d845b57b6a4d9824b303db39132c446645d07a72db4c9de3f03`。之后独立审查指出 dispatching COMMIT 后所引用 boundary 的变化仍需补入同步授权复核；该修复及最终源码的最小 matching 仍待完成。本目录不得用来认证后来的源码。

| 场景 | 已记录结果 | 进程耗时 | 证据 |
| --- | --- | --- | --- |
| 原容量 RED | A/B 真实验收后，C 第三次真实 prepare 命中未放宽的两槽 `SANDBOX_STORAGE_LIMIT`；两 scope 保留、零 accepted-stop | 测试 27.366s | `baseline-red.txt`、`baseline-summary.json` |
| normal | 开发 A → 独立 QA B → 经理 C 均有 distinct key/attempt/sandbox、真实 prepare/读写/Node 测试/accepted；A/B 各一次 accepted-stop | 70.655s | `historical-cd98427b-normal-*` |
| interleave | B 在 A 验收后推进完整 head；停止 A 仍绑定旧 partial，B 的 QA 文件保留，C 完成实际交付 | 91.024s | `historical-cd98427b-interleave-*` |
| loss | 实际停止后响应丢失，SQL/journal 保持未决；冷设备与冷 API bind 仅 get 原 ID，不重发停止，不派发下一 prepare | 21.500s | `historical-cd98427b-loss-*` |

normal/interleave/loss 各为独立新 PGlite 进程，串行运行；各 1 PASS、0 FAIL、0 SKIP，退出码 0、signal=null、未触发 wrapper timeout。16 份相关生产/测试/运行器文件的起止 SHA 各自一致，三次运行也完全相同；记录在各 `process.json` 和 `historical-cd98427b-source-sha.json` 中。`process-start.json` 保留初始 PID、时间及启动参数。

生产 ProductDshRuntime、Host、Handoff、HTTP poll/start/result、SQL canonical CAS、OpenShellDeviceExecutor、schema-2 journal、maintenance queue、容量门禁和 REMOTE_SCRIPT 均实际运行。文件位于真实临时目录；Node 子进程实际读取文件并执行测试。模型选择、CLI transport、网关/mTLS、UID/cgroup 和所报告远端运行环境是工程 fixture。SQL 只初始化批准 snapshot、设备和原输入，未 seed 成功 scope/merge/accepted/checkpoint。profile 始终关闭；保存模型、付费 usage、reservation 均为零。没有安装、部署或 Git 写入。

三项成功记录不能解释或消除另两项进程异常：`whole-file-185s-process-failure.txt` 保留同文件批量运行在 185.193s 的进程级失败，原 wrapper 未记录具体 worker exit/signal，原因未明；该日志之后的旧三模式回归确实 3 PASS，但不把整次调用记为通过。`stale-normal-no-final-exit.txt` 是上一上下文留下的 109-byte TAP header，无最终 exit metadata，也不记通过。

物理 OpenShell/JJ、原生 PostgreSQL、付费模型、同进程整文件稳定性及最终 C 的跨 run 槽位释放仍是独立边界。本目录没有证明这些门禁已完成。这些边界没有被放宽来换取通过。

`manifest.json` 列出每份文件的大小、SHA、私有原件 SHA 和转换说明。只收录摘要、明确退出记录和有界原始控制台日志；未复制 MB 级 trace、REMOTE_SCRIPT 或工作区文件内容。控制台中的用户工作区绝对路径替换为 `[workspace]`，私有原件保持原样。
