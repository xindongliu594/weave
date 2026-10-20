# Task 2c.1 implementation report

2026-10-21. Base supplied by controller: `def5d27`, after Task 2b independent PASS. This is the narrow SQL bulk-writer tail slice only. No Git writes, dependency changes, public documentation changes, production/JJ access, model API calls, or subagents were used by this implementer.

## Implemented contract

- `apps/api/src/cost-control.ts:17`: `costMaintenanceTransaction` owns one pool connection, awaits `BEGIN`, shared transaction advisory lock `918275`, the callback's real SQL, and actual `COMMIT`. On error it awaits the rollback attempt, preserves the original error, and discards the owned client if rollback also fails. It never retries the callback/business action.
- `cost-control.ts:28`: public `expireReservations()` accepts no arbitrary database/query object. It uses that owned transaction for both original probe and reservation UPDATEs. Their predicates, fee amounts, history and messages are unchanged.
- `cost-control.ts:33,141`: the internal expiry implementation is private. `reserveCall` calls it inside its original connection/transaction, after its existing shared advisory acquisition. It does not take another connection, nest a transaction, or acquire a native guard. Existing shared-before-project-row/global-policy-row ordering remains intact.
- `apps/api/src/provider-reconciliation.ts:157,169`: `expireProviderQueries()` owns the same narrow shared transaction helper; the service awaits it before its unchanged selection and provider lookup loop. The stale UPDATE text and claim/history/attempt behavior remain unchanged. The existing service-level catch is preserved; standalone cleanup rejects SQL failures instead of claiming success.
- `receiptTransaction`, global manual billing-scope UPDATE, claim-token CAS, provider lookup logic/counts, settlement/error/permission logic were not modified. The stated $3.41 cap and seven historical unknown fees were not read or changed; test money is synthetic.

Controller explicitly approved this helper and no-argument public-entry design before implementation, including rollback-failure discard and original-error preservation.

## Native environment and boundaries

Requirements reported to controller before runner creation: owned fresh native database, at least three independent connections, same-role activity/lock visibility, minimal schema, trigger-controlled original UPDATE/deferred COMMIT barriers, separate writer/source/controller application names, private explicit connection config, and no inherited production URL. Root provisioned PostgreSQL **17.10**, fresh loopback private DB/role, using official `initdb`/`pg_ctl`; this implementer neither installed nor started/stopped the cluster.

Only root's dedicated `postgres-runtime/run-cost-tail.mjs` ran native tests. It supplies `COST_TAIL_NATIVE=1` and the private config path with a safe OS environment; tests validate kind/state/id/host/role/database before generating their owned URL or importing `db.ts`. No production `DATABASE_URL` fallback, observability runner allowlist bypass, or full application/migration was used. Native tests create a unique minimal schema and fixture-owned `test-*` DATA_DIR/TRACE_ROOT. PGlite results below are business regression only.

## Exact executions and actual exits

Commands ran sequentially in the assigned heavy-test slot. Logs are in this report's directory; full command text and real `EXIT` are appended to each log. Ordinary Windows escalation was used for actual node/test/build execution after the restricted runner's no-TAP timeout.

| Stage | Exact command | Actual result | Log |
| --- | --- | --- | --- |
| Restricted attempt, not RED | `node .superpowers/sdd/2026-10-21-archive-writer-fence/postgres-runtime/run-cost-tail.mjs` | 124, runner timeout, child SIGTERM, no TAP | `task-2c.1-native-red.log` |
| Initial ordinary fixture error, not RED | same command | 1; native `pg` array passed to jsonb needed JSON.stringify; beforeEach failed before assertions | `task-2c.1-native-red-ordinary.log` |
| Valid native RED | same command, corrected JSON fixture | 1; 9 tests, 1 pass, **8 expected failures**, no skips/cancellations | `task-2c.1-native-red-2.log` |
| Business RED | `node scripts/test-integration.mjs '--test-name-pattern=standalone expiry rolls back' tests/cost.test.ts` | 1; original probe interruption remained committed after reservation UPDATE failed | `task-2c.1-business-red.log` |
| Native GREEN | `node .superpowers/sdd/2026-10-21-archive-writer-fence/postgres-runtime/run-cost-tail.mjs` | 0; **9/9**, no skips/cancellations | `task-2c.1-native-green.log` |
| Business GREEN | `node scripts/test-integration.mjs tests/cost.test.ts tests/provider-reconciliation.test.ts` | 0; **12/12 + 17/17**, no skips/cancellations | `task-2c.1-business-green.log` |
| Strengthened native edges | `node .superpowers/sdd/2026-10-21-archive-writer-fence/postgres-runtime/run-cost-tail.mjs --test-name-pattern 'disconnect\|reserveCall'` (literal pattern passed is `disconnect|reserveCall`, without a backslash) | 0; **3/3**, no skips/cancellations | `task-2c.1-native-edge-green.log` |
| Final build/typecheck | `npm run build` | 0; `tsc --noEmit` and Vite pass; Vite reports >500 kB chunk advisory | `task-2c.1-build.log` |
| Tracked diff whitespace | `git diff --check -- apps/api/src/cost-control.ts apps/api/src/provider-reconciliation.ts tests/cost.test.ts` | 0 | `task-2c.1-diffcheck.log` |

