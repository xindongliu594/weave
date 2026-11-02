# Observation export research — 2026-10-29

Scope: D2 Task 5 only. Existing `createObservability` already subscribes to committed archive/audit projections. `validateObservationSummary` strictly rejects extra fields/accessors and bounds the serialized summary to 4096 bytes. Do not replay files or extend the summary contract.

Installed runtime package evidence: `@opentelemetry/sdk-logs`, `api-logs`, `exporter-logs-otlp-http` are 0.220.0; `resources` and `core` are 2.9.0; `api` is 1.9.1. These are currently transitive runtime dependencies, absent from the root manifest. Explicit direct dependencies need coordinator ownership.

DSH 0.1.5-rc.1 `dsh-session-telemetry-otel` uses feedback-triggered session replay, with `FEEDBACK_ONLY`/`DISABLED`. Its capture policy cannot implement this product's strict, fresh-summary-only stream. Reuse its mature OTel SDK/exporter, not its session capture backend. No separate telemetry protocol or monitoring platform is needed.

Sources inspected:

- [Official JS exporters](https://opentelemetry.io/docs/languages/js/exporters/)
- [Fixed SDK source tag](https://github.com/open-telemetry/opentelemetry-js/tree/experimental/v0.220.0/experimental/packages/sdk-logs)
- [DSH official repository](https://github.com/deepseek-ai/deepseek-harness)
- Local `services/agent-runtime/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-telemetry-otel/lib/index.js`
- Local SDK `LoggerProvider.js`, `export/BatchLogRecordProcessorBase.js`, exporter `platform/node/OTLPLogExporter.js`, exporter-base `otlp-export-delegate.js`, `logging-response-handler.js`, `transport/http-transport-utils.js`.

Fixed-version findings: provider takes `processors` in its constructor; batch processor takes exporter/options. Batch queue defaults are too broad. Explicit values will be 256 queue, 32 batch, 1000 ms schedule, 2000 ms processor/transport deadlines, concurrency 1, 3000 ms outer close. SDK retries remain its own; no second retry spool.

Crucial limitation: OTLP delegate reports SUCCESS even on partialSuccess, malformed response, or a successful HTTP response interrupted during reading. It may send raw collector response to global diag. Ordinary callback success is therefore only transport acknowledgement, not proof of all records received. Proposed integration isolates SDK in worker_thread, sends only fixed result codes to parent, and reports acknowledged records as exportedUnknown, keeping exportedSuccess zero. Business success/failure/unknown in the validated summary remains unchanged.

Only explicit loopback `/v1/logs` configuration is in this slice. Remote recipients and secret-header support remain disabled pending recipient/configuration review. Disabled mode creates no worker/provider/network; enabled mode rejects ambient OTEL configuration rather than inheriting it. No production configuration, model calls or external collector is used during development.

Review alignment: Task 5 step 6 requires fixed event-name body plus scalar correlation attributes, rather than a JSON summary body. The worker uses an explicit field-to-attribute mapping, `service.name=weiwu`, and root-package `service.version`. Deployment/git identity is omitted because none was explicitly configured or verified for deployment. Real receiver assertions cover this contract.
