# Task 4 — installed DSH guard and actual tool-binding investigation

Date: 2026-10-20. Source base: `a581e7a07a67161efc8f4e992663c8c2cd19d40d` (verified `git rev-parse HEAD`). This initial investigation was source-only: no model, network, database, product/dependency edit, or runtime test. Subsequent authorized shared-boundary implementation and runtime evidence are recorded separately in `task-4-boundary-report.md`. No prior Task 4 scratch report existed in this task directory; the existing research below was reused and its relevant source claims checked against the installed implementation.

## Scope and reused decisions

- Plan: `docs/superpowers/plans/2026-10-20-task-sandbox-integration.md:138-155`. In particular line 150 fixes the real tool sequence and line 152 requires both Host registries, exact definitions, late registration, scope shadow, missing identity, and denial of new capabilities without a controlled wrapper.
- Existing research: `docs/research/enterprise-execution-boundaries-2026-10-20.md:128,151,168`. Reuse DSH registry/guard/wrapper, not another tool engine. Synchronous guards cannot perform asynchronous authority transactions.
- Installed `services/agent-runtime/node_modules/@deepseek-ai/dsh-tools/package.json:2-4` is `@deepseek-ai/dsh-tools` **0.1.5-rc.1**. Conclusions below concern this installed file, not an upstream current release.

All installed-source line references below use these abbreviations:

| Label | File |
| --- | --- |
| TOOLS | `services/agent-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js` |
| TYPES | `services/agent-runtime/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts` |
| SCOPE | `services/agent-runtime/node_modules/@deepseek-ai/dsh-scope/lib/index.js` |
| CORDIS | `services/agent-runtime/node_modules/@deepseek-ai/cordis/lib/index.js` |
| LOOP | `services/agent-runtime/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` |

## Exact installed execution order

1. `tools.execute(input)` calls `prepareExecution`, then dispatch/finalization (TOOLS 3010-3020). Preparation creates a registry token, defaults rootCallId, copies name/agent/parent/signal, JSON-snapshots and deep-freezes the argument value, and captures the **initially visible** definition's content finalizer (3025-3066).
2. A model-direct non-`run_code` call in PTC mode may return `UNKNOWN_TOOL` before policy (3034-3035,3067-3077). Current coordinator and employee Hosts explicitly mount `mode:'native'` (`host.mjs:253`; `employee-hosts.mjs:86`).
3. `tools/pre-execute` runs as an extensible async waterfall. An `ask` may await native approval. **After that wait**, allow runs the monotonic guard chain (TOOLS 3115-3127). A deny becomes an error and bypasses the body (3128-3139). Cancellation is checked again (3140-3143).
4. Guards run global first, then scope-chain layers, farthest first (TOOLS 2823-2829). A non-undefined reason terminates the chain (2550-2553). A plain-context guard therefore sees agentless calls; scope-only guards never run for agentless calls (2826). Public guard type is synchronous `string | undefined` (TYPES 482-489,611-620).
5. Allowed dispatch runs the async `tools/execute` waterfall (TOOLS 3209-3214). Cordis captures matching callbacks, composes them outermost first, and makes the built-in body the final `next` (CORDIS 307-324).
6. **After every before-next async wrapper**, `dispatchToolBody` checks fused cancellation, then resolves the definition **again**, and calls that currently resolved definition's `execute` (TOOLS 3176-3193). The resolved definition is not carried as a frozen binding from guard to dispatch.
7. Normal dispatch and pre-denial flow through post-execute; thrown pipeline errors may already be final. Final content uses the callback captured before policy. Result notification freezes the execution and publishes the final result (TOOLS 3013-3020,3222-3229,3241-3246,3257-3294).

The application terminal approval is separate: it is currently requested **inside the product tool body**, after DSH guard, at `product-tools.mjs:53-59`. It cannot replace revalidation after application approval/queue waits.

## What the registry actually identifies

- `register(definition)` inserts the supplied object by reference into the appropriate layer (TOOLS 2773-2781; SCOPE 27-35). It does not freeze or clone the definition or its `execute` function. Same-object `execute` replacement is therefore a different hazard from object replacement.
- `get(name, scope)` is the authoritative visibility/definition resolver (TOOLS 2890-2891). It incorporates scoped shadow and restrictions. Always pass the actual `exec.agent`; global-only `get(name)` is insufficient for employee-scope binding checks.
- Own-scope registrations override inherited definitions (TOOLS 2856-2872). Restrictions intersect on inherited tools and **do not constrain the scope's own registrations** (2784-2786,2839-2844,2870-2872). A filtered discovery list or `restrict({allow})` alone is not an execution boundary.
- The same visible definition resolver feeds dispatch (`resolveExecution`, TOOLS 2906-2910,3189), including nested calls. A parent token only changes PTC transport presentation permission; it does not grant capability permission (2894-2900; TYPES 209-218).
- `tools/change` is useful for invalidation/diagnostics, but is **not** a before-mutation gate. Insert/undo happen before onChange (SCOPE 206-216); TOOLS 2592-2594 emits the change afterward. Throwing from a change observer does not prove that insertion was rolled back.
- The installed declaration says identity is immutable (TYPES 40-44,197-220), but the inspected runtime constructs a plain execution object (TOOLS 3037-3060) and only freezes `exec` at final notification (3285). The argument *value* is frozen; its property is not made nonwritable there. Do not infer runtime protection of name/agent/argument-reference/callId from TypeScript readonly alone. This discrepancy is source evidence; no runtime mutation probe was run in this bounded task.

