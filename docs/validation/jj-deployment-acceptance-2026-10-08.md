# 为伍部署到 JJ：阶段一验收与后续边界

日期：2026-10-08（北京时间）。用户授权开始部署，并在 JJ 本机执行 Docker 准备脚本后回复安装成功。阶段一已有实际运行证据；沙箱接入、长期部门与真实模型迁移分别记录，未把安装和固定模型检查写成完整业务验收。

## 结果

| 检查 | 状态 | 证据 |
| --- | --- | --- |
| 固定源码与独立运行环境 | 通过 | 465 个基线文件 SHA256；私有 Node 24.19.0/npm 11.17.0；原 JJ Node 24.15.0 保留 |
| Linux 类型检查、生产构建 | 通过 | 首次及最终 `tsc --noEmit && vite build` 退出 0 |
| 相关 Linux 回归 | 通过 | 本机执行器 7、关闭/启动器/静态网页 21、portable runtime 246，共 274 项，无跳过 |
| 完整本机启动检查 | 最初失败，修复后通过 | 首次 PGlite 清理竞态日志保留；最终检查退出 0 |
| 生产用户服务 | 通过 | `weiwu-jj.service` active/running、enabled、NRestarts=0；只监听 `127.0.0.1:4310` |
| Windows 浏览器访问 | 通过 | SSH 回环隧道 `127.0.0.1:4312`；内置浏览器实际操作及截图；最终网页无捕获的 error/warn |
| 网页保存知识与完整重启 | 通过 | 网页创建空间、保存 v1/v2；完整服务停止重开后，两版正文、SHA、Markdown、设置、费用和设备授权均一致 |
| 已完成节点不重放 | 通过，零模型费用检查范围 | 独立固定协议检查项目完整重开两次；4 条本机操作、9 条测试调用、182 条运行事件和 13 个文件不变 |
| 新环境备份隔离恢复 | 通过，pilot 范围 | 1,132 个文件字节一致；恢复数据库实际读取文档 v2/v1 和每日预算 $20；原数据未覆盖 |
| Docker/Compose/tmux | 软件和服务已核对 | Docker 29.8.2、Buildx 0.37.1、Compose 5.6.0、tmux 3.6；Docker active；Server API/hello-world digest 未独立核验 |
| OpenShell CLI/管理网关 | 安装与 mTLS 认证通过 | 官方 v0.1.2 SHA256 一致；端口修复后 connected/authenticated，健康检查通过；员工沙箱未启动成功 |
| JJ 真实模型主流程 | 开发、QA已通过，经理未正式完成 | 用户批准Go Key迁移；v5真实测试8/8通过并接收，经理2048输出截断；已修复诊断与交接提示，正在8K新方案验收 |
| 跨机器旧数据迁移 | 仅授权 Go 配置通过 | 原 Windows 数据、历史费用、未知预留和设备授权保留；唯一 Go Key 经 SSH 传输后加密保存 |
| 7×24、无人登录开机、休眠恢复 | 保活已配置，稳定性未验证 | 用户登录自启与 Linger=yes 已核对；开机实测、休眠/合盖策略和连续运行未验 |
| OpenRig 长期部门试点 | 基础安装通过，部门未激活 | 固定 CLI 0.6.6、SQLite 13.0.3、官方 ABI 与实际内存读写通过；setup/up/daemon/provider 均未执行 |

使用说明：[Windows 访问 JJ](../deployment-jj-quickstart-2026-10-08.md)。

## 发布与权限

- 部署 ID：`8dd9fa7e-d584-4915-8d51-57bdff4e83dc`。
- 基线提交：`4f19ab005f80eb07fd3623e7f2e8792ed5ba71ac`，归档 SHA256 `1a3c83700d6b52facfe27d36960bd06383aba63bb4631dbec1a1112f5f7acb82`。
- 原基线发布保留在 `/home/jj/.local/share/weiwu/releases/4f19ab005f80eb07fd3623e7f2e8792ed5ba71ac`。
- 当前派生发布：同目录名加 `-jj1`，包含本轮经过验证的部署与主流程修复，未把原基线覆盖。逐文件SHA在`metadata/derived-release-patch.json`，历史源码均有私有备份。
- 最新生产bundle：`index-dgXdn7Qi.js`，包含页面内恢复确认与新建128KB默认；历次构建和原bundle证据保留。
- 数据与私有 HOME 分别在 `/home/jj/.local/share/weiwu/data/pilot` 和 `/home/jj/.local/share/weiwu/home`；服务显式设置 Node/PATH，员工 `/bin/sh -lc` 已实际核对 Node 24.19.0。
- pilot 目录 `0700`、`device.credential` 为 `0600`。JJ 新设备/授权 ID：`5b34cfd1-eee6-45fd-9be7-9000c4daf9d8` / `7ffb9e55-18e1-4a9c-aeed-befddb39a6b3`。没有复制 Windows 的设备授权。
- 只用用户 `jj` 的既有权限，未修改 sudoers、用户组、SSH 身份、系统代理或原用户 Node。员工没有 Docker socket。当前 Node 执行器以 JJ 用户权限运行，**尚未具备 OpenShell OS 隔离**。

