# Restricted observation exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans and test-driven-development. No Git mutations; shared main checkout and file ownership constraints override commit/worktree steps.

**Goal:** explicitly enable bounded, nonblocking export of fresh allowlisted summaries, with truthful degradation status.

**Architecture:** keep existing persistence subscriptions; offer validated summaries to an admission gate with 256-record/1 MiB reservations including in-flight work. Isolate the fixed standard OTel SDK/exporter in a worker; release reservations only when its export callback completes. Close stops admission and subscriptions, waits at most 3 seconds, terminates the worker, and exposes unconfirmed records.

**Tech Stack:** Node worker_threads, TypeScript, standard OTel Logs SDK/exporter 0.220.0/resources 2.9.0.

**Spec:** `2026-10-20-enterprise-observability.md` Task 5; research `docs/research/2026-10-29-observation-export.md`.

## Global Constraints

- Default disabled; no worker/provider/network when disabled or invalid.
- Explicit complete loopback URL only, no credentials/query/fragment; reject ambient OTEL configuration when enabled. No remote/header support in this slice.
- No raw prompt, tool/file content, identity, credentials, error text or collector response in exports/status.
- No historical replay, auto instrumentation/global provider, second retry spool or business-state writes.
- Parent synchronous offer does not await network; all pending/in-flight reservations remain bounded.
- SDK success is transport acknowledgement, tracked as unknown final delivery; actual business outcomes are preserved.
- Modify only observability.ts, new observation-exporter.ts/observation-exporter-worker.mjs, owned tests and research/plan/validation docs. Shared manifests only coordinator-owned.

## Review Focus

- Disabled/invalid config creates zero traffic.
- Malicious summaries and accessors fail closed without traversal.
- Overflow/hung transport never grows the parent queue beyond 256 or 1 MiB.
- Partial success and stalled shutdown cannot masquerade as confirmed reception.
- Worker termination/error does not block business or reveal raw diagnostics.

## Task 1: config, admission and lifecycle

- [x] Write owned tests for disabled/invalid, allowlist rejection, bounded admission, failures and duplicate close; observe RED.
- [x] Implement exporter module and isolated worker using existing standard packages; coordinator pins dependencies.
- [x] Verify loopback byte capture, failure/reset/429/503/stall and partialSuccess; inspect counters and close deadlines.

## Task 2: existing observability integration

- [x] Write failing test for fresh offer forwarding and truthful snapshots.
- [x] Forward in existing offer, merge fixed exporter health, retain disabled compatibility and close subscription disposal.
- [x] Run owned exporter tests and existing observation-pipeline/runtime observation tests. Coordinator runs full suite/build once after integration.
- [x] Record actual evidence and limitations in docs/validation/observation-export-2026-10-29.md. No browser/JJ/model acceptance claims.

Implementation rulings: the coordinator approved `observation-exporter-worker.mjs` and runtime direct dependency ownership. One enabled owner per process is enforced; a second owner reports a fixed already-active degradation rather than creating another provider. Disabled roots remain independent. Worker stdout/stderr are drained privately, no raw SDK error/response is forwarded, no global provider or diag handler is installed. Worker environment and execArgv are empty.

Shutdown refinement from RED evidence: waiting 3000 ms before termination took 3011 ms overall. Reserve 100 ms for worker termination by expiring the drain at 2900 ms; the test requires the overall close, including termination, to finish under 3000 ms. This is a Node timer budget, not a real-time scheduling guarantee.

Review corrections: clear the worker reference on exit so a later close is immediate and preserves the true exit code; map fixed event-name body and explicit allowlisted scalar/correlation attributes with `service.name=weiwu` and checked-in package version. Deployment/git labels remain omitted without verified explicit configuration. Both regressions received failing tests and passed after correction; review evidence is in the same validation report.
