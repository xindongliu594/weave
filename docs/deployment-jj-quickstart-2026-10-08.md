# 在 Windows 使用 JJ 上的为伍

> 本文保留 2026-10-08 的历史状态。当前操作请使用 [2026-10-09 使用说明](deployment-jj-quickstart-2026-10-09.md)，其中包括部门工作台、OpenShell 设备和可选 OpenRig 入口。

日期：2026-10-08。为伍生产网页和后端已在 JJ 的 Ubuntu 环境运行。Windows 负责浏览器访问；文件、数据库、员工命令实际在 JJ 上执行。

## 打开网页

当前会话的访问入口：**http://127.0.0.1:4312/**。SSH 隧道已经建立，只监听 Windows 回环地址。

以后在当前项目的 PowerShell 中运行：

```powershell
.\scripts\deployment\connect-jj.ps1
```

然后打开脚本输出的网页地址。脚本沿用已有 `ssh jj` 身份和已知主机验证，后台创建专用隧道，检查后端健康并输出隧道 PID。端口已经占用时会停止，不会关闭其他进程；可以改用 `-LocalPort 4313`。

在网页“系统设置”中，应看到 `linux · Node 24.19.0`、在线的本机执行设备，以及 `/home/jj/.local/share/weiwu/data/pilot/workspaces`。

## 首次配置与使用

当前 JJ 使用新的独立 pilot 数据库。经用户明确许可，已通过 SSH 复制唯一 OpenCode Go 配置，并在 JJ 后端加密保存 Key；DeepSeek 的文本和工具协议检查通过。原 Windows 项目、费用、未知预留与设备授权仍保留在原环境，未复制为新的预算。

1. “模型目录”已有 `OpenCode Go · JJ 网页验收` 与 `Go · DeepSeek V4.1 Flash`，可直接使用。报价沿用原配置，费用以服务账单为准。
2. 付费请求仍受原环境已批准额度约束。用户后来批准本轮JJ小任务累计总上限$2；当前项目上限$1.90、检查/对话预留$0.10，已发生费用也计入。原$10总授权、每日$20及原未知费用继续保留；旧运行仍记录当时$0.40，不能因新库或新方案清零。
3. 回到“需求组建”持续补充需求，核对团队方案，确认后才保存部门和创建项目。
4. 在项目中核对执行方案、费用与审批边界；员工运行时，网页会逐条显示命令审批。
5. 从执行详情查看文件、测试结果和恢复条件。费用或外部操作结果未知时先核对，不直接重放。

真实小任务项目 `4ae5cce4-73c1-420a-987f-83db54d196f2` 已从网页确认并创建。v9正常运行 `f86bfd4f-265d-43f4-ad30-5c5c1140dd92` 已完成：开发生成代码与README，独立QA真实Node测试16/16通过，经理提交正式原生审查通过，三个节点均accepted。完整测试输出见 `validation/jj-simple-real-qa-v9-2026-10-08.txt`。v10受控恢复验证 `4fac3246-e4fe-462e-aca0-7e571b99924a` 在首个真实模型请求90秒超时后失败，尚未生成开发文件，不能宣称该版恢复通过。旧v4确实保留完成开发节点、三个文件及费用并继续QA，但该次QA失败，历史记录保留。

截至北京时间21:27，本轮已登记$0.7083729，另有$0.0192111模型费用结果未知并继续预留；不能将其按零结算。JJ服务仍运行，没有正在执行的员工任务。OpenShell已安装并验证管理网关mTLS连接，实际沙箱探针因Docker Hub镜像拉取超时失败；OpenRig仅完成独立安装、CLI及SQLite兼容检查。当前员工使用JJ本机Node执行器，两者均未接入为伍员工执行流程。

## 上下文与输出设置

项目“编辑方案”中，每项任务的“单次最大输出 Token”控制一次模型回复最多写多少；“累计预计输入/输出 Token”用于整项任务费用估算。项目“策略上下文上限（字节）”限制请求体大小，模型目录的“上下文容量（Token）”用于自动摘要触发，四者不能混用。

本轮2048是测试方案的输出设置，不是DeepSeek模型硬上限。较长代码或经理报告可在新方案中设合理输出（如8192），保存新版本并重新批准；实际仍取任务、路线及本次请求允许值中的限制。旧运行恢复沿用原快照，修改新方案不会偷偷放宽旧快照。新建页面默认请求容量128000字节，旧草稿与旧方案保持原值。

DeepSeek官方当前列出V4.1 Flash上下文1M、最大输出384K（[规格](https://api-docs.deepseek.com/quick_start/pricing/)）；Go的实际路线需单独核对。本轮保存的模型容量131072是沿用配置，未实测百万Token请求，不能以厂商规格宣称该配置已做超长验收。网页当前任务单次输出字段允许1–32768，路线自身还可能更小。使用小任务验证功能无需填满模型容量，预算与工具审批继续生效。

## 管理服务

在 Windows PowerShell 中：

```powershell
ssh jj 'systemctl --user status weiwu-jj.service --no-pager'
ssh jj 'systemctl --user stop weiwu-jj.service'
ssh jj 'systemctl --user start weiwu-jj.service'
```

正常停止会先关闭网页和员工 API，再清理数据库连接。重启沿用同一数据目录和设备授权。关闭 Windows 隧道只断开访问，JJ 服务继续运行；脚本输出的 PID 只属于该次隧道。

已启用用户登录自启，用户在 JJ 本机启用 `Linger` 后实际核对为 **yes**。用户服务可在退出登录后保活；无人登录开机实测、休眠/合盖策略和连续 24 小时稳定性尚未验证。不要在聊天里发送 sudo 密码。

## 路径与备份

| 内容 | JJ 路径 |
| --- | --- |
| 当前发布 | `/home/jj/.local/share/weiwu/releases/4f19ab005f80eb07fd3623e7f2e8792ed5ba71ac-jj1` |
| pilot 数据 | `/home/jj/.local/share/weiwu/data/pilot` |
| 知识 Markdown | `data/pilot/obsidian-vault`（相对上述部署根目录） |
| 测试及服务日志 | `/home/jj/.local/share/weiwu/logs` |
| 部署元数据 | `/home/jj/.local/share/weiwu/metadata` |
| 停机快照 | `/home/jj/.local/share/weiwu/backups/pilot-20261008-071014-9775ab73.tar.gz` |
| 隔离恢复检查 | `/home/jj/.local/share/weiwu/data/restore-checks/pilot-20261008-071014-9775ab73/pilot` |
| 含真实业务的停机快照 | `/home/jj/.local/share/weiwu/backups/final-pilot-20261008T113723.300058Z-750ca148.tar.gz` |
| 真实业务隔离恢复副本 | `/home/jj/.local/share/weiwu/data/restore-checks/final-pilot-20261008T113723.300058Z-750ca148/pilot` |

首份停机快照生成于Go配置及业务调用之前。后续真实业务快照10,977,856字节、1305文件核对一致，副本数据库实际读取92条用量、9运行、6方案版本、全部交付及知识v1/v2，Key可解密核对但未输出明文；原服务重新启动后数据与授权不变。该快照产生时经理尚未完成，明确标记`businessCompleted=false`，不包含随后成功的v9。两份都在用户私有目录，权限0600、没有备份密码加密；正式业务可用网页密码加密备份。恢复设备未启动，原环境未覆盖。设备目录授权绑定原路径，迁移到其他路径或电脑时须重新核对。

完整结果见 [JJ 部署验收报告](validation/jj-deployment-acceptance-2026-10-08.md)。
