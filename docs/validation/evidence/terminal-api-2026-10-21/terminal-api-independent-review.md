# Terminal API independent review — 2026-10-20

**Changes requested: one P1 and one P2. No P0 found.** This is one comprehensive static review of the frozen source-only API slice against `docs/superpowers/plans/2026-10-20-task-stop-finalization.md`, with baseline HEAD `769c42f`. It does not approve runtime, projection, route wiring, or web implementation owned by other workers.

## Findings

### [P1] The shared deadline cannot terminate a wait on an acquired SQL connection

Location: `apps/api/src/task-accepted-stop.ts:88-100`, especially the raw `COMMIT` and `ROLLBACK` waits at lines 99-100.

Once `pool.connect()` resolves, the abort listener is removed. The transaction then awaits ordinary `pg` query promises, with signal checks only before/after the awaits. `set_config(statement_timeout, lock_timeout)` bounds server statement/lock execution but does not bound delivery of the reply. The installed `pg` 8.16.3 client only starts a response timer when `query_timeout` is supplied (`node_modules/pg/lib/client.js:531-574`); neither this wrapper nor the pool in `apps/api/src/db.ts:9` supplies one or cancels/disposes the acquired client when the shared signal expires.

A stopped/paused database socket, stalled socket proxy, or lost COMMIT acknowledgement while the connection remains open therefore leaves `finalizeAccepted()` and `reconcileExact()` awaiting SQL after the 120-second signal has aborted. A failed query followed by a non-settling ROLLBACK has the same outcome. Business acceptance never reaches the bounded pending result in this case. Also, raw COMMIT inherits the previous query's timeout rather than refreshing it to its own remaining budget; a long preceding query can leave COMMIT with substantially more than the remaining allowance.

The current COMMIT-loss test (`tests/task-accepted-stop-delivery.test.ts:376-387`) throws immediately after a completed COMMIT, and the deadline tests hold only pool acquisition. They do not exercise a non-settling acquired-client SQL wait.

Required repair: extend the existing transaction wrapper's cancellation handling through acquired-client SQL and transaction completion/cleanup, using the shared remaining deadline. Ensure the local query/connection wait settles or the connection is safely discarded, and fence every later continuation. Preserve uncertain COMMIT outcomes and the original marker; a bare caller-side race that leaves an executable transaction/dispatch continuation behind is insufficient. Refresh the COMMIT statement/lock allowance as appropriate. Add a targeted acquired-client/COMMIT-response hold test that crosses the deadline, verifies a bounded pending/rejection result, and then releases the delayed response to prove zero later callback/device effect.

### [P2] Repeated reconciliation of a stopped SQL marker skips the current local binding check

Location: `apps/api/src/task-accepted-stop.ts:377-380`.

`observeMarker()` returns immediately when the SQL marker is already `stopped`. The preceding `observation()` verifies archived proof and the SQL device enabled/grant/backend fields, but it does not verify the actual executor's current grant root inode, closed state, policy/CLI files, or gateway identity. `acceptedStopCapabilities()` is a pure constant and supplies none of those checks. They run through the existing original-ID reconciliation path: `assertAcceptedStopGrant()` / `assertGrant()` / `observeAcceptedTaskStop()` in `apps/desktop/openshell-executor.cjs:208-214,431-455`.

Consequently, after one successful stop, replacing the granted local directory, closing/revoking the local executor, or changing the local binding while leaving the SQL/provider identity unchanged makes an identical `reconcileExact()` request succeed without consulting the device. This contradicts the frozen requirement that each authenticated historical observation still refuses revoked or changed local binding. This owner-raised concern was independently confirmed from the API and device call path.

Required repair: let the stopped case use the already-frozen `selected.reconcile` with the original full identity and shared signal as well. A successful duplicate remains original-ID observation and must perform zero fresh stops. Reuse the existing provider contract; do not expand the public capability response or inspect executor internals from the API. Add a duplicate-stopped observer test with changed actual local binding, plus a successful duplicate asserting original-ID read and unchanged stop count.

## Reviewed behavior and evidence

- Reviewed production changes in `task-accepted-stop.ts`, `local-execution.ts`, and the narrow `SandboxMaintenance` type, plus the terminal tests and three named fixture adapters. Read immediate existing helpers/device/installed-driver source only to establish the affected boundaries.
- Source-only selection proves every current approved slot with its own accepted/checkpoint/commit chain, does not fabricate an active target, uses original method references, preserves the two-fresh-stop bound, and keeps retained inactive scopes out of fresh-stop selection.
- Existing markers are observed by original identity. Narrow fact CAS omits running-owner/cancellation eligibility, while the shared signal prevents unbounded attempted bookkeeping after cancellation. The supplied tests distinguish SQL cancel/lease transfer from an actually aborted signal.
- Strict exact-request parsing, class/run identity matching, preflight capability rejection before prepare SQL, post-COMMIT source rechecks, and pending-pool cancellation/late-client release are present.
- Read `terminal-api-final-green.txt`: 28 passed, 0 failed. Read `terminal-api-legacy39-green.txt`: 39 passed, 0 failed. Read the zero-exit type-check evidence. These are existing worker results, not tests rerun by this reviewer.
- Recomputed all seven file SHA-256 values from `terminal-api-final-source-sha.json`; every current file matched. The recorded `terminal-api-source-stable.json` also reports no changed files during the final run.

## Limits

No test, PGlite instance, build, paid/model request, physical JJ/OpenShell operation, network operation, source edit, or Git mutation was performed by this reviewer. Read-only diff/status inspection and writing this private review report were the only repository actions beyond file reads/hashes. Runtime teardown/admission, SQL projection/public route integration, and web rendering are outside this review.

The existing integration evidence uses PGlite and synthetic model/device behavior around real SQL/HTTP/Handoff paths. It does not establish independent PostgreSQL lock contention, a stalled live SQL transport, physical device behavior, paid acceptance, or the later three-project/profile-release gates. Findings above are static source conclusions and need focused RED/GREEN evidence after repair.
