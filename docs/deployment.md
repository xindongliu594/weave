# 服务器前端 + Mac 后端

部署入口：`https://47.88.76.167/agent-department/`，与 AI-Mortgage 共用服务器和 HTTPS 证书。

请求经过服务器 HTTPS Nginx → 独立的 `agent-department-web` 容器 → SSH Unix socket 隧道 → Mac 的 `127.0.0.1:4311`。浏览器请求始终同源，Mac 不开放公网端口。服务器只保存前端、桌面安装包、代理配置和登录密码散列，不保存模型密钥、数据库或执行记录。

整个入口（包括 API）有 HTTP Basic 登录保护，须使用 HTTPS。登录信息在源码目录 `.data/deployment/登录信息.txt`，不要提交到 Git 或发送到公共渠道。当前是共享管理员账号，拥有全部工作台操作权限；独立账号和细分权限尚未实现。与 AI-Mortgage 共用 origin，因此并非独立安全域；未来使用独立域名可进一步隔离。

## Mac 目录及启动

- 源码：`/Users/macmini1/Desktop/subject/agent-department`
- 后台运行副本：`~/Library/Application Support/AgentDepartment`
- 运行数据：该目录的 `.data`；源码的 `.data` 链接到同一份数据。
- PostgreSQL：Docker 项目 `agent-department` 的原有卷，端口 `127.0.0.1:55432`。
- 日志：`.data/deployment/api.log`、`api.error.log`、`tunnel.error.log`。
- 用户级 launchd：`com.agent-department.api` 和 `com.agent-department.tunnel`，登录时启动、退出时重试；隧道断线自动重连。

Mac 必须在线、保持唤醒，且用户已登录、Docker Desktop 可用。关机或睡眠时前端仍可打开，但依赖后端的数据和执行功能不可用。用户级服务并不保证 Mac 重启后在用户登录前可用。PostgreSQL 配置为随 Docker 恢复；API 启动脚本也会检查数据库。

macOS 限制后台进程读取桌面，因此服务使用应用数据目录中的运行副本。修改源码后需重新安装后台副本；不要同时运行 `npm run dev` 占用 4311 端口。只调前端可以运行 `npm run dev:web`。

## 更新

在源码目录、使用 Node 22.19+：

```sh
npm test
npm run build -- --base=/agent-department/
python3 scripts/deploy-frontend.py
ALLOWED_ORIGINS=https://47.88.76.167 python3 scripts/install-mac-services.py
```

部署脚本仅适用于当前服务器布局，使用 `ai-mortgage-server` SSH 别名。它保留原有 Mortgage 路由，首次追加独立路径前备份配置，验证 `nginx -t` 后平滑重载。已有路径不会重复插入；如要修改 edge-location.conf，需要单独核对服务器 Nginx 配置。

后端更新会重启服务，先确认没有正在运行的任务。脚本同步已安装的代码与依赖目录（包括删除已移除模块），不覆盖或清理共享 `.data`。

服务器文件在 `/opt/agent-department`；容器仅加入现有 `docker_default` 网络，不映射额外公网端口。`agent-department-web.service` 在服务器启动时恢复容器，容器本身配置异常退出重启。复用既有 `ai-mortgage-cert-renew.timer` 续期证书。

## 检查与停用

```sh
launchctl print gui/$(id -u)/com.agent-department.api
launchctl print gui/$(id -u)/com.agent-department.tunnel
ssh ai-mortgage-server 'systemctl status agent-department-web.service; podman ps --filter name=agent-department-web'
```

停用 Mac 服务：`launchctl bootout gui/$(id -u)/com.agent-department.api`，隧道同理；删除对应 `~/Library/LaunchAgents/com.agent-department.*.plist` 可取消下次登录启动。停用服务器入口应只删除 `/agent-department` 两条 location，`nginx -t` 后重载，再停用独立服务；不要用旧备份覆盖其他后来新增的配置。

## 本次验收

2026-09-20：v0.2 的 27 项自动化测试、macOS 桌面 UI 检查及正式构建通过。通过有效 HTTPS 证书验证：已认证的 HTML/JS/CSS 返回 200；未认证页面/API 返回 401；Mac 数据库和运行时就绪；部门、模型、项目、Run 列表返回 200；同源写请求通过来源校验，跨站写请求返回 403。AI-Mortgage 官网、管理端、门户均返回 200。本次没有调用真实模型 API，不能据此认定模型执行链路已恢复。

技术参考：[OpenSSH 端口/Unix socket 转发](https://man.openbsd.org/ssh)、[Nginx proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)。

桌面版本更新：先在 `apps/desktop` 安装依赖，运行 `npm run dist --prefix apps/desktop -- --mac --arm64 --x64` 和 `npm run dist --prefix apps/desktop -- --win --x64`，再运行 `python3 scripts/publish-desktop.py`。网页单独更新不删除既有 downloads 目录。Obsidian 目录配置和能力边界见 [知识库说明](obsidian.md)。
