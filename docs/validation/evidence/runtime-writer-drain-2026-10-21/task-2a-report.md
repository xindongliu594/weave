# Task 2a implementation report

Status: implemented and locally verified; independent review/commit remain owned by root. Baseline supplied by controller: `f3c451c`. This implementer performed no Git operation, paid model call, dependency change, production/JJ access, deployment, credential access, or production database action.

## Behavior and scope

- Adapter exposes one non-writable `writerDrained` promise. It settles only after permanent admission stop and every original request finally, including undispatched admission, provider metadata, usage and error accounting. Existing dispatched-only bounded `drain` semantics remain intact.
- Runtime returns business completion and separate observed actual drain. It retains original Host creation/lifecycle, shared Host/executor cleanup and adapter references until safe drain. Timeout preserves the original close. Cleanup rejection/unproven native startup latches a sanitized failure and keeps admission blocked, without rewriting accepted business results or unknown fees. Pre-Host preparation failure closes only resources actually constructed.
- Host/employee lifecycle tracks original setup callbacks and retains failed unpublished resources. Native startup with no returned handle remains `RUNTIME_WRITER_DRAIN_UNPROVEN` after known callbacks end; no successful allSettled shortcut certifies abandoned storage cleanup.
- New `host-lifecycle.mjs` uses pinned Cordis 4.0.2 public `ctx.logger.exporter` records and public fiber state to detect rejected unload cleanup. Fixed source basis: `services/agent-runtime/node_modules/@deepseek-ai/cordis/src/fiber.ts`, `FiberState.UNLOADING=5`, `_unload` catches each disposer failure and calls its Context logger while unloading; `src/logger.ts` exporter record has fiber WeakRef and severity. Each observer belongs to its own newly constructed root Context/logger service, including employee Contexts; it cannot observe another Host's logger. It records only error records from unloading fibers, leaves the observer/fence retained on failure, and detaches only on proven success. Existing employee isolation test adds explicit active `ACTIVE_BUSINESS_ERROR_CONTROL` log and retains real active model-failure control; both close successfully.
- Coordinator distinguishes executing, draining and drain-failed entries. SQL terminal persists before actual drain release; draining entries do not renew leases or receive heartbeat cancellation. Original in-flight heartbeat is joined. Close is shared, joins originals and explicitly rejects retained drain failures. Missing runtime contract preserves business completion but latches unproven; consumer fixtures explicitly supply drain and workspace-preparation contracts.
- RunSandbox reuses original remove Promise per container generation, blocks restart on pending/failed cleanup, observes abort-triggered close, and preserves successful sequential terminal/terminal_test generations. No extra Docker command/permission was introduced. Ambiguous failed startup is conservatively unproven.
- `index.ts` observes one shared shutdown rejection and stops before pool.end/normal exit on failure. No real process-signal/database shutdown test was run; coordinator close behavior is tested directly and composition was inspected.

## TDD and verification evidence

All logs are adjacent to this report. Each completed command log includes exact command and actual process exit. No full project suite was run; controller explicitly restricted testing to affected bounded suites. PGlite commands use the existing isolated runner (fresh in-memory DB/file, ephemeral loopback); no production fallback was used.

| Evidence | Actual result |
| --- | --- |
| `task-2a-red-adapter.log`: `node --test services/agent-runtime/writer-drain.test.mjs` | exit 1, 6 expected missing-writerDrained contract failures before implementation |
| `task-2a-red-native.log`: focused unpublished-native/held-native/sandbox cases | exit 1; unpublished native setup genuinely falsely completed; the other two cases also encountered sandbox native filesystem/environment failures and are not counted as behavioral RED |
| `task-2a-red-sandbox.log`: sandbox-close.test.mjs | exit 1, 2 expected original-close identity failures before implementation |
| `task-2a-red-coordinator.log` | exit 1 before test assertions, Windows sandbox local socket connection failure; environment failure, not behavioral RED |
| `task-2a-red-coordinator-ordinary.log`: isolated SQL terminal retention focus | exit 1, 2 expected retention failures before coordinator implementation |
| `task-2a-red-heartbeat.log`: isolated in-flight heartbeat focus | exit 1, expected 1 unwanted recancel; fixed by checking that the original active entry still exists and is executing |
| `task-2a-green-unit.log` | exit 0, 8/8: 4 original adapter callbacks, 2 pre-Host cleanup cases, 2 per-generation sandbox cleanup cases |
| `task-2a-native-focused.log` | exit 0, 2/2 real DSH failed/unpublished original setup cases |
| `task-2a-green-native.log` | interrupted via Ctrl-C/tool exit 1 after sandbox employee isolation timeout left event loop pending; terminal cases had passed individually, no suite success claimed |
| `task-2a-green-runtime-ordinary.log` | exit 1, 39/40; meaningful new real Cordis disposer-rejection RED (public fiber.dispose swallowed its rejection) |
| `task-2a-green-runtime-final.log` | exit 0, 40/40 after public lifecycle observation; includes checkpoint-policy 7 and sandbox generations 2 |
| `task-2a-green-lifecycle-regression.log` | exit 0, 44/44 after retaining task fences and restoring ordinary failure-path Host-close ordering; final affected Host/runtime source behavior |
| `task-2a-green-integration.log` | exit 1: coordinator21 + lease9 passed; work-file fixture 2/3, one ENOENT because its old runtime stub omitted source-only prepareWorkspace; fixed explicit fixture contract |
| `task-2a-green-integration-final.log` | coordinator23/23, lease9/9, work-file3/3 all passed; then run-state atomic case passed. Entire command interrupted/tool exit 1 because next native-only row-lock/pg_stat_activity test cannot progress on single-backend PGlite. No whole-command success claimed. |
| `task-2a-run-state-safe.log` | exit 0, 2/2 PGlite-compatible recovery state regressions; native-only concurrent row-lock test excluded |
| `task-2a-build.log` | exit 2, one ActiveRun union-inference type error; corrected by explicit type annotation only |
| `task-2a-build-final.log`: `npm run build` | exit 0, project tsc and Vite build passed; existing >500kB chunk warning remains |
| `task-2a-declarations.log` | exit 0, explicit strict tsc with skipLibCheck not enabled for both changed .d.mts declarations |

