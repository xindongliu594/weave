# Protected run detail when original history is unreadable

Independent review response: the single P2 in `terminal-http-web-storage-independent-review.md` is implemented and frozen for narrow rereview. This is only the run GET fallback correction, not broader terminal/profile release acceptance.

Changed sources: `apps/api/src/app.ts` and `tests/task-stop-maintenance-http.test.ts`. Root's existing type-only `SandboxMaintenance` import/provider annotation was preserved. No web/trace reader/lifecycle/storage/fixture source was edited.

The root cause was the unguarded archive read before SQL lookup. A malformed snapshot or unreadable journal threw before the new SQL maintenance projection ran. The correction catches archive read failure locally in GET `/api/runs/:id` and uses the existing known-SQL-run fallback. That fallback now explicitly reports `integrity:'incomplete'`, empty event/summary arrays, a bounded static `checkpointBlocked` reason, and the unavailable-history pending/unverified SQL maintenance projection. The original SQL business state is retained. No accepted, file or device fact is constructed; unavailable history cannot enable reconciliation/recovery. A missing readable archive and missing SQL row still return 404. Raw filesystem/JSON/archive errors do not appear in the response. `readRun` itself remains strict and unchanged.

Actual test behavior:

1. Missing snapshot: precondition proves `readRun` returns null. The old fallback incorrectly reported integrity ok.
2. Malformed existing snapshot JSON: precondition explicitly proves `readRun` throws; the old GET returned 500.
3. Missing plain journal with no archived journal: precondition explicitly proves `readRun` throws; the old GET returned 500.
4. Invalid archived-journal metadata with plain journal moved aside: precondition explicitly proves `readRun` throws; the old GET returned 500.

Each case restores the original snapshot/journal in `finally`; generated compressed/metadata fixture files are removed before restoring the original journal. Each corrected response is checked for the same SQL business status, incomplete archive, nonempty pending/unverified scopes with `canReconcile:false`, empty events/summary, and no private corruption sentinel. An original-ID POST fails closed with 409 before another provider observation. The SQL original marker is compared exactly before/after; the existing provider observation count and original stop call/effect counts remain unchanged.

Evidence, all in the existing private directory:

- `task-stop-maintenance-http-archive-light-ready.txt`: intermediate light preparation, 3 passed and actual app test skipped while Product held the exclusive PG window.
- `task-stop-maintenance-http-archive-red.txt`: real app/PGlite RED, all four intended archive cases failed (the parent is also counted as failed, giving 3 pass / 5 fail / 0 skip). The three exception paths proved throws rather than reusing the null case.
- `task-stop-maintenance-http-archive-green.txt`: same file after the minimal fix, **8 passed / 0 failed / 0 skipped**, including the original HTTP authorization/CSRF/cache/repeated original-ID/storage checks and all four archive subtests. No unrelated test files were rerun.
- `task-stop-maintenance-http-archive-fix-sha.json`: exact two corrected file hashes. The ten-file current HTTP/Web manifest `task-stop-maintenance-http-web-sha.json` was refreshed; its prior freeze is preserved as `task-stop-maintenance-http-web-sha-pre-archive-fix.json`.

Both test sessions are finished: RED session 18143 exited 1 as intended; GREEN session 24512 exited 0. The PG window was explicitly released to root immediately after GREEN. No test session remains running. No full build/tsc, browser, paid model, physical JJ/OpenShell, Git or installation action was run in this correction. The local PGlite/transport fixture limitations from the main HTTP/Web report remain unchanged; root owns global build/browser evidence and the original reviewer's narrow rereview.
