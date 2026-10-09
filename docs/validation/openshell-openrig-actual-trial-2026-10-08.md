# OpenShell / OpenRig 实际试用：重新聚焦

日期：2026-10-08，北京时间。用户明确指出原目标是实际试用两项现成组件；此前大量工作转向为伍自身回归，不能用该回归替代组件运行验证。本阶段停止追加同类付费模型测试，先做独立组件的零模型费用实测。

## 最新实际核查

21:33 至 21:37，SSH 只读核对：

- 为伍 `weiwu-jj.service` active，PID1890583，NRestarts0。正常v9任务在JJ真实completed，16项QA及经理正式交接通过；迁移后的应用并非完全不能运行。
- OpenShell0.1.2网关仍 connected / mTLS authenticated。唯一旧沙箱 `297d673e-400e-4e3f-9c73-fc4fe474964a` 为Error/ImagePullFailed，员工进程没有启动。
- Docker后台active，现无systemd drop-in，`/etc/docker/daemon.json`不存在；JJ既有127.0.0.1:7897代理在监听。Docker Hub仓库HEAD直连约7秒失败；经既有代理0.93秒返回正常认证挑战HTTP401，证明该路径网络可达，未发送模型或使用私人Key。
- Docker daemon独立于桌面/CLI代理。官方要求为daemon配置代理并重启；仅给CLI设置HTTPS_PROXY不能替代。[Docker官方说明](https://docs.docker.com/engine/daemon/proxy/)
- 对Go目录端点未带Key的HEAD直连/代理均0.8秒返回403，只证明可得到HTTP响应，不能判断模型能力、账户余额或90秒超时原因。
- 只读状态核查第一次给systemctl用户服务的临时环境缺XDG_RUNTIME_DIR而失败，随后使用实际用户runtime目录核对active；该失败是诊断脚本环境错误，不能记为应用停机。
- OpenRig0.6.6已装包的CLI实际提供无kernel daemon、仅物化拓扑、队列create/claim/handoff/transition与no-nudge；21:54已在独立HOME/端口/数据库完成控制面实测，见下文。DSH不是其已列官方Harness，暂不能称已接入员工。

本机原始结果：`.data/research/jj-deployment-2026-10-08/components-current-result.json`、`go-transport-current.json`；凭据和原业务数据未修改。

## 本阶段完成标准

1. 核验固定Node镜像的daemon实际拉取或预载成功，再运行真正OpenShell沙箱：进程身份、允许文件写入、越界/联网拒绝、文件往返、停止/重启；原失败记录保留。
2. 用官方OpenRig建立独立最小实例，实际核验持久岗位、队列领取、交接、重开后的工作记录；不把无模型控制面试验称作真实员工开发验收。
3. 两项组件完成独立试用后，再决定为伍与组件的适配边界、唯一派发器及预算归属；安装、help与软件兼容检查均不能替代接入完成。

Docker socket/服务为系统管理员管理，JJ SSH账号不具有非交互sudo；相关修复先准备、检查并上传具体可审阅脚本，真正管理员动作需要本机交互执行。不能绕过权限，也不能给员工Docker权限。其余无sudo依赖的OpenRig控制面试用继续推进。

## OpenRig 控制面实际通过（21:54）

复用已装0.6.6，正式CLI完成19个步骤：无kernel daemon启动、仅物化developer/QA两个岗位、创建任务、开发岗位身份领取、事务交接给QA岗位身份、QA领取、停止并重启同一SQLite数据库、比对原nodeId/role及两个任务的完整transition历史、闭合试验任务，最后官方停止daemon。每个阶段实际sessions为空、无runtime binding/kernel agents，监听仅127.0.0.1:58033；结束后进程和端口均退出，原为伍服务PID1890583保持active。

Rig ID `01M4DWNWQ6KA70DSXTWVSK9RBM`；任务 `qitem-probe-d0b494ba-53dc-4371-906c-acf9249c6dc2` → `qitem-20261008135409-0c12d361`。原始CLI/API与SQLite保存在独立目录 `/home/jj/.local/share/weiwu/openrig/probes/control-plane-20261008T135403Z-3d03bb0b-bf56-4a4c-9b1b-5b5eea148065`。公开实际结果见 [JSON证据](openrig-control-plane-actual-2026-10-08.json)。没有云模型调用、没有启动Stub响应或真实员工会话；这证明官方控制面和持久化可用，不能替代真实员工开发、QA或经理验收。

## OpenShell 预载恢复校验错误（已恢复）

用户执行已上传预载脚本后，自动恢复未完成，原私有报告保留在 `/var/lib/weiwu-openshell-v012/node-preload-20261008T135324.533471Z-67ee1d48`。SSH实际核对Docker已active且临时代理drop-in已移除，OpenShell健康端口拒绝连接，为伍PID1890583仍active。

独立代码审阅确认脚本把systemctl ExecStart中的PID/start_time等瞬态信息作为配置比对，Docker正常重启会改变它们，导致恢复阶段误拒绝。已规范化为真实命令/静态配置比对，保留旧raw报告，并核对实际dockerd环境。用户执行冻结的recovery-v2恢复后返回rollbackPassed=true、modelCalls=0、sandboxOperations=0；Root在22:11独立核对mTLS authenticated/connected及健康端点正常。没有重跑镜像下载，没有覆盖数据库或PKI；为伍PID1890583保持运行。原7项辅助回归未覆盖真实systemctl瞬态字段，该缺口与更正后的10项回归均保留。

## Node 镜像已缓存，Docker 29 身份字段兼容更正

用户提供真实管理员 `docker image inspect` 的四字段：Id为固定manifest digest `sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`，Os=linux、Architecture=amd64，RepoDigests含 `node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`。因此该固定镜像确已存在。原检查只接受旧image store的config ID，误拒绝containerd store返回的manifest ID；修正为两个已核对的固定ID之一，仍严格要求同一Node repository digest和linux/amd64。没有再执行pull或Apply。原recovery-v2上传版本与历史证据保留。

## 22:32 真实 OpenShell 创建进入下一项阻塞

Root执行冻结探针SHA `1aa74adb41f26e18a742757aa6ef61eddcdbd0fff332c4e4d204aae3c1bd4d58`，使用上述人类管理员读取的镜像证明，唯一创建 `wwp-57ef585b3a37` / `22a0fa90-8a07-4b0a-a921-373f0d7571bd`。实际boundary控制监听已启动，原ImagePullFailed未再出现；监督进程gRPC回连五次失败，最终为Error / ControlSupervisorStartFailed，ConfigurationReady仍pending。创建仅执行一次；随后只读确认同一ID的实际Error，原两个失败沙箱均保留。没有启动Node工作负载，不能记录Landlock、资源限制、文件恢复等通过。

公开实际结果：[OpenShell物理试用证据](openshell-physical-actual-2026-10-08.json)。原始CLI回执和失败日志保存在 `/home/jj/.local/share/weiwu/probes/wwp-57ef585b3a37/evidence/`。本机原始结果在 `.data/research/jj-deployment-2026-10-08/openshell-physical-actual-result.json` 和 `openshell-physical-create-failure-readonly.json`；公开证据记录其SHA。

Root只读核对：JJ宿主无法解析host.openshell.internal（Errno -2）；127.0.0.1:18770可连接，既有CLI使用该地址通过mTLS authenticated/connected。固定[官方driver实现](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/crates/openshell-driver-docker/src/lib.rs#L4733-L4785)让受信任supervisor使用host网络，仅IPv4/localhost端点会生成额外host映射；Compose给gateway的extra_hosts不会继承给supervisor。显式grpc_endpoint原样传入supervisor，默认地址本身也为127.0.0.1。当前部署仍显式使用host.openshell.internal，故回连地址是已定位的配置错误候选，管理员修复将先核对实际失败supervisor的network/映射再改唯一端点。源码模板已修正，JJ部署尚未应用。

该零模型试用前后为伍服务active/PID1890583相同，全部146条模型用量和项目费用预留逐项一致。已记录费用$0.7083729、未知请求仍预留$0.0192111；没有新增模型调用，没有把未知费用归零。OpenRig控制面通过，OpenShell员工隔离接入及后续真实员工验收仍未完成。

22:55管理员Apply回执passed=true；22:57 Root独立mTLS/health核对通过。新唯一物理沙箱 `wwp-43170b8e3257` / `67e64e45-7302-4fb9-ac33-cb050825baef` 于22:58进入Ready/ConfigurationAccepted，supervisor实际回连成功。

首次Node载荷在任何写入之前报ENOENT：目录upload会保留basename，实际文件位于/sandbox/upload/fixture.txt，冻结探针误读/sandbox/fixture.txt。该失败及冻结源保留。Root对同一Ready ID仅执行只读目录检查，确认文件实际位置、无输出文件、UID/GID1000、Node24.19.0及cgroup1CPU/512Mi；没有重新创建或重新上传。随后使用新独立continuation源SHA `3265a378cb4106dea570d2621c5f0c175c6874cd844f4fb9ba8604354606ec96` 修正读取路径继续，原载荷中的CPU分割与JSON换行转义经语义核对本来正确，没有因JSON显示双反斜杠去修改它们。

## OpenShell 真实核心功能通过

实际continuation 12个步骤均exit0，无未知结果。Node版本v24.19.0、UID/GID1000、cpu.max为100000/100000、memory.max为536870912。Unix世界可写的/var/tmp（1777）越界新文件写入返回EACCES；真实连接1.1.1.1:443也返回EACCES，属于明确拒绝，不把网络超时或普通连接拒绝视为政策通过。

真实文件上传/下载SHA一致；官方stop→Stopped→start→Ready后，保留同一sandbox ID、fixture与artifact SHA、JSON内容及完整有效策略。有效策略hash和configuration admission保持 `27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5`。最终再次stop并核对Stopped，工作区和所有证据保留。

完整实际结果：[OpenShell物理核心通过](openshell-physical-core-pass-2026-10-08.json)。JJ原始回执目录 `/home/jj/.local/share/weiwu/probes/wwp-43170b8e3257/evidence/continuation-physical/`；模型用量仍146条，已记录$0.7083729，未知费用仍保留$0.0192111，逐项账本没有变化。原为伍active/PID1890583未变。

已完成独立OpenShell核心试用与OpenRig控制面试用。尚未验证：运行沙箱时重启gateway、命令取消、DNS政策、为伍DSH员工适配。两份组件证据不能替代接入后的真实员工开发/独立QA/经理验收及DAG重启恢复验收。下一阶段保留现有唯一DAG/预算/审批/文件版本机制，核对薄适配边界，再用小任务做接入验收；此前最新v10仍failed且未知调用不重放。
