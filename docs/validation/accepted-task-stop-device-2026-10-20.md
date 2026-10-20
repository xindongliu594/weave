# 已验收任务沙箱停止：设备基础验证

基线 e3374fd。本批补齐现有 OpenShell 停止原语，沿用 maintenance 串行队列、schema-2 journal、固定 CLI 与 mTLS 检查。**尚未接通产品的历史验收证明/provider 调用链，task profile 仍关闭；不代表三员工容量或完整恢复已通过。**

修复内容：严格绑定原 task/attempt/generation、sandboxId 和部分工作版本；必需可信授权回调，回调后同步重新核对完整 journal/本地授权；先持久化 stop_intent，再停止一次。丢应答或重启后只查原 sandboxId，明确 Stopped 才释放运行名额；文件、scope 和磁盘占用保留。已验收对象不能通过普通执行、插件加载、导出、容量检查或回收入口重新启动。旧 schema-1 行为保留。

| 实际验证 | 结果与边界 |
| --- | --- |
| 原错误 sandboxId | RED：旧实现没有拒绝并执行了停止；修复后拒绝且零停止 |
| 原插件入口 | RED：原先在已验收检查前加载 bundle；修复后零加载，并保留 await 后复核 |
| 严格类型 | RED：boxed String 摘要曾被正则隐式转换；修复后拒绝 |
| 新合同用例 | 11/11；真实 executor/journal，CLI、UID/cgroup/远端环境为 fixture |
| 相关串行回归 | 55/55，无跳过；覆盖冷实例、应答丢失、journal 失败、错身份、callback 变更、未知容量和旧行为 |
| Windows 权限事件 | 首轮 54/55，既有符号链接用例 EPERM；相同命令仅提高本机测试权限后 55/55，原失败日志保留 |
| 类型/构建 | root `npm run build` exit 0，Vite 9.63s；原有大 chunk 提示保留 |
| 独立代码审查 | PASS，未发现 P0/P1/P2；未将设备夹具当作物理验收 |
| JJ 只读健康检查 | 原生产服务 active/running、NRestarts=0，数据库 connected/runtime ready；未更新服务 |

源码 SHA、RED/GREEN 与审查保存在 [evidence](evidence/accepted-task-stop-device-2026-10-20/)。工程测试不调用保存的模型，无新增付费请求、预算调整、JJ 写入或依赖安装；七笔旧未知预留保留。

复现命令：`node --test --test-concurrency=1 apps/desktop/openshell-executor.test.cjs apps/desktop/task-execution.test.cjs apps/desktop/sandbox-storage.test.cjs`。Windows 需允许本机测试创建符号链接。

仍待验证/实现：SQL 停止记录与普通 admission fence 的独立收口、真实历史 accepted/v2 checkpoint/原操作验真、provider 接线及三任务产品链；原生 PostgreSQL 并发、真实 OpenShell/JJ 故障恢复；Task5 的检查点恢复、精确维护和只读 task 备份。全十项企业基础目标继续进行。
