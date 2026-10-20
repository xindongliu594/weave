# Original-ID HTTP, Web and storage — final independent rereview

Result: **PASS. The previous P2 is closed; no other directly related P0–P2 issue was found.**

Date: 2026-10-21. Reviewer: the same independent reviewer that wrote `terminal-http-web-storage-independent-review.md`. This report supersedes that report's CHANGES REQUIRED conclusion for its single archive-fallback finding. Its broader scope limits remain.

## Correction verified

`apps/api/src/app.ts:536-545` now catches archive read exceptions locally, continues to the existing SQL lookup, and supplies unavailable history to the maintenance reader. A known SQL run retains its original SQL business state while returning `integrity:'incomplete'`, empty events/summary arrays, zero event count, no further event page, and a static `checkpointBlocked` warning. Its maintenance projection remains pending/unverified with reconciliation disabled. Raw JSON/filesystem/archive failures are not copied into the response. Neither readable archive nor SQL row still yields 404.

`readRun` and the original-ID effect/observation path remain strict. This fallback grants no acceptance, stopped marker, provider fact, recovery or device authority. An original-ID POST against unavailable history still fails closed before another provider observation. The existing strict UI therefore displays protected unresolved maintenance without an action, instead of losing the entire detail page.

The change is local to this GET fallback and the HTTP regression file. The root-authorized type-only `SandboxMaintenance` fixture annotation is retained. No Web, storage join, authentication, cache exception or original-stop lifecycle implementation changed in this correction; the earlier review's findings on those surfaces remain valid.

## Evidence inspected

The actual HTTP/PGlite test now exercises four independent unavailable-history cases:

- missing snapshot, explicitly proving readRun returns null;
- malformed snapshot JSON, explicitly proving readRun throws;
- missing plain and archived journal, explicitly proving readRun throws;
- invalid archived-journal metadata, explicitly proving readRun throws.

The supplied RED log shows the expected old integrity-ok failure and three 500-versus-200 failures; Node counts the failing parent as well, producing 3 passed / 5 failed. The supplied GREEN log records **8 passed, 0 failed/cancelled/skipped**. The correction report records the RED session exiting 1 and GREEN exiting 0. Every corrected case checks the original SQL status, pending/unverified/no-action maintenance, incomplete/empty event metadata, no corruption sentinel leakage, and a failed-closed original-ID POST. The original SQL marker and provider observation/stop call/effect counts remain exactly unchanged. A missing archive plus missing SQL row remains 404.

Both files match `task-stop-maintenance-http-archive-fix-sha.json`:

- app.ts: `0140392e9d1e3f09e0b2986193e1e17dc63687e67c9bb9b6d94df9d8c9c04408`
- task-stop-maintenance-http.test.ts: `7348596b6d2d465f95e91492127fa6cf4914a6d0cb0dd1bb5ea931994e397cc3`

All ten current files also match the refreshed `task-stop-maintenance-http-web-sha.json`; the old freeze was preserved separately. This reviewer inspected source, hashes, fix report and logs without rerunning any test.

No product source was edited and no test, network, browser, PG/PGlite, build, paid model, JJ, Git, installation or device process was run. Only this final report was written. Root's rendered browser/global build evidence, native PostgreSQL concurrency, physical device/disk facts, sequential Product acceptance and the later retirement/recovery/Task 5/6 gates remain separate; this PASS is not global completion.
