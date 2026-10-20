# 79ba4d74 产品 matching 证据候选

本批在 API 综合同步授权修复后的冻结源码上，依次启动三个独立新 PGlite 进程；没有修改生产或测试源。`task-accepted-stop.ts` SHA 为 `79ba4d74b5f65d550e13e18962f5543c629c30c260e4f648b4cad7d6bc839c91`，`local-execution.ts` SHA 为 `3be24a67d8fe33570955cf76e1f33ea76643f13c3e73cacb25ca208ac88fa9f3`。16 份相关文件的每次起止 SHA 均一致，三个场景也完全相同。

| 场景 | 结果 | 进程耗时 | 已核对的产品行为 |
| --- | --- | --- | --- |
| normal | 1 PASS / 0 FAIL / 0 SKIP，exit 0 | 70.036s | A 开发、B 独立 QA、C 经理三个 distinct key/attempt/sandbox，均实际 prepare、读写、Node 测试并验收；A/B 各一次 accepted-stop |
| interleave | 1 PASS / 0 FAIL / 0 SKIP，exit 0 | 93.121s | A 验收后 B 推进完整 canonical；停止 A 使用原 partial identity，保留 B 文件，经理 C 完成真实交付 |
| loss | 1 PASS / 0 FAIL / 0 SKIP，exit 0 | 27.254s | 真实 stop 后响应丢失，冷设备及冷 API bind 只 get 原 sandbox ID；不重发 stop，不派发下一 prepare，保留原任务授权拒绝 |

三个进程的 signal 均为 null，均未触发 wrapper timeout。各 `*-process-start.json` 记录 PID、启动时间与 start SHA；各 `*-process.json` 记录明确 exit/signal/elapsed、start/end SHA 和 sourceStable。`source-sha.json` 与 `results.json` 提供跨场景汇总。各 `*-summary.json` 保留真实 run/key/operation IDs、accepted/CP/SQL prepared/dispatch/设备 intent/原 ID get/下一 prepare 的顺序与文件、scope、原 SQL claim-result-merge 的摘要核对。

本批实际运行生产 ProductDshRuntime、Host、Handoff、HTTP poll/start/result、SQL canonical CAS、OpenShellDeviceExecutor、schema-2 journal、maintenance queue、容量门禁及 REMOTE_SCRIPT；实际临时文件和 Node 子进程参与读写及测试。CLI transport、网关/mTLS、UID/cgroup、所报告的远端运行环境及模型响应仍为工程 fixture。SQL 未 seed 成功 scope、merge、accepted 或 checkpoint。两 running 槽、128 scope 和磁盘限制均未放宽；停止保留 scope、磁盘和原文件 SHA。

profile 保持关闭，没有保存模型、付费 usage 或 reservation，也没有部署、安装或 Git 写入。物理 OpenShell/JJ、原生 PostgreSQL、付费模型、最终 C 的跨 run 槽位释放及整个 Task 5/6 完成仍是独立门禁；最终交付结论由 root 拥有。本批 matching PASS 不能替代最终 API 独立审查或 build。

父目录的 baseline 容量 RED、`cd98427b` 三场景以及 185s whole-file 进程失败和 109-byte stale 无退出日志均保留为历史。本批隔离 PASS 没有解释或解决同进程整文件异常；历史失败没有升级为通过。

`manifest.json` 列出有界文件的大小、SHA、私有原件 SHA 和转换。没有复制 MB 级 trace、REMOTE_SCRIPT、工作区内容、凭据或私人配置；仅将控制台中的用户工作区绝对路径替换为 `[workspace]`。
