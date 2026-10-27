# 项目重规划保留未知费用：隔离验证记录

2026-10-06 00:56 UTC 最终复验：根代理修复费用锁内检查后，API **16/16 通过**，此前 UI **22/22 通过**的源码和测试 SHA 未变。最终记录见 `planning-carryover-2026-10-06-final.md` / `-final.txt`。以下保留 00:46 UTC 初次失败记录；原 `.txt` 未覆盖。

2026-10-06 00:46 UTC 冻结。UI **22/22 通过**；API **15/16 通过、1 项失败**。没有取消或跳过项。本次不能标记完整通过：费用模块仍需修复下面的锁内进行中收据边界。测试前后记录的 12 个源文件 SHA256 无漂移，完整输出及依赖 SHA 在同名 `.txt`。

仅使用当前工作树和 runner 新建的内存 PGlite、临时运行档案、本机临时 HTTP 模型 fixture。没有访问 `C:/Users/JJ/Desktop/la/agent_department/.data/local`，没有请求真实中转站、产生真实费用、操作产品运行进程，或启动项目执行。测试结束只清理经过绝对父目录和名称校验的临时 fixture 目录。

| 检查 | 结果 |
| --- | --- |
| 未勾选或省略选项时拒绝未知费用；GET 只接受字面量 `true` / `false`，拒绝重复或未声明参数 | 通过 |
| 明确 `true` 在原项目净预算内生成并确认；全部旧未知收据、历史运行、档案和未知外部操作记录保持原样 | 通过 |
| 只读 quote 和 HTTP generation 在 `true` / `false` 下都拒绝 pending，且不会过期、结算或改写旧收据 | 通过 |
| 所有未知预留持续占用预算；新收据使净余额下降后，HTTP 与锁内 admission 都拒绝额外费用 | 通过 |
| candidate 与 confirmation 的保留选择匹配；旧省略字段的 generation / confirmation key 与正文不可自动改变 | 通过 |
| Responses 预检报告 `CONTEXT_LIMIT`、单次限额和净预算不足，保留明确输出上限，且不创建请求或预留 | 通过 |
| Responses 费用预留包含完整 stateless wire JSON 与 1024 字节余量；上下文边界差 1 字节即拒绝；可用边界传递原输出值 | 通过 |
| 真实 checkbox 默认不勾、变更使 quote 失效、锁定期间禁用；恢复原 pending 请求保持原 true / false / 省略正文 | 通过 |
| 预算锁内在过期 pending 收据变为 uncertain 之前拒绝规划 admission | **失败，根代理费用模块待修** |

失败发生在 `tests/project-planning.test.ts:282`，用 `reserveCall({ projectId, projectVersion: 1, retainUncertainCosts: true, ... })` 检验合成过期 pending 收据。预期 `COST_PENDING`，实际成功创建预留，断言报 `Missing expected rejection`。`apps/api/src/cost-control.ts` 当前先 `expireReservations(client)`，再 `requireProjectCostReady(..., true)`，使该 pending 变为 uncertain 后被放行。HTTP 当前预检会先拒绝 pending；此回归检验的是预检之后仍必须成立的锁内约束，PGlite 不证明独立 PostgreSQL 后端的并发锁行为。

根代理可在持有项目行锁和费用策略锁之后、调用 `expireReservations` 之前，对 `project && !input.runId` 调用 `requireProjectCostReady(client, project.id, input.retainUncertainCosts === true)`；随后保留已有最新账本和预算复核。失败应回滚，旧收据及其历史不变。本代理未修改根代理拥有的 `app.ts`、`cost-control.ts`、`provider.ts` 或 contracts。

本次增补了 8 项 API 回归和 2 项 UI 回归，并将 quote query 改为 `.strict()`，与严格 generation 正文一致。已有 `ProjectPlanning.tsx` 修改全部保留，本次没有再修改它。另将 fixture 的递归清理改为先核对已解析绝对父目录和明确的临时目录名称。

执行命令（Node：`C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`）：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-integration.mjs tests/project-planning.test.ts
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --import tsx --test tests/project-planning-ui.test.ts
```

源码冻结 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `apps/api/src/project-planning.ts` | `d3ac7ced1c65dc49db1e38e5f1ef7f1b66a963e89b705672da050e99e680a277` |
| `apps/web/src/ProjectPlanning.tsx` | `863CEE67C97673224169B4BBA50176A3CBEECCE1E2C06309A2195AD8368A3975` |
| `tests/project-planning.test.ts` | `020067ba29a0fb1fccfbe1e0366977a7415f27293d25f6505a69efdcec1e2c69` |
| `tests/project-planning-ui.test.ts` | `c1a22c8d3f834cbd27d6a2ad3697c3ca82d9c2aa57a2a276859607f3997f3cd4` |

失败时费用模块 SHA256：`fe41830316d3c9a6d23e2165378738f59ba616a034dcabd19f6d7249dc8a0735`。修复根文件后应保留上述测试正文，重新运行这两条命令，并更新本记录和日志。冻结的本次结果不代表完整 MVP、真实网关或真实费用验收通过。
