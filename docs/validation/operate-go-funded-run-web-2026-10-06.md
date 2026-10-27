# Go funded operator engineering validation

Frozen at 2026-10-06 10:34:15 +08:00 after the bounded approval-card loading fix. The NEW helper preserves the two existing funded projects and binds their actual HTTP 200 replanning confirmations (version 4 → 5) to the complete generated plan, policy, requirement, source-file SHA chain, supported DeepSeek route, public model configuration hash and tool-capability test identity.

`node --test tests/go-funded-operator.test.mjs`: **8 tests passed, 0 failed, cancelled, skipped or todo**. These are pure synthetic guard fixtures; they make no API or browser requests and are not employee delivery or real model acceptance. No employee files, original database, credentials, supplier billing or fee settlement were accessed. The full output and frozen source hashes are in `operate-go-funded-run-web-2026-10-06.txt`.

The parent's captured normal command attempt `funded-run-web-normal-command-2026-10-06T02-31-41-928Z-39045114.json` failed during initial rendering with zero POSTs and no action receipt. The command branch now waits up to 15 seconds for the visible approval card, exact approval button and argument display, then requires each to be unique and matches the full displayed arguments to the already selected GET record. The existing durable claim, workspace SHA, pending-request identity, funding and POST checks remain intact. The 8 fixture tests passed again after this change; actual UI execution remains for the parent operator to verify.

Read-only validation of the provided actual JSON files passed for both scenarios. Normal retains the cached-read → original paid-generation chain, usage `f8a89329-fe9b-4ccb-972d-0b7424c3bce1` and original planning fee `$0.0067287`; recovery retains usage `c609903e-ab3d-4d3c-b327-b2385953c204` and `$0.0060192`. Zero new inference on cached generation does not erase the original paid fee. See `operate-go-funded-run-web-2026-10-06-source-binding.json` for the compact result; this validation issued zero real API requests.

The copied `fundedBudgetGuard` is identical to the original function. Funding limits, outside-project attribution, unknown reserves, pending/native-operation restrictions, exact project/version/run identity, command/workspace checks and one-POST intent guards remain enforced. Fresh observation also verifies the confirmed project contract and public model/gateway configuration; run archives must match the full approved task contracts and single approved route. Inspect deliberately aborts the webpage's cost-expiry maintenance read and records it as `suppressedMaintenanceReads`. Unexpected mutations still block the action.

Frozen source SHA256:

```text
cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3  docs/test-evidence/helpers/operate-go-funded-run-web-2026-10-06.mjs
29bac218545ff57d311bf7d8e480606f48800f73366a6ef9838c726f290d1dff  tests/go-funded-operator.test.mjs
```

The original operator, stop helper and audit helper were left unchanged. Existing unknown costs remain reserved, and supplier-billing/finance acceptance remains independently blocked until supported by its required evidence.

For the parent operator's authorized actual normal inspection, use these arguments with the existing Node runtime. This command was **not executed** by the validating subagent. Approval uses the same arguments with action `approve`, after inspecting the current state. The webpage origin is port 4310; port 60546 is the API and is not the browser base URL.

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  'docs/test-evidence/helpers/operate-go-funded-run-web-2026-10-06.mjs' inspect `
  --scenario=normal `
  --normal-project-id=4938eab8-26ed-4f60-9413-d979f05fa968 `
  --recovery-project-id=3e101c24-87e6-43ea-80f9-a2c4b0b410f4 `
  --version=5 `
  --confirmed-evidence=docs/test-evidence/go-normal-confirm-2026-10-06T01-49-58-426Z-78c51eb2.json `
  --generation-evidence=docs/test-evidence/go-normal-recover-known-2026-10-06T01-48-07-081Z-52ec172c.json `
  --go-model-id=fcce40cf-3172-4863-b0bd-776673f499e6 `
  --retain-uncertain-costs=true `
  --base-url=http://127.0.0.1:4310/
```

No actual Go run, command approval or cancellation was performed in this engineering validation. Those outcomes require the subsequent actual UI evidence captured by the parent operator.
