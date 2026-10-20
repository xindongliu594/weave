# Task 3 browser identity independent review

Reviewed on 2026-10-20. Baseline HEAD: `d38cfa7377f06dce8b426aac70bddca716d0da30`; this review covers the uncommitted browser identity integration on that baseline, not a completed enterprise deployment. No source files were edited by the reviewer. No production endpoint, model, ambient database, or existing production configuration was used.

## Scope

Read `AGENTS.md` and Task 3 of `docs/superpowers/plans/2026-10-20-oidc-api-integration.md`. Inspected `identity-session.ts`, `IdentityGate.tsx`, `identity-reset.ts`, `api.ts`, all three singleton sync stores, the principal-scoped OrganizationChat/ProjectPlanning/OpenRigWorkbench persistence, RunExtras preview/download handling, the login JSON handoff in `identity-http.ts`, main entry, Vite and local/static/demo launcher proxy paths, and focused tests. A second read-only reviewer independently inspected the HTTP/proxy/download paths.

## Concrete findings

### 1. [P1] A failed logout could silently reopen the previous workspace

Original location: `apps/web/src/identity-session.ts`, `later`, `wake`, and `authAction` cleanup.

The original implementation invalidated browser state immediately, but queued the next session poll from `invalidate()`. Once the logout POST returned 503 or lost its response, `finally` cleared `loggingOut`. The next timer or focus event fetched the still-live server session and silently remounted the previous workspace, despite the displayed message that logout was unconfirmed. This can expose a previous user's draft/workspace after an attempted logout on a shared browser.

Deterministic reproduction used an injected fetch and timer queue: authenticate a synthetic administrator; return 503 from the only logout POST; observe `signed-out` with the unconfirmed message; invoke the queued poll while `/auth/session` still returns the administrator. Output before repair:

```json
{"immediately":"signed-out","afterAutomaticPoll":"authenticated","gets":3,"logoutPosts":1}
```

The parent added `logoutUnconfirmed` to suppress automatic timer/focus/subscription refresh until an explicit user refresh verifies server state. Initial code re-review found that repair consistent with the required single mutation/no automatic replay semantics. Final regression rerun is recorded below.

### 2. [P1] Normal local/demo development launchers sent the new session probe to a different API port

Location: `vite.config.ts:6`; supporting callers `scripts/local.mjs:149`, `scripts/demo.mjs:60`, and random API binding in `scripts/local-api.ts:48`.

`IdentityGate` now requires `/auth/session` before mounting business UI. The Vite base config adds `/auth` using `API_PORT` or 4311. The local launcher overrides `/api` and `/healthz` to the actual random `ready.apiPort`; demo overrides `/api`; neither originally overrides `/auth`. Thus a normal local/demo dev start consults port 4311 instead of its own API and remains unavailable, or obtains another workspace's session if a service happens to exist there.

The independent reviewer reproduced the config resolution using the installed Vite `mergeConfig` without opening ports or starting services. With the selected API port 54321:

```json
{"/api":"http://127.0.0.1:54321","/auth":"http://127.0.0.1:4311","/healthz":"http://127.0.0.1:54321"}
```

Both runtime launcher overrides must include `/auth` pointing to `ready.apiPort`. Final repair/recheck status is recorded below.

### 3. [P2] Page restoration retained authorization while its identity recheck was pending

Original location: `apps/web/src/identity-session.ts`, common `wake` callback for `pageshow` and focus.

The initial implementation handled `pageshow` by starting an asynchronous session refresh while retaining the previous authenticated snapshot and mounted business subtree. A browser-restored document could therefore expose the previous principal's cached draft/content until the request returned or timed out after another tab logged out/switched accounts. There was no pagehide suspension. This is a state-machine observation; this review does not claim a real-browser BFCache reproduction.

The parent added pagehide/pageshow suspension and deterministic coverage. In combination with finding 1's hold, pagehide after an uncertain logout retains the signed-out screen with explicit refresh available, rather than getting stuck at `loading` with automatic refresh disabled.

## Verification evidence

The following pure frontend test command was run independently before the parent repairs, and completed with **41 passing, 0 failing, 0 skipped**:

```text
node --import tsx --test tests/identity-session.test.ts tests/identity-gate.test.ts tests/identity-reset.test.ts tests/api-response.test.ts tests/project-sync.test.ts tests/usage-sync.test.ts tests/health-sync.test.ts
```

A separate synthetic integration probe imported the actual `identity-reset.ts`, populated all three real singleton snapshots through mocked API responses, then performed successful logout. It verified the registration wiring and produced:

```json
{"logout":"signed-out","health":null,"usageRows":0,"projectRows":0}
```

