# 企业身份、部门授权与真人审计调研

日期：2026-10-20。代码基线：`4fc7639`。范围：JJ 部署、单组织多人内网使用；本文件只做调研与可执行设计，未安装依赖、未配置真实 IdP、未改生产数据或开启网络监听。文中的接口与表名是建议，尚未实施。

## 1. 选型结论

采用 **OIDC Authorization Code + PKCE 的服务端登录（BFF）**。优先连接组织已有 OIDC 身份提供方；如果没有，Keycloak 可作为独立 IdP 候选，但不能因为客户端代码完成就声称已有企业登录服务。浏览器仅持有应用会话 cookie，不持有 IdP access/refresh token。

复用 `openid-client` 处理 discovery、授权请求、code exchange 和 ID token 校验；复用 `express-session` 与 `connect-pg-simple` 保存服务端会话。为伍只实现本组织的人类用户、部门成员资格、业务权限、审批和审计，不开发密码库、密码重置、MFA 或 OIDC 协议。`jose` 是协议实现的底层依赖，不能单独替代完整登录流程。

保留两种明确模式：`legacy-local` 是现有单机操作入口，actor 显式为 `local-owner`，没有多人身份保证；`oidc` 是企业入口，配置不完整、验证失败或路由未分类一律拒绝，绝不自动降级为本机管理员。两种模式不能在同一企业进程中同时开放旁路。

## 2. 当前项目事实

| 检查项 | 已核实事实与影响 |
| --- | --- |
| Node / Web | 根 `package.json` 为 ESM，Node `^22.19.0 || >=24`，Express `5.1.0`，pg `8.16.3`，React `19.1.1`，可承载 `openid-client` v6。 |
| DSH 固定版本 | `services/agent-runtime/package.json` 和安装包 manifest 为 `@deepseek-ai/dsh* 0.1.5-rc.1`，Cordis `4.0.2`，agent-teams `0.1.20`。没有升级理由。 |
| 已装认证依赖 | 根 lock 未发现 openid-client、express-session、connect-pg-simple、passport；runtime lock 存在传递依赖 jose `6.2.12`，不应跨 runtime 安装目录隐式引用。 |
| 当前入口 | `apps/api/src/app.ts:99` 起对 Host、Origin、Sec-Fetch-Site、JSON 做全局检查，没有 principal。`index.ts` 默认监听 `127.0.0.1`；Host 检查不是用户身份，也不能独立证明远端 socket 来自本机。 |
| API 覆盖 | `app.ts:118` 起在同一 `/api` 下挂多个 router，包括插件、模型、知识、运行、备份、存储、设备、费用；不能只保护几个新路由。 |
| 数据 | `db.ts` / `product-schema.ts` 无真人用户或成员表。现有 `organizations` 路由表示组建组织/团队业务，不应误当 SaaS tenant。 |
| 审批 | `product-schema.ts:63` 的 tool_approvals 只有 status/decided_at；`run-management.ts:28` 更新后写 JSONL，未记录批准的真人。 |
| 现有细粒度执行授权 | `execution-policy.ts`、员工工具/知识范围、预算、固定版本和本机逐次批准已存在，应作为独立约束继续保留。真人有权限不能放宽 agent 工具范围。 |
| 幂等 | `idempotency.ts` 以全局 request_keys.key 缓存，未绑定 principal；多人使用相同 key 可命中彼此结果，必须在企业入口启用前迁移。 |
| 本机执行器 | `local-execution.ts` 的 poll/start/result/disable 已校验 `X-Local-Device-Key`；register/list/delete 是管理动作。不能把整个 `/local-devices` 前缀排除真人认证。 |

## 3. 复用调查与来源

