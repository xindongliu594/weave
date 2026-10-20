# Terminal API review fix — 2026-10-21

Scope: the two findings in `terminal-api-independent-review.md`. No Git/JJ/install/paid/model/native-device action or child agent. API source remains locked for final independent re-review.

## Repair

P1: the existing lifecycle transaction now uses installed node-postgres 8.16.3 native `query_timeout` with the remaining shared budget for BEGIN, SET/config, ordinary queries, COMMIT and ROLLBACK. COMMIT first refreshes its server statement/lock allowance. One transaction-wide abort listener latches the connection poisoned before public `PoolClient.release(true)` discards it. Driver read/transport uncertainty and statement/lock timeout also discard. Every continuation checks usability; poisoned clients never issue rollback or return a dispatch closure. Known server SQL failures may perform only a bounded rollback. There is no new SQL queue or caller-side Promise.race that abandons a live transaction.

P2: an exact stopped-repeat request now invokes the captured reconcile method with the original full identity and shared signal, then performs narrow idempotent fact bookkeeping. It never invokes fresh stop. This delegates current local directory/policy/gateway binding checks to the existing trusted device path rather than inferring them from SQL or constant capability metadata.

Authorized fixture compatibility: delivery query interception understands official pg config.text/values; in-memory scope fixture normalizes that same shape without bypassing production timeout logic. The HTTP/Handoff fixture adds a real temporary grant directory inode check in its explicitly synthetic physical provider. No successful operation/claim/merge was seeded.

## Behavior RED

`terminal-api-review-red.txt`: 12 failed, exit1. Ten real pg socket receive holds cover BEGIN/SET/query/dispatching COMMIT/ROLLBACK under abort and shared deadline, revealing unbounded or undiscarded connection behavior. The combined positive stopped case encountered the preceding unsafe connection's late error; it is not counted as the intended stopped-repeat RED.

`terminal-api-review-stopped-red.txt`: isolated 2 failed, exit1, for stopped-repeat zero original-ID reads and replaced real temporary grant inode not refused. These are the intended independent P2 REDs.

First GREEN attempt had 10 pass/2 fail because its COMMIT counter counted three earlier healthy releases together with one poisoned release (4 instead of1). Only that test counter was corrected to count poisoned releases; original logs are retained. The corrected full review matrix then passed12. Final matching runs below use the final source after removing a type-inappropriate redundant pool-client end fallback and narrowing a test Promise type.

## Matching verification

- `terminal-api-matching-review12.txt`: PASS12, 0 fail/skip, exit0, 78.3s. SQL held-response tests prove bounded result before response release, one poison/discard, zero later transaction continuation/device effect and a different acquired client. Stopped-repeat tests prove original-ID read, zero fresh stop and local inode replacement refusal.
- `terminal-api-matching-terminal28.txt`: PASS28, 0 fail/skip, exit0, 126.2s.
- `terminal-api-matching-legacy39.txt`: PASS39, 0 fail/skip, exit0, 76.0s.
- `terminal-api-matching-scope25.txt`: direct scope PASS25, 0 fail/skip, exit0, 67.2s. Session18050 exited0; all owned heavy processes ended and the PG window was explicitly released to root.
- Current full tsc has no owned-source/test error, but `terminal-api-matching-type.txt` reports another owner's in-progress `tests/task-stop-storage.test.ts` missing its new `apps/api/src/task-stop-storage.ts`. This is not a global type PASS. Root was notified and owns the final global check.
- `terminal-api-review-final-source-sha.json` and `terminal-api-review-source-stable.json`: all8 owned/authorized source, test and helper files match final start→end. Core task-accepted-stop SHA: 928fcb46e1e6007823e814c4818d1efb27c0fff8bdd847a2e508a9d9731adb7d. Independent re-review remains required; source is locked.

## Limits retained

The transport hold uses the actual installed pg client and an isolated PGlite socket server; it does not certify independent native PostgreSQL backend locks, physical JJ/OpenShell or paid model acceptance. It is a bounded failure fixture around genuine API/HTTP/CAS/Handoff sources. Default no-workspace provenance, inactive historical fresh-stop eligibility, repeated-failure/rework capacity, exact-key retirement/recovery/carrier and profile release remain separately gated. Public observer/admin/CSRF/cache/projection/runtime/web are owned elsewhere.


Final gate: terminal-api-review-final-type.txt / .exit.txt is tsc PASS exit0. Independent terminal-api-independent-review-final.md is scoped P1/P2 PASS. All104 matching tests passed and all8 source/test/fixture SHA values stayed stable. Exact file/log/exit/review SHA and ownership are in terminal-api-final-manifest.json; root owns export/commit. No agent commit/push was made.