The inspected implementation uses same-origin credentials, carries CSRF on planning-quote and other unsafe methods, keeps original mutation idempotency keys, never automatically replays a mutation, treats 401 as invalidation without reading an error body, and preserves authentication on ordinary 403. Generation checks run before response handling and after body consumption; identity changes abort old reads and reset singleton snapshots. Principal storage captures the principal at component creation, so delayed old component writes cannot enter a new principal's draft namespace. Pending, disabled and active non-admin states fail closed in the gate. Login JSON retains the existing CSRF/middleware/no-store controls and validates an HTTPS handoff before navigation. No additional definite P1/P2 issue was found in those paths.

## Final repair verification

The parent repaired all three findings. Fresh independent code re-review confirmed:

- `logoutUnconfirmed` prevents automatic timer/focus/subscription session loads after a failed or lost logout response; a deliberate explicit refresh may verify server state. An unresolved logout still blocks even explicit reads, and the mutation is never replayed.
- `pagehide` suspends authorization, clears the session snapshot, advances the generation and triggers business cache resets. `pageshow` rechecks identity while the gate remains closed. The uncertain-logout hold is preserved across those lifecycle events without removing the explicit-refresh screen.
- Both local/demo Vite launcher overrides bind `/auth`, `/api`, and `/healthz` to the selected `ready.apiPort`. The new regression parses the actual launcher AST and checks the installed Vite merge result, without starting a database or launcher.

After these repairs, the reviewer freshly ran:

```text
node --import tsx --test tests/identity-session.test.ts tests/identity-gate.test.ts tests/identity-reset.test.ts tests/api-response.test.ts tests/project-sync.test.ts tests/usage-sync.test.ts tests/health-sync.test.ts tests/local-auth-proxy.test.ts
```

Result: **44 passing, 0 failing, 0 skipped**, exit code 0. This includes the failed-logout hold across focus/pagehide/pageshow, explicit recovery, page-restore gate suspension, principal-change late-response rejection, singleton reset behavior, and actual launcher proxy merge regression. Baseline HEAD remained `d38cfa7377f06dce8b426aac70bddca716d0da30`; repairs and tests were uncommitted working-tree changes.

**No unresolved definite P1/P2 code defect remains in this reviewed scope.** This is approval of the bounded browser identity code slice following repair, subject to the acceptance boundaries below; it is not approval to activate JJ enterprise OIDC.

## Follow-up: empty department workspace smoke fix

The parent's built-page browser smoke found an existing empty-workspace crash in `DepartmentWorkbench.tsx`: when `data` was null and there was no selected/first department, `data?.departmentId === departmentId` evaluated to `undefined === undefined`, then the following `data.offset` dereference threw before the creation screen could render. The one-line repair makes the whole match conditional on `data` being present. It preserves the existing department/offset filtering for loaded data and adds no request or authorization behavior.

The reviewer independently inspected that exact one-line source delta and `tests/department-workbench-empty.test.ts`, then ran:

```text
node --import tsx --test tests/department-workbench-empty.test.ts
```

Result: **1 passing, 0 failing, 0 skipped**, exit code 0. The test renders the real React component with no departments and asserts the creation entry appears. Its only loader substitute is the component's static CSS file; it does not replace the component or its rendering logic. The parent reported the maintained RED reproduction before repair, build exit 0 after repair, and the creation entry appearing in the built browser. The reviewer did not independently operate that browser. No further issue was found in this small delta.

## Follow-up: parent-owned native PostgreSQL evidence inspected

The reviewer read `result.json` and the end of `identity-suite.log` from the parent's owned cluster `cluster-7f00ee2d-c412-4052-a98d-907063de1b8c` under `.superpowers/sdd/2026-10-20-real-postgres-validation`. The recorded executable is PostgreSQL 17.10, the two backend PIDs differ, and `pg_blocking_pids` identifies the first backend blocking the second. The suite records **29 passing, 0 failing, 0 skipped**, `identityExit: 0`; the runner records `stopped: true` and `dataRemoved: true`. A fresh read-only filesystem check also confirmed the owned `data` directory and temporary password file are absent.

These are inspected artifacts from the parent's native run, not a second reviewer-run cluster. The separate `identity-fixture-independent-review.md` records fixture safety, resolved failure-path cleanup, and the maintenance synchronization review. This evidence advances the native protocol/store test gate; it does not establish real-browser enterprise deployment or the remaining Task 3 gates.

## Acceptance boundaries

The code review and inspected native-run artifacts do not establish actual built-browser OIDC login/callback/logout, trusted HTTPS cookie and navigation behavior, direct download revocation and real BFCache behavior, configured IdP integration, service restart against that stack, or local launcher end-to-end startup. Those require their own isolated evidence. Parent owns typecheck/build/browser follow-up. A2 member authorization and human operation auditing remain outside this task. Neither Task 3 nor the enterprise feature is declared complete by this report.