Final lifecycle command:

```text
node --test --test-force-exit --test-concurrency=1 --test-timeout=35000 services/agent-runtime/host-admission.test.mjs services/agent-runtime/deadline.test.mjs services/agent-runtime/delivery-settlement.test.mjs services/agent-runtime/model-settlement.test.mjs services/agent-runtime/terminal-finalization.test.mjs services/agent-runtime/employee-hosts.test.mjs services/agent-runtime/writer-drain.test.mjs
```

Explicit declaration command:

```text
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --types node services/agent-runtime/product-runtime.d.mts services/agent-runtime/openai-compatible.d.mts
```

Windows sandbox Temp native MoveFileExW EACCES and loopback limitations required bounded ordinary-Windows tests with require_escalated. Ordinary context resolved those native/transport limits. A dedicated workspace `.superpowers/task-2a-fixtures` TEMP/TMP tree was used once; after verifying the absolute target is exactly that workspace child, it was removed with native PowerShell. Arbitrary unrelated untracked files were preserved.

## Boundaries and remaining concerns

This is actual participating-writer lifetime retention only. Task 1 native primitive is unchanged and unwired. No source fencing, source recovery approval, native PostgreSQL lock-order certification, cross-process recovery acceptance, real Docker/device process-quiescence proof, model quality, or production rollout is claimed. Historical unknown reservations and accepted nodes remain governed by their existing policy; the isolated SQL tests preserve their exact original receipts.

Unproven native startup remains intentionally quarantined without retry/clear API. Future pinned Cordis version changes require rechecking its public state/logging behavior and retaining the real native disposer regression. New test fixtures remain consumer-only where declared; producer claims come from actual adapter, runtime, Host and DSH tests. Independent review is pending with root.

## Final source/test allowlist and SHA-256

The following are the only production/test files intentionally changed by this implementer. Root-owned docs/evidence and any other pre-existing working-tree files are excluded. Exact hashes are also in `task-2a-source-sha256.txt`.

```text
7fffb957ad258780437266e03d2f41e8c7515e837a35993eba02065900a5a24c  services/agent-runtime/openai-compatible.mjs
1171730a786178188b7060d4bdb06878e47c949a67502e2a79ac730cf47e2f7c  services/agent-runtime/openai-compatible.d.mts
7f614ba74297f19626dee2cf240cc73aff8750764ee6ee0231974ba7d2471b44  services/agent-runtime/product-runtime.mjs
1b96450e2c978d539cfc7866357f89933afbbd6fe4f9276f17cdc5b6e53e6e6f  services/agent-runtime/product-runtime.d.mts
c4185b391e7bfbf5c51fada615ab11da3978cd12ab93afb062a895e15de355c1  services/agent-runtime/host.mjs
ceecc21c3c2f4467df8876d1bf025cc9e33de4669d666f4ebd33bcfa8ab7c648  services/agent-runtime/employee-hosts.mjs
2088a687ac8f8b566fe99bca8b3e660183136eeb815384e437b5d8b8f184f21d  services/agent-runtime/host-lifecycle.mjs
fd4773923aa334fba5603fcd67267d46833975a99579fc79bf57e45c3ff027de  services/agent-runtime/sandbox.mjs
777a914838fcffddc7b431bb2be063745815a0dcc4e5759b0b2969539c9c1a24  apps/api/src/run-coordinator.ts
5b18045f2b5dd2c653382b862ca23a282574f25f17b2a1aedea65a716a8fc1c0  apps/api/src/index.ts
0992ccf05b097e055273ab6c3ca82a47dacdad280652c5081997ca8f18fe1393  services/agent-runtime/writer-drain.test.mjs
9df609d48ad2258697ba6f3b61d8c40e891bc710ae0823e66e6cdf05e1144367  services/agent-runtime/sandbox-close.test.mjs
f070757244180d18adf2ef1c6ccc1d704f0cbf2776916c693fbe6f71973b0660  services/agent-runtime/terminal-finalization.test.mjs
4e9b56ebe352b94f72b748256973cd4f319a7c194825573837fd9ec8caccf8cf  services/agent-runtime/employee-hosts.test.mjs
51208292edc94b0db63d0755115c43e55b2ec0c8f4a4aee6782a721a897ebca8  services/agent-runtime/model-settlement.test.mjs
6bc3548ca0c3806d0f6e4935810968d517ab8b64d003a0f9e4a455d2842e77cd  services/agent-runtime/host-admission.test.mjs
ffd96bc207f75004f4bd4d18331bfc81376255ce3d20bdc889ee908a05062720  tests/run-terminal-maintenance.test.ts
1520f5769e885629d6ef09db731d9bb82a1d80d8e2a848fddd3a890d56d47836  tests/run-live-lease.test.ts
21143e0c604918bc70566738b3594f4f7f9db36feff81d62e8afa96710051268  tests/work-file-project.test.ts
```