## 已修复问题

1. **数据库关闭竞态。** 锁定 `pglite-socket 0.2.11` 的 stop 未等待 detach，close 回调会延后执行并清理事务。本地适配器跟踪在途工作与清理、合并重复 detach，在完成后才关闭数据库；不修改依赖。清理失败保留锁并记录失败，不输出正常停止。真实 pg 事务回滚及磁盘重开回归通过，独立多客户端/在途查询检查通过。详见 [关闭修复报告](pglite-socket-close-repair-2026-10-08.md)。
2. **通过提示时机。** `local:check` 只有最终清理成功后才提示通过。
3. **测试子进程泄漏边界。** 新回归子进程有独立超时和退出清理，死锁失败不会无限留下子进程。
4. **Linux 安装中的可选 CUDA 下载。** 首次根项目安装退出 1；用 ORT 提供的 `ONNXRUNTIME_NODE_INSTALL=skip` 跳过非捆绑 CUDA 后安装成功，CPU 原生绑定实际加载通过。锁定依赖版本不变；这不等于已安装语义检索模型。
5. **远程页面文案。** 数据位置改为后端所在电脑，执行设备说明包含网页启动器；避免 Windows 浏览器用户误认为文件写在 Windows 或必须安装桌面端。审批和授权逻辑保留。
6. **员工上下文与摘要。** 移除额外1024帽，完整摘要成功的软压力允许继续；按新增历史增长门槛避免重复摘要。确切已知费用截断可保留完整原文，但正式派发也禁止删除source，64KB旧保护仍拒绝超限。见[修复证据](employee-summary-jj-repair-2026-10-08.md)。
7. **方案与模型配置。** AI收到明确任务种类和校验反馈；显式推理强度缺能力声明时提前拒绝，网页可选模型默认。新建默认128KB，旧草稿与快照容量不自动修改。
8. **网页恢复确认。** 原生confirm在IAB延迟生效，改为页面内显示原Run/版本、预算继承、模式风险；重新GET检查后才POST，同步ref防重复、迟到旧Run响应不导航。23项相关回归、类型和构建通过，旧审批/未知操作核对保留。
9. **普通执行输出截断。** 真实经理长正文达到2048却被报EMPLOYEE_IDLE。修复为已知用量结算后的明确MAX_TOKENS，不传递残缺文本或工具，不自动续写；review增加紧凑完整原生交接提示。44项相关本地DSH回归、适配器费用/预检回归及类型构建通过，已部署，不以回归冒充经理实际验收。

构建仍提示约 540KB 的 JS chunk 超过 500KB；npm 的 allowScripts 覆盖提示保留。实际构建、CPU 绑定和相关回归已通过，未通过升级依赖或放宽全部脚本规则消除提示。

## 完整停止与恢复的实际证据

生产 pilot 第一次受控停止：launcher PID `1623232`，收到 SIGTERM；API 退出 0，launcher-stopped、launcher-exit 0，启动锁不存在。重新启动 PID `1631534` 后，知识、设备和费用核对通过。之后补充网页文案构建及备份检查，最终服务 PID `1641129`；均属于同一 pilot 数据目录。

知识文档 `981a73f7-419e-4ff6-9920-e394651ebc93`：

| 项目 | SHA256 |
| --- | --- |
| v1 正文 | `50c5d56eb56959559539f83077c40f7745f80e092069d7886edd7d056383bead` |
| v2 正文 | `28f402ffac2655212e91e732e03b3490bc2320675430d73de28192ca6dddf08d` |
| Vault Markdown | `770a726a9b4674dadaf591a674fb1f730b9aa918b6be9d72bc9b9a495e952451` |

