# Task 5 plan independent review — CHANGES REQUIRED

Reviewed 2026-10-20. Read-only review of the original Task 5 plan, `2026-10-20-task-checkpoint-v2-integration.md`, both interface maps and the relevant current contracts/runtime/API/device/backup sources. No application source, database, model, JJ service, dependency or Git history changed. This review file is the only output. No tests were run, and planned RED cases are not test evidence.

The architecture is sound: private awaited refs into synchronous checkpoint publication; separate task work and complete canonical manifests; source-pinned child NULL-only initialization; current permission and SQL unknown checks; committed-object readers; exact task-key maintenance; existing OpenShell stop/delete journals; and inert restored operation history. These choices do not require another engine. The following small contract decisions must be recorded before their respective implementation cohorts start. They do not require another user approval.

## 1. Recovery source and initialization contract is not fully frozen

**Gate: recovery implementation and recovery-bearing v2 codec cases.**

The continuation plan lines 16–17, 33 and 35 require checkpoint provenance and restored own-output ancestry, but do not fix their durable carrier/schema. Current `TaskInputOrigin.source` only supports `import | accepted` (`packages/contracts/task-execution.ts:6`); current `initializeTaskCanonical` scans artifacts and publishes only a head (`apps/api/src/task-canonical.ts:91–104`). Its existing-head branch simply returns the current head. Naming “recovery-initialization provenance” alone does not specify what survives a lost COMMIT response, a later child merge, or a missing archive append.

Before that cohort, record:

- An explicit checkpoint-origin variant (or an equally strict source-bearing record) resolving to the source checkpoint's full key, source run/object owner, checkpoint ID/SHA and exact path/SHA. Do not encode restored own outputs as current-run accepted work. Reuse the existing import/accepted variants unchanged.
- The exact durable initialization field/location, version and digest. Its minimum binding is child run, approval-pinned source run/head, selected checkpoint ID/SHA, validated authorized delta and resulting initial revision. Publish it atomically with the child NULL→candidate CAS and retain it after subsequent head changes. Initialization retry validates this marker and the actual child head; it never resets a newer head or requires a fabricated operation receipt.
- Whether a repeated initialization of an already initialized child may finish bookkeeping after source changes. Authenticate the original marker/publication first; a new or uninitialized child must still reject a changed approval-pinned source. Do not conflate these two cases.

**Concrete planner compatibility case — root ruling accepted during review:** if A's selected checkpoint precedes creation of a later A output, that checkpoint lacks a current A path. Building the restore scope against current canonical requires reading the existing output (`task-workspace.cjs:73–77`), and literal checkpoint export then fails “Imported files cannot be deleted” (`:112–115`). Root selected explicit refusal when the source's current A-authorized import path set differs from the checkpoint work path set. Task 5 supports same-path-set content rollback while preserving B. Record that limit in the plan, user-facing failure reason and named RED case “A checkpoint → A creates another allowed output → B commits → select old A”: no child head published and source unchanged. This case needs no further design decision. Do not silently retain the extra file as checkpoint content or relax deletion rules; future owned-output omission in a new child requires separate design and does not cancel the broader C2 goal.

## 2. Source/target verification compatibility needs a concrete comparison rule

**Gate: inherited verification and recovery admission.**

The continuation plan line 25 correctly rejects comparing identity-bearing source and target hashes directly. The map (`checkpoint-map.md:47,94`) still delegates the actual semantic comparison to implementation. Current `validateInheritedEvidence` compares one environment digest and current whole-workspace files (`step-checkpoints.mjs:132–160`), so that code cannot simply be reused with new identity-bearing hashes or the full canonical cache.

Freeze the positive rule: authenticate source checkpoint/key/archive owner and original operation/sandbox evidence first; compare unchanged task contract, exact task work/input/source ancestry, current permission/capability versions and admitted backend/policy/resource identity separately; then bind a fresh target run/attempt/generation/session/sandbox. List the identity fields intentionally fresh and the backend/permission fields required equal. Task byte revision is not full canonical revision. Any inherited command must retain its original operation/source identity and `inheritedFrom`; a historical terminal approval authenticates history and never authorizes target dispatch. A v1 pass is never task-profile proof.

An acceptable smaller first rule is to refuse unfinished-task verification inheritance for v2 and require fresh verification, while keeping completed source acceptance records as historical source records. If that is chosen, state it and test it; do not silently report evidence reuse as implemented. The SQL unknown index must cover the source ancestry and later source history before either route, even when JSONL says finished or acknowledgment is true.

## 3. Accepted-task stop is required, but its trusted delivery seam must be named

**Gate: accepted-stop/capacity cohort; not a reason to block pure checkpoint work.**

