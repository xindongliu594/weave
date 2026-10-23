# 插件安装入口部署到 JJ（2026-10-23）

## 部署结果

用户批准“部署上去”后，已将插件安装版本切换到 JJ 的 `weiwu-jj.service`。部署来源为已提交的 `d4c5eca`，另含本轮核对的两项 Linux 安装兼容修复。部署使用独立 Git 归档，未带入工作区旧的未提交恢复加固改动。

**当前状态：服务部署通过；Windows 到 JJ 的连接反复中断，最终网页复核受阻。** 不把已通过的服务检查表述为网页验收通过。

- 当前版本：`/home/jj/.local/share/weiwu/releases/weiwu-plugin-install-full-d4c5eca-20261023`
- 原版本保留：`/home/jj/.local/share/weiwu/releases/weiwu-hardening-coordination-20261020`
- 停服完整备份：`/home/jj/.local/share/weiwu/backups/plugin-install-predeploy-20261023`，包含原数据及服务单元。
- 原始私有部署记录：`/home/jj/.local/share/weiwu/validation/plugin-install-d4c5eca-20261023`。
- 网页入口：[浏览器与 MCP](http://127.0.0.1:4312/#work-tools)，须保持 Windows 到 JJ 的 SSH 隧道可用。

新服务启动后，数据库连接、运行时就绪、能力目录读取及新安装任务路由检查通过。65 次历史运行、732 条用量记录、7 笔未知费用预留保留；用量与预留内容哈希前后相同。本次模型调用为 0，未启用新插件、授予新员工权限或开始业务项目。

## 实际验证

| 项目 | 结果 |
|---|---|
| 部署前停服核对 | 活动运行、消息、待定调用、活动能力测试均为 0 |
| 数据库升级预演 | 先在停止后的数据库副本迁移；8 类关键业务表计数前后一致 |
| JJ Linux 回归 | 安装器、构建边界、版本库、API 访问、请求来源共 23/23；最终兼容修复后安装器另通过 9/9 |
| 类型与网页构建 | JJ 类型检查、Vite 构建退出 0；最终兼容修复后类型检查再次退出 0 |
| 原版 Office 安装 | 在 JJ 隔离插件目录实际从 npm 安装 `0.2.4`，10 个工具；约 19 秒完成 |
| Office 安装任务 | `bcee665f-57ec-418b-a65c-f35684861d04` |
| Office 固定版本 | `6697cf44d6a34851b4c1745732cd7b6263096d58a5e3bd910a783495f26555b6` |
| JJ 本机认证与健康 | `/auth/session` HTTP 200，约 6 ms；`/api/health` HTTP 200，约 9 ms；服务 active |
| Windows 网页复核 | 受阻：认证请求经过旧隧道约 15 秒；重建后短暂健康检查成功，随后隧道再次退出，四个 HTTP 端点均超时，新浏览器标签返回连接被拒绝 |

可复核摘要及测试输出保存在 [deployment.json](evidence/plugin-install-deployment-jj-2026-10-23/deployment.json)、[迁移预演](evidence/plugin-install-deployment-jj-2026-10-23/migration-check.json)、[Linux 回归](evidence/plugin-install-deployment-jj-2026-10-23/linux-tests.txt)、[最终安装器回归](evidence/plugin-install-deployment-jj-2026-10-23/linux-final-installer-tests.txt)。这些文件不包含凭据、数据库内容或模型请求正文。

最后一轮 Windows HTTP 检查见 [final-http-check.json](evidence/plugin-install-deployment-jj-2026-10-23/final-http-check.json)。本轮隧道仅绑定 `127.0.0.1:4312`；只重建了本轮创建的连接，未修改 JJ 网络配置或公开服务端口。最终浏览器截图未取得；旧标签控制也曾超时，切换新标签后明确报告连接被拒绝。恢复稳定连接后，运行 `scripts/deployment/connect-jj.ps1` 再打开上述网页补核；本次未设置自动循环重连。

## 部署中修复

1. Node 官方 Linux 压缩包的 npm 位于 `lib/node_modules/npm`，原查找只覆盖 Windows 和常见系统路径。现在补充该布局，沿用同一个 Node 和权限子进程。
2. npm 在 Linux 创建 `.bin` 符号链接被 Node 受限权限拒绝。插件构建只需要导入包，不需要命令行快捷方式，因此安装时增加 `--bin-links=false`。未放开任意文件系统权限，安装脚本仍禁用。

最初尝试在旧生产版本叠加插件补丁，预检发现缺少新访问控制文件，未修改生产；随后改用完整已提交版本及独立依赖目录。原服务、原依赖与凭据保留。升级预演和构建通过后才切换服务。

## 回退与范围

回退须先停止服务并核对无活动任务，保留失败现场，再恢复备份数据库与原服务单元；不可仅切回旧代码却继续使用升级后的数据库。本次未触发回退，完整备份继续保留。生产恢复演练未额外执行。

这次验证的是 Linux 安装与发布，未重新执行付费模型业务验收，也未把隔离安装的 Office 自动启用到生产。插件兼容范围和员工授权方法见[安装说明](../plugin-installation.md)；原本地验证与未完成边界见[插件验收报告](plugin-plug-and-play-2026-10-23.md)。
