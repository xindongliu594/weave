# Go funded stop 工程守卫（2026-10-06）

冻结时间：2026-10-06T02:38:29.8564037+00:00。新 helper 和新纯内存测试均已建立；**58/58 通过**，fail/cancel/skip 为 0，两文件 node --check 通过。本次没有执行 helper 主入口，没有任何真实 HTTP、GET /costs、原库访问、stop/approve/start、模型调用、员工命令或员工文件操作。**真实 recovery Run 的受控停止、重启恢复与独立 QA 尚未验证。**

[新 helper](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/stop-go-funded-run-web-2026-10-06.mjs) 与 [新测试](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/tests/go-funded-stop.test.mjs) 首次写入均使用 wx。旧 stop 源码保留，SHA256 一直为 `46b9bc88738e73f600db9862e83127c0079934e3f756019fafeb346ff496f6fe`。不修改新 operator、其他旧源码、确认文件、计划或 rationale。

确认入口复用 NEW operator 的 goGenerationChain / assertGoApprovedRun，并复用原 fundedBudgetGuard。离线本地验证了已保存的实际 recovery 帧：原项目 3e101c24-87e6-43ea-80f9-a2c4b0b410f4、部门 f16bb7ee-6868-417d-a9c6-9229d7fa7339、**HTTP 200 同项目重规划确认**、v5。链是原付费 generate → 同 key/body 缓存 generate + confirm 两个 POST，不接受旧 201 新项目确认；原规划 receipt c609903e-ab3d-4d3c-b327-b2385953c204 与费用 $0.0060192 完整保留。normal 项目固定 4938eab8-26ed-4f60-9413-d979f05fa968，所有允许范围和原未知费用归属继续由 fundedBudgetGuard 核对。

新增验证覆盖以下独立条件：

- Run、当前项目、确认及完整批准 snapshot 必须属于同一明确 version、原 recovery 项目/部门；四任务 ID 及完整合同、requirement、policy、rationale 不变。version 是显式动态 CLI 值，当前已存证据为 5；若根任务获得新的 AI 修订确认，须显式传入新证据和实际版本。Run/command UUID 没有默认值，也未猜测。
- 单 Go DeepSeek 路由必须是 fcce40cf-3172-4863-b0bd-776673f499e6，经原 Go gateway、Chat Completions、disabled thinking、0.3/1.2 费率和已确认配置/工具测试绑定；模型与中转站的完整公共对象在停止前后保持一致。
- dev 必须实际 checkpoint-completed，有同 attempt 的 handoff acceptance seal；所有 dev verify 都需真实完成的 native operation、exit 0、完整输出字节 SHA 和原摘要逐项相符。使用原 nodeTestCounts 重解析真实输出，完整 TAP 与本机 Node spec 两种格式都接受；必须全部通过且 fail/cancel/skip/todo 为 0，不能以模型声明或缺失/截断摘要代替。三份开发文件的 accepted SHA、manifest 和实际下载 SHA 同时一致。
- 唯一且显式给定的 pending approval 必须是独立 QA 的首次 terminal_test；其 literal command、attempt、employee/session/call、完整 arguments 和 workspaceRevision 都绑定真实档案。选中操作从未 started/enqueued，QA/review/manager 尚未 completed；全局模型 pending 为 0、目标 recovery unknown fees 为 0、native unknown 为明确 0。
- 仅对已知 model dispatch/receipt 写入窗口做有上限的 fresh-read 等待，不把缺失用量或 unknown 当零；无 clean 证据时不会发送停止请求。
- 预算/调用数来自完整 admission snapshot 加实际 settled wire/usage，使用原费用而非估算 Token 或静态计划。停止后最新宿主 checkpoint budgetEvidence 必须为 current、没有后续 accounting，并与停止前实际派生值一致；原 dev seal 的历史预算仍原样保留。货币运算沿用 1e-9 USD 的浮点比较，整数调用数严格相等；完整原始 receipts/cost summaries/usage 都严格相同，测试确认连 1e-12 的 receipt 改动也拒绝。
- 完整 snapshot、之前的 events 前缀、所有 manifest/downloads、models/gateways、costs.recent/calls、旧及 normal 的 unknown holds/history、资金归属 ledger/phase limits、native operations 在停止后保持不变。新增档案事件逐项记录；不能新增 paid wire、operation-start/queue，最终必须有明确取消状态和终止事件。
- 真实 Edge UI 等待明确 pending 卡片/停止按钮显示，再严格唯一核验完整 arguments。仅允许一个空正文 cancel POST；先 wx 写不可覆盖的 stop intent，再同步 onePostClaim，任何未知结果只 GET 核对、不重发，也不 approve/retry/write employee files。

