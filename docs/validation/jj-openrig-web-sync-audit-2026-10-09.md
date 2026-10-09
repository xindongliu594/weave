# JJ 网页同步 OpenRig 与隔离恢复实际验收

主任务从网页保存一个未执行的待办，并显式点击同步。随后独立只读核对官方队列、为伍 API、本地映射和费用，再使用 SQLite 备份接口完成私有隔离恢复。两项均通过；不表示该待办已开发或已通过经理验收。

## 真实业务与队列身份

- 部门：`3c0cb5ee-0b24-4ef5-9957-8a048c7dae0a`。
- 待办项目：`c547e45b-393a-4848-b707-defa6005a26f`，版本 1。
- 官方工作项：`qitem-weiwu-5d3269976fa8bc4ff40334eb07c6f6e72c49896b2298545f315dae6cf3f882ac`。
- OpenRig PID `3186171`；固定实例身份 `host-91ecbc4f`、rig `01M4FVAV12PXXFXH4Q9XJY00K2`、原 node ID 均保留。

| 核对项 | 实际结果 |
| --- | --- |
| 唯一工作项 | SQLite 真实 `queue_items` 总数 1；该 ID 恰好 1 行；官方状态 `pending` |
| 唯一项目映射 | mapping 只有该项目的一份项目回执，没有自动同步其他历史项目 |
| 回执一致 | 本地 outcome 为 `confirmed`；qitem、部门、项目、来源和目标身份一致 |
| 来源与目标 | 为伍 mgr-1 → dev-1；官方 session 为 `dev-manager@weiwu-pilot-3c0cb5ee` → `dev-dev@weiwu-pilot-3c0cb5ee` |
| 内容核对 | 只含版本、项目/部门身份、需求摘要和员工归属等元数据；正文和来源/目标的 payload SHA256 与持久回执完全一致 |
| 为伍 API | 可选集成 ready，项目映射 synced；批量接口 `queueState:null` 表示列表未远端核对，官方直接查询为 pending |
| 项目未被执行 | 待办仍为 `DRAFT`、版本 1、currentRun/completedRun 均 null；该项目 usage 为 0，记录费用为 0 |
| 无第二套执行 | OpenRig `NO_KERNEL=1`，无 kernel agents、无员工会话、无模型凭据；验收权仍为 weiwu |

payload SHA256：`95baed7576452afc4908f0fab0f345a282decea49353a60556439d0f9ad0b5c8`。

本审计只执行 GET、SQLite `mode=ro` 和文件读取，没有创建 qitem、修改其他项目或启动运行。对“其他项目未同步”的证明是项目映射只有 1 份和官方队列只有 1 行；不会把并行的旧项目正常执行误报为全局数据没有变化。

全局账单首轮为 202 行、约 $1.034637，备份后为 204 行、约 $1.043793。随后核对新增的 3 笔调用均属于旧项目 `4ae5cce4-73c1-420a-987f-83db54d196f2` 的运行 `19acad23-c885-40cc-9fa7-df7d7ec127bf`，用途为“项目执行”；新待办始终 0 笔。机器报告保留 API 浮点金额的原始求和结果，不声称全局费用未变化。

[独立审计机器报告](jj-openrig-web-sync-audit-2026-10-09.json) 保存备份前后核对及并行费用归属。网页点击及截图由主任务的浏览器验收记录提供。

## SQLite 备份与隔离恢复

生产 SQLite 连接使用 `mode=ro`；通过 SQLite `Connection.backup` 写入新建私有备份，再从该备份用同一接口恢复到另一个新目录。生产库及生产配置没有被覆盖；没有停止生产服务或启动恢复副本。

隔离目录：

`/home/jj/.local/share/weiwu/backups/openrig-isolated-20261009T082638Z-462a4b78-10df-48f4-87f3-88a039e5df80`

| 核对项 | 实际结果 |
| --- | --- |
| 备份库 | `backup/state/openrig.sqlite`，`PRAGMA integrity_check=ok` |
| 恢复库 | `restore/state/openrig.sqlite`，`PRAGMA integrity_check=ok` |
| 全库数据 | 备份与恢复的逻辑 dump SHA256 完全相同 |
| 工作项 | 相同 qitem、source/destination、pending 状态及完整记录；恢复后队列数 1 |
| 元数据 | 112 个文件、879150 字节精确复制，包括 mapping、私有 config/token、实例状态、岗位说明及 runner/unit 副本 |
| 私有凭据 | token 逐字节核对一致，文件权限只允许当前用户；未导出 token 值或 token 哈希 |
| 生产稳定性 | 备份期间源 qitem 与所复制的元数据未变；完成后再次核对生产项目和映射仍一致 |
| 恢复隔离 | 恢复 config 设为 disabled，token/mapping 路径改为恢复目录；精确原配置另存私有副本，未启动 daemon |

逻辑数据库 dump SHA256：`f625fff0e1f73a0d638eaf6b233e91c530ca4a65fe9e9cffbf65d8bac3fa36ae`。

[恢复机器报告](jj-openrig-isolated-backup-restore-2026-10-09.json) 记录具体路径和逐项结果；原始私有报告位于隔离目录的 `result.json`。备份和恢复数据全部保留。

## 验证边界

本轮覆盖真实网页待办 → 官方 OpenRig 队列 → 持久映射核对，以及真实队列数据的隔离备份恢复。未对该待办批准规划、启动开发或产生经理验收结果；未启动隔离恢复服务。现有网页备份导出仍不包括可选 OpenRig 数据，不能把本次专项恢复等同于网页备份功能已扩展。

正式常驻实例在该 qitem 创建后的重启接续，仍需单独记录；此前的独立实例受控中断/重启证据保留在 [模块真实验收](openrig-bridge-actual-2026-10-09.md)。业务的独立 QA、经理验收和 OpenShell 员工执行证据由对应主任务报告负责。
