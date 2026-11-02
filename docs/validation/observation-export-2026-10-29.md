# Restricted observation export — local validation, 2026-10-29

Status: local SDK/loopback and existing observation regression verified. Coordinator owns full-project validation and independent review. No JJ deployment, production collector, browser or paid model evidence is claimed.

## Scope and configuration

Changed `apps/api/src/observability.ts`; added `observation-exporter.ts`, `observation-exporter-worker.mjs`, and `tests/observation-export.test.ts`. No app/DB/trace/archive/checkpoint/recovery/budget/authorization edits. Runtime direct package pins were handled by the coordinator, preserving installed versions.

Default is disabled: neither provider nor worker is constructed. Explicit enablement requires `WEIWU_TELEMETRY_ENABLED=1` and `WEIWU_TELEMETRY_ENDPOINT` containing a canonical complete HTTP(S) URL ending exactly `/v1/logs`, with literal `127.0.0.1` or `::1` host. Userinfo, query, fragment, hostname aliases, remote hosts, and enabled ambient `OTEL_*` configuration are rejected with a fixed status code. Endpoint/header secrets never appear in health. Remote export and protected secret-header configuration are outside this slice.

One enabled owner per process, bounded to 256 reservations/1 MiB encoded summary bytes including in-flight messages. Fixed SDK batch size 32, scheduled delay 1000 ms, export/transport timeout 2000 ms, concurrency 1. Standard exporter retry is retained; no application retry spool. Worker 64 MiB old-generation limit is not a total RSS claim. No SDK environment/resource detectors, global logger/provider, history reader or business mutator is installed.

## Evidence

Evidence preservation: RED failures were observed in the tool output at the time, but no independent RED log file was retained. The RED descriptions and measurements below are contemporaneous report summaries, not independently preserved raw logs. The currently available reviewable log files are GREEN only: `exporter-green.log`, `exporter-review-green.log`, and `pipeline-review-green.log` in `.private/p0-observation-export-20261029/`. This documentation correction did not rerun tests or reconstruct a raw RED log.

- RED: owned test initially failed for the missing exporter, then the explicit not-implemented implementation; fresh-offer integration timed out before forwarding existed.
- Network layering: initial sandbox execution could listen but outbound loopback connect failed `EACCES`; an independent minimal SDK test reproduced the same failure. Approved test execution with access to only the fixture's temporary loopback listener produced real HTTP requests. No product changes bypassed the sandbox.
- Final owned suite: `node --import tsx --test tests/observation-export.test.ts`: **10/10 pass, exit 0, 23.555 seconds**, saved at `.private/p0-observation-export-20261029/exporter-green.log` (ignored local fixture evidence). Covers zero-network disabled/invalid settings; sensitive extras/accessors/correlation fields rejected; fresh summaries only; successful, failed and unknown business outcomes preserved; transport ACK separated from final reception; overflow; stalled/trickling callbacks; 429/503/reset; partial/malformed response; concurrent duplicate close and singleton reuse.
- Existing API observation pipeline: `node --import tsx --test tests/observation-pipeline.test.ts`: 6/6 pass, exit 0. Includes acknowledged projection, lost COMMIT ACK, throwing observers, 100,000 bounded local offers, disposal/reinitialization.
- Existing runtime summaries and persistence observer: `node --test services/agent-runtime/observation-summary.test.mjs services/agent-runtime/trace-observation.test.mjs`: 17/17 pass, exit 0.
- `node --check apps/api/src/observation-exporter-worker.mjs`: exit 0. `git diff --check -- apps/api/src/observability.ts`: exit 0 (Git emits only its checkout LF/CRLF notice).

Flood evidence: 10,000 offers accepted 256 and rejected 9,744 as queue-full, with 43,264 encoded pending bytes. The final acceptance log records elapsed offer time, parent-process RSS before/after (which includes the worker), and close time. This is a bounded synthetic local load, not a production capacity benchmark.

Final measurements: offer loop 117 ms; process RSS 119,373,824 to 138,891,264 bytes (delta 19,517,440 bytes); flood close 2903 ms; stalled-callback close 2912 ms. After each close, pending count and bytes were zero. 429, 503 and reset each made 2 actual requests before reporting one transport failure; partial and malformed response each made 1 request and reported one acknowledged-but-unknown delivery with zero exportedSuccess.

