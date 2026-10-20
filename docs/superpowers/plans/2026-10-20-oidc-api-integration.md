# OIDC and API Boundary Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Identity kernel Task 1 must pass its independent fix review before dispatch.

**Goal:** 通过真实 OIDC 协议登录并将真人身份接到现有 API，保持本机兼容模式，企业模式不向未获授权用户暴露旧管理 API。

**Architecture:** 使用已选 openid-client、express-session、connect-pg-simple；沿用 identity kernel 的不可反向降级状态。登录/回调/退出与业务鉴权拆开；先将现有业务接口逐条登记为管理员可用，再按下一阶段的部门权限矩阵开放普通成员。完整真人操作审计与角色网页仍由后续任务交付。

**Tech Stack:** Node 22.19+/24、Express 5、PostgreSQL、openid-client 6.8.8、express-session 1.19.0、connect-pg-simple 10.0.0；测试使用 oidc-provider 9.12.2。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md` 与 `docs/research/enterprise-identity-2026-10-20.md`。

## Global Constraints

- 真实用户秘密、现有 DATABASE_URL 与生产不作为测试材料；新协议验证只用隔离 DB、临时签名密钥和本地测试 IdP。
- 沿用 kernel 的 exact issuer+subject、持久 bootstrap/closure、disabled/epoch 校验与不降级语义。
- 身份、路由权限及 CSRF 必须在幂等缓存之前；未知路由拒绝。
- 不信任 HTTP body/header 指定的 user/role/system 身份。机器设备凭据只能使用明确机器路由。
- 企业 public origin/issuer 必须 HTTPS；生产无 skip-signature、insecure、test-user 或默认管理员开关。
- 真实模型、现有运行/预算和生产配置本任务不改变。只跑定向测试，不启动不适用的根全量 npm test。

## Review Focus

- 并发 callback/code/state 重放最多一次消费；失败后不能再次利用旧 transaction。
- cookie/session 在登录、退出、停用及重启时正确轮换/失效，不能仅验证 ID token。
- callback 导航例外不能扩展为 auth 前缀跨站写；代理 Host/Origin 不能决定 redirect URI。
- session store/IdP 不可用时拒绝新登录，不回退 local-owner；旧有效会话只按既定 TTL 存续。
- 路由新增加、大小写/尾斜杠/编码/HEAD/OPTIONS 差异不能绕过权限清单；设备凭据不能使用人的管理接口。

### Task 1: OIDC protocol service and persistent HTTP session

**Files:** create `apps/api/src/identity-oidc.ts`, `identity-http.ts`, `tests/identity-oidc.test.ts`, test-only fixture under `tests/fixtures/identity/`; modify root `package.json`/`package-lock.json` for exact libraries and type dependencies. Do not modify `app.ts` in this task.

**Interfaces:** `createIdentityHttp({pool,config,...trustedTestDependencies})` builds a router/session middleware plus `ready`, `close`, `authenticate`, `csrf` functions. `config` is actual `IdentityConfig`; HTTP never provides these options. Kernel functions `activateIdentityMode`, `upsertOidcIdentity`, `loadHumanPrincipal`, `principalKey` are the authoritative domain operations. Concrete dependency injection must permit transport/clock testing without replacing protocol validation or enabling production bypass flags.

- [ ] Inspect installed kernel interfaces; verify pinned packages official metadata and install exact versions with lock and lifecycle scripts disabled. No import from transitive runtime node_modules.
- [ ] Implement `/auth/session` GET, `/auth/login` POST, exact `/auth/callback` GET, `/auth/logout` POST. Session info returns mode/authenticated/safe user fields/CSRF/loginAvailable only. `__Host-weiwu.sid`, Secure/HttpOnly/Lax/path `/`, no Domain; production store is PostgreSQL, never MemoryStore.
- [ ] Generate library PKCE S256, state, nonce; transaction TTL 5 minutes and maximum 3 live transactions per initiating session. Persist initiating SID binding hash, configured issuer/client/redirect, verifier/nonce/state hash, validated relative returnTo. Absolute/protocol-relative/backslash/control character return targets reject.
- [ ] Atomically consume matching unexpired transaction before exchange. Use library code grant with expectedState, expectedNonce, pkceCodeVerifier and idTokenExpected. Require verified sub. Persist no access/refresh token in browser/model/audit. Regenerate SID and CSRF after success; use kernel to resolve pending/active identity.
- [ ] `authenticate` rechecks stored identity/epoch/idle/absolute bounds and updates lastSeenAt only for valid sessions. `csrf` compares bounded synchronizer token using constant-time comparison. Logout destroys server session and clears cookie. Cleanup expired login rows and session store through bounded lifecycle, drained by `close`.
- [ ] Test complete authorize/discovery/JWKS/token exchange through real openid-client and test-only oidc-provider. Fixture may auto-accept its synthetic identities, but must not stub signature/state/nonce/PKCE verification. Verify wrong issuer/audience/key, nonce/state mismatch, expired and replayed transactions, pending/disabled identity, SID rotation, logout and store recreation.
- [ ] Use trusted local TLS certificate/CA transport in tests; do not set global TLS verification off. Document exactly what is protocol-tested versus HTTPS proxy/browser deployment-tested.
- [ ] Run targeted protocol/store tests and TypeScript check, then independent review. No whole-repository npm test.

### Task 2: Whole API boundary, scoped idempotency and launch compatibility

**Files:** create `apps/api/src/api-route-policies.ts`, `api-access.ts`, tests `tests/api-access.test.ts` and route inventory coverage helper; modify `app.ts`, `db.ts`, `index.ts`, `request-origin.ts`, `idempotency.ts`, relevant launcher lifecycle hook only after inspection.

- [ ] Enumerate actual registered route method/path pairs using TypeScript AST or Express registration inspection. Store explicit catalog; fail test and enterprise startup if an unclassified route exists. All current business routes initially administrator-only; `/healthz` contains only liveness, existing `/api/health` remains protected.
- [ ] Integrate identity migration and lifecycle without changing synchronous `createApp` consumers blindly. Expose readiness promise and await/guard it before serving authenticated traffic. Gate order: network/origin → bounded parser/session → exact auth/machine exemptions → principal/current route policy → CSRF → resource policy → principal idempotency → handler.
- [ ] Only exact machine poll/start/result/disable paths retain device-key authentication. New device registration/list/deletion remain administrator operations. Resolve current launcher re-registration compatibility explicitly; do not allow a device key to create/expand its own grant. Enterprise activation is not production-ready until machine startup tests pass.
- [ ] Public hostname is derived only from validated config; proxy trust only explicit loopback/known deployment proxy, never `true`. The sole cross-site navigation exception is exact GET callback. Preserve legacy same-origin loopback behavior.
- [ ] Migrate request_keys to composite `(principal_key,key)` preserving historical keys in `legacy-local`; cache lookup follows all current authorization checks. Auth/session payloads never enter idempotency cache. Test same key across humans and revoked sessions, plus existing device durable operation id behavior.
- [ ] Run full registered-route negative coverage, isolated product API regression and local launcher checks. Verify legacy cannot start on external listen or downgrade activated OIDC state. Errors disclose neither secrets nor internal session/DB data.
- [ ] Independent review, then add minimal login UI/CSRF transport in a separate scoped task before enterprise browser acceptance. Do not activate production OIDC during incomplete route/device coverage.

### Task 3: Browser login connection and deployment acceptance

- [ ] Expand after backend review: frontend login/SSO callback handoff, clear pending user and local-mode badge, CSRF propagation, safe session-expired handling without replaying mutations.
- [ ] Browser two-user negative and logout/restart cases; configured TLS proxy cookie and fixed-host checks; real PostgreSQL concurrent callback bootstrap/closure proof.
- [ ] Follow later A2 plan for department roles and actor audit; administrator-only intermediate mode is not full enterprise authorization completion.