The added capacity ruling is correct. `stopAcceptedTask` exists (`openshell-executor.cjs:387–394`), only confirmed stopped rows release running capacity (`:261–266`), and ordinary completion stays ready. Current production `LocalDeviceClient` only dispatches poll jobs through `executor.execute` (`local-client.cjs:50–79`); the tool allowlist has no stop control (`openshell-executor.cjs:271`). `SandboxMaintenance` currently has no stop method and requires the entire run completed (`storage-lifecycle.ts:4,8–17`). Merely adding a method to `LocalRunExecutor` is insufficient.

Record one concrete existing delivery seam and its owner before edits: for example, the trusted in-process maintenance provider already passed by `scripts/local-api.ts:46`, expanded narrowly for accepted-task stop, with unsupported deployments failing closed. If a device poll control is instead required, name its existing operation/claim journal binding and strict internal dispatch discriminator. In either case models cannot supply the three boolean proofs. Verify accepted + durable v2 checkpoint + settled operations/current authority in the API, persist original key/sandboxId/work revision before dispatch, and recheck expected sandboxId inside the serialized device boundary (the current helper only tests work revision).

Keep the stated no-replay rule: interrupted/unknown stop queries the original object and validates Stopped, never resends stop, creates a generation, or treats absent/retired as stopped. The planned three-task product fixture is necessary; direct helper calls alone remain insufficient.

## 4. Read-only backup evidence requires an exact carrier, DTO and claim fence

**Gate: all task backup export/restore edits and restored-source recovery admission.**

The plan correctly selects inert source evidence instead of inserting historical operations into live tables, but `consumer-map.md:91` explicitly leaves the carrier/query interface to root. This is the remaining security/interop contract, not an invitation to implement a second runtime. `local_operations` has a live device FK and `claim_token` (`product-schema.ts:72–75`); poll/start/result consume these identities (`local-execution.ts:317–351`). Raw `SELECT *` operation export is therefore not the promised credential-free task evidence DTO.

Before backup edits, fix the location/version of the immutable source-evidence record within the existing archive/envelope, the exact allowed fields and digest/reference rules, and the one trusted reader used by backup validation and source unknown/provenance checks. Preserve original statuses/payload/result/late-result/merge conclusions as facts, but exclude executable claim tokens, device authentication and OpenShell management material. Device/grant IDs may remain inert historical references. Restored scopes are historical records, never active `task_attempt_workspaces` rows. Unsupported/missing evidence must fail closed; absent live `local_operations` rows after restore cannot be interpreted as “all operations resolved.” Enqueue/poll/claim must have no path to this carrier. Test restored started/queued/unknown history and attempted ID collision against a live operation.

Also freeze the completion claims: current online backup deliberately includes encrypted business credentials plus `master` (`backup.ts:30,54,69`). “New task evidence contains no execution/management credentials” is supportable; “the whole backup excludes all credentials” is false. Unknown but structurally valid evidence may be preserved, never certified runnable.

The destination refusal rule is sufficient for this B2 cohort and should remain mandatory: any restore format, including legacy, must reject before destructive SQL/file swap when the destination contains protected enterprise identity/audit history. Apply the decision under the restore lock before `TRUNCATE ... CASCADE` (`backup.ts:61`); test a nonempty destination. Append-only UPDATE/DELETE triggers do not protect TRUNCATE (`identity-schema.ts:75`). Keep D2/A2/F1 preserving import and outbox/projection semantics explicitly unfinished until their own evidence exists.

## Cohort decision

| Cohort | Decision |
| --- | --- |
| Existing non-recovery v2 field codec/object checks; private async refs and sync publication barriers; legacy compatibility | May begin with the fixed existing import/accepted types and unknown recovery variants rejected. No backup-carrier dependency. Do not close Task 5 on this subset. |
| SQL/current-authority checks and committed canonical consumers | May begin for live non-restored sources. Restored/recovery branches must remain explicitly blocked until the corresponding source contract exists; never fall back to cache or an empty operation index. |
| Recovery provenance, NULL→candidate initialization, source/target inheritance | Record conditions 1–2 before this cohort. |
| Accepted-task stop/capacity integration | Record condition 3 before this cohort; reuse the existing device primitive and journal. |
| Task backup and restored-source recovery | Record condition 4 before this cohort. Core codec work does not need to wait for this carrier, but backup cannot start on an unspecified store. |
| Full Task 5 completion / profile release | All original Task 5 consumers/maintenance/backup tests remain required; profile stays closed through Task 6. PGlite, native PostgreSQL, JJ/OpenShell and model/business evidence retain their separate meanings. |

No further architecture expansion is recommended. The canonical reader and destination-protection directions already address the material risks; retain their negative tests rather than adding another abstraction.