## Existing application coverage and gaps

| Existing component | Relevant current behavior |
| --- | --- |
| `employee-tool-access.mjs:13-31` | Snapshots granted/infrastructure global definitions, restricts discovery, and installs a plain-context guard in the employee Host. Exact agent identity and `get(name,agent) === admittedDefinition` are checked (22-27). Good basis, but no raw execute snapshot, post-guard body-bound check, or coordinator global gate. |
| `employee-hosts.mjs:24-34` | Captures coordinator definitions only at first admission, after AgentTeams mount. Keep this registration timing; otherwise native team tools disappear from the snapshot. |
| `employee-hosts.mjs:119-138` | Registers a local relay per coordinator definition. Relay checks coordinator global definition before forwarding to a **new** coordinator execution (124-130). Global-only check misses a coordinator scope shadow, and any async coordinator policy/wrapper still precedes its final re-resolution. |
| `employee-hosts.mjs:202-210` | Approved skill tool and employee capability tools are installed before employee admission guard. A new shared registration adapter must cover these normal registrations as well. |
| `host.mjs:119-140` | `activeWork` reads trusted team state; async `bindActiveWork` binds and rereads identity after the await. Preserve it; guard does not replace it. |
| `host.mjs:289-297` | Current pre-execute does async binding and plan-change policy. It dereferences `exec.agent.id`, so absent-agent calls can throw there before any future guard. Add an intentional identity rejection rather than relying on TypeError. |
| `host.mjs:299-338` | Coordinator Handoff `tools/execute` wrapper covers only terminal task update and mutex behavior. It is not a generic tool binding guard. |
| `product-tools.mjs:28-30,53-75,97-101` | Granted tool check precedes approval/capacity waits; current activeWork is repeated inside Handoff mutex. New scope/approval identity must remain fixed through all those awaits and be revalidated before enqueue. |
| `native-plugin-tools.mjs:7-30,46` | Native manifest binding/permission/file-access adapter already exists. It waits capacity, then enters Handoff mutex and dispatches `native_plugin`. Reuse this adapter and bundle binding; do not run plugin business bodies in Host. |

The exact infrastructure-name list is already centralized in `employee-tool-access.mjs:3-10`. Retain explicit names and their existing native policies; never turn `agent_teams_*`, a package prefix, `parent`, or an arbitrary registered name into an allow rule. Enterprise domain permission remains separate from infrastructure access.

## Concrete answer to the post-guard re-resolution gap

**A `tools/execute` middleware cannot independently provide the requested final definition guarantee without controlling all later middleware order.** Its check before `next()` can be followed by another async listener that registers a scope shadow; then native dispatch resolves that shadow. A check after `next()` is too late. Scope guards run at the same earlier stage. There is no installed public final-before-body guard or public registry freeze method (TYPES 601,609,620,655; TOOLS 3115-3127,3189-3192,3213).

Checking only in the original product body is insufficient: a substituted definition's raw body does not enter it. Freezing the original object alone does not prevent a new scoped registration from shadowing it. Replacing only public `tools.execute` also misses the native scheduler paths below.

### Smallest integration that closes it while retaining DSH

Install one application adapter around **the existing `tools.register` API**, immediately after mounting DSH tools in **both** `host.mjs:253` and `employee-hosts.mjs:86`, before any tool-providing plugin or adapter registers. Do not add a registry, scheduler, tool engine, or installed-package patch.

For each registration, retain the raw execute callback once, create an ordinary DSH `ToolDefinition` with an application body-entry wrapper, and register that definition using the original API. The body-entry wrapper must run for **every** definition including late registrations and scope-local definitions. This makes the check apply to whichever definition DSH actually selected. It must:

1. Deny absent/stale/foreign agent objects and unknown/unadmitted definition identities. Coordinator must use its own exact definitions and same live employee/captain identity checks; employee forwarding must not be an exemption.
2. Require exact admitted registered-definition identity, exact captured raw execute binding, approved kind (infrastructure/product/native/explicit read-only helper), and any immutable native bundle/version binding. `ctx.tools.get(registeredName, exec.agent)` must resolve this exact boundary definition.
3. Compare the call against a guard-owned, per-execution identity snapshot (a `WeakMap` keyed by the native exec object is sufficient): name, agent object, arguments reference/digest, callId, rootCallId, token, parent. Only signal is allowed to vary. For unadmitted or altered executions, reject before calling raw execute. Each new coordinator execution must obtain its own guard admission; no grant is copied merely because it was forwarded.
4. Freeze/detach the registered binding and capture callback identity, so later mutation of the source definition cannot change the raw callback used by the boundary. Preserve the registered definition's output/schema callbacks and declared fields; those version/hash inputs must also be immutable snapshots when used as approval evidence.
5. Delegate to the captured raw body only after the synchronous entry check. The existing product/native body continues the Task 4 async sequence and repeats live task/authority/scope validation after approval/capacity/mutex waits immediately before the actual sandbox/API side effect. The registry boundary itself does not fabricate an async transaction.

