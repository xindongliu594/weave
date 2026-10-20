Spec Compliance: ✅ PASS for the scoped Task 2b fix round 1, `d9bb4a4..a8852f4`.

Task quality: **Approved**. Both prior Important findings and the expected-heartbeat-log Minor are resolved; no new blocking regression found in the four-file fix.

### Closed findings and checks

- **Nested expiry and failure retention — resolved.** `services/agent-runtime/archive-writer-scope.mjs:43` introduces a shared private invoke path. Each call gets its own ALS context and increments the original producer's in-flight count at `:46`; settlement expires that context and decrements the count at `:47`. Both synchronous throw and original Promise rejection latch failure before settlement at `:49` and `:51`. Nested withWriter uses this path at `:98`, so a parent catching the nested failure cannot silently release the original guard. It neither acquires another native guard nor closes parent admission. Owner/producer run delegates to the same path at `:60`, retaining its existing finished-record admission check.
- **Borrowed-view identity — resolved.** `services/agent-runtime/archive-writer-scope.mjs:100` requires the current ALS context to equal the captured nested invocation before live guard validation and retain. A different independently acquired same-run owner, a returned nested view used from its parent, and a callback bound to an expired nested invocation therefore cannot obtain an original-owner producer through that view. Explicitly retained producer handles still enter their original context through run.
- **Behavioral regression coverage — adequate for these findings.** `services/agent-runtime/archive-writer-scope.test.mjs:70` verifies stale nested callback rejection alongside a delayed explicitly retained tail that still blocks source acquisition. `:88` rejects foreign-owner borrowed retain while proving explicit producer transfer still works; `:102` rejects the expired borrowed view inside its live parent. `:111` tests both synchronous and asynchronous caught nested failures against actual native source exclusion.
- **Failed guard retention is tested through actual process lifetime.** `services/agent-runtime/test-helpers/archive-writer-source-child.mjs:5` catches each nested failure inside the parent helper, reports the outer drain rejection and remains alive without releasing the failed guard. The parent at `services/agent-runtime/archive-writer-scope.test.mjs:114` checks source timeout, then awaits actual child exit code 0 before checking source acquisition succeeds. Fixture cleanup at `:21` joins remaining children before removing the checked exclusive synthetic directory. No failure-reset or forced-release API was added.
- **Expected heartbeat diagnostic — resolved.** `tests/run-terminal-maintenance.test.ts:174` captures all error arguments; `:191` asserts the exact expected diagnostic, and `:192` restores the logger after original launch work settles. Production coordinator behavior is unchanged. The focused green log contains no uncaptured `Run lease cancellation: Error`.

### Evidence checked

- `task-2b-fix1-red.txt:1`: all five new regressions fail before the production fix, with the expected missing scope rejection and `outerError: null` symptoms; recorded EXIT=1.
- `task-2b-fix1-scope-green.txt:13`: 12 tests, 12 pass, 0 fail/skip; EXIT=0 at `:21`. Includes the seven existing scope cases and five new regressions, with actual process source/producer checks.
- `task-2b-fix1-heartbeat-green.txt:5`: exactly one affected test, one pass, zero fail/skip; EXIT=0 at `:13`. The deliberate post-exit-cleanup marker remains informational, not an uncaptured failure.
- `task-2b-fix1-build-green.txt:3`: build includes `tsc --noEmit`; EXIT=0 at `:19`. The existing >500 kB chunk advisory at `:14` remains outside this scoped fix.
- Read the fix report and its four-file `task-2b-fix1-sourceSHA.json`, then the complete supplied fix diff. No changed source was separately reopened, no outside-diff code inspection was needed, and no passing suite or synthetic probe was rerun. Only this review report was written; no source, Git/index, production/JJ, network/model or delegated work was performed.

### Evidence limits retained

- `task-2b-fix1-report.md`, Final bounded verification / Self-review and boundary: the native primitive suite and broader callers were intentionally not rerun for this bounded fix. Public API declarations were unchanged; the project build supplies current TypeScript consumer validation.
- `tests/run-terminal-maintenance.test.ts:169`: its PGlite heartbeat result does not prove native PostgreSQL independent-backend lock order. Prior native PostgreSQL skips and the three constructor-only unexecuted migrations remain unverified.
- `services/agent-runtime/archive-writer-scope.mjs:98`: this approval closes the reviewed nested-scope defects; it does not certify later 2c/3/4 trace, HTTP/device/cost/canonical/maintenance/backup/offline writer coverage. Enterprise/source approval remains closed. Task 2c.1 was not included or reviewed.

Task quality: **Approved** for fix round 1; the original Task 2b review blockers are closed within the previously stated scope and evidence limits.
