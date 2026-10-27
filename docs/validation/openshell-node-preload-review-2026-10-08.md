# OpenShell 镜像预载修复审阅（2026-10-08）

当前阻塞是 Docker daemon 未使用 JJ 已有的本机代理下载 Docker Hub 镜像。网关的 mTLS 连接成功，不能证明员工沙箱已经运行。旧探针 `weiwu-probe-0e69d0d` / `297d673e-400e-4e3f-9c73-fc4fe474964a` 保留在 `Error / ImagePullFailed`：固定 Node 镜像的 registry HEAD 直连超时，工作负载尚未激活。

Root 的当前只读检查记录在 `.data/research/jj-deployment-2026-10-08/components-current-result.json`：Docker active、无 systemd drop-in、无 `/etc/docker/daemon.json`；代理 `127.0.0.1:7897` 正在监听；Docker Hub 直连失败，同一请求经该代理返回正常的未登录 `401`。这不是模型 API、余额或员工权限失败。

## 官方接口核对

- [Docker daemon 代理](https://docs.docker.com/engine/daemon/proxy/)独立于 CLI 代理环境，systemd 环境修改需要重启 daemon。
- [Docker 固定 digest 拉取](https://docs.docker.com/reference/cli/docker/image/pull/)允许只下载已经核对的镜像版本。
- 固定 [OpenShell v0.1.2 Docker driver](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-driver-docker/src/lib.rs#L2759-L2780) 的 `IfNotPresent` 先 inspect 完整镜像引用，命中后不再请求 registry。现有 `gateway.toml` 是 `image_pull_policy = "if_not_present"`，预载脚本也重新断言该配置。
- 已安装 v0.1.2 CLI 的 `sandbox --help` 没有 retry/import/update，只有 stop/start 等操作。固定[生命周期源码](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-server/src/compute/mod.rs#L1458-L1466)禁止将普通 `ImagePullFailed Error` 当作 start 的合法来源。不能盲目用 start 重试旧记录；网络与镜像确实修好后，可由 Root 保留旧记录并另建唯一的新探针，重新实测。

## 可审阅实现

`scripts/deployment/openshell-v012/preload-node-proxy.py` 默认 `--check` 只读；实际 Docker socket 检查仍需管理员本机 sudo。`--apply` 仅做以下操作：

1. 拒绝陌生容器（包括已停止但可能随 daemon 重启启动的容器）、已有 daemon 配置/代理、发生变化的网关镜像、命令或端口。
2. 暂停同一个现有 gateway container ID，确认已停止，在 root 私有唯一目录保存关闭后的 SQLite 原字节及 sidecar 副本，记录 PKI/config SHA，不输出私钥。
3. 在 `/run/systemd/system/docker.service.d/99-weiwu-preload-proxy.conf` 写入本机已有代理。暂时重启 Docker，按原始完整引用拉取一次 `node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`，核对 linux/amd64、config SHA 和 repository digest。
4. 不论 pull 成功或失败，清理自己创建的精确临时 drop-in，再重启 Docker 恢复原 unit 环境；确认 DB/sidecar/PKI/config 未改变，启动同一个 gateway container ID。没有 Compose recreate、证书重建、数据库恢复覆盖、TLS 降级或员工授权修改。

该操作包含两次 Docker restart 和短暂 gateway 停机；为伍 API 服务不在操作范围内。出现他人配置更改、数据库变动或结果不明确时保留证据，拒绝自动覆盖和自动启动。`--rollback <脚本输出的唯一证据目录>` 可恢复进程异常中断后的精确临时配置；缺乏已确认停止/数据库冻结证据时仍要求管理员检查。文件名冲突、未知容器和别人的 drop-in 均不被删除或覆盖。

管理员审阅后使用 Python 执行 `preload-node-proxy.py --check`，再执行 `--apply`。上传、sudo 和真正 pull 尚未在本子任务执行；Root 决定并记录实际执行。

## 本地验证与界限

`test-preload-node-proxy.py` 的 7 项本地故障注入检查通过：已有固定镜像零变更；一次 pull 后恢复原容器；pull 拒绝/超时零自动重试并回滚；DB 被更改时不覆盖备份、不启动 gateway；他人代理修改保留；陌生容器/旧端口拒绝；digest/config/platform 不一致拒绝。Python AST 解析通过。

这些是辅助脚本的本地回归结果，**不是员工沙箱验收**。预载、实际 workload 激活、非 root 身份、Landlock 文件限制、网络拒绝、CPU/内存限制及 stop/start 仍需另行真实验证。宿主 Node 运行结果不能计入沙箱通过证据。

冻结 SHA-256：

- `preload-node-proxy.py`: `92301fb9d56343e19bca7af16429019553d5d52d69048eb5631ca209b25225c8`
- `test-preload-node-proxy.py`: `abec22c7e580410928370546e48f42bdd0494d7194223ae0cc7c256df9a20215`

## 实际管理员执行发现与紧急更正

首次管理员 Apply 在回滚阶段停止，原证据保存在 `/var/lib/weiwu-openshell-v012/node-preload-20261008T135324.533471Z-67ee1d48`。原脚本把 `systemctl show` 的完整 `ExecStart` 当作静态配置比较，其中包含正常重启后改变的 PID、时间和退出状态，造成恢复判断错误。此为辅助脚本缺陷，不能解释为 OpenShell 沙箱或为伍服务成功/失败的验收结论。Root 已只读确认 Docker active、临时代理文件与 drop-in 均不存在，gateway 尚未重新启动，为伍服务保持运行。

紧急更正只规范化比较 ExecStart 的 `path`、`argv[]`、`ignore_errors` 及真实静态 unit 字段；恢复还需读取当前 Docker MainPID 的实际 `/proc` 环境，确认没有临时代理。如果 daemon 已恢复，`--rollback` 直接在所有 DB/sidecar/PKI/config 和同一容器 ID 守卫通过后启动原 gateway，不追加 Docker restart，不重跑 pull，不创建 sandbox。原 `report.json` 完全保留，新恢复证据写入唯一 root-owned `recovery-*` 子目录，并保存原始报告字节副本和 SHA；历史失败字段不替换。

更正后的 10 项本地回归与 AST 检查通过，新增实际 systemctl 序列化的瞬态字段回归、实际进程代理环境拒绝及旧报告恢复仅启动同一容器/原报告字节不变检查。用户已执行管理员恢复，返回rollbackPassed=true；Root在22:11独立确认现有网关mTLS connected/authenticated及health正常。这些检查仍不等于员工沙箱验收。

已上传并实际使用的 recovery-v2 冻结 SHA-256（保留，不覆盖）：

- `preload-node-proxy.py`: `c37c556c27dddda6cf5850177bf45e6cfbaf31b50c5ebfe88107e52309359b09`
- `test-preload-node-proxy.py`: `fbd392efd7acb4c6737b14faeaf7ee49d8e1091fceb745f9d4d161ab2b46be2d`

## Docker 29 镜像身份兼容更正

用户真实管理员inspect确认固定Node manifest已缓存，Id=固定manifest SHA、Os=linux、Architecture=amd64、RepoDigests=node@同一固定SHA。旧脚本只按legacy image store的config SHA比较Id，错误拒绝containerd image store返回的manifest SHA。当前源码只允许两个已核对的固定ID之一，并继续要求同一Node仓库digest及linux/amd64；返回imageId和identityKind，避免将manifest ID误称config。

11项本地回归通过，覆盖用户这份真实四字段、陌生Id、错误平台和不同repository。没有重跑Apply或pull，没有覆盖远端recovery-v2。

当前源码冻结SHA：`preload-node-proxy.py` 为 `20099a1d7ba86a6b09ecb0a12546defb967d12ea724bfc088eaf0355935e2f98`，测试为 `a755fe281bb5fc872dc156885833cc8d0773db2e540207d8baa773ff681fe8ff`。后续真正OpenShell创建已跨过镜像拉取，在监督进程回连阶段失败；见[实际试用记录](openshell-openrig-actual-trial-2026-10-08.md)。

