# Terminal accepted-stop product engineering evidence

All four serial, isolated runner invocations passed with explicit exit code 0, signal null, no wrapper timeout, and identical start/end SHA maps for all 20 sampled source files. The three-project invocation executes all three projects inside one test, one database, and the same actual OpenShellDeviceExecutor and journal. It does not clear SQL or rebuild the device between projects.

| Scenario | Test result | Whole process time | Evidence prefix |
| --- | --- | --- | --- |
| Normal A developer → B independent QA → C manager | 1 pass / 0 fail / 0 skip | 89.802 s | terminal-product-normal-1792513681309 |
| Three consecutive complete projects, same executor/journal | 1 pass / 0 fail / 0 skip | 268.829 s | terminal-product-three-projects-1792513831874 |
| A partial historical head / B advanced full head interleave | 1 pass / 0 fail / 0 skip | 168.016 s | terminal-product-interleave-1792514178280 |
| Lost stop response / cold original-ID observation | 1 pass / 0 fail / 0 skip | 32.771 s | terminal-product-loss-1792514373232 |

The three-project test duration was 263.327 s (test timeout 570 s; runner deadline 590 s), below the 600 s bound. It retained nine distinct stopped scopes, nine accepted-stop intents/results, and 57 original HTTP/CAS operations and claims. After each project it reread prior complete SQL rows, claim hashes, canonical heads/objects, event-file hashes, exact device journal hashes, and actual remote file manifests, comparing them with the prior snapshots. Final C follows its accepted node checkpoint and final durable team checkpoint, then the original sandbox stop confirmation, then run/finished. The original two running slots, 128 retained-scope limit, disk reservations and storage limits were not widened. The observed maximum running count was one.

The loss scenario ends at the intentional cold reconciliation boundary: original-ID get confirms the completed stop without replaying stop/start/create/exec/delete or preparing the next scope. It is not a completed three-task run.

These are zero-paid-call engineering fixtures: actual ProductDshRuntime/Host/Handoff/HTTP/CAS, actual OpenShellDeviceExecutor, schema-2 journal/queue, actual REMOTE_SCRIPT and Node subprocess file tests. Model selection, CLI transport, UID/cgroup, gateway/mTLS and the PGlite-backed SQL service are bounded test fixtures. No saved or paid model API, physical JJ/OpenShell service, native PostgreSQL deployment, installation, Git mutation or public profile opening was used. This is not real business acceptance or physical deployment proof. Retained stopped scopes and disk reservations remain; scope retirement/deletion and unlimited project throughput are outside this evidence.

Source identity is in terminal-product-final-source-sha.json. The unchanged helper is SHA 7270cb220a9f40389ff95eee9c118a5be82b994b123c18e9d8a9cd73bb2ee384; the owned test is SHA 5875aff4764cd84d03513ea8ae7932ba2c2aa33efdcefcb20a79e9e5d14445a2. Production accepted-stop is SHA 928fcb46e1e6007823e814c4818d1efb27c0fff8bdd847a2e508a9d9731adb7d; product runtime is SHA 1dd37089e6e49fa2e328ddff9ec8c23f94bc5a1d3beecc0544de7231c63661a8.

The runner snapshot records the exact commands, deadlines and source sampling, but reproduction must use the original workspace-relative runner location recorded in the source map; moving it changes its own sampled SHA. Each isolated invocation uses its own PGlite service, while the three-project test keeps its single database and executor throughout all three rounds.

The static independent review is separate from the four actual running results. The earlier 185.193 s whole-file worker failure and stale 109-byte TAP-only attempt remain nonpassing historical evidence in ../accepted-task-stop-product-2026-10-20/. This successful bounded three-project invocation does not diagnose those earlier failures or validate the old whole-file invocation. Earlier historical cd98427b and 79ba4d74 evidence remains unchanged.

This candidate package contains bounded ID/key/sequence/phase/SHA/call-count summaries. Full CLI commands, full event arrays, repeated REMOTE_SCRIPT/stdin, raw claim tokens, full authority/capability proofs and private configuration are omitted. Private original logs/summaries are preserved; manifest.json lists hashes and projection/redaction details. Root owns the final integration report and publication decision.

A later read-only packaging check observed post-run source drift in apps/api/src/app.ts. See post-run-current-source-check.json for tested and current hashes. All four results apply to their recorded start/end source map; this package does not assert coverage of later changes. No test was rerun after this observation.
