# ssh jj：为伍部署设备只读评估

日期：2026-10-08（北京时间）。经用户指定 `ssh jj` 连接成功，沿用现有 SSH 身份和已知主机验证。仅执行只读系统/版本探测；没有上传项目、安装依赖、创建服务、修改系统、读取凭据或调用模型。

## 实际设备与环境

| 项目 | 实际结果 |
| --- | --- |
| 系统 | Ubuntu 26.04 LTS，x86_64，Linux 7.0.0-15-generic |
| 虚拟化探测 | systemd-detect-virt 返回 none；对端已提供 Linux 环境，无需通过 WSL2 获得 Linux |
| CPU | Intel Core i7-9750H，6 核 12 线程，12 个 CPU 在当前进程 affinity 内 |
| 内存 | MemTotal 15635680 KiB，约 14.9 GiB（标称约 16GB）；采样时 MemAvailable 约 12.9 GiB |
| 磁盘 | NVMe 非旋转存储，476.9 GiB 物理盘；根/用户数据所在文件系统剩余 433479647232 字节，约 403.7 GiB |
| GPU | GTX 1660 Ti Max-Q，6144 MiB；当前中转站模型路线不要求本机执行大模型 |
| 已可用工具 | Git 2.53.0、Python 3.14.4 |
| 未检测到工具 | SSH PATH 中没有 Node、npm、tmux、Docker、Podman；常见 Node/fnm/nvm/mise/Volta/Codex runtime 路径及常见 Docker 路径也未检测到 |
| Linux 隔离前提 | cgroup2fs；内核启用 cgroups、seccomp、seccomp filter、Landlock；当前 LSM 列表包含 Landlock。未执行沙箱预检或隔离测试 |

第一次块设备输出因 snap loop 条目过多而被截断，后续使用 `lsblk -d -e 7` 排除 loop，已实际确认 NVMe。仅凭内核版本或 CONFIG=y 不能认定 OpenShell 的完整运行及隔离验收通过。

## 与项目要求的对应

[package.json](../../package.json)要求 Node.js `^22.19.0 || >=24`。当前可选已验证版本路线是 Node 24；首次运行还需要 npm、项目和员工运行器两套锁文件依赖，以及网页构建。当前设备软件环境尚不满足直接启动条件。

当前模型调用由已配置中转站完成，本机负责网页、管理 API、PGlite、任务/上下文及文件/测试执行；[本机启动器](../../scripts/local.mjs)没有要求运行本地大模型。[可选语义检索](../../services/embedding/local.mjs)使用 CPU q8 模型且限制线程，并需另行安装固定模型，不能与已验证关键词检索混为一谈。

OpenShell 的 Linux 路线还需容器运行环境及实际隔离预检；mvschwarz/openrig 还需 Node 和 tmux，并有当前 DSH/工作流适配限制。Ubuntu 26.04、当前内核及这些项目组合未在本轮实际启动验证，参见 [选型报告](../research/openshell-openrig-reuse-2026-10-08.md)。

## 评估结论与未验证项

**工程判断：硬件足够作为当前 MVP、轻量研发团队及 Linux 隔离组件的部署候选，无需为当前中转站路线更换显卡。** 先以少量执行员工并发试点，根据实际内存、CPU、容器和构建用量调整；员工人数不能直接等同可并发的重型测试任务数。

软件缺口是 Node/npm；容器沙箱与 OpenRig 路线另外需要 Docker 等运行环境和 tmux。下一步是独立目录安装/构建/启动验证，而非直接迁移原数据库或凭据。Windows 用户可通过受控连接访问该 Linux 后端的网页，访问通道与认证须单独配置。

尚未验证：源码在该机构建和启动、真实中转站连通、沙箱隔离、并发性能、持续运行、服务自启/休眠策略、跨机器数据与凭据迁移。不能将本次硬件核对写成已部署成功或 7×24 稳定验收。

原探测 JSON 保留本机忽略目录 `.data/research/jj-device-2026-10-08/`。原机上的项目、用户配置和服务未改动。