The trickling HTTP 200 response continues sending bytes without completing, preventing the transport callback from releasing its 32 reservations. Timeout is visible; close stops admission and subscriptions, expires drain at 2900 ms, terminates the worker, records 32 unconfirmed deliveries, clears pending records/bytes, and permits a new enabled owner. Earlier 3000 ms drain failed the stronger overall-close test at 3011 ms; the 100 ms termination allowance fixed it.

## Status semantics and limits

`accepted` remains local validated observation count for compatibility. `exportAccepted` means reserved in this process, never confirmed collector storage. `transportAcknowledged` and `lastSuccessAt` mean SDK transport success callback only. Fixed SDK 0.220.0 also returns that callback for partialSuccess and unparseable response bodies, so `exportedSuccess` remains zero; `exportedUnknown` includes acknowledged-but-unconfirmed records and shutdown/worker-exit unconfirmed records. `closedUnconfirmed` identifies the latter subset. `exportedFailure` means transport callback failure, not proof the recipient never saw bytes. Business `outcome` stays unchanged in the allowlisted summary.

`dropped` comprises sanitize rejection, queue-full and unavailable admission; disabled offers have a separate `disabled` counter. Close-unconfirmed records are tracked separately rather than disguised as confirmed failure. Snapshot errors are fixed codes; raw collector text and SDK exceptions stay inside the isolated SDK worker and are not forwarded to existing DSH handlers or console.

No telemetry is an authority for audit, costs, effects or permissions. No full receipt proof, durable spool, remote recipient, secret header, real model or JJ performance acceptance is implied. Node timers/worker termination cannot promise real-time behavior under a stalled OS; local overall-close assertions include termination and enforce the requested three-second budget.

## Independent review corrections

Two P2 findings were observed in the tool output before product changes with `node --import tsx --test --test-name-pattern='review:' tests/observation-export.test.ts`: the contemporaneous summary recorded 0/2 pass, exit 1, an already-exited worker taking 2915 ms to close, and the receiver finding `service.name=weiwu-observation` without the required version. No independent RED log file was retained; currently reviewable files are the GREEN logs listed above.

1. Exit clears the owned worker reference before completing health bookkeeping. `close()` on an exited worker therefore performs no new postMessage or deadline wait. The test intercepts only the initial offer dispatch to terminate a real Worker, restores the method immediately, waits for the real exit event, and verifies concurrent/repeated closes complete under 300 ms without replacing `OBSERVATION_EXPORT_WORKER_EXITED`. GREEN measured **0 ms**, one unconfirmed record, zero pending bytes/records.
2. The log body and eventName are now the fixed allowlisted summary event name. A fixed mapping selects scalar summary fields into `weiwu.*` attributes (`source_event_id`, `outcome`, duration/token/cost/capability fields) and canonical UUID correlations into `weiwu.correlation_id`, `run_id`, `request_id`, etc. The existing summary validator and SDK 32-attribute/128-character bounds remain in place. No correlation is fabricated as a W3C trace/span. Actual collector assertions verify three business outcomes and typed scalar fields. Resource attributes are exactly `service.name='weiwu'` and `service.version` read from the checked-in root package (`0.2.0` here). No deployment label or git identity was explicitly configured, so none is invented or emitted; package version does not claim a deployed git revision.

Review acceptance: `node --import tsx --test tests/observation-export.test.ts`: **12/12 pass, exit 0, 25.570 seconds**; log `.private/p0-observation-export-20261029/exporter-review-green.log`. Includes all original fault cases plus both review regressions. Updated measurements: flood 183 ms, 256 accepted/9744 queue-full, 43,264 pending bytes, RSS 120,668,160 to 139,485,184 bytes; flood close 2907 ms; trickling close 2915 ms. 429/503/reset still made exactly 2 fixture requests each; partial/malformed remain acknowledged-but-unknown, with zero exportedSuccess. Worker syntax and scoped whitespace checks exit 0. No shared manifest or app/trace/archive module changed for these corrections.

After the corrections, `node --import tsx --test tests/observation-pipeline.test.ts` again passed **6/6, exit 0, 17.745 seconds**, with log `.private/p0-observation-export-20261029/pipeline-review-green.log`. No full-project build/typecheck or release-audit work was repeated in this subtask.
