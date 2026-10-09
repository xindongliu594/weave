# 阶段 2 管理员网关与端口修正

适用：jj 的 Ubuntu 26.04 amd64、现有 Docker Engine 29.8.2、Compose 5.6.0。CLI v0.1.2 已由 Root 验证安装；本目录负责新的管理员网关，不替换为伍/DSH。

`compose.yaml` 和 `gateway.toml` 来自 NVIDIA 官方 v0.1.2 源码及 schema 2 文档。三个官方 `0.1.2` 标签已只读查询 OCI manifest，返回 200 且包含 linux/amd64；同时固定 index digest，详见 `verified-images.json`。此检查没有拉取镜像或启动容器。

## 操作入口

jj 已执行首次安装，健康端点返回 v0.1.2，但主 API 尚未通过认证验证。只读核对实际网关进程证明镜像默认参数 `--port 8080` 保留下来，覆盖了 TOML 的 `18770`，导致宿主 `18770` 转发到没有监听的容器端口。`command: []` 在此次部署中不能清除默认 CMD；当前 Compose 改为显式 `--bind-address 0.0.0.0 --port 18770`。客户端 `ca.crt/tls.crt/tls.key` 文件名、证书链和证书/私钥配对均已检查正确，不需重新生成。

**已有部署只运行端口修正，不重复首次安装。** Root 审查并上传本目录新版后，先检查：

```bash
bash scripts/deployment/openshell-v012/fix-gateway-port.sh --check
```

然后由 jj 本机一次管理员认证：

```bash
sudo bash scripts/deployment/openshell-v012/fix-gateway-port.sh --apply
```

修正仅接受 root 数据目录中的原 Compose SHA `a10c59aa4721ad614ae4e3a8ac339ce26386b316e00d0f1301d9b25ce9abf3f6`、固定镜像以及实际容器 `8080` 参数。它先保存原 Compose 与不含环境变量的窄检查记录，再原子替换唯一 command 行、验证 Compose、只重建 gateway（`--no-deps --pull never`）。不删除、更新或重置 PKI、数据库、client bundle，不拉取镜像，不操作为伍服务；不匹配则保留现场停止。修正后由 Root 再验证健康与非 sudo CLI 的 Connected/Authenticated，当前不能视作认证通过。

以下首次安装入口仅供尚未安装的新环境：

Root 审查并上传整个目录后，jj 可先无 sudo 检查：

```bash
bash scripts/deployment/openshell-v012/start-gateway.sh --check
```

审查通过后，在 jj 本机通过一次 sudo 认证执行：

```bash
sudo bash scripts/deployment/openshell-v012/start-gateway.sh --apply
```

`--apply` 才拉取三个固定镜像、在 `/var/lib/weiwu-openshell-v012` 建新私有数据与 PKI、把新客户端证书副本写入为伍私有 HOME `/home/jj/.local/share/weiwu/home/.config/openshell/gateways/weiwu-openshell-v012/mtls`，并启动名为 `weiwu-openshell-v012` 的 Compose 项目。先检查此私有 HOME 已存在、属于 jj、路径没有符号链接。jj 的个人 OpenShell 配置不动。只支持首次安装；目录/CLI 条目已存在则停止，失败后保留现场，不能盲目再次执行或自动删除重建。

宿主发布端口为 `127.0.0.1:18770`（TLS/mTLS）及 `127.0.0.1:18771`（健康）；准备时无监听，apply 时再次检查，不终止已有进程。容器内部使用 `0.0.0.0`，以接受 Docker 转发到容器 IP 的流量；这不是宿主对外网监听。Docker bridge 上的其它容器仍可能访问容器监听器，主 API 对这些调用同样要求 mTLS，健康端点只供观测。不可向不可信容器交付 client key；实际 bridge 可达性、无证书拒绝与回调仍需部署后验证。

## 权限与证书

只有可信管理员 gateway 持有 Docker socket、root 数据目录及 CA/JWT/server 私钥。没有 privileged 配置，没有员工容器，也不给员工 socket、客户端控制凭据或宿主挂载权限。gateway 自身具有 root 等价 Docker 管理能力，需要与员工运行身份区分。

证书使用官方 `generate-certs --output-dir`，local 模式写入 `ca.crt/ca.key`、`server/tls.*`、`client/tls.*`、`jwt/*`；生成容器断网且无 Docker socket。不得使用 `--dry-run`，它会打印私钥。自动 discovery 副本留在新 root 私有目录；只把 CA 证书与 client cert/key 交给 jj（目录/文件由 jj 的权限创建，umask 077），不交付 CA/server/JWT 私钥。`.config/openshell/gateways` 每层父目录及新入口若为符号链接则停止，不沿链接写入其它目录；已有 CLI 入口不覆盖。

随后 jj 用现有私有 CLI（不 sudo）：

```bash
env HOME=/home/jj/.local/share/weiwu/home XDG_CONFIG_HOME=/home/jj/.local/share/weiwu/home/.config /home/jj/.local/share/weiwu/runtime/openshell-v0.1.2/openshell gateway add https://127.0.0.1:18770 --local --name weiwu-openshell-v012
env HOME=/home/jj/.local/share/weiwu/home XDG_CONFIG_HOME=/home/jj/.local/share/weiwu/home/.config /home/jj/.local/share/weiwu/runtime/openshell-v0.1.2/openshell status -g weiwu-openshell-v012 --output json
```

必须同时确认 Connected 与 Authenticated，再单独验证保护 API、非 root sandbox 身份、拒绝未授权文件/网络、停止/重启恢复。mTLS 默认 local single-user 身份不是企业员工角色治理；本阶段不配置模型或创建员工，也不宣称 OS 沙箱或 7×24 验收完成。

## 已知限制

- `--check` 仅 Compose 语法、显式 command 与 TOML 安全字段断言。首次部署已执行固定 gateway 的 config preflight；修正后的实际认证仍待验证。
- registry metadata 经既有桌面代理查询成功，不表示 Docker daemon 能拉取镜像。脚本不改 Docker proxy/config、用户组、sudoers、防火墙或休眠；拉取失败会停止，须另行处理明确的网络问题。
- 不给首个员工指定默认基础镜像，必须另行审核非 root USER、WORKDIR 和文件/网络 policy；不能把官方 root Ubuntu 镜像当合格员工。
- 保留官方 Docker supervisor-compatible `Unconfined` AppArmor 值；不是“已验证 AppArmor 强隔离”的证据。需要实际 Landlock/seccomp/非 root 与策略负向测试。
- root 数据、client key 与备份应受权限保护。备份应包含 SQLite 的一致性快照与加密 key/PKI，不能仅复制活动 `.db`；当前未做本阶段恢复实验。

官方依据均固定到 v0.1.2：

- [Compose](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/deploy/docker/docker-compose.yml)
- [配置与 TLS/guest bundle schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/docs/how-it-works/gateways/configuration.mdx)
- [mTLS 与 CLI 凭据目录](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/docs/how-it-works/gateways/authentication.mdx)
- [certgen 实现](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-server/src/certgen.rs)
- [CLI 参数优先于 TOML 的实现](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-server/src/cli.rs#L938-L995)
- [CLI mTLS bundle 文件名](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-bootstrap/src/mtls.rs)
