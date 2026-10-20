# Final batch independent review

2026-10-20. Verdict: **CHANGES REQUIRED — one P2 finding.**

Reviewed the current checkpoint/live-reader batch against baseline `68085f5`, including committed restore guard `ae3785f` and the named new helpers/tests. Read AGENTS.md, the integration plan, current validation report and previous independent reviews. No source/test changes, database, JJ, model, installation or large test runs. Only this report was written; one memory-only Node check exercised production validators, redaction and digests.

## P2 — Archive redaction silently invalidates a successfully published v2 checkpoint

Location: `services/agent-runtime/step-checkpoints.mjs:75–78`, interacting with `services/agent-runtime/trace-store.mjs:12–17,51` and checkpoint validation at `step-checkpoints.mjs:175–182`.

The new writer redacts boundary/receipts, then spreads raw immutable task refs into metadata and hashes them. The existing archive append recursively redacts that whole record again. A legal path such as `docs/sk-abcdefghijkl.txt` becomes `docs/[REDACTED].txt` after the digest is calculated. The append still returns successfully and the writer returns its original record; consequently Handoff can publish a successful committed seal without detecting that the stored checkpoint is unreadable. Both its outer SHA and its canonical manifest revision are now invalid. This is in the supported nonrecovery codec/publication path, not a request to enable a pending recovery module.

The memory-only reproduction called actual `validArtifactPath`, contract `isArtifactPath`, desktop `validPath` and `validateTaskCheckpointRefs`; all accepted that filename and metadata. Applying the writer's metadata/digest sequence followed by the actual `redact` yielded:

```json
{"path":"docs/sk-abcdefghijkl.txt","isArtifactPath":true,"refsValid":true,"storedPath":"docs/[REDACTED].txt","checkpointHashMatches":false,"canonicalHashMatches":false}
```

Required correction: make typed immutable checkpoint references and archival redaction consistent before declaring publication successful. A narrow fail-closed rejection of redaction-changing refs is sufficient for this cohort; an explicitly bounded typed archive policy is another option. Do not merely redact paths and regenerate canonical/scope identities, since those must remain bound to the actual committed objects and SQL records. Do not weaken general archive secret redaction.

Add a focused real archive writer/reader regression with a valid redaction-matching path, including one only present in the complete canonical manifest. It must either round-trip the exact authenticated refs or reject before publishing a usable checkpoint/committed seal. The existing v2 codec tests cover corruption, missing objects, malformed refs and append failure, but not this post-hash transformation.

## Other integration checks

No additional actionable P0–P3 finding identified in the reviewed scope. The private API publisher runs after actual COMMIT; the wrappers await exact-operation refs; synchronous publication failures retain the global fatal latch; the consumer selects actual SQL canonical plus original committed-operation proof; accepted work uses the separately checked task work revision; coordinator and app callers pass the selected complete manifest. The restore guard is inside the restore transaction before clearing/swapping, with protected-table locks and closed failure behavior.

Inspected final Product log: 3/3, approximately 124.17 seconds; the saved summary contains 36 operations, six sandbox identities and seven approvals. Read current reader/acceptance regression output and final build log. These supplied fixture results support the current integration but do not cover the finding above; they were not independently rerun.

Task 5 recovery/provenance, maintenance/capacity and task backup, and Task 6 physical acceptance remain explicitly pending with the profile closed. They are not new findings. No native task concurrency, physical JJ/OpenShell, paid-model or production certification is made here.