Late registrations can remain discoverable according to native behavior but are not admitted to the running approved snapshot; their boundary fails closed. A stricter acceptable alternative for this fixed-version first slice is to **reject new register calls after the allowed mounting/admission phase** in each Host, also freeze all admitted definition bindings. If using a seal, it must cover all scoped contexts and scope setup timing, not just the root's current tool list. Removing a definition must never silently authorize a revealed fallback definition; exact admitted resolution still applies.

Cordis service API methods are traced to the caller's context (CORDIS 117-151). Preserve dynamic `this` when delegating original register, otherwise a scoped registration can accidentally become global. Do not bind native register to the root context. Ordinary writable method replacement or an accessor getter is compatible with traced methods; making an own function property nonconfigurable/nonwritable can violate JavaScript Proxy `get` invariants because Cordis returns a method proxy (CORDIS 131-142). This compatibility detail needs a focused implementation test.

This is enforcement within the documented registration/execution API. Arbitrary hostile same-process JavaScript that directly edits DSH private tables, prototypes, event machinery, or calls captured raw callbacks is outside what a registry guard can isolate. Actual plugin business code belongs in the existing remote sandbox path.

## Caller/registration map that tests must cover

| Entry | Exact source | Consequence |
| --- | --- | --- |
| Product runtime's manual captain calls | `product-runtime.mjs:136,146` -> `host.mjs:467-474` | Enters **employee** agent's tools registry, then relays coordinator. Captain is an identified employee with infrastructure policy, not an agentless bypass. |
| Employee model loop | LOOP 588-592; TOOLS 2577-2582 | Uses `TOOL_RUNTIME_SCHEDULER.prepare/dispatch`, **not** public `tools.execute`. Both stages use the same guard/body pipeline, so register boundary covers them. |
| Employee -> coordinator relay | `employee-hosts.mjs:123-130` | Separate native execution in coordinator registry. Protect both registries and scoped resolver there. |
| Native PTC nested tool dispatch | TOOLS 1207-1221,1272-1274 | Propagates agent/root/parent and uses scheduler. Every nested execution requires its own permission/definition/body check; top-level authorization is not inherited. Current Hosts are native mode. |
| Any plugin direct nested `ctx.tools.execute` | Public TOOLS 3010-3011 | Same native pipeline; child executes its own admission check. Passing parent cannot authorize it. |
| Agentless/background direct call | Public execute + TOOLS 2823-2826,3323-3326 | Global guard/body boundary must explicitly reject missing agent. Native `ask` denies agentless calls, but a normal allow does not automatically reject them. |
| Product tool registrations | `product-tools.mjs:28,103` | File/terminal/read-only helpers and recovery. All must be captured before admission and classified explicitly. |
| Native plugin registrations | `native-plugin-tools.mjs:7-11` | Exact manifest/tool/bundle-bound controlled transport wrapper. |
| Coordinator team plugin registrations | `host.mjs:410-412`; `employee-hosts.mjs:24-34` | Adapter must be installed before mount; admission snapshot must occur after mount. |
| Local employee relays | `employee-hosts.mjs:119-138` | Each is a fresh registered definition with a fresh execute callback. |
| Skill tool | `approved-skills.mjs:45-58` | Official `dsh-tool-skill` mount registers normal tool; must remain covered by adapter and exact policy. Existing skill guard alone only enforces identity for name `skill`. |
| Capability helper tools | `employee-capabilities.mjs:26,38` | Normal registered helper tools; existing body has live identity checks at 16-18. |

## Minimum negative evidence to add in Task 4

- Unknown late global tool; same-name late own-scope shadow; ancestor shadow; replacement of admitted object's raw execute. Assert raw unapproved body counter zero.
- Swap shadow **after guard** from an async `tools/execute` listener, with listener registered both before and after application middleware. Assert selected unapproved raw body counter zero in employee and coordinator registries. This is the essential regression absent from a guard-only test.
- Mutate name, agent, or argument reference after guard; missing agent; stale agent object with same id; detached employee. Assert explicit denial and side-effect counter zero.
- Nested public execute and installed scheduler paths; allowed parent invokes an unknown child. Assert child's raw body zero, with parent's result error where appropriate.
- Approved exact infrastructure and allowed product/native tool still succeed; employee relay reaches exact admitted coordinator definition; ordinary callback disposal/Host cleanup still works.
- Task/attempt/scope or work revision changes while prepare/approval/capacity/mutex waits. Preserve original approval parameters and assert enqueue/transport/shell count zero. This is a different check from registry-binding integrity and remains in the product/native/API wrapper path.

Initial investigation status: **installed-source behavior verified by reading.** The later authorized implementation and runtime verification of the shared adapter are recorded in `task-4-boundary-report.md`; Host integration remains the parent's responsibility.