脚本真实执行会读取 /costs；产品该 GET 可做预留过期维护，因此主入口不是纯只读审核，也没有 fee settlement 或 provider reconciliation POST。本次测试完全封锁 fetch（调用数 0），没有进入该真实维护路径。

执行模板（未执行，需 root 审核后填入真实 UUID；如版本修订，传入对应新证据）：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'docs/test-evidence/helpers/stop-go-funded-run-web-2026-10-06.mjs' "--run-id=<ROOT_RUN_UUID>" "--command-id=<ROOT_PENDING_APPROVAL_UUID>" "--version=<ACTUAL_CONFIRMED_VERSION>" "--confirmed-evidence=docs/test-evidence/go-recovery-confirm-2026-10-06T02-00-20-236Z-0e2ec036.json" "--generation-evidence=docs/test-evidence/go-recovery-generate-2026-10-06T01-53-14-065Z-827664e3.json"
```

最终测试命令为 `C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --test tests/go-funded-stop.test.mjs`。完整末次输出见同名 TXT，结构化状态见同名 JSON。初次 memory fixture 缺少新 operator 所需 response.validation.valid，随后暴露共享审批对象导致模拟取消改写历史；两处只修正 fixture 数据形态，没有放宽生产守卫。最终加入 spec 支持时保持退出码、SHA 与全部计数要求。

## 冻结源码和已读证据

| 文件 | SHA256 |
| --- | --- |
| `docs/test-evidence/helpers/stop-go-funded-run-web-2026-10-06.mjs` | `22f928e9262c34b86971b07891e20adfa06457a7500f762ec6db0da2dfa37baf` |
| `tests/go-funded-stop.test.mjs` | `1a872c6f0a85488a942c141f63b82720b3d3a9cfccbfc78a9c5dcfaacd28dcec` |
| `docs/test-evidence/helpers/operate-go-funded-run-web-2026-10-06.mjs` | `cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3` |
| `docs/test-evidence/helpers/stop-funded-run-web-2026-10-05.mjs` | `46b9bc88738e73f600db9862e83127c0079934e3f756019fafeb346ff496f6fe` |
| `services/agent-runtime/run-evidence.mjs` | `3153a172d050a70c83bd9752b1dca8a153acb92abee7c33486c9a264dde60ffb` |
| `services/agent-runtime/recovery.mjs` | `aa2866bb3d472f8fe4db94881b3be1e9225b1866949370630dd4d14645271e79` |
| `services/agent-runtime/trace-store.mjs` | `152dc9bbd1a949906452cba7f56d482b34f53e708126d00f42aa816ddcbc7a6f` |
| `docs/test-evidence/go-recovery-confirm-2026-10-06T02-00-20-236Z-0e2ec036.json` | `cc79bc1c9618938fe721420196628c2535443f3f983e6e2faf699b9c9a00c6c7` |
| `docs/test-evidence/go-recovery-generate-2026-10-06T01-53-14-065Z-827664e3.json` | `5020f28b9579fc5c36a2c9d91b7b45db818ec72752f75dc6241f904a5d54c959` |
