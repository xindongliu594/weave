# Task 2a review — f3c451c..1ed2563

Spec compliance: **NEEDS_FIXES**. Code quality: **NEEDS_FIXES**.

## Strengths

- Business completion and actual drain are separate; original Host/executor promises and failed job references are retained (`services/agent-runtime/product-runtime.mjs:79`, `:97`, `:103`, `:118`). Accepted business completion survives cleanup failure.
- Employee setup callbacks are joined and unpublished native startup remains unproven; failed employee slots and fences survive (`services/agent-runtime/employee-hosts.mjs:57`, `:70`, `:76`).
- The observer belongs to each new root Context and checks error records only while the originating fiber is UNLOADING (`services/agent-runtime/host-lifecycle.mjs:4`, `services/agent-runtime/host.mjs:54`, `:259`, `services/agent-runtime/employee-hosts.mjs:42`, `:70`). Focused pinned-Cordis inspection confirms separate LoggerService ownership and synchronous error export during unload. No loaded plugin exporter was found that removes this observer. Active business errors are excluded; real coordinator/employee disposer regressions are present.
- Coordinator immediately observes rejection, retains drain phases, and excludes terminal tails from heartbeat renewal/cancellation (`apps/api/src/run-coordinator.ts:167`, `:169`, `:184`, `:203`). Database close follows successful application shutdown (`apps/api/src/index.ts:13`). Sandbox cleanup is memoized per container generation (`services/agent-runtime/sandbox.mjs:52`, `:92`).

## Important — must fix

**Premature drain during synchronous admission reentrancy** — `services/agent-runtime/openai-compatible.mjs:343` (new drain decision), `:496`, `:510`, `:517` (ordering).

`stream()` invokes preparation/reservation callbacks before registering its active request. Budget warnings invoke the public `onBudget` callback (`services/agent-runtime/budget.mjs:32`, `:51`, `:66`). If that callback calls `stopAdmission()`, no request is registered yet, so `writerDrained` permanently fulfills. The same stream then registers and enters `beforeRequest`, which can still write while the drain promise already reports success. The stop check after `beforeRequest` is too late.

This violates requirement 1 and produces false-safe drain evidence without another request, network transport, or monkey-patching. Establish request ownership before reentrant admission callbacks, or otherwise prevent drain fulfillment until admission has exited and prevent later callback admission. Preserve budget and undispatched-error accounting. Add a focused regression; merely delaying drain by a microtask is insufficient.

### Single focused reproducer executed

PowerShell from workspace root, in-memory adapter and deferred callback; no network, database, or script filesystem writes:

```powershell
@'
import { OpenAiCompatibleAdapter } from './services/agent-runtime/openai-compatible.mjs';
const entered=Promise.withResolvers(),release=Promise.withResolvers();
let adapter,drained=false,calls=0;
adapter=new OpenAiCompatibleAdapter({routes:[{id:'fixture',wireModel:'fixture',baseUrl:'https://fixture.invalid',inputRate:0,outputRate:0,maxOutputTokens:16}],maxBudget:1,priorSpend:3,onBudget(){adapter.stopAdmission();},beforeRequest:async()=>{calls++;entered.resolve();await release.promise;}});
adapter.writerDrained.then(()=>{drained=true;});
const running=(async()=>{for await(const chunk of adapter.stream({model:'fixture',messages:[{role:'user',content:[{type:'text',text:'fixture'}]}]})){} })().catch(error=>error.code);
await entered.promise;
await new Promise(setImmediate);
console.log(JSON.stringify({beforeRequestPending:true,writerDrained:drained,activeRequests:adapter.activeRequests.size,beforeRequestCalls:calls}));
release.resolve();console.log(await running);
'@ | node --input-type=module
```

Actual stdout:

```text
{"beforeRequestPending":true,"writerDrained":true,"activeRequests":1,"beforeRequestCalls":1}
RUNTIME_STOPPING
```

The script completed normally; it prints the incorrect state rather than asserting failure. No separate log file was created; command and stdout are preserved here.

## Review and test boundaries

- Read the supplied diff; recovered omitted sections in bounded slices after the first tool output was truncated. No Git commands or source/test edits. This requested report is the only file written.
- Focused source checks beyond diff context: Cordis logger/fiber/context ownership and error timing (observer lifetime risk); stream admission preamble and budget callback invocation (reproduced reentrancy risk); employee catch/finally and Host mounting references (cut-off startup/disposal ownership context). No broad repository review.
- Inspected final lifecycle log (44/44, exit 0), integration-final log (coordinator 23, lease 9, work-file 3 passed; entire command interrupted/exit 1 on the native-only case), build-final (exit 0), and explicit declarations (exit 0). No passing suite rerun or heavy-test slot taken.
- Existing Vite >500 kB warning is recorded background noise, not a new regression. The interrupted integration command is not considered a successful whole-suite run.
- No production/JJ access, paid model calls, real Docker process-quiescence validation, native PostgreSQL validation, or process-signal/database shutdown integration test. Native archive fencing/source recovery remain Task 2b/c, not Task 2a omissions.

Assessment: the main lifecycle work is supported by useful real DSH evidence, but actual-drain producer correctness fails at a synchronous callback boundary. Fix this gap and perform limited follow-up review and focused regression before accepting Task 2a.
