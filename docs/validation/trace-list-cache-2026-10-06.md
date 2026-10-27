# 运行列表摘要缓存（2026-10-06）

仅修改 `services/agent-runtime/trace-store.mjs` 的列表摘要路径，首次及文件身份变化仍严格readRun。完整readRun、append/create/export/恢复校验、列表返回字段和createdAt降序排序保持。未读取原运行文件/数据库，未调用live API/provider、操作服务或修改员工文件；原app.ts未改。

进程内LRU最多256条，单条摘要最多64KiB；超大摘要照常完整返回但不缓存。key为绝对root+Run ID。snapshot.json/events.jsonl的全部BigInt stat own字段构成身份，包括size、mtimeNs、ctimeNs、ino/dev、birthtime、mode等，任何变化失效。读前后除read自身可能更新的atime外，其余身份必须相等才缓存post-read完整身份；复用时atime也参加比较。异常读取不缓存，短暂文件锁解除可重试。列表返回副本，调用者修改不会污染缓存。

最终10/10 PASS（新缓存7+原trace3），tsc exit0。真实10MiB临时journal：首次列表snapshot/journal各读取一次，连续额外5次list仍只有一次journal读取；直接readRun立即再读/严格解析一次。断言基于隔离进程builtin fs读次数，不以耗时猜复用。

其余覆盖：跨handle追加、terminal状态/排序、journal截断、同size且mtimeNs恢复但ctimeNs改变的损坏/修复、snapshot替换/破坏/修复、两root同ID、条目删除、返回值污染保护、256容量驱逐、64KiB超大摘要不截断、临时EACCES恢复。损坏仍incomplete；原trace用例继续验证独立进程完整档案恢复、sourceKey去重与严格partial journal拒绝。全部是临时目录和确定性DSH离线adapter，无真实模型或员工业务执行。

日志：[首次9/9](trace-list-cache-2026-10-06-first.txt)、[最终10/10](trace-list-cache-2026-10-06-final.txt)、[tsc](trace-list-cache-2026-10-06-tsc-final.txt)。冻结SHA：[manifest](trace-list-cache-2026-10-06-sourceSHA.json)。本轮未测真实 `/runs` 新延迟；冷缓存或持续变化中的journal仍完整解析。由root在idle统一加载后验证真实列表响应。
