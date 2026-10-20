# Enterprise Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Check steps only against actual evidence.

**Goal:** 给为伍增加标准真人登录、可撤销会话、部门权限与可归责审批。

**Architecture:** 复用 openid-client 6.8.8、express-session 1.19.0、connect-pg-simple 10.0.0。应用只管理身份映射、部门成员和业务授权；协议校验由成熟库完成。先构造可测试身份内核，再接登录与全 API 门禁，最后逐资源开放成员和网页。

**Tech Stack:** TypeScript, PostgreSQL, Express 5, OIDC。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`; detailed research `docs/research/enterprise-identity-2026-10-20.md`。

## Global Constraints

- 不读取真实凭据、不调用模型、不变更生产；本机旧模式与已有历史保留。
- 身份按 issuer+subject 匹配，email 只展示；默认用户 pending/member。
- 首管理员只能匹配预配置 issuer+subject，bootstrap 只消费一次；禁止第一个登录者管理员。
- OIDC 已激活后删除配置不得降级到 local-owner。新用户和未知角色没有业务权限。
- 当前用户状态与 epoch 每次重新读取；审计不包含 token/凭据/会话内容。
- 每个模块独立验证；身份内核通过不等于企业登录或部门权限已上线。

## Review Focus

- 同邮箱不同 subject、issuer 尾斜杠差异不能误绑定管理员。
- bootstrap 并发与 consumed 状态必须原子；管理员消失不能重新 bootstrap。
- 配置错误/存储失败不得回退默认管理员。
- 停用、撤销、过期会话后不能取幂等缓存或走旧授权。
- 迁移、审计异常及重启必须保持旧数据并回滚未提交角色修改。

### Task 1: 持久身份内核

**Files:** create `apps/api/src/identity-types.ts`, `identity-config.ts`, `identity-schema.ts`, `identity-store.ts`; tests `tests/identity-config.test.ts`, `tests/identity-store.test.ts`.

**Interfaces:**
- `loadIdentityConfig(env:NodeJS.ProcessEnv):IdentityConfig` returns discriminated `legacy-local` or `oidc`; legacy default is compatibility only. Unknown mode rejects. Enterprise requires HTTPS origin (no path/query/userinfo), HTTPS issuer (path permitted, no query/userinfo/fragment), client ID/secret, session secrets JSON array of >=32-byte secrets, exact bootstrap issuer+subject pair; configured issuer must equal bootstrap issuer. Reject obvious placeholder/repeated weak secrets. No request-controlled redirect origin. Fields named `WEIWU_AUTH_MODE`, `WEIWU_PUBLIC_ORIGIN`, `WEIWU_OIDC_ISSUER`, `WEIWU_OIDC_CLIENT_ID`, `WEIWU_OIDC_CLIENT_SECRET`, `WEIWU_SESSION_SECRETS`, `WEIWU_BOOTSTRAP_ISSUER`, `WEIWU_BOOTSTRAP_SUBJECT`.
- `Principal`: human `{kind,userId,sessionId,issuer,subject,orgRole,sessionEpoch,authenticatedAt}`; local-owner; device `{deviceId}`; system `{service}`. `principalKey(principal)` rejects invalid objects and returns `human:<id>`, `device:<id>`, `system:<service>` or `legacy-local`; never uses display name/email/SID as cache namespace.
- `migrateIdentity(db)` additive/idempotent schema for human_users, department_memberships, human_sessions (pg store official schema), oidc_login_transactions, identity_bootstrap, human_audit_events and audit_outbox. No FK dependency from users to not-yet-existing tables; department_memberships uses existing departments table. CHECK role/status/version constraints. Secrets in transient login tables excluded from future backups.
- `activateIdentityMode(pool,config)` records irreversible activation marker when OIDC configured; rejects legacy when marker activated. No implicit offline downgrade option.
- `upsertOidcIdentity(pool,config,{issuer,subject,displayName?,email?})` transactionally binds exact identity, produces pending member unless matching unused bootstrap; bootstrap lock serializes concurrent grants; records consumed state and append-only audit. Caller must supply library-verified claims (document this trust boundary).
- `loadHumanPrincipal(db,{userId,sessionId,sessionEpoch,authenticatedAt,createdAt,lastSeenAt},now?)` validates active status/current epoch, 30-minute idle and 8-hour absolute lifetime; future/nonfinite dates reject; returns null for invalid/revoked. No role copied from supplied session.
- `appendHumanAudit(db,event)` accepts a constrained typed event and returns ID, only allowlisted actor/resource/change metadata, rejects unsupported sensitive fields rather than storing arbitrary request bodies.

- [ ] Write failing config, migration, identity and lifecycle tests. Include duplicate issuer/sub, same email/different sub, bootstrap once, disabled epoch, all lifetime boundaries, and audit failure rollback.
- [ ] Run config tests via `node --import tsx --test tests/identity-config.test.ts`; store tests via isolated `node scripts/test-integration.mjs tests/identity-store.test.ts` using fresh DB.
- [ ] Implement only named files, using pg transactions and row locks. Do not wire app/db migration or change packages yet: next task owns protocol integration. No production bypass/test secret in env handling.
- [ ] Verify config/store tests and `npx tsc --noEmit`; record PostgreSQL concurrency separately if PGlite cannot prove it.
- [ ] Independent review then commit scoped files. Report unused/unwired status plainly.

### Task 2: OIDC protocol and persistent sessions

**Files:** create `identity-oidc.ts`, `identity-http.ts`, protocol tests; modify root dependency lock, `db.ts`, `app.ts`, `request-origin.ts`, `index.ts` and `idempotency.ts`.

- [ ] Before implementing, expand this task into its own executable brief using Task 1 exported interfaces; confirm fixed published package versions.
- [ ] Use real library code with a local signing IdP fixture for code flow, JWKS signature, issuer/aud/nonce/state/PKCE, transaction replay, SID rotation and logout. Never mock successful OIDC validation.
- [ ] Exact `/auth/callback` GET cross-site navigation exception only; persistent one-use transactions bound to initiating session. Stable redirect URI from config.
- [ ] Add CSRF, explicit route catalog with unported business routes administrator-only, four machine proof routes only; registration requires administrator. All unknown route policies denied.
- [ ] Bind idempotency to principal before caching; legacy keys remain legacy. Sensitive auth bodies excluded from cache.
- [ ] Verify callback over HTTPS, safe proxy config, durable store restart, status/epoch revocation and route coverage. No enterprise production activation until these pass.

### Task 3: Department permissions, attributable decisions and UI

- [ ] Expand route matrix by actual registered routes; implement SQL-scoped lists and resource-authoritative detail/download/search/run/approval scopes.
- [ ] Member administration and last-admin safeguards; actor/audit/outbox in same transaction for approval and privilege changes.
- [ ] Frontend login, mode badge, CSRF transport, pending user state, members and audit views.
- [ ] Two-user role/access/cross-department tests, fake-header rejection, revoked-cache denial, machine/user separation, backup migration and JJ deployment with actual configured IdP.
