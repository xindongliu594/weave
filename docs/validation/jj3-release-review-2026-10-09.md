# JJ3 发布准备与审阅

日期：2026-10-09。本文记录发布准备；生产启用由主任务执行，并以独立启用回执为准。

## 文件与版本

从 JJ2 `weiwu-jj2-20261009` 创建唯一的新目录 `weiwu-jj3-20261009`。不覆盖原目录，不安装或升级依赖，保留两处原有 `node_modules` 符号链接及其解析目标。

仅叠加 20 个文件：

- API：`apps/api/src/app.ts`、`openrig-bridge.ts`、`openrig-router.ts`。
- 网页：`DepartmentWorkbench.tsx`、`DepartmentWorkbench.css`、`OpenRigWorkbench.tsx`、`openrig-workbench.ts`、`ProjectRequirement.tsx`、`RunCenter.tsx`、`styles.css`、`RunExtras.tsx`、`run-recovery-confirmation.ts`，均位于 `apps/web/src/`。
- 员工运行时：`services/agent-runtime/host.mjs`、`employee-hosts.mjs`、`quality-handoff.test.mjs`。
- 回归：`tests/openrig-bridge.test.ts`、`openrig-router.test.ts`、`openrig-workbench-ui.test.ts`、`run-recovery-confirmation.test.ts`。
- 说明：`docs/openrig-integration.md`。

原 JJ2 清单除三个已部署恢复界面热补丁外全部保留原哈希。这三个文件的基线取自当时实际执行脚本的 payload，核对成功部署回执，并确认与当前冻结源码逐字节相同。第一次预检在发现旧基线差异时停止，未创建新发布目录；原脚本、清单与失败回执保留。

## 已完成的验证

主任务执行 Linux 独立目录 stage v2 后，OpenRig 31 项、部门与恢复 42 项、员工终态交接与返工 32 项，共 **105/105 通过**。类型检查、网页构建、`scripts/local.mjs --check` 均通过。构建入口为 `index-DRaaSSyr.js` / `index-CzCbk_YO.css`。

发布守卫另有 **10/10 本地离线测试通过**，覆盖：相对路径、活跃运行/审批/外部操作/费用预留门禁、历史未知费用保留、主服务最小变更、tar 实际隔离恢复、路径穿越/链接/意外文件/哈希变化拒绝、只读 SQLite 与既有身份、热补丁基线范围、在线只读数据形状扫描。Python AST 与内嵌 SQL 核对程序的 JavaScript 语法检查通过。首次 Windows 沙箱执行受临时目录 ACL 限制；本地离线扩大权限执行通过，未 SSH、操作服务或调用模型。

Linux 构建回执：`.data/research/jj-deployment-2026-10-08/stage-jj3-result-v2-2026-10-09.json`。

## 启用操作边界

激活脚本默认只读。显式 `--activate` 必须同时提供刚审阅的 `--expected-service-sha256`、`--expected-stage-sha256`、`--expected-inputs-sha256`。后者覆盖两个服务的主文件、drop-in 与 OpenRig 既有身份配置；输入变化会拒绝切换。

实际流程：

1. 验证阶段回执、源码、构建产物、依赖链接；查询运行、审批、外部操作与费用预留，禁止活跃或结果未知的外部操作。
2. 核对固定 OpenRig helper 的哈希，复用其只读进程、环境、端口、rig、seat、空会话检查。不重复执行 OpenRig `--apply`。
3. 保存两个服务、drop-in、API 状态与配置哈希；再次核对未出现新工作，然后依次停止为伍、OpenRig。必须取得为伍 clean exit 和对应 OpenRig PID 的 clean drain。
4. 离线归档整个 pilot，逐文件校验，从归档实际恢复到备份内的独立目录；在副本中检查 PGlite 业务数据、费用与全表空闲条件，以及 OpenRig SQLite 完整性和既有身份。再次确认原数据文件字节未变。
5. 主服务只修改 WorkingDirectory 并追加 `WEIWU_OPENRIG_CONFIG=/home/jj/.local/share/weiwu/data/pilot/openrig/bridge-config.json`。先恢复 OpenRig 并核对原身份，再启动为伍；核对业务记录、费用和原凭据不变，OpenRig 配置状态 ready。
6. 失败时保留新目录、备份与证据；能证明无新活跃工作时，仅回退原服务配置并重启。不会用备份覆盖原数据库；不能证明回退安全时记录阻塞并保留现场。

既有 OpenRig 身份：`01M4FVAV12PXXFXH4Q9XJY00K2` / `host-91ecbc4f`。本流程不写队列、不调用模型、不创建员工会话、不提高预算。

## 冻结脚本

脚本目录：`.data/research/jj-deployment-2026-10-08/`。

| 文件 | SHA-256 |
| --- | --- |
| `stage-jj3-release-v2-2026-10-09.py` | `d58a2a8e04b6ad888860db76e4500b946fc3599e273148cd4dd5887e250f7183` |
| `stage-jj3-source-manifest-v2-2026-10-09.json` | `259443c768559d3b3027d6e896fbe2033320b63a4742f78ed90537af365d121a` |
| `activate-jj3-2026-10-09.py` | `cdadc92ba613b1ee654c035d17331bbc53860b4b46d3bf7ce09acfc7cf0ff672` |
| `test-jj3-release-guards-2026-10-09.py` | `bc7de9eb5eac447286a76d29a9a77c63dd3a4f09f2d81a0e1f93c8bc4a162ac5` |

远端成功 stage metadata：`/home/jj/.local/share/weiwu/metadata/jj3-stage-20261009.json`，SHA-256 `f6c979bf04ad300d5145a9b79e6bfdf64ac4741d24099f208bbe158d5d085238`。

生产启用、网页待办同步、真实后续运行的结果应另附实际回执；本文件不将准备完成当成实际验收。
