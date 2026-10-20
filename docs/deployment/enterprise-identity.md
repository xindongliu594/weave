# 企业身份接入准备

状态：本地身份协议、网页 transport 与隔离 PostgreSQL 已验证；实际企业浏览器及 JJ 门禁尚未完成。不要按本页直接切换当前生产服务。单人本机入口继续使用原启动方式，无需配置 IdP。

企业模式复用 OIDC 和 PostgreSQL 服务端会话。浏览器不保存 OAuth token；只使用 Secure/HttpOnly/SameSite=Lax 的 `__Host-weiwu.sid` cookie，CSRF token 仅放内存。

管理员需在部署私密配置中准备：

| 配置 | 要求 |
| --- | --- |
| `WEIWU_AUTH_MODE` | 企业才设为 `oidc`；缺少下列配置会拒绝启动 |
| `WEIWU_PUBLIC_ORIGIN` | 完整 HTTPS origin，无路径或末尾斜杠 |
| `ALLOWED_ORIGINS` | 包含同一公开 HTTPS origin；不扩大到任意来源 |
| `WEIWU_OIDC_ISSUER` | IdP 的精确 issuer，保留其末尾斜杠语义 |
| `WEIWU_OIDC_CLIENT_ID` / `WEIWU_OIDC_CLIENT_SECRET` | IdP 中登记的服务端客户端；秘密不提交 Git |
| `WEIWU_SESSION_SECRETS` | 强随机秘密的 JSON 数组，至少 32 字节/项；首项用于新签名，其余用于轮换兼容 |
| `WEIWU_BOOTSTRAP_ISSUER` / `WEIWU_BOOTSTRAP_SUBJECT` | 首位管理员的精确 issuer/sub；不按 email 匹配或自动加入部门 |

IdP 回调 URI 必须精确登记为公开 origin 加 `/auth/callback`。保持单一 HTTPS origin；前置代理分别把 `/api`、`/auth`、`/healthz` 发到该工作空间 API，把静态文件发到对应构建。保留原 method/query/cookie/CSRF、响应状态、Set-Cookie 与 no-store，不能重发失败的 POST。API 只信任回环代理的转发协议，前置代理须覆盖转发头；后端保持回环监听。普通本机静态宿主用于单人兼容，不能当成已经验收的企业反向代理。

启用前依次验证：受信 TLS；OIDC 初始化和精确回调；首位管理员一次性 bootstrap；pending/disabled/成员拒绝；原预批准设备启动；退出/失效/重启/双用户隔离；A2 当前资源授权。禁止为通过验收关闭证书验证、CSRF 或来源检查。

登录失败时显示身份服务不可用，后台任务与历史不因网页退出而被删除。写入结果不明时保留原编号并先核对；退出结果不明时网页保持关闭，用户可明确刷新登录状态核对，不自动重发退出或业务操作。

升级时先停止旧写者并排空已接纳操作，按加法迁移、检查身份 ready 后才切流量。已持久激活的 OIDC 环境不允许退回匿名本机 owner；回滚使用兼容 OIDC 的旧版本，不清空身份表/世代/审计。会话秘密轮换、正式 IdP 切换、完整备份恢复和 JJ 发布仍各需实际验收，不能把本文当作已验证结果。

实际进度和证据：[身份接线阶段验收](../validation/enterprise-browser-identity-2026-10-20.md)。
