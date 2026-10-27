# Output truncation engineering validation

Frozen at 2026-10-06 10:47:21 +08:00. Only `services/agent-runtime/openai-compatible.mjs` and NEW `output-truncation.test.mjs` changed. No context strategy, approved cap, shared run, plan, employee file or failed evidence was edited. No API, model or fee calls were made during diagnosis; the new tests use loopback HTTP fixtures.

The actual failed archive `docs/test-evidence/go-normal-failed-20261006-104010-90f0e832.json` remains failed and unchanged (SHA256 `97eea22dd3cb0ded07d31a0f3f0e50380cfa5b7972e7dfa9e2530fbdffd3c52f`). Its QA `artifact_write` calls have unterminated JSON, rather than an object-wrapper mismatch:

| Evidence | First call | Second call |
| --- | --- | --- |
| Assistant event | 2757 | 2808 |
| Tool-call event | 2758 | 2809 |
| Raw argument characters | 12155 | 12041 |
| Output tokens | 3000 | 3000 |
| Actual wire cap | 3000 (2712) | 3000 (2770) |
| Tool result | INVALID_ARGS (2760/2761) | INVALID_ARGS (2811/2812) |

Both raw arguments fail `JSON.parse` with an unterminated string and end inside the proposed `acceptance.test.mjs` content. The adapter correctly applies the approved QA task's `maxOutputTokens:3000`, even though its native request and pinned model route allow 4600. No complete QA write or successful QA command is inferred from these failed calls. The archive reports tool-call finishes; its mapped finish events alone do not preserve the upstream raw finish field because the existing mapper prioritizes the presence of tool calls.

The subsequent summary starts at 2814. Its request at 2820 has `max_tokens:1024`; usage at 2844 reports exactly 1024 output tokens, finish at 2845 is `max-tokens`, and 2846 rejects an incomplete checkpoint. The QA turn errors and the run ends failed at 2868. The saved policy omits `contextManagement`, so the existing default is `summary`. With contextBytes 192000 and the declared 131072-token model, `employeeContextPolicy` computes a 33600-token heuristic trigger, 8064 retained tokens and a 1024-token summary cap. There is no successful QA summary or pruning event in this archive; source history remains available.

The minimal adapter fix runs after the existing awaited known-usage accounting and before any block is yielded. It reports `OUTPUT_TRUNCATED` only when the normalized Chat choice has upstream `finish_reason:'tool_calls'`, output usage reaches the actual requested cap, and a function argument fails JSON parsing. The message names the model and cap and asks for AI replanning or smaller single outputs. Every call is checked before any tool block is emitted, including a valid call preceding a partial call. It neither completes JSON, dispatches a native tool, retries, falls back nor changes the cap. Valid JSON at the cap, invalid JSON below it, and other finish reasons retain their prior behavior. Missing usage remains an uncertain sent call.

**62/62 targeted tests passed**, 0 failed, cancelled, skipped or todo. These include four NEW loopback tests plus the existing adapter, settlement, task-output-limit and Responses regressions. The fee-persistence gate test observes zero emitted blocks until its fee callback completes, then one paid receipt and one `OUTPUT_TRUNCATED` error with no fallback or second dispatch. The legacy Chat configuration omitting thinking and protocol fields still emits complete calls at the cap. Full command output, stable-source verification and hashes are in `output-truncation-runtime-2026-10-06.txt`.

Frozen source SHA256:

```text
4f6c834bc10ed7aea85cb7c683152123b15c82bf3880825143f3784edbef3d9b  services/agent-runtime/openai-compatible.mjs
8e079f1d8e3e7eac40f8bef9151b5b6a37d87f42e373ac0129e0fd335b8e44cf  services/agent-runtime/output-truncation.test.mjs
```

The existing product control is 编辑方案 → 项目执行策略 → **员工上下文管理**. Its select maps `summary` to 自动摘要与工具结果缩减, `prune` to 仅缩减工具结果, and `off` to 仅限制请求大小. `policy.contextManagement:'prune'` retains the tool-result pruner, complete SHA file reads, protected receipts and the adapter's request-byte guard while disabling summary calls. Saving policy creates a new plan version. An old-run retry clones its original snapshot, so it retains its original strategy and cap; an AI-generated replacement plan must be confirmed and approved for the new version. Old accepted development evidence remains a source, not automatic completion of new contracts.

This is local engineering verification. It does not turn the failed run into acceptance, establish that a future AI-selected cap is sufficient, or replace the next actual UI/model outcome.