检查项目 Run ID：`38114b4b-e486-49c8-b752-0216a92b3d85`，独立目录 `...-jj1/.data/local-check/538f33e7-4f2e-4e81-838e-0bfe65927e52`。两个完整重开进程 PID `1633480`、`1633506`。固定协议驱动了真实文件写入、1 次命令审批与真实 Node 命令；完成后重开不增加操作、费用记录或运行事件，已停用设备没有自动重新授权。这是恢复回归，不是 DeepSeek/GLM 的员工项目验收；也不涵盖断电或强制杀数据库进程。

## 备份恢复证据

运维快照：`/home/jj/.local/share/weiwu/backups/pilot-20261008-071014-9775ab73.tar.gz`，5,148,312 字节，权限 `0600`，SHA256 `2908b43386fc3369556c86b9fbea5b89ffc03459f2a3fe06649ba63ca7cce549`。

在原数据库停止后生成快照，恢复到 `data/restore-checks/pilot-20261008-071014-9775ab73/pilot`，1,132 个文件逐项核对一致。实际打开副本 PGlite，读出文档、两版 revisions、每日预算 $20、usage=0、runs=0；随后关闭副本。原 pilot 自动重新启动，未覆盖原目录、未激活恢复设备。该快照未密码加密，留在私有目录；正式业务使用网页加密备份。旧 Windows 交付文件并未在本轮迁移。

## OpenShell 安装及仍需完成的工作

JJ 直连官方 GitHub release 下载超时，Windows 路径连接重置，失败记录保留。只读核对发现 JJ GNOME 已配置手动 HTTP/HTTPS 代理 `127.0.0.1:7897`，SSH 环境没有 proxy 变量；显式沿用既有 HTTP CONNECT 代理后下载成功，未修改代理配置。