| 方案 | 核实版本 / 来源 | 适用性和决定 |
| --- | --- | --- |
| DSH authorization | 本地安装 `0.1.5-rc.1` 的 README 与 lib 类型；[官方目录](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/authorization) | 注册获取插件凭据的交互流程，成功表示凭据已保存；不是工作台账号系统。保留用于插件授权，不能替代真人登录。 |
| DSH anonymous-user-id | 本地安装 `0.1.5-rc.1` README；[官方目录](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/identity/anonymous-user-id) | 每个 DSH_HOME 的安装 UUID，不能识别多个人。 |
| DSH client-connection | 本地安装 `0.1.5-rc.1` README | launch token 换安装级浏览器 cookie；没有用户目录和部门角色；默认 loopback HTTP，不提供企业退出/单用户撤销语义。不能用作企业 principal。 |
| DSH user-approval | 本地安装 `0.1.5-rc.1` 的 `lib/types/types.d.ts`；[官方接口](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/interaction/user-approval) | 已有 allowed-once/rejected/cancelled/unavailable 和 asked/decided 配对；事件仅 id/outcome，没有真人 actor。继续复用运行审批机制，在产品边界记录真人和权限。 |
| DSH 市场 | [DSH Plugin Registry](https://dshplugin.app/plugins)、[社区目录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)、[官方 Show Your Plugins](https://github.com/deepseek-ai/deepseek-harness/discussions/3360) | 本轮找到登录门插件，未找到经核实可直接提供当前自有 Express Host 的 OIDC、部门行级授权和真人审计的完整插件。目录收录不等于安装验收。 |
| TecFancy/dsh-auth-gate | [维护者仓库](https://github.com/TecFancy/dsh-auth-gate)、[manifest](https://raw.githubusercontent.com/TecFancy/dsh-auth-gate/main/package.json)：`0.17.4` / MIT；声明 DSH `^0.1.0-rc.6 \|\| ^0.1.5-rc.2 \|\| ^0.1.7-alpha.1 \|\| >=0.2.0-rc.1` | 针对原生 DSH Web 的密码/共享 token/TOTP 登录门；不是本项目自有 API 的 OIDC RBAC。固定 rc.1 不在其对应 prerelease 兼容区间内。不能因名称接近直接安装或为此升级 DSH。 |
| 同名另一个 dsh-auth-gate | [zephaniahwang94-cmyk 仓库](https://github.com/zephaniahwang94-cmyk/dsh-auth-gate) | 维护者明确说明认证用户仍共享 Agent、workspace authority 与 audit identity。不满足多人隔离；同名插件需按来源区分。 |
| openid-client | [v6.8.8 release](https://github.com/panva/openid-client/releases/tag/v6.8.8)、[固定 manifest](https://raw.githubusercontent.com/panva/openid-client/v6.8.8/package.json)、[固定 OIDC example](https://raw.githubusercontent.com/panva/openid-client/v6.8.8/examples/oidc.ts)，MIT | **选用**。v6 ESM、Node 20 基线兼容项目；固定候选 `6.8.8`，锁全部传递依赖。复用 `discovery` / `buildAuthorizationUrl` / `authorizationCodeGrant` / `tokens.claims()`。 |
| express-session | [官方说明](https://expressjs.com/en/resources/middleware/session.html)、[维护者 manifest](https://raw.githubusercontent.com/expressjs/session/master/package.json) 检索为 `1.19.0`，MIT | **选用组件，实施时核实发布版本并精确固定**。使用 regenerate/destroy、服务端存储，不能使用默认 MemoryStore。官方文档与 master 是滚动材料，不应视为 npm 已安装证据。 |
| connect-pg-simple | [维护者仓库](https://github.com/voxpelli/node-connect-pg-simple)、[manifest](https://raw.githubusercontent.com/voxpelli/node-connect-pg-simple/master/package.json)：`10.0.0` / MIT | **选用候选**，Node/pg 范围兼容现有版本，复用 pool；先对隔离 PGlite 和真实 PostgreSQL 做会话 store 行为验证。 |
| jose | [维护者仓库](https://github.com/panva/jose)，runtime 已锁 `6.2.12` | 保留为库的底层依赖，不自行组合 JWT 验签代码来替代 OIDC 协议。 |
| Keycloak | [通用 OIDC 接入](https://www.keycloak.org/securing-apps/oidc-layers)、[Node adapter](https://www.keycloak.org/securing-apps/nodejs-adapter)、[IdP 管理员恢复](https://www.keycloak.org/server/bootstrap-admin-recovery) | 可用作真实 IdP 验收对象。客户端选通用 OIDC 而非耦合 keycloak-connect；没有证据表明 JJ 已安装或配置 Keycloak，本轮不指定未验证的服务端部署版本。 |

npm registry latest 页面在本轮 web 工具中不可访问；随后只读 `npm view` 对四个候选包也均返回 `ENOTFOUND registry.npmjs.org`，没有拿到 npm integrity。候选版本依据上列维护者 tag/manifest。实施时应读发布元数据、固定 lock、检查许可证与实际安装版本，不用浮动 latest。本地 DSH 结论以已安装 `0.1.5-rc.1` 内容为准，上游 master 链接仅为追溯入口。

## 4. 完整认证与会话流程

### 配置与启动

建议配置名：`WEIWU_AUTH_MODE=legacy-local|oidc`、`WEIWU_PUBLIC_ORIGIN`、`WEIWU_OIDC_ISSUER`、`WEIWU_OIDC_CLIENT_ID`、`WEIWU_OIDC_CLIENT_SECRET`（或明确选择的 private_key_jwt）、`WEIWU_SESSION_SECRETS`、`WEIWU_BOOTSTRAP_ISSUER`、`WEIWU_BOOTSTRAP_SUBJECT`。本次先做 client_secret_basic，其他客户端认证方式不预留未使用抽象。

企业模式要求固定 HTTPS public origin、固定 issuer、精确注册 `${publicOrigin}/auth/callback`、强随机持久 session secret。不从请求 Host / X-Forwarded-Host 构造 redirect_uri。代理信任只限部署者配置的明确网络边界，不能 `trust proxy=true`。OIDC discovery 使用配置 issuer；不接受请求参数或用户资料决定 discovery 地址。配置不全在启动检查失败，IdP 不可达标记 not-ready，受保护 API 拒绝，不允许假登录。

### 登录

1. `GET /auth/session` 返回模式、当前真人（或 null）、CSRF token 和是否可登录。匿名预登录会话只保存 CSRF 和短期认证 transaction，不拥有业务权限。
2. 登录按钮 `POST /auth/login`，同源 JSON 与 CSRF 均通过后，由库生成独立 PKCE verifier/challenge、state、nonce，使用 code flow、`openid profile email`、S256。returnTo 仅允许经过校验的相对站内路径，拒绝 `//`、外部 origin 和控制字符。
3. 保存短期、单次 transaction：绑定发起浏览器的 session、issuer/client/redirect URI、state、nonce、PKCE verifier、issued/expiry、returnTo。建议 TTL 5 分钟、有界事务数；不可只在进程内 Map 保存。保存成功后返回 authorization URL，由前端导航。
4. `GET /auth/callback` 是唯一跨站顶层导航例外，使用 query response mode。它仍要匹配 configured host/public origin，并验证浏览器 transaction cookie/state；不为 `/auth/*` 整个前缀放开跨站。现有全局 cross-site 拒绝必须在此处重构，否则正常 IdP 回调会失败。
5. 在数据库原子消费 transaction，防并发回放，然后 `authorizationCodeGrant` 带 expectedState、expectedNonce、pkceCodeVerifier、idTokenExpected=true。库验证签名、issuer、audience、有效期等；应用要求非空 sub，并用 `(issuer, subject)` 唯一身份。不以 email、displayName 或请求 body 绑定管理员。
6. 事务失败/过期、state/nonce/PKCE 不符、issuer/audience/签名错误均拒绝；失败 transaction 不能复用。没有匹配预登录会话不得继续。用户资料仅更新展示字段；userinfo 如使用，必须绑定同一 sub。
7. 新用户登录成功也只得到 `pending` 账号，不自动加入部门。部署 bootstrap 的精确 issuer+subject 可原子激活首管理员；其他用户等待管理员批准。邮件地址不是授权凭据，不自动按同邮箱合并账号。
8. 登录后 regenerate 应用 SID，写入 userId、认证时间、会话建立时间及 session epoch；重新生成 CSRF。身份 token 不传浏览器、不进入模型上下文/日志，不请求 offline_access；没有第三方 API 用途时丢弃 access/refresh token。若支持 RP logout 所需 ID token hint，应密封存储且限制生命周期。

企业 cookie 使用 `__Host-weiwu.sid`、Secure、HttpOnly、SameSite=Lax、Path=/、无 Domain。Lax 允许 IdP 顶层 GET 回调，业务写操作仍要求 CSRF；Strict 会破坏跨站回调会话绑定。库提供的随机 SID 和签名机制直接复用。服务端持久 store 处理过期与清理；建议空闲 30 分钟、绝对 8 小时，两者都由服务端检查而非只看浏览器 cookie。

### 会话撤销、CSRF 与退出

- 所有 POST/PUT/PATCH/DELETE 的人类入口验证 `X-CSRF-Token` 与该 session 的随机同步 token，配合精确 Origin 和 Fetch Metadata。token 不放 URL。CSRF 采用既有会话及 Node 安全随机/常量时间比较的同步 token 模式，不新增认证协议；[OWASP 的实现原则](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)是依据。
- 每次请求重读 user status / session epoch 和当前成员资格，不能长期信任 session 内旧 role。停用用户、改角色、撤销会话后下一请求失效；重要写操作在同一 DB transaction 再查当前权限，避免鉴权后角色被撤销仍写入。
- `POST /auth/logout` 要 CSRF，先销毁本地 session 并清 cookie，立即完成应用退出；若配置了 IdP logout，再由库构造固定 post_logout_redirect_uri，带一次性 logout state。IdP 注销失败不恢复本地会话。未做 IdP 全局注销就明确展示“已退出为伍”，不承诺退出整个组织 SSO。
- IdP 暂时不可用时，不允许新登录；已认证会话是否继续至既定 TTL 是明确策略（建议继续，但业务权限仍从 DB 验证）。不能声称 IdP 端停用会立刻同步，除非已配置并验证 back-channel logout 或其他撤销机制。应用内停用即时生效。
- 高风险操作（恢复备份、授权提升、插件安装、放开本机命令）要求近期登录，初始建议 15 分钟；通过 OIDC `max_age` 与经验证 auth_time 重新认证。MFA 由 IdP 策略负责，只在实际验证 acr/amr 映射后声称满足 MFA。

## 5. 管理员 bootstrap、用户与部门模型

应用管理员与 IdP 管理员是两个系统。首管理员必须由部署者预先给定精确 `issuer + sub`，且首次成功 OIDC 登录后，以数据库锁在“尚无企业管理员”的条件下授予角色并写审计。不得使用“第一个访问者即管理员”、用户名 admin、邮箱域或 HTTP body 指定 owner。

bootstrap 完成后记录 consumed 状态；配置残留不得在管理员被移除后自动重新生效。最后一名 active org_admin 的停用/降权要拒绝。失去全部管理员时只提供需本机 OS/数据库管理权限的显式恢复命令，要求精确 identity、操作原因，并写恢复审计；不提供匿名恢复 HTTP 路由，不存后门密码。

建议表：

| 表 / 字段 | 最小语义 |
| --- | --- |
| `human_users` | id text PK；issuer+subject UNIQUE；display_name；email（展示）；status pending/active/disabled；org_role member/admin/auditor；session_epoch bigint；version；created_at/updated_at。不存密码。 |
| `department_memberships` | (department_id,user_id) PK/FK；role viewer/operator/manager；can_approve boolean 默认 false；version；granted_by；created_at/updated_at。人的成员资格与 AI employee 保持不同实体。 |
| `human_sessions` | 复用 connect-pg-simple 官方 sid/sess/expire schema，sess 仅存有限身份引用和时间；user/epoch 撤销检查来自 human_users。不要备份活动 session。 |
| `oidc_login_transactions` | id；session_binding_hash；state_hash UNIQUE；nonce；verifier（短期服务端秘密）；issuer/client_id/redirect_uri；return_to；expires_at；consumed_at。仅用于登录协议，定期清理且不备份。 |
| `identity_bootstrap` | singleton id；expected issuer/subject 的非秘密配置指纹；consumed_by；consumed_at；version。企业激活状态与一般产品设置分开。 |
| `human_audit_events` | id；occurred_at；actor_kind；actor_user_id 可空；actor_snapshot；action；resource_type/id；department_id；request_id；outcome；reason；受限变更摘要。只追加；不写密码/token/cookie/全文工具秘密参数。 |
| `audit_outbox` | audit event id UNIQUE；run_id；event_type；redacted payload；published_at。用于把已提交 DB 审计可靠投影进现有运行 JSONL，失败可重试。 |

所有新表使用显式 schema migration。旧记录没有真人证据，actor 必须保留 `legacy-unknown`，禁止补成首管理员。原审批 actor 字段可空以兼容历史；新企业真人决策强制填入。备份格式需升级：用户/成员/历史审计可纳入受控备份，但 session、OIDC transaction、临时 token/密钥不纳入。导入前后要撤销活动会话、检验身份 issuer 与迁移版本，不能把旧备份恢复成可绕过企业模式的状态。

角色建议：org_admin 管全组织管理与授权；org_auditor 只看脱敏审计/费用，不默认读全部机密交付正文。viewer 可读所属部门已授予资源；operator 可建/编辑/运行部门项目，但不改组织凭据、插件安装、备份或成员；manager 可改部门配置并管理本部门普通成员，不能赋 org_admin。`can_approve` 单独授权，避免“可以执行”隐含“可以批准任意工具”。修改自身 can_approve 或提升到同级/更高角色交由 org_admin。所有角色仍受项目预算与员工工具范围约束。

跨部门项目需要操作者对全部参与部门有相应权限；只凭主 department_id 放行会泄露其余部门员工/知识。对象所属部门由 DB 外键/持久快照解析，不能相信请求中的 departmentId。列表在 SQL 层筛选，详情、搜索、导出、下载、统计与恢复均做相同授权。没有归属或旧 trace-only 记录先仅 org_admin 可见，不能推测部门。

## 6. 全路由 fail-closed 策略

鉴权必须在所有业务 router 和 idempotency 前。顺序建议：固定网络边界 → parser 的有限例外 → session → 精确 auth/probe/machine 路由 → principal → route policy → CSRF（human 写入）→ resource scope → principal namespace idempotency → handler → 审计。

以显式 method+path route catalog 声明 `public | human | device`，不以 `/api/*` 下“未命中就 next”默认允许。未知 /api 路由返回 404/403 并且 handler 不执行；缺 principal 返回 401；身份合法但权限不足返回 403（对象存在性敏感可统一 404）。新加 route 没 policy 时测试失败，运行时也拒绝。策略表不能用一个宽 `GET /api/* = authenticated` 来省略读隔离。路由注册辅助函数或集中 catalog 二选一即可，不建立通用政策引擎。

第一模块未完成细粒度迁移的现有路由仅限 active org_admin，必须逐个 method+path 登记，不能把未知路由自动升级为管理员可用。后续把明确审查的部门路由降到成员权限。`/api/health` 现返回 runtime/workspace 信息，企业模式仅管理员可读；另设最小公开 `/healthz`，仅进程存活状态，且可被部署层限制。

机器路由最小白名单：

| method + path | 要求 |
| --- | --- |
| `POST /api/local-devices/:id/poll` | device principal；既有 X-Local-Device-Key 哈希校验；只能自己的 id。 |
| `POST /api/local-devices/:id/operations/:operation/start` | 同上，且 operation.device_id 与 claimToken 一致。 |
| `POST /api/local-devices/:id/operations/:operation/result` | 同上，保留现有迟到回执、操作状态检查。 |
| `POST /api/local-devices/:id/disable` | device 可禁用自己，不能带此 token 调其他路由。 |
| `GET /api/local-devices`、`POST /api/local-devices/register`、`DELETE /api/local-devices/:id` | human org_admin + 写操作 CSRF/近期登录；不能归入 machine bypass。 |

机器请求没有 cookie CSRF 语义，但必须验证既有设备凭证及操作范围；设备 token 不得解析为 human，也不能审批、改预算、读全局知识或拿管理列表。现有本机 launcher 需在 enterprise mode 下采用管理员预登记/显式 enrollment 流程，不再匿名自注册；此兼容性必须实际验收。

管理能力需 org_admin（或日后明确更窄权限）：模型/中转站配置与有费用的测试、插件安装/卸载/凭据/授权、MCP/浏览器连接、产品全局设置、备份导入导出、存储清理、设备登记、组织级预算和授权。用户/部门成员/audit API 同样纳入 central gate。

其余必须审查的路由族：部门与 employee-history/workbench、projects/organizations/manager-chat、runs 与 recovery/export/artifact/citations、approvals、knowledge 搜索/版本/知识空间、work-files 及附件、automation/schedules、cost/usage/activity、native-capabilities、浏览器工具、OpenRig。路径全清单应由源码/注册路由收集，再与 catalog 一一比对；不得用只列 top-level router 的测试代替完整路由覆盖。

幂等键建议新增 `principal_key text NOT NULL`，唯一约束改为 `(principal_key,key)`，并保留 method+originalUrl+body fingerprint。principal_key 固定为 `human:<userId>`、`device:<deviceId>` 或 `local-owner`；未认证请求不能建立 key。历史 key 迁移到 `legacy-local` namespace，不能被企业用户命中。授权与 CSRF 必须在缓存命中前重验，避免撤权后仍读取旧响应。组织变化/资源权限变化后缓存也不能绕过资源 scope 检查。明确 namespace 不包含可伪造姓名/email，通常不绑 SID（用户重新登录仍可恢复自己请求结果）。

## 7. 真人审批与审计的事务边界

`POST /api/approvals/:id` 输入仅接受 `{decision, reason?}`，真人 actor 来自服务端 principal，拒绝/忽略 body 中 userId、decidedBy、role 等身份字段。查 approval → run → project → participating departments，检查当前 can_approve/org_admin、运行仍可审批、项目/工具批准快照和版本仍有效。保持现有仅 pending 可决策及 running/not-cancelled 条件。

在同一 DB transaction 内锁 approval 与权限关联行，写 `decided_by_user_id`、`decided_actor_kind`、`decided_actor_snapshot`、`decision_request_id`、`decision_reason`、decided_at 和 human_audit_events；成功提交之前不能让执行器见到 approved。审计写入失败必须回滚批准。并发同意/拒绝只能一个成功，其他 409。系统停止造成 cancelled 的 actor=system，不能伪装真人拒绝。

现有 JSONL append 不和 PostgreSQL 共享事务；使用同事务 outbox，把 auditEventId 与真人摘要投影到 `approval/decided`。写文件失败不会丢失 DB 审计，也不会通过重试再次批准；消费者按 event id 去重。不要声称 DB+文件天然原子。

同一 actor 约定应覆盖方案确认、启动/取消/恢复、预算增加、凭据更改、插件授权、备份恢复、存储清理、成员修改。现有 activity 的中文描述不能代替结构化审计。agent 运行记录分别保存 `requestedBy`（真人发起者）和 `executedBy`（agent/system）；后台调度有明确 system actor 与原授权来源，不能继承一个不存在的浏览器会话。

初期审计为应用只追加、无删除 API；数据库管理员仍有改表能力，因此不能声称防篡改合规账本。若后续要对数据库管理员防篡改，需要外部只追加存储/签名锚点的独立需求与验证。

## 8. 旧本机模式迁移

1. 新版本默认保持既有工作空间 `legacy-local`，清晰展示“本机单人模式”；以 local-owner actor 记录今后本机操作，旧历史保持 unknown。限制 loopback socket 与合法 Host，拒绝外部监听或未获支持代理的 legacy 启动，不因允许 HTTPS origin 自动开放多人。
2. 企业模式先在隔离 DB/数据目录配置并测试。创建 schema 采用 additive migration，不把 departments/projects/运行档案搬到新架构。
3. 配置固定 IdP、TLS/public origin、bootstrap issuer+sub，验证真实登录、退出、第二人无权、管理员授权后访问、撤权后失败。旧部门默认无人可见，由已 bootstrap 的管理员分配成员；不能默认全员拥有所有历史数据。
4. 切换时处理正在执行/等待审批的任务，持久写企业模式激活标记、废弃旧幂等 namespace，撤销旧 sessions。企业激活后删除 OIDC 配置必须导致启动失败，不能隐式回到 local-owner。
5. 显式恢复 legacy 只能在本机维护窗口停止企业入口后操作，并留下迁移审计。rollback 不回写虚构真人，不删除旧批准/预算/运行证据。

## 9. 首个可独立交付模块（建议给实现者）

**任务：企业身份边界与真人上下文 v1。** 先只把 enterprise 的现有业务 API 收紧为管理员；成员细粒度和审批审计在随后独立任务迁移。这能形成可运行、不会因未迁移 route 暴露数据的中间状态。

文件建议：`apps/api/src/identity-schema.ts`、`identity.ts`、`identity-oidc.ts`、`api-access.ts`、`api-route-policies.ts`，修改 `db.ts` / `app.ts` / `index.ts` / `request-origin.ts` / `idempotency.ts` 与根依赖 lock；测试放现有 tests 体系。无需第一步改 DSH 包、换 Express 或加政策服务。

建议 TypeScript 接口：

```ts
type HumanPrincipal = { kind:'human'; userId:string; sessionId:string;
  issuer:string; subject:string; orgRole:'member'|'admin'|'auditor';
  sessionEpoch:number; authenticatedAt:string };
type Principal = HumanPrincipal | {kind:'local-owner'} |
  {kind:'device'; deviceId:string} | {kind:'system'; service:string};
type ApiRoutePolicy = { method:string; path:string;
  access:'public'|'human'|'device'; permission?:Permission;
  scope?:'organization'|'department'|'project'|'run'|'approval'|'knowledge'|'file' };
type Permission = 'organization.admin'|'identity.manage'|'audit.read'|
  'department.read'|'department.manage'|'project.write'|'run.execute'|'approval.decide';
function migrateIdentity(db:QueryExecutor):Promise<void>;
function loadIdentityConfig(env:NodeJS.ProcessEnv):IdentityConfig;
function identityRouter(deps:IdentityDependencies):express.Router;
function authenticateRequest(deps:IdentityDependencies):express.RequestHandler;
function enforceApiPolicy(catalog:readonly ApiRoutePolicy[]):express.RequestHandler;
function principalKey(principal:Principal):string;
function requireHuman(req:express.Request):HumanPrincipal;
function requirePermission(db:QueryExecutor, principal:Principal,
  permission:Permission, resource:ResourceRef):Promise<void>;
function appendHumanAudit(db:QueryExecutor, event:AuditEventInput):Promise<string>;
```

system principal 仅由内部调用构造，不接受 HTTP header 或 body 生成；测试注入不能成为生产 `X-User-ID` 后门。Express principal 类型通过声明合并，不能给路由一个默认 admin。

首批外部 API：

| 接口 | 输入 / 返回 / 权限 |
| --- | --- |
| `GET /healthz` | 最小 liveness，无 runtime 路径/凭据/配置。 |
| `GET /auth/session` | `{mode, authenticated, user?, csrfToken, loginAvailable}`；no-store；不公开完整 issuer/client secret/config。 |
| `POST /auth/login` | `{returnTo?}`；CSRF；返回 `{authorizationUrl}`；仅 OIDC 模式。 |
| `GET /auth/callback` | code/state 或 IdP error；单次 transaction；成功固定站内跳转。 |
| `POST /auth/logout` | CSRF；本地撤销后 `{ok:true, logoutUrl?}`。 |
| `GET /api/identity/users` | org_admin，分页 pending/active/disabled 目录。 |
| `PATCH /api/identity/users/:id` | org_admin + CSRF + version，激活/停用/orgRole；禁止失去最后管理员。 |
| `GET /api/identity/departments/:id/members` | org_admin（后续允许本部门 manager）。 |
| `PUT /api/identity/departments/:id/members/:userId` | org_admin + CSRF，role/canApprove/version；审计。 |
| `DELETE /api/identity/departments/:id/members/:userId` | org_admin + CSRF + version；审计。 |
| `POST /api/identity/users/:id/revoke-sessions` | org_admin + CSRF，增加 session_epoch；审计。 |

若首任务只完成登录和 gate，可把 identity 管理 API 放第二个提交，但首用户必须通过精确 bootstrap 激活，且任何普通用户 API 仍拒绝；不能通过所有登录用户默认 admin 来填空。

第一任务必须有的测试：

- 新/重复迁移、旧数据与 legacy namespace 保留；同一 issuer/sub 唯一、同邮箱不同 sub 不合并、bootstrap 并发只能一次。
- 缺配置、弱 session secret、HTTP public origin、未知模式启动失败；legacy 外部监听拒绝；enterprise missing config 不降级。
- 使用测试专用本地 OIDC fixture（discovery + JWKS + authorize + token），真实跑库的授权码流程、签名验证和 state/nonce/PKCE；错误 issuer/aud/nonce/state/签名/过期 token、code 与 transaction 重放必须失败。fixture 密钥仅测试目录，测试注入不能开生产禁验签开关。
- 回调 cross-site 顶层 GET 可进入协议验证；cross-site 业务写、缺/错 CSRF、伪造 Host/forwarded headers、外部 returnTo、重复 callback 全拒绝。
- SID 登录旋转、session持久化/过期、退出撤销、disabled/epoch改变立即失效；store 故障不得变成匿名 owner。
- 遍历全部已注册 route：匿名不能读业务；member 不能调用任何尚未迁移的管理 route；未登记 route 默认拒绝；HEAD/OPTIONS/大小写/尾斜杠/编码路径行为明确且不能绕过。
- 四个精确 machine route 可用合法设备 key；错误 id/key/claim 拒绝；设备 key 调 register、列表、审批、备份、模型管理全部拒绝。
- 同幂等 key 两个真人互不命中；同人重试保留；撤权后不返回缓存；匿名无缓存行；现有设备 durable operation id 行为保留。
- 全部使用隔离 DB 与临时目录，无模型计费、无生产 API；PGlite fixture 检查后仍需真实 PostgreSQL + HTTPS 代理 cookie 的部署验收。

后续独立任务顺序：部门/资源授权及完整路由目录 → 真人审批与审计/outbox → 前端登录/用户成员管理与权限空态 → 备份/恢复/本机 launcher 兼容与真实 IdP 双人验收。每批记录已验证/未验证/受阻，不能在首模块完成时宣称整个企业权限完成。

### 首包版本与测试 IdP 补充

2026-10-20 再核对维护者 release 后，首包可使用以下精确版本：`openid-client 6.8.8`、`express-session 1.19.0`、`connect-pg-simple 10.0.0`。session 已有 [v1.19.0 发布页](https://github.com/expressjs/session/releases/tag/v1.19.0)，PG store 已有 [v10.0.0 发布页](https://github.com/voxpelli/node-connect-pg-simple/releases/tag/v10.0.0)，不再只依据滚动 master 判断。这里只确定版本选择，安装产物/integrity 和兼容性须由实现者实际确认；不使用 cookie.sameSite=auto 等动态默认值替代本设计的明确值。

测试 IdP 可精确固定 devDependency `oidc-provider 9.12.2`（[release](https://github.com/panva/node-oidc-provider/releases/tag/v9.12.2)、[固定 manifest](https://raw.githubusercontent.com/panva/node-oidc-provider/v9.12.2/package.json)，MIT，额外传递依赖主要为 koa/debug/jose）。推荐其作为正常完整协议测试的 provider：每个测试分配临时回环端口、独立 signing key、内存测试账户与 test-only 自动登录/同意交互，注册唯一测试 client 和精确 redirect URI。由它实际验证 code、PKCE 和 client authentication；测试经浏览器 cookie jar 经过 app login → provider authorize → app callback → provider token，再访问 session。它只存在测试入口，不接到生产 createApp，不作为用户的真实 IdP 部署。

错误 issuer/aud/signature/nonce 等异常用受控响应 fixture 或 provider 测试钩子产生，仍由真实 openid-client 检测。禁止 mock `authorizationCodeGrant()` 直接返回“已登录用户”作为端到端证据。最小 HTTP fixture 可以用 Node http/crypto 创建签名测试响应，避免引入测试 provider 的依赖；这种替代需逐项验证 PKCE/code/client/state、不能把同一实现两侧互相验证当外部互通证明。协议测试用 loopback HTTP 时，只在测试注入的 Configuration 中允许 insecure request，生产配置始终 HTTPS，不加可被环境变量误启用的 production insecure 开关。

父计划把 A1 限为身份库、auth/session router、CSRF 和 principal 幂等隔离，把全路由授权/前端放 A2，这是可行的拆分。但 A1 结束时若 route catalog 尚未逐条完成，企业业务入口必须保持拒绝/未开放；不得让成功登录绕过现有业务权限。只有实际完成 catalog 管理员兜底清单才可启用管理员内部试用。A1 的完成声明应为“认证底座隔离测试通过，企业业务入口等待 A2”。

## 10. 验收状态与外部依赖

- **已验证**：上述当前代码入口、schema、审批和幂等缺口；固定 DSH 安装包职责；维护者 OIDC/session 候选 API、版本与许可材料。
- **尚未验证**：依赖实际安装与安全审计、候选 store 在项目测试环境兼容性、全量路由迁移、浏览器 HTTPS cookie、真实 IdP 完整登录/注销/停用、企业管理员分配、第二个真人隔离、真实 PostgreSQL 恢复。
- **部署输入待具备**：真实 issuer、client 注册与 secret、HTTPS 域名/证书与代理边界、首管理员 issuer/sub、组织部门成员安排。缺这些只可报告“协议 fixture 和应用权限测试通过、企业部署待配置”，不能生成假 IdP 配置或假管理员来报完成。

权限设计参考 [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) 的默认拒绝与每请求校验；具体角色、单组织表结构、管理员 bootstrap、首批路由策略和迁移步骤是基于本项目代码的设计判断，未宣称由第三方库自动提供。
