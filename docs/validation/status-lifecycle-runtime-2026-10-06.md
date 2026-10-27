# Native status lifecycle engineering validation

Frozen at 2026-10-06 12:44:03 +08:00. The production change is limited to one status-call signal in `product-runtime.mjs`, with an explanatory comment. NEW `status-lifecycle.test.mjs` exercises the actual native Host/AgentTeams lifecycle using loopback synthetic model replies, disposable files and real local Node TAP commands. No original API, gateway/model, database, supplier-billing query or employee file was accessed or changed.

The actual failed normal v8 archive `docs/test-evidence/go-normal-v8-review-abort-20261006-122118.json` remains unchanged, SHA256 `372df14c5430594c6197fc9f26f316ef217f6a62001ce3817b3582e6df9e5889`:

| Event | Observed fact |
| --- | --- |
| 1797 / 2994 | Development / independent QA accepted; these remain predecessor evidence. |
| 3088 | Captain status call `60fb40c5-721d-40ec-afae-53e5499db387` starts at 04:15:21.198 UTC. |
| 3089 / 3097 / 3101 | Old QA Host is disposed; the same QA session begins cold setup and is published again at 04:15:48.501 UTC. |
| 3091 | Captain inbox starts its third model turn during the transition. |
| 3112 | Captain/manager request `8e1cb3bc-5e80-4311-a6c5-c2c11f261db3` is dispatched. This is not the QA review request. |
| 3113 | The same status call returns ABORTED at 04:15:53.494 UTC, 32296 ms after it started. |
| 3115 | QA review admission `aac77ca0-f367-4a9c-8b4c-b4c3971ecfe6` is interrupted with `dispatched:false`; no corresponding QA wire request exists. |
| 3124 / 3126 | The original late captain response settles its known usage; model settlement completes. |
| 3133 | Run remains failed. |

Source inspection closes the local cancellation chain. Native `agent_teams_status` awaits `scheduler.kickTeam`; it can therefore wait for member dispatch and cold Host resume. The native tool runtime preserves the caller's signal and normalizes a completed body into ABORTED when that signal expires. The product loop independently supplied a 15-second timeout to this status call. The recorded cold transition exceeds it; there is no preceding provider failure, supervision anomaly or approved-run deadline event in the archive. The resulting status error stops model admission, interrupts the unsent QA request and drains the already dispatched captain request.

The product loop now passes `job.controller.signal` to status. The original approved run deadline and explicit user cancellation still abort that signal. Setup/approval timeouts, model limits, budgets, DAG, completed-node seals, fee settlement and retry rules are unchanged. No vendor or `node_modules` patch was made. The separate API admission-count correction and optional inherited `callsBasis` propagation belong to the parent team's work, not this change.

**Final 25/25 targeted tests passed**, 0 failed, cancelled, skipped or todo. NEW 3/3 covers a 16-second native cold-setup delay across the same QA's verification → review transition through manager completion, explicit user cancellation before a later node dispatch, and the approved run deadline preserving accepted predecessors. Existing Host isolation, native checkpoint recovery, settlement and supervision tests also passed. These are engineering fixtures, not real employee/model acceptance.

The first 25-test batch also passed, but its source-stability wrapper exited 3 because the other agent changed the optional inherited-budget metadata source during that run. That result is retained in the text log. The final recheck ran after that source froze and ended with `FINAL_EXIT_CODE=0` and `FINAL_SOURCES_STABLE=True` for the runtime, new tests, Host, employee factory and inherited-budget dependency. Full output is in `status-lifecycle-runtime-2026-10-06.txt`.

Frozen SHA256:

```text
9c9747ad48fdd8cacbee02947e04e544c3a69ce0566bde7d6c40e715c550e05b  services/agent-runtime/product-runtime.mjs
e3e40f4e5e25ae07a47301582d83759d99e60f17c85bca75b99f3f88951614fd  services/agent-runtime/status-lifecycle.test.mjs
e5b7da3646c0918ffc2b064e54991bed0360afcaa5957832c154ecd94cbafaf3  services/agent-runtime/host.mjs (read-only)
1543d40d420d29a171f863cccb00da4885f1fc278ff9937d3b50f3fcbd40b7ca  services/agent-runtime/employee-hosts.mjs (read-only)
6985ab3fd12379f2022c46d7e230f85dcc899d9b61e5c6ad2405a24a2bce7737  services/agent-runtime/run-evidence.mjs (other agent's frozen dependency)
```

After controlled reload, actual same-version v8 recovery must independently verify its development/QA seals, unchanged files, all admissions/calls, original unknown reserves and remaining review/manager work. This report does not erase the failed run or claim that the restored or separate full v8 path has passed.
