# Terminal API repair review — 2026-10-21

**PASS for the two previously reported source defects. No remaining P0–P2 finding was identified in these fixes or their directly related behavior. Consolidated validation is still pending its final status; this is not a release or full-integration PASS.**

This review is limited to the P1 acquired-client SQL deadline issue and the P2 stopped-marker observation issue in `terminal-api-independent-review.md`. It does not reopen runtime, projection, route, web, or architecture scope.

## P1 closed: acquired-client SQL waits use the shared deadline and discard uncertain sessions

`apps/api/src/task-accepted-stop.ts:87-117` now retains cancellation handling after pool acquisition:

- Every original driver query, including BEGIN, timeout setup, ordinary queries, COMMIT, and ROLLBACK, goes through `native()` with a `query_timeout` derived from the same signal's remaining budget.
- Shared abort marks the client poisoned before calling `release(true)`. The local release latch prevents a second release, and `usable()` checks before/after each driver await prevent a late result from continuing the transaction.
- Driver/transport failures, read timeouts, and server statement/lock timeouts discard the client. A poisoned transaction does not enqueue ROLLBACK or further work on it. Ordinary server SQL errors can still use bounded rollback.
- COMMIT now passes through the bounded wrapper, refreshing the server statement/lock limits to the remaining allowance. Its completion is checked before returning the callback result.
- The installed driver's actual path supports the intended behavior: `pg-pool` removes a client released with an error/true, calls `client.end()`, and `pg` destroys the stream when a query remains active. Query promises are rejected on termination. This is connection disposal with continuation fencing, rather than an abandoned caller-side race.

The new socket-hold tests pause the real acquired pg client's response stream at five stages, under both explicit abort and the shared deadline. They verify caller settlement before resuming the response, exactly one discard, zero later native calls/device effects, a replacement connection that can execute a query, and preservation of a protected marker for uncertain dispatching COMMIT.

## P2 closed: stopped duplicates still consult the frozen original-ID provider

`apps/api/src/task-accepted-stop.ts:394-398` removes the stopped-marker early return. A repeat request now completes the existing historical SQL/archive checks, calls the frozen `selected.reconcile` with the original key/identity and shared signal, then uses the existing exact fact-recording path.

The current device binding check is therefore reached even when SQL already records stopped. No fresh stop method, capability-field expansion, or API access to private executor internals was added. Existing stopped SQL facts remain unchanged when the provider refuses a replaced binding.

The two new tests verify that a valid duplicate performs one original-ID reconciliation with unchanged stop count, and that replacing the real temporary grant directory's inode is rejected while preserving the stopped SQL marker. The provider in this API fixture remains a test double implementing the binding check; this is real filesystem replacement evidence, not a physical OpenShell get.

## Evidence read and source identity

All eight files in `terminal-api-review-final-start-sha.json` matched when independently hashed twice during this review. In particular:

- `apps/api/src/task-accepted-stop.ts`: `928fcb46e1e6007823e814c4818d1efb27c0fff8bdd847a2e508a9d9731adb7d`
- `tests/task-accepted-stop-delivery.test.ts`: `cb9cd5f9340f36f24fa9f194df5f2b05de71f58e3d626955f3594267b3a67cc0`
- `tests/helpers/task-accepted-stop-api-fixture.ts`: `5ed337120df8620cce01ec72e053938115299f2c029d3a580f7775f021a43698`

Read the requested original `terminal-api-review-red.txt` and the separate `terminal-api-review-stopped-red.txt`. The first RED contains the expected held-response failures and also some connection-termination teardown interference; the clean separate stopped RED demonstrates both missing-device-read and missing-rejection failures.

Read the completed matching-source results:

- `terminal-api-matching-review12.txt` and its exit file: 12 passed, 0 failed, exit 0.
- `terminal-api-matching-terminal28.txt` and its exit file: 28 passed, 0 failed, exit 0.

The earlier `terminal-api-review-green.txt` was 10/12 because the initial release assertion counted normal pool releases before the held COMMIT. The current assertion counts nonempty discard reasons and checks the last release; the subsequent focused final log and the matching-source 12-case run both pass. That earlier failed result remains recorded.

The old `terminal-api-review-type.txt` is a failed intermediate check, not current green evidence. The source no longer calls the untyped `PoolClient.end()`, but the ongoing matching type check and remaining consolidated regressions must supply their own final exit results. At this review's evidence cutoff, the owner was continuing the sequential matching-source batch; no full-batch completion is claimed here.

## Limits

This reviewer ran no test, PostgreSQL/PGlite instance, type check, build, network request, paid/model operation, or physical device operation, and made no source or Git changes. Only this private report was written.

The inspected tests use PGlite with the real pg client/socket path and synthetic device/model behavior. They do not certify independent native PostgreSQL lock contention, physical JJ/OpenShell, paid acceptance, runtime teardown, the three-project run, or task-profile release. Final consolidated results remain the owner's verification gate.