No production source was written until valid native RED and business RED had completed. After native full GREEN, only native test assertions/fixture bounds were strengthened: preserve the original COMMIT connection error when rollback also fails, assert failed pool client removal, set a bounded pool acquisition timeout, type the pinned pg connection access, and attach client error listeners once per connection. Only the affected three cases were rerun, not the unchanged full suite. No production code changed after full native GREEN. No broader/full-project suite was repeated, per controller's scope/resource instruction.

## What the native evidence establishes

Both real production cleanup paths were exercised, including the actual provider service tick/close, not a fake query object or lock-text assertion. Each uses two synthetic rows belonging to different projects, preserving amounts `0.11`/`0.23` and original history.

1. Source backend holding exclusive `918275` causes cleanup's real shared lock request to wait before either UPDATE. Evidence includes backend PID, advisory mode/granted flag, original query, and `pg_blocking_pids` relation; source reads unchanged rows.
2. A real deferred constraint trigger holds each cleanup during its original **COMMIT**, after its UPDATEs. The separate source exclusive request remains blocked by the writer shared gate until actual database completion; source then reads both committed rows and retained history/amounts.
3. A real after-statement trigger pauses the original UPDATE and then raises `TAIL_FIXTURE_ROLLBACK`. Source cannot pass the gate early; after abort/rollback it reads the exact original rows. For expiry, the prior probe UPDATE also rolled back and the original SQL error propagated.
4. During actual COMMIT, the test destroys the real writer socket. The expiry JS result is `Connection terminated unexpectedly`; rollback also cannot use that broken connection, which is discarded. This error does **not** prove rollback. After releasing the fixture barrier and acquiring the SQL source gate, exact persisted rows showed the original transaction **committed** for both cleanup operations. No business action was replayed. The provider service's pre-existing catch remains intact.
5. With product pool maximum one and a bounded acquisition wait, real `reserveCall` performs its internal expiry then rejects the missing probe with `PROBE_EXPIRED`; earlier probe/reservation writes roll back together. It did not require a second/nested transaction connection.

Example full-GREEN backend evidence: source PID 43112 waited on expiry writer 18220 and stale-query writer 8532. Strengthened edge run: source 9956 waited on expiry writer 22940 and stale-query writer 26992. Full row outcomes are retained in the respective private logs.

Awaited `after` hooks dropped each unique test schema, ended writer pool/source/controller clients, and removed each owned DATA_DIR; successful native exits include those hooks. Root's private PostgreSQL cluster remains running intentionally for review/lifecycle ownership. The heavy-test slot was explicitly released to root after final build completion.

## Exact changed-source allowlist and SHA-256

These are live on-disk SHA-256 values, also saved in `task-2c.1-sourceSHA.json`. No other production/test source was edited by this implementer. The new native test is untracked until controller selects it; unrelated existing private/public/untracked artifacts were left alone.

| Path | SHA-256 |
| --- | --- |
| `apps/api/src/cost-control.ts` | `7da3b0aa3777fa742b6c67ef09542dbc770d8fcd54d5f6b013e4e53144728791` |
| `apps/api/src/provider-reconciliation.ts` | `4d02ad64afccf59905f21048c9f64e877926385a947940f70fab9885b39af9b2` |
| `tests/cost.test.ts` | `a42058e5eaaa2784cc823adba08211e516a3eb98bb59c1b4bab87f98c6ddf656` |
| `tests/cost-maintenance-native.test.ts` | `9f3a80f99e7a644439f735f01e38ac51371328db51c4e2e5af0bcc953b708705` |

## Remaining scope and review

Independent review is controller-owned and still required. This report claims the tested SQL-tail slice, not overall Task 2c completion or source approval. Run/HTTP/device/receipt native lifetime coverage, strict trace registration/synchronous append, source capture barriers/isolation/revalidation, and Tasks 3–4 remain outside this change. Native tests did not add source-capture production code, simulate all process-loss timings, or certify arbitrary plugins/models/devices. The reused advisory gate is global, so future exclusive source capture deliberately waits across projects; no new distributed/native lock scheme was introduced.
