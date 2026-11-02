# 成员工作台调研（2026-10-29）

范围：现有企业身份前端的独立只读入口，不建立身份系统，不改变服务端权限。

## 代码核对

- `IdentityGate.tsx` 只给 local-owner/admin 挂业务 children，member 当前显示未开放；`identity-session.ts` 的 `identityAuthorized` 和通用 `api.ts` 同样仅管理入口。
- `api-route-policies.ts` 已逐条登记 GET `/api/departments`、`/api/projects`、`/api/runs` 为 member。`api-access.ts` 先 authenticate/currentRoutePrincipal，再进入 handler；不采用客户端身份 header。
- `app.ts` 的上述列表按 visibleResourceQuery/visibleProjectsQuery 过滤。项目和运行在 LIMIT/OFFSET 前筛选；成员运行列表使用 safeRunSql，返回概要，管理员运行详情 GET `/api/runs/:id` 仍禁止成员。
- `/auth/session` 返回身份、CSRF、登录可用性，没有部门角色列表。全仓未发现 current-access API；`/identity/departments/:id/members` 为 admin。成员 UI 不能声称知道 viewer/operator/manager 或 canApprove。
- 运行 artifacts/artifact 是 member 路由，但需固定来源、归档与文件校验，P0优先列表，后续再接交付正文/下载。
- 不复用 App/RunCenter/DepartmentWorkbench 作为成员页面：它们包含额外请求和写入口；复用 React、session generation/reset 和响应解析。

## 成熟方案与适用性

| 来源 | 结论 |
| --- | --- |
| [DSH 市场](https://dshplugin.app/plugins)（本轮读取） | 原生插件目录有 UI/工作台插件，但不能据目录名称推断支持本项目 Express 资源权限。保持已固定 DSH，不安装新引擎。 |
| [dsh-auth-gate](https://github.com/TecFancy/dsh-auth-gate)（本轮读取） | 密码/共享令牌/TOTP 原生 DSH Web 登录门；已有 OIDC 项目不需要第二登录系统。固定版本兼容分析见 enterprise-identity-2026-10-20.md。 |
| [openid-client v6.8.8](https://github.com/panva/openid-client/tree/v6.8.8) | 项目 package.json 已精确固定 6.8.8，继续复用已有后端；本切片不改协议。 |
| [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) / [useEffect](https://react.dev/reference/react/useEffect) | 复用既有 session store；清理读取请求、阻止旧响应覆盖新身份，使用 React 19 现有依赖。 |

因此只补小型前端资源阅读页面与窄请求入口。没有找到经核实能直接替换这些自有产品连接代码的插件，不新增依赖。
