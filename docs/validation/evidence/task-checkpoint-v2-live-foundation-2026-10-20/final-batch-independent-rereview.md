# Final batch independent re-review

2026-10-20. Verdict: **PASS for the reviewed nonrecovery checkpoint/live-reader foundation batch.** The P2 in `final-batch-independent-review.md` is resolved; no remaining actionable P0–P3 finding was identified in this narrow re-review.

Read-only inspection of the changed `step-checkpoints.mjs`, added `task-checkpoint-v2.test.mjs` cases and supplied `metadata-red.txt` / `metadata-green.txt`. No source/test changes, database, tests, installation, JJ or model calls. Only this report was written.

The fix closes the reported successful-publication gap:

- `step-checkpoints.mjs:38` rejects refs that archival redaction would change. This shared validator also runs in the trusted API publisher and Handoff binding, so the complete canonical manifest is checked even when the filename is absent from task work.
- `step-checkpoints.mjs:76–78` checks the complete v2 metadata, including boundary and receipts, before hashing or appending. It preserves the authenticated references rather than redacting/recomputing SQL canonical identities.
- `step-checkpoints.mjs:80–81` clones the expected record before append and compares returned `event.data` with that clone. An unexpected returned transformation throws; in-place mutation cannot change the expected comparison copy. The existing Handoff publication catch then sets the global fatal barrier and does not publish the committed seal.
- General trace-store redaction remains intact. The v1 branch is unchanged. The explicit compatibility limit is that v2 metadata containing strings altered by the existing redactor—including otherwise legal secret-shaped filenames—is refused with `CHECKPOINT_METADATA_UNSAFE`. This is fail-closed unsupported input, not silent metadata rewriting.

The four new behavioral regressions use actual archive fixtures. They cover own-work and canonical-only filename cases, boundary/receipt transformations, and an altered append return through real Handoff commit. They assert zero checkpoint publication for the preflight failures; the post-append case preserves the already durable historical event, leaves the committed map empty and blocks another task/generation. The inspected RED reports 0/4 because the expected rejections were absent; GREEN reports 70/70 with no skips or failures. The returned-data test uses a replacement object; resistance to in-place mutation is established by the pre-append structured clone in source, not separately claimed as tested.

The prior broad review's other wiring checks remain applicable. Existing whole-Product and reader results predate this small codec fix; they are not represented as newly rerun here. The profile stays closed, Task 5 recovery/provenance/maintenance/capacity/task backup and Task 6 remain pending, and this PASS makes no physical JJ/OpenShell, native task-concurrency, paid-model or production claim.

## Addendum: private canonical error text

**PASS** for the subsequent one-line privacy correction. At `step-checkpoints.mjs:63`, failed referenced-object validation still throws immediately, but now uses only `CHECKPOINT_CONTENT_INVALID`; it does not include the private canonical filename or preserve it through an error cause. Object validation, identity/digest checks and failure propagation are unchanged. The legacy reader branch is untouched.

The new test at `task-checkpoint-v2.test.mjs:42–45` corrupts the actual object for `private-b.txt`, which is present only in the full canonical fixture, and requires the exact generic error. `private-error-red.txt` shows the intended former failure with that filename disclosed. The now-completed `runtime-root-final.txt` records 71/71 passing, no skips/failures. This was a source/log review only; no tests or other operations were rerun by this reviewer.
