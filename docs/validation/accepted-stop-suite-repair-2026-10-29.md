# 已验收任务停止：完整回归收尾

基线：`417b46e` 已推送 GitHub `codex/weiwu-mvp-validation`。用户随后授权继续本机开发，优先复用。此批仅修复工程验证方式，不开放企业 task profile、不调用模型、不部署 JJ。

## 实际根因与选择

原 `task-accepted-stop-delivery.test.ts` 包含 79 个展开用例，多数真实经过 HTTP、SQL、文件 CAS 和交接凭据，物理设备效果为夹具。完整命令在 180 秒文件上限退出 124；退出前仍有案例持续通过。首个 API 正向案例单独运行通过，9.659 秒。因此不能把整份超时直接判断为该案例死锁，也不能把已筛选的部分结果当作完整通过。

先检查现有实现：保留 Node 内置 `node:test`、`scripts/test-integration.mjs` 的逐文件隔离 PGlite，以及既有 `acceptedStopApiFixture`。这已能提供测试隔离，无需安装新的测试框架或队列插件。

按职责拆为六个文件，共用原有夹具初始化与清理。拆分时原来 35 个测试注册块逐字比对不变，循环展开仍为 79 项；随后针对完整运行暴露的四处旧测试问题作下述修正。最终 31 个注册块逐字不变，4 个修正，无遗漏或新增注册块。没有调高 180 秒上限、跳过断言、修改产品代码或用固定响应冒充模型验收。

| 文件后缀（`tests/task-accepted-stop-…test.ts`） | 项数 | 负责内容 |
| --- | ---: | --- |
| delivery | 21 | 原提交证明、正常停止、授权变化、提交响应丢失 |
| provenance | 18 | 历史来源、文件/边界/交接内容损坏与当前任务绑定 |
| terminal | 9 | 最后任务停止、完整验收证明与每次停止数量上限 |
| authority | 11 | 等待后权限重验、取消和租约变化、原编号核对 |
| lifecycle | 10 | 迟到连接归还、截止时间排空、能力声明检查 |
| sql-deadline | 10 | SQL 各阶段响应延迟、取消及连接丢弃 |

运行入口仍为原脚本，依次传入这六个文件；每个文件独立数据库和 Node 进程。正常 `npm test` 的文件通配也包含新增文件，但 SQL 用例仍需通过隔离集成入口执行，不能用普通命令的跳过项宣称通过。公共夹具中的清理和零模型/零用量断言保留。

## 完整运行暴露的旧测试问题

1. COMMIT 响应丢失后，可信原编号观察入口保留执行器的 `LOCAL_OUTCOME_UNKNOWN`；只有外层完成入口转换为 `pending.reasonCode`。旧测试错误期待通用错误码。改为核对原错误，同时新增同一实例重复调用返回同一错误、仅观察一次、设备效果不增加和 SQL marker 完整不变的断言。
2. 授权根目录被替换时，原观察入口抛出 `LOCAL_BINDING_CHANGED`。保留拒绝和目录绑定要求，新增失败锁存断言；SQL 的 stopped 状态不能免除当前绑定核对。
3. 连接获取期间取消用例先等待任务结束，再交付被它挂起的连接，形成测试自身的循环等待。产品要求排空原连接生产者；新版先断言取消后尚未结束且没有 SQL，再交付连接，核对释放一次、零 SQL。相邻截止时间用例继续证明排空之前写入屏障仍被持有。
4. `prepare` / `prepareTask` 的能力预检会同步抛错；旧循环中的 `assert.rejects` 普通回调无法捕获，导致八项正确的拒绝被报为测试失败。回调改为 `async`，仍严格校验 `TASK_STOP_UNAVAILABLE`，并新增连接获取次数为零的断言。

独立只读复核确认四处均为旧测试修正，没有弱化产品安全机制。中间运行的两项错误码失败、180 秒超时及后续八项同步异常失败均保留，不能改写为通过。

## 当前验证状态

按文件取最后一次有效结果：**79 项通过、0 未解决失败、0 跳过**。六文件耗时分别为 61.9、92.4、97.3、153.1、15.2、116.1 秒，均在原 180 秒上限内。类型检查和构建退出 0；原 >500 kB 前端包提示仍保留。独立只读审查及增量复核均未发现待处理问题。

首次六文件组合命令退出 124；修正后三个有问题的注册块时，两文件重跑退出 1（authority 全通过，lifecycle 尚有八项同步异常断言失败）；最后只重跑受影响的 lifecycle 文件，10 项通过、退出 0。因此最终统计是各文件的最新结果，不能称首次组合命令成功或全仓库测试通过，也不与前批重叠用例累加。

证据：`docs/validation/evidence/accepted-stop-suite-2026-10-29/manifest.json`。保留完整失败/通过日志、拆分前后注册块哈希、最终源码哈希及命令。复跑命令：

```powershell
node scripts/test-integration.mjs tests/task-accepted-stop-delivery.test.ts tests/task-accepted-stop-provenance.test.ts tests/task-accepted-stop-terminal.test.ts tests/task-accepted-stop-authority.test.ts tests/task-accepted-stop-lifecycle.test.ts tests/task-accepted-stop-sql-deadline.test.ts
npm run build
```

范围是 Windows 本机真实 HTTP/SQL/CAS/交接链路的功能测试，设备效果来自夹具，模型调用为零；不是 OpenShell 物理沙箱、真实模型或原生 PostgreSQL 多后端锁验收。本批测试修复保留在本地，首次要求的备份功能快照已通过 `417b46e` 推送当前分支；未合并 main 或部署 JJ。

另做了只读复用核对：旧 PostgreSQL 17.10 测试二进制仍在私有缓存，但没有 `vector.control` 或 `vector.dll`，也未配置 `BACKUP_RESTORE_POSTGRES_URL`。不把可执行文件存在当成完整企业迁移可用；未安装服务、未修改 vector 类型或生产数据库。
