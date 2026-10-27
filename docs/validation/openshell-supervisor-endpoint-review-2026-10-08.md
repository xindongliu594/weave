# OpenShell supervisor 端点修复审阅（2026-10-08）

Root 报告：管理员恢复后原 gateway 已重新通过 health 与 mTLS；Node 镜像已经缓存。用户实际 Docker 29 inspect 返回固定 amd64 manifest SHA 作为 `Id`，不是经典存储返回的 config SHA。当前 `verify_node` 已兼容这两个已核对的固定 SHA，并继续严格验证同一 repository digest 和 linux/amd64；返回 `imageId` 与 `identityKind`，避免把 manifest 误称 config。对应 11 项本地回归通过，已上传的旧 recovery-v2 版本保持不动。

新的探针 `wwp-57ef585b3a37` / `22a0fa90-8a07-4b0a-a921-373f0d7571bd` 已跨过镜像下载，随后出现 `ControlSupervisorStartFailed`。Root 只读记录证明宿主不能解析 `host.openshell.internal`，已有 `https://127.0.0.1:18770` 路线 mTLS 正常。固定 [OpenShell v0.1.2 Docker driver](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-driver-docker/src/lib.rs#L4733-L4784) 的 supervisor 使用 host 网络；显式域名端点不会生成 extra-host 映射，端点按原值传入 supervisor。工作负载仍使用 network=none。

`scripts/deployment/openshell-v012/fix-supervisor-endpoint.py` 针对这一具体已知故障，默认 `--check` 只读，管理员 `--apply` 只做以下可逆改动：

- 要求原 gateway.toml SHA 为 `54d63287df601a4538c842525849d9dd0ca406c8d0e77fc5c8a3448fda41b2ce`，只把唯一 `grpc_endpoint` 从该域名改为 `https://127.0.0.1:18770`。原注释和所有其它字节保留，不覆盖新版模板。
- 内部核对原固定 gateway、命令、loopback 端口、文件 bind mount、TLS 的 127 SAN、旧失败探针 exact ID/phase/reason 和现有 mTLS 路线。残留 supervisor 若存在，只读取单个端点环境项及网络字段；已由官方失败 cleanup 删除时明确记录缺席，不能声称做过现存容器检查。其它活跃容器阻止操作。
- 停止同一 gateway ID，在唯一 root 私有证据目录保存关闭后的 SQLite/sidecar 和原 config；PKI、Compose 只记录 SHA。停止期间通过 CAS 检查原字节，**保持文件 inode 原位写入并 fsync**，避免 rename 导致文件 bind mount 仍读取旧 inode。
- 启动同一 gateway ID，核对实际挂载字节、health 与同 JJ 用户身份的官方 CLI mTLS status。没有 daemon restart、image pull、sandbox create/start、证书重建、权限扩大或数据库覆盖。
- 失败保留证据；只有停止状态、同容器、DB/sidecar/PKI 与当前 config 字节全部可证明未变时，才允许原端点原位回退。超时等未知操作结果禁止自动重放。

4 项本地检查与 AST 解析通过：单字段替换及 SHA/CAS 拒绝；实际原位写 inode 保持及回退；cleanup 缺席如实记录与活跃员工拒绝；supervisor host/workload none 严格验证。此子任务未执行 SSH、sudo 或实际修复，实际管理员执行及后续物理沙箱验收由 Root 记录。

最终冻结 SHA-256：

- `fix-supervisor-endpoint.py`: `612c3fbf00ad7eb9e06e50bfee5c72cd176aa42413012d2a0c4b1c19c40de899`
- `test-fix-supervisor-endpoint.py`: `d2dcecddd7364f3cd233369b126ea9f00578a831fb4458f71103fde48a3db2e2`
- 当前 `preload-node-proxy.py`: `20099a1d7ba86a6b09ecb0a12546defb967d12ea724bfc088eaf0355935e2f98`
- 当前 `test-preload-node-proxy.py`: `a755fe281bb5fc872dc156885833cc8d0773db2e540207d8baa773ff681fe8ff`

没有把宿主 Node 测试、网关认证或本地脚本回归计为员工沙箱隔离通过。

## Root 上传与目标 Linux 回归

Root已通过SSH把四个冻结文件上传到独立新目录 `/home/jj/.local/share/weiwu/admin/openshell-v012/endpoint-fix-v1`，没有覆盖已运行的原脚本或recovery-v2。在JJ使用系统Python实际运行镜像脚本11项、端点脚本4项辅助回归，均exit0；Python AST均通过。原用户目录模板SHA恰为54d632…，只改端点的候选SHA为 `8df2029363e77a5da4579c8c89a156522c9921fba7f6bc3c44b0fcd3ff68fb1d`。

完整辅助回归输出与上传SHA见[准备结果](openshell-supervisor-endpoint-helper-ready-2026-10-08.json)。这次上传与测试以普通JJ身份执行，没有取得root Docker inspect、没有执行管理员预检或Apply、没有模型调用及sandbox操作。实际部署的root文件和容器守卫需由脚本在本机sudo执行时核对。

需本机执行一次：

```bash
sudo python3 /home/jj/.local/share/weiwu/admin/openshell-v012/endpoint-fix-v1/fix-supervisor-endpoint.py --apply
```

SSH身份没有非交互sudo权限，无法复用用户本机终端认证，密码仅在JJ输入。执行后Root独立核对mTLS/health及账本，再进行新唯一物理探针；当前为待执行，不记录为修复成功。

## 管理员实际完成与独立核对

用户已执行上述Apply，实际回执为passed=true，证据目录 `/var/lib/weiwu-openshell-v012/supervisor-endpoint-20261008T145544.566406Z-95625258`。原gateway ID `9bb792c44df7e0577acc1f14afc940e2285cbb4d5a565915f95ac24b4d96a0fa`，新endpoint为https://127.0.0.1:18770，modelCalls=0。这是人类管理员实际回执，Root没有读取该root私有证据目录。

Root在22:57通过原JJ身份的独立SSH检查，官方CLI报告mTLS authenticated/connected，health=healthy/version0.1.2。随后新唯一沙箱进入Ready/ConfigurationAccepted，进一步证明supervisor已能回连。真正Node隔离、拒绝和文件恢复结果见[物理核心通过证据](openshell-physical-core-pass-2026-10-08.json)；端点修复与核心试验均已实际完成。
