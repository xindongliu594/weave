# 运行档案写入性能与完整性验证

2026-10-06。生产源码尚待本阶段受控重载；此报告不代表真实正常运行或受控重启恢复验收通过。

旧 `openRunArchive.append` 每条事件完整读取、解析此前 journal，再追加并 fsync。档案随运行增大时出现重复工作，可能阻塞同线程心跳。使用已封存 v12 完整导出在隔离目录重建相同 31,503,327 字节、2867 事件的 journal，精确旧源码 SHA `0cf0d4c7a84e689d7d4bd181e6642d99a6611e4ba1a09def7de4cd016d2196ba` 与新源码做相同 Node 24.19、40 条轻事件、相同 sourceKey 和 fsync 比较：旧总耗时 15,526 ms、100 ms timer 首次迟到 15,427 ms；新总耗时 76.6 ms、timer 首次迟到 11.6 ms。完整内容和最终严格读取均一致。此批次支持同步累积阻塞机制，但不能单独证明真实 30 秒租约失效的唯一原因。

新实现保留每条同步追加与 fsync。进程内只缓存已验证的事件序号、sourceKey 集合及两文件的原生 BigInt metadata；各 handle 共享绝对档案路径的游标。首次读取或文件身份、大小、纳秒修改/更改时间等发生变化时，先完整严格验证再写。访问时间变化不表示内容变更。缓存最多 256 项、单项 512 KiB、总计 8 MiB，sourceKey 超界退回严格读取。完整 `readRun`、导出、恢复仍重新解析全档案，不使用追加游标代替证据。无 journal 删除、事件裁剪、预算或调用减少。

**最终 45/45 相关工程回归通过，0 fail/skip**，包括新 10 项大 journal/跨 handle/外部追加/同尺寸损坏与还原 mtime/替换/快照 SHA/部分写失败/fsync 失败/去重与界限，以及原生 DSH 团队、真实本地命令回执、checkpoint 恢复、独立员工 Host、冷恢复、取消、期限及模型结算。独立审查发现 nonfinite sourceKey 的 JSON 序列化语义差异后已修复：本模块写入 Infinity 变 null，热/冷追加均保持原行为；外部合法 `1e400` 历史解析为 Infinity 时回退全读、保留原去重判断。协议回复为隔离本地工程 fixture，不能替代真实员工/model 验收。最终日志 [trace-append-cursor-2026-10-06-final-v2.txt](trace-append-cursor-2026-10-06-final-v2.txt)，最初 44 项日志继续保留。

冻结 SHA：

- `services/agent-runtime/trace-store.mjs`: `201cbbeb241e586f1bd144ade3c663235b2f5929eba8c4f1db0c9beac40bbc01`
- `services/agent-runtime/trace-append-cursor.test.mjs`: `d5dfea0afbcf3ef3c5697cfa6ddc7c81158719da777a9f41d72958a2d3240b74`
- 最终 45 项输出日志：`41f35dc50f0bdb7500e80b2cda64221b1feafb28ae0d360f29a75de6963ddea4`

原字节来源、每条耗时、完整读取和 timer 结果见 [隔离比较报告](go-normal-v12-trace-append-comparison-2026-10-06.json)。其 first-after 使用修复 corner 前 `7a1773…` 源码，严格按实际来源保留；本次 corner 改动不影响其中的字符串 sourceKey 场景。旧源码冻结副本仅用于隔离基线；原 live 档案和员工交付物没有被用于写入实验。
