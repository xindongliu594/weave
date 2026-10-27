# JJ OpenShell 首轮隔离探针：待网关认证后执行

状态：只读准备完成，未创建或执行工作负载。所有命令形状已用 JJ 上实际 OpenShell 0.1.2 的帮助核对；不把本计划记为通过。

## 准入

先等待管理员网关启动和 CLI mTLS 认证。使用为伍私有 HOME，命令不使用 `--gateway-insecure`；首轮不配置模型/provider，MVP 账本前后须相同。没有结果查询能力的外部命令在传输中断时保留未知，不自动重放。

固定发布中的 `ghcr.io/nvidia/openshell/sandbox` 是运行时镜像，不能当 Node 开发镜像。工作负载使用经 registry 核对并固定 digest 的官方 Node 镜像，薄封装 `/workspace`、UID/GID `1000:1000`、非 root USER 和 WORKDIR。Node 24 路线优先与现有为伍环境一致；实际镜像 tag/digest及可启动性尚未验明。镜像不放 API Key，不挂宿主目录、Docker socket 或宿主 PID。

镜像内添加纯测试文字的 world-readable `/probe-outside/sentinel.txt`，目录 `0777`。它使越界读写失败能区分 Landlock 与单纯 Unix 权限失败；不是公司资料。

## 最小策略草稿

下列字段已按固定源码 schema 核对，生效策略仍要在运行后读取确认：

```yaml
version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/bin, /usr, /lib, /lib64, /etc, /proc, /dev/urandom]
  read_write: [/workspace, /tmp, /dev/null]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: "1000"
  run_as_group: "1000"
network_policies: {}
network_middlewares: {}
```

创建时显式 `--no-auto-providers`、不添加 provider，再读取 base/full policy；空 network_policies 本身不能排除后续追加规则。[固定 schema](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/docs/how-it-works/policies/schema.mdx)、[策略选择](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/docs/how-it-works/policies/default-policy.mdx)。

## 已核对的 CLI 形状

变量须在执行时设置固定值；没有以占位符实际启动。0.1.2 没有 `--restart-policy`。

```sh
"$WEIWU_OPENSHELL_BIN" --gateway "$WEIWU_GATEWAY" sandbox create \
  --name "$WEIWU_PROBE_NAME" --from "$WEIWU_NODE_IMAGE" \
  --policy "$WEIWU_PROBE_POLICY" --cpu 1 --memory 512Mi \
  --no-auto-providers --approval-mode manual --detach --no-tty \
  -- sleep infinity

"$WEIWU_OPENSHELL_BIN" --gateway "$WEIWU_GATEWAY" sandbox get \
  "$WEIWU_PROBE_NAME" --output json

"$WEIWU_OPENSHELL_BIN" --gateway "$WEIWU_GATEWAY" sandbox upload \
  "$WEIWU_PROBE_NAME" "$WEIWU_FIXTURE_DIR" /workspace

"$WEIWU_OPENSHELL_BIN" --gateway "$WEIWU_GATEWAY" sandbox exec \
  --name "$WEIWU_PROBE_NAME" --workdir /workspace \
  --no-tty --no-login-shell --timeout 15 -- node probe.mjs

"$WEIWU_OPENSHELL_BIN" --gateway "$WEIWU_GATEWAY" sandbox download \
  "$WEIWU_PROBE_NAME" /workspace "$WEIWU_RESULT_DIR"
```

先单独 create，再 upload/exec，避免创建时主命令和上传时序竞态。

## 实测顺序与通过条件

1. **身份/资源/策略：** ready、Node 可运行、UID/GID 非 root、实际 CPU/内存限制，生效策略没有 provider 或网络放行规则。
2. **文件：** `/workspace` 写入成功；sentinel 读取和 `/probe-outside` 写入被策略拒绝，有拒绝证据；上传下载逐文件 SHA 一致。
3. **网络：** 直接 IP TCP 与 DNS 操作均被拒绝，有对应策略事件；单纯超时不能判通过。
4. **取消：** 长命令持续写 marker，分别验证 `--timeout` 和中断 CLI；核对 marker 停止增长、远端进程结束。CLI 退出不能证明远端已停止。
5. **恢复：** 同一个 sandbox stop/start 后文件、身份一致；再做网关重启。不能把文件保留写成进程内存、DAG 或预算恢复。
6. **清理：** 仅 `sandbox delete "$WEIWU_PROBE_NAME"`，不使用 `--all`。原始证据另行保留。

归档版本、镜像 digest、实际策略 SHA、状态、退出码、拒绝事件和文件 SHA；前后 MVP 费用和调用记录必须完全相同。

## 为伍接入边界

先完成真实探针，再在现有 `ProductRuntime.createExecutor(archive, snapshot)` 接口接最薄适配器，实现 `root / prepare / revision / execute / close`，保持 `exitCode / output / artifacts / workspaceRevision` 契约。复用现有并发、文件 SHA/CAS、文件/输出限额、审批、handoff、预算和运行档案，仅替换生命周期与传输。

固定 CLI exec 的 request_id 为空，且没有结果查询能力；断开传输必须进入结果未知流程。正式接入还要验证单文件 5MB、总量20MB和输出1MB边界；小探针不能证明全部文件额度兼容。官方同版 SDK 尚未在 JJ 安装验证，不先假定包与网关匹配。
