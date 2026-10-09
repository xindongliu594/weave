# JJ 最小零模型隔离探针：镜像下载受阻

网关端口修正后，Root 独立确认 v0.1.2 CLI Connected/Authenticated（mTLS）和健康正常。本探针实际发送了创建请求，但 **员工进程尚未启动，隔离测试未通过**；不把已保存的策略视为实际内核执行证据。

唯一已登记沙箱：`weiwu-probe-0e69d0d`，ID `297d673e-400e-4e3f-9c73-fc4fe474964a`，当前 `Error / ImagePullFailed`。完整实际请求、退出码、stdout/stderr、get 与 full policy 回执保存在同名 JSON；JJ 原始证据目录 `/home/jj/.local/share/weiwu/probes/weiwu-probe-0e69d0d`。

## 已执行与保留

- 官方 `node:24.19.0-bookworm-slim` 的 index、linux/amd64 manifest 和 image config 均经明确配置的 `127.0.0.1:7897` 桌面代理读取并校验 SHA；没有自行下载镜像层或制作镜像。
- 固定员工镜像为 `docker.io/library/node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`。其 OCI USER/WORKDIR 为空，固定 OpenShell Docker driver 支持创建时的 UID/GID 策略优先于镜像身份，可直接用 stock image；不需要 sudo 构建薄封装。
- 创建请求使用 process `1000:1000`、Landlock `hard_requirement`、空网络规则、无 provider、`--no-auto-providers`、manual 审批、CPU 1 / memory 512Mi；只启动 `/bin/sleep infinity`，未发模型请求。
- 第一条长 UUID 名称请求被明确校验拒绝：最大长度 19，实际 48。该失败完整保留；19 字符短名先查询得到 NotFound，才发送一次修正输入。共两条 create 请求，其中仅一条登记了沙箱。没有重放未知结果。
- 随后 get 返回 Error：Docker daemon 直连 `registry-1.docker.io` 的 `202.160.129.6:443` 超时。full policy 查询保存了版本 1、hash `a130dc461b446b99b9d8505c1433d1703ba80863ca092a7720f36c06cf1dabf6`；get 的 configuration admission 仍 pending，不能解释成工作负载已经验证或激活。

## 尚未验证

实际 UID/GID、工作区写入、越界写拒绝、CPU/内存 enforcement、网络拒绝和停止/恢复均未执行。未读取或修改为伍原数据库、凭据、员工文件，未用 sudo，未调整用户组、Docker proxy 或服务；失败沙箱保留。MVP 账本前后差异由 Root 单独审核，本记录不声称已核实账本。

最小续行前提是由管理员通过受审阅的代理或官方镜像归档路线，把上述**相同 digest**预加载到现有 Docker daemon。桌面代理可查 registry 元数据，不代表 daemon 拉取也走代理；CLI 临时 `HTTPS_PROXY` 通常不会改变后台 daemon 的 pull 路径，不能盲目重复同一失败命令。不为此创建第二个沙箱、手造 OCI 客户端或自行扩大权限。

预加载后先查询原沙箱与固定版生命周期帮助，再由 Root 审核恢复同一失败沙箱。保持策略不变，用 Node 在 `/tmp` 内创建 `/tmp/weiwu-probe` 并写入测试文本；检查 `/var/tmp` 的 mode 是 world-writable，再尝试唯一测试文件写入，要求 EACCES/EPERM。策略允许只读 `/var/tmp`，以区分目录是否存在、Unix 权限与额外写限制。成功还须实际记录 UID/GID、输出及生效策略，不能用本计划补作验收证据。

官方依据：[固定策略 schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/docs/how-it-works/policies/schema.mdx)、[Docker 身份解析](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-driver-docker/src/lib.rs#L582-L653)、[stock OCI 工作区回退](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-core/src/driver_mounts.rs#L93-L111)、[官方 Node 镜像维护源](https://github.com/nodejs/docker-node)。
