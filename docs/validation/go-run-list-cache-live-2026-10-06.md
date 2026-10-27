# 运行列表性能修复：本机实测

本次只核对运行列表与无在途业务时的服务重启，不替代员工验收或受控中断恢复。

- 工程来源：[列表缓存回归](trace-list-cache-2026-10-06.md)，10 项通过、类型检查通过。仅列表摘要使用有界缓存；完整读取、追加、导出和恢复仍严格解析。源 `trace-store.mjs` SHA256：`0cf0d4c7a84e689d7d4bd181e6642d99a6611e4ba1a09def7de4cd016d2196ba`。
- 原服务准确关闭并由正式 launcher 重启，原始数据目录保持。证明：[所属服务重启](../test-evidence/go-owned-service-20261006-174247-fedff04e.json)、[重启后核对](../test-evidence/go-idle-reload-verified-2026-10-06T09-44-22-940Z-e68bb34c/sources.json)。重启前后 461 条用量、所有项目及运行 metadata 相同，仅 PowerShell 的等价 ISO 时间精度作规范化比较；无自动模型调用、费用清零或员工文件修改。
- 三次顺序 GET `/runs`：修复前 4510 / 4508 / 4476 ms；加载后 71 / 23 / 30 ms。全部包含同 26 条运行记录，原始响应字节 SHA256 均为 `8b7dfe99770d629e4ff6a601f70af377df6c5094a91564601810a8aa37c4a157`，未删历史或缩减字段。
- 原始计时：[修复前](../test-evidence/go-run-list-performance-before-2026-10-06T09-40-21-702Z-af221ecb.json)、[修复后](../test-evidence/go-run-list-performance-after-2026-10-06T09-45-02-925Z-bd036efb.json)。这些数字是本机当时的列表读取；完整档案、首轮缓存建立及运行中的日志仍有独立成本。

正常 v11 之后由网页唯一批准成功，Run `9878e368-9ebe-443d-8c2f-59ba3e5b4274`：[202 / 1 POST](../test-evidence/funded-run-web-normal-approve-2026-10-06T09-48-13-527Z-70028ee4.json)。这证明新操作路径已实际发出并创建运行，尚不证明最终交付完成。旧 0 POST 审批证据及永久意图保持。