已安装 `/home/jj/.local/share/weiwu/runtime/openshell-v0.1.2/openshell`。[官方发布文件](https://github.com/NVIDIA/OpenShell/releases/download/v0.1.2/openshell-x86_64-unknown-linux-musl.tar.gz) 的 SHA256：`7eb6917285331a09e3300266a0558616481a5e9927cae2612ea07c4045b6dd6f`；版本、帮助检查成功。CLI 不等于网关或沙箱上线。

Docker socket 为 `660 root:docker`，jj 不在 docker 组；SSH 的 `sudo -n` 仍要求本机交互认证。保留此权限边界，下一步使用经过审阅的管理员网关配置，由可信管理侧接触 Docker socket，员工经受限网关执行。固定 v0.1.2 没有 `gateway start` 命令，官方原样 Compose/TOML 还需固定 sandbox/supervisor 镜像并启用 TLS；不会直接以关闭 TLS、latest 镜像或扩大员工权限的方式推进。参见 [固定版本 Compose](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/deploy/docker/docker-compose.yml)、[配置](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/deploy/docker/gateway.toml)。实际隔离、越界/联网拒绝、取消、文件往返和恢复尚待验证。

已完成可审阅配置并上传到 `/home/jj/.local/share/weiwu/admin/openshell-v012`，JJ 上实际 `bash -n`、Compose config 和 TOML 安全字段检查退出 0。三个 `:0.1.2` OCI manifest 已查询返回 200、存在 amd64，并固定 digest；没有把 manifest 查询当成 daemon 拉取成功。配置将容器内监听设为 `0.0.0.0`，宿主发布只绑定回环地址，主 API 保持 mTLS。客户端证书只交给为伍私有 HOME；已有状态或配置会保留并停止。源码、检查记录和权限说明见 [网关草稿](../../scripts/deployment/openshell-v012/README.md)。

用户已在 JJ 本机执行 `start-gateway.sh --apply`、`loginctl enable-linger jj` 和一次端口修复。初次 `command: []` 未抵消镜像默认 `--port 8080`，覆盖 TOML 的 18770；实际进程参数与公开固定镜像配置证实该问题。修复脚本核对旧 SHA、保留原 Compose/窄 inspect，仅显式改为 `--port 18770` 并重建该网关，未重建数据库、PKI或客户端证书。Root 随后实际 CLI status 返回 `connected`、`authentication.status=authenticated`、版本0.1.2，health=healthy；为伍健康正常且 Linger=yes。配置及修正过程保留，见 [网关说明](../../scripts/deployment/openshell-v012/README.md)。

首个零模型沙箱探针 `weiwu-probe-0e69d0d`（ID `297d673e-400e-4e3f-9c73-fc4fe474964a`）在 Docker Hub 下载固定官方 Node 镜像时失败：daemon 直连 registry 超时，未继承已有 GNOME 代理。保留失败沙箱和证据，未重复创建；进程身份、文件越界、网络拒绝、取消与恢复全部未运行，不把存储的有效策略当作 OS 生效证据。详见 [最小探针实际记录](openshell-jj-minimal-probe-2026-10-08.md)。

OpenRig 固定 CLI 0.6.6 安装在 `/home/jj/.local/share/weiwu/runtime/openrig-v0.6.6`，HOME/OPENRIG_HOME 独立为 `openrig/home`、`openrig/state`。安装跳过生命周期脚本后单独跑官方 ABI 检查及 CLI help，通过；从 CLI 安装树实际加载 better-sqlite3 13.0.3、内存创建/插入/查询成功，SQLite3.53.4/Node24.19.0。package-lock SHA256 `c4f0512525ea5e425c9e6ca1e2671f22570d6f6ae7df738dbc04c559e0e77de0`。未运行 setup/up/daemon 或配置 provider，保持为伍是当前派发器。

## 小任务业务验证准备与预算

用户最新指定使用简单小任务检验功能，业务用例缩为摄氏转华氏 CLI，覆盖需求、开发、独立 QA、经理验收和一次中断续跑；不扩成大型 Todo 项目。

原 Windows 服务当前未运行，但未留下干净关闭记录。只复制其完整 database（含 pg_wal）到当前工作空间副本，1,151 文件/69,501,023 字节逐字节相同，原锁/WAL/数据库均未打开或修改。副本恢复后用 `BEGIN READ ONLY` 审计：原批准新增总上限 $10，自审批时刻以来全部登记费用 $4.2114518；保守计入所有原未知/未结算预留 $1.322368，剩余 $4.4661802。小任务连同规划、模型检查和恢复上限 $0.50，在原额度内；原预留不结零。

精确匹配既有 Go URL 的 DeepSeek Flash 配置已找到。首次跨机迁移被自动审批拒绝；用户随后明确回答允许迁移这一份 Key 至 JJ，SSH 传输和后端加密保存已完成。只复制该 Go 网关/模型及原协议、thinking、上下文容量选项，未复制旧设备授权或把旧费用清零。DeepSeek 文本及工具往返测试实际通过。

17:12:05 的确认前证据为8条真实调用、$0.011379、无未结算预留、部门/项目0。随后在网页确认有效方案才创建项目 `4ae5cce4-73c1-420a-987f-83db54d196f2`，Run `f6690108-e1ec-4251-bdb3-0c256fa82349`。开发实际生成 `cli.mjs`（SHA256 `11b27fe12cc810889d0ad1d4f321f2ae79360be15069a3a034827732eb60d8de`）与 `README.md`（`13769cb83a37a6790d6dd7e8468f266efa012b946855f14059b48c5f4b82b426`）。自动摘要在自设1024输出上限截断而停止，下游QA/经理未执行，不能标成功。此次摘要 reasoningTokens=0，费用取得完整用量；17:21干净停机时全部13条调用合计$0.0260259、未知/在途0。正在修复并部署，原记录/文件保留。

## 证据位置与继续入口

JJ 原件：`/home/jj/.local/share/weiwu/metadata/` 与 `logs/`。

本机已回收 `.data/research/jj-deployment-2026-10-08/evidence/`；证据包 144,192 字节、35 个条目，SHA256 `b68e44999b821a676020d257aba019498eb25305a6718b7fe883611bdf401081`，只含部署元数据和日志，不含数据库/凭据。OpenShell 安装结果另存 `openshell-cli-installed-proxy.json`。

主要原始记录：

- `logs/linux-production-build-final.txt`、`linux-native-executor.txt`、`linux-shutdown-regression.txt`、`linux-runtime-portable.txt`、`linux-local-check.txt`（首次失败）、`linux-local-check-fixed.txt`（最终通过）。
- `metadata/pilot-before-restart.json`、`pilot-stopped.json`、`pilot-restart-proof.json`、`completed-fixture-full-reopen.json`、`pilot-backup-restore.json`、`deployment-stage1-final.json`。
- 网页截图：`screenshots/knowledge-before-restart.png`、`knowledge-after-restart.png`、`settings-final.png`。浏览器实际保存、编辑和展开历史，不以静态截图代替操作。

后续优先修复小任务摘要阻断，完成真实开发、独立 QA、经理验收和受控重启恢复。OpenShell 管理网关已通过，镜像网络和真实隔离适配单独列为受阻；其后再验证无人登录开机/持续运行及 OpenRig 独立长期部门。沿用已批准总额度和审批规则，不自动增加额度。
