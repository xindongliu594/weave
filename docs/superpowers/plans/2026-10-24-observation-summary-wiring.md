# Restricted observation summary wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use executing-plans and test-driven-development. Existing D2 Task 4 is approved; this is its bounded implementation mapping, not a new exporter.

**Goal:** connect committed trace/audit events to one safe, bounded local observation sink.
**Architecture:** keep existing fsync/cursor/sourceKey and SQL outbox semantics; add only post-persistence adapters. Construct fresh allowlisted scalar summaries. The local sink keeps saturated finite counters, no raw events, record queue or per-ID history.
**Tech stack:** existing Node/TypeScript/PGlite tests; no dependency changes, network, model, CUA or production actions.
**Spec:** enterprise-observability.md Task 4 and 2026-10-20-enterprise-foundations.md D2.

## Reuse evidence and limits

- Installed `@deepseek-ai/dsh-session-telemetry@0.1.5-rc.1`, `lib/types/index.d.ts`, defines synchronous `session-telemetry/record` and captures full event `body`. Its default redaction is pass-through. Reuse existing DSH→`trace.mjs` capture; do not enable this full-body mirror as a safe-summary exporter.
- Existing approved D2 research links `https://github.com/deepseek-ai/deepseek-harness` and the fixed telemetry package. The optional OTel backend package is not present at the checkout's direct package path; no upstream feature or exporter is assumed installed. Task 5 owns package/transport verification.
- `trace-store.mjs` already fsyncs before cursor advancement, and suppresses duplicate sourceKey. Observer runs afterward. No replay/history scan is added.
- `audit-outbox.ts` already validates canonical columns and atomically inserts projection/marks publication. Add a bounded per-pool callback only after acknowledged COMMIT; preserve SQL, microseconds, parser and retry behavior. Lost ACK emits nothing, even if DB committed.

## Mapping

| Persisted source | Summary | Selected metadata |
| --- | --- | --- |
| run/created, run/finished | run.created, run.finished | canonical run UUID/seq; fixed terminal outcome when recognized |
| tool/start, tool/result | tool.started, tool.result | lifecycle only; bool error outcome; omit raw tool names/args/results |
| runtime/operation-start, operation-finished, operation-failed, outcome-unknown | operation.started, operation.finished, operation.failed, operation.unknown | failed/unknown only; finished does not prove successful execution |
| billing/usage, billing/unconfirmed | billing.usage, billing.unknown | finite nonnegative token/duration numbers; explicit unknown flag |
| runtime/status, runtime/anomaly | runtime.status, runtime.anomaly | fixed phase only; no employee/name/code/error/message/body |
| task/merge-committed, team/checkpoint, handoff/accepted | task.merge, task.checkpoint, task.accepted | lifecycle only; no paths/manifests |
| strict published audit action | audit.<fixed action> | actor kind, outcome/reason enum, UUID-only canonical correlation; no resource/user/session/body/parameter hash |
| session/*, model/*, provider responses, requests and unknown source | none | bounded dropped counters only |

Billing trace precedes coordinator settlement; never turn `data.cost` into `confirmedCost`. Registered capability metadata is omitted until its source is explicitly bound; unknown names are not guessed. Runtime event task/request/session links are not trusted correlation. Only hash-verified snapshot `auditContext` supplies optional UUID correlation; canonical run UUID and seq always come from the archive adapter. Old/unbound snapshots have no invented human attribution. Audit correlation accepts only safe UUID scalar fields; legacy free-string IDs are omitted or rejected as appropriate, never copied.

## Interfaces and ownership

- New `observation-summary.mjs/.d.mts/.test.mjs`: explicit mapping plus strict summary validation (4 KiB, 32 scalar leaves, 128-char strings). Descriptor-based field access avoids getters/toJSON and does not traverse ignored bodies.
- `trace-store.mjs/.d.mts` + new `trace-observation.test.mjs`: `observeRunArchive(root,sink):dispose`, root-bounded subscriptions/health, post-fsync emit, bounded verified auditContext attached to existing cursor; no raw snapshot added to a new cache.
- `audit-outbox.ts`: bounded/disposable pool listeners receiving newly committed validated projections; optional telemetry callback failures cannot change durable projection result.
- New `apps/api/src/observability.ts` + `tests/observation-pipeline.test.ts`: `createObservability({traceRoot,db?}) → {offer,snapshot,close}`; subscribe to both original sources, one summary admission path, fixed counters only. Export status stays disabled. Parent owns bootstrap/close in app lifecycle.

## RED/GREEN steps

- [x] Pure mapping tests: nested/raw secrets and arbitrary IDs, getters/cycles/free-text errors, unknown source, safe numeric bounds and immutable fresh summary.
- [x] Trace tests: actual append fsync failure emits none; dedupe once; observer throw/rejection does not change durable append; raw returned event mutation cannot affect summary; hash-bound optional context; repeated subscribe/dispose and resource bounds. Also verify exact serialized bytes, snapshot replacement during fsync, subscription mutation and synchronous reentry.
- [x] Pipeline tests: actual trace plus real PGlite audit projection reach one offer path only after COMMIT; unknown COMMIT emits none; callback failure cannot alter projection; 100,000 fresh synthetic IDs have fixed state size; close/dispose repeats cleanly.
- [x] Implement minimum changes after observed RED, run only focused new/adjacent regression suites, save evidence and freeze owned files for independent review. Parent does final merged type/build after upstream source freeze.

Ruling: no local summary ring because this slice has no consumer for stored records. Fixed counters establish the working sink without inventing an exporter queue. No OTLP delivery or billing truth is claimed.
