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

**Prerequisite:** Task 2 independent review and fixes pass. Do not activate OIDC on JJ until the configured IdP, HTTPS proxy, device startup, and browser tests below have evidence. A2 owns department roles and human audit; this task owns only session transport and login UI.

**Files:** create `apps/web/src/identity-session.ts`, `IdentityGate.tsx`, `tests/identity-session.test.ts`, `tests/identity-browser.test.ts` and a disposable HTTPS/IdP fixture under `tests/fixtures/identity/`. Modify `apps/web/src/main.tsx`, `api.ts`, `App.tsx`, `health-sync.ts`, `project-sync.ts`, `usage-sync.ts`, `RunExtras.tsx` and scoped styles. Modify `apps/api/src/identity-http.ts` and its protocol tests only for the browser login response contract. Add deployment instructions and a disposable PostgreSQL concurrency runner after checking the existing test-integration runner. No root dependency update or new auth framework.

**Observed current contracts:** `/auth/session` returns `mode`, `authenticated`, safe `user`, `csrf`, `loginAvailable`. `/auth/login` currently redirects with 303; a JS fetch carrying the required CSRF header cannot safely use a cross-origin IdP redirect as its response. Change this POST to no-store JSON `{authorizationUrl}` produced by the existing OIDC protocol, then navigate the browser. Keep the exact GET callback and its fixed validated return target. Do not move tokens into URL parameters or localStorage, accept a caller-supplied IdP URL, or weaken CSRF to make a form submit work.

- [ ] Implement a small session store with `refresh`, `subscribe`, `getSnapshot`, `login`, `logout` and a monotonic local generation. State distinguishes initial loading, local-owner, authenticated OIDC, pending/disabled user, signed-out, and unavailable service. Failure to fetch session must never select local mode. Deduplicate session GETs and stop polling when no subscriber/hidden; use focus recheck for revocation. No OAuth SDK in the browser; use the existing server session.
- [ ] Wrap `App` in `IdentityGate` before it mounts: no business refresh or background poll before authorization. Show a clear local single-user badge; OIDC shows current safe identity and logout. Pending/disabled users see a safe status and explicit refresh/logout, not business content. The intermediate member role remains denied until A2, with an accurate message rather than a broken empty dashboard. Preserve the current minimal visual style.
- [ ] Use same-origin credentials and the current synchronizer token for every unsafe HTTP method, including POST planning-quote (read-only billing semantics do not exempt it from CSRF). Keep current idempotency keys and uncertain-write behavior. A confirmed 401 invalidates the session and does not replay the original request. A 403 resource denial must not automatically sign the user out. A CSRF failure may prompt a session refresh but never resubmit a mutation. Logout and login actions also use the session token.
- [ ] On session invalidation or identity switch, unmount business UI, abort reads, clear global project/usage/health snapshots and previews, and advance a generation so a late old response cannot repopulate another user's screen. Update existing sync-store APIs with a tested reset/invalidation method; preserve their original polling/version semantics. Do not clear server history or blindly retry in-flight writes. Review sessionStorage/localStorage draft keys and scope any persisted business draft to the principal before exposing it after login.
- [ ] Route the separate artifact preview fetch in `RunExtras` through the same authenticated response handling; keep download links protected by the backend. Test an expired session during preview and direct download, including browser back/cache behavior. No secret/user token appears in an artifact URL or error body.
- [ ] Add deterministic transport tests: no business request before session readiness; session failure does not fall back; POST quote includes CSRF; old principal delayed GET is discarded; logout clears all three singleton stores; 401/403 and response-loss writes make no second mutation; pending/disabled screens and locally cached drafts cannot expose another user's data. Run `node --import tsx --test tests/identity-session.test.ts tests/api-response.test.ts tests/project-sync.test.ts tests/usage-sync.test.ts tests/health-sync.test.ts` after verifying actual filenames, plus `npm run build`.
- [ ] Serve an actual built web application through a disposable loopback HTTPS reverse proxy with a test CA and the existing real oidc-provider fixture. Use an available browser for actual login, callback, pending user, admin entry, logout, expired-session mutation, second-user isolation and service restart. Record cookie flags, route/status, screenshot, test identity (synthetic only), and exact tested commit. Do not globally disable TLS verification or change the user's production browser cookies. Browser mocks of session JSON are only UI unit evidence.
- [ ] Run real PostgreSQL tests with separate connections/processes for parallel callback consumption, session save racing logout, initial admin bootstrap, last-admin protection where implemented, and server restart. Reuse an isolated local/remote test database only after checking its identity; never point at the production DB. PGlite proves SQL/function behavior but is not evidence for independent PostgreSQL lock concurrency. If PostgreSQL or trusted-browser TLS is unavailable, record that gate as blocked and continue independent work; do not silently downgrade the acceptance claim.
- [ ] Document required OIDC/HTTPS configuration, exact callback URL, bootstrap identity, preapproved machine credential startup, rollback/stop-old-writer sequence, and safe failure states without putting secrets in tracked files. Validate legacy local launch still works. Independent security and UI review precedes any JJ enterprise activation. This task alone does not complete A2 member authorization or the overall enterprise goal.
