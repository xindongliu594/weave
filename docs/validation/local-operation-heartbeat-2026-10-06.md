# 已开始本机操作的心跳判定修复

只读原始 v9 失败归档确认：最早可证错误是 `LOCAL_DEVICE_OFFLINE`，随后形成 `OUTCOME_UNKNOWN`。后端把 15 秒软在线判定用于已经开始的操作等待，心跳过旧即取消操作；晚到的真实退出码 0 因操作已经取消，仅存入 `late_result`。没有证据支持中转站、费用或命令自身超时导致此故障。

原始 Run `1e91d7d2-d99d-45f7-90a8-bb9bb2c80ff0` 保持 failed、3941 events。所有时间为 UTC，同一调用 `call_00_8p99lah701924pe7e5y7bjgc`、session `d763604f-e8aa-4433-8779-d229d5b0d32d`、attempt `9e71e4d7-f9f0-4976-86a8-983eba46b250`、task `qa_review`、employee `qa` / agent `employee-3` 严格关联：

| 记录 | 时间 | 已存事实 |
| --- | --- | --- |
| seq3338 | 05:46:03.881Z | 请求 approval `93d78bf9-cfb4-4e4a-bb1f-d9857d8d07f8` |
| seq3898 | 05:52:23.289Z | 同一 approval approved |
| seq3901 | 05:52:24.760Z | `runtime/operation-start` |
| op.createdAt | 05:52:27.781Z | operation `2982099d-e930-46d4-8838-7e37cd4d4efb` 创建 |
| seq3907 | 05:52:32.577Z | 同一 operation / call / approval 入队事件 |
| seq3919 | 05:52:49.642Z | `operation-failed`、`LOCAL_DEVICE_OFFLINE`、`outcome_unknown` |
| seq3920 | 05:52:50.137Z | `runtime/outcome-unknown` |
| seq3941 | 05:53:02.385Z | Run failed、`OUTCOME_UNKNOWN` |

命令为 `node --test acceptance.test.mjs`，批准工作区 revision 为 `8e500b5d5ee13189b1b8f122867f81c5a21462504298b996088746bb46fde7eb`。已存 operation 为 cancelled / started=true / result=null，lateResult.ok=true、exitCode=0；真实测试输出为 3/3，duration 5535.5279ms。晚到输出 UTF-8 373 bytes、SHA256 `1023984c4b6696643853c1288837ff08f68026f72e48a3faa19bda9a6fd87ed1`。

源码路径为 `LocalOperationService.wait → executable → assertRunAuthorization → localTarget`。`executable` 先检查设备授权、运行状态/取消、worker lease、operation deadline，再进入授权检查，因此实际抛出 `LOCAL_DEVICE_OFFLINE` 可定位到随后执行的 `last_seen > clock_timestamp() - interval '15 seconds'`。wait 的 catch 将进行中的操作标为 cancelled；result 路径将 cancelled 的回执保存为 late_result。原始公开 projection 没有设备 last_seen、claimed/start/finish 或结果提交时间，不能进一步认定哪次 heartbeat 请求被阻塞，也不能由 stdout duration 推算真实完成时间。42,457,586-byte 归档的写入/扫描性能是后续独立限制，本次未扩缓存或宣称它是已测定的根因。

最小修复仅涉及 `apps/api/src/execution-policy.ts` 与 `local-execution.ts`（9 insertions / 3 deletions）：授权新增可选 `requireLocalOnline`，默认保持严格；只有已 started 的同一 operation 在全部硬条件仍有效时，等待与回执检查不将软心跳过期当成撤权。queued/claimed/start、恢复及模型调度前的默认授权仍要求在线。通过设备 token、同 claimToken、完整授权与结果校验的新 started 回执，在登记 durable result 的同一事务内刷新 last_seen。原 result 路径此前仅 register/poll 刷新心跳，此处补充真实认证在线证据，避免下一次严格授权立即报离线。

撤权、运行取消/终止、项目版本变化、worker 置换、lease/deadline 过期、错 claimToken、无效回执和调用方 Abort 均维持原拒绝行为。取消或过期后的 late_result 不刷新心跳、不变成 completed；旧 v9 晚到成功没有被晋升或重放，预算、审批、DAG、员工文件和旧 status 修复未修改。

本地最终 **18/18，0 失败，sourceStable=true**：新增心跳集成 4/4、原本机并发 7/7、原桌面 native 7/7。新增案例使用 fresh PGlite、loopback HTTP、临时 native 工作区；SQL backdate 20 秒直接覆盖真实 15 秒判定。真实批准的 `node --test fixture.test.mjs` 只执行一次，退出码 0 / pass 1、结果完整被调用方观察，回执刷新后默认授权通过；再使心跳过旧，已完成回执仍可读取。9 个硬条件反例和错 token / explicit caller Abort / late result 不刷新均通过。所有用例 usage / model_reservations 为 0，预算仍为 1；不接触真实 API、原库、真实模型、Key 或员工交付物。

复现 CLI（既有 Node 路径）：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-integration.mjs tests/local-operation-heartbeat.test.ts tests/multi-agent-operation-concurrency.test.ts
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test apps/desktop/local-executor.test.cjs
```

修前误取消的预期红例保留在 `local-operation-heartbeat-2026-10-06-before.txt`。初次新测试的递归 node:test fixture 环境失败保留在 `-fixture-recursive-context.txt`；修正仅限 fixture 子进程环境，产品代码未因此改变。最终日志为 `-after.txt` 与 `-desktop.txt`；`-sources-before.json` / `-sources.json` 保存测试前后 8 个源码 SHA、退出码及稳定检查。`-actual-read.json` 保存所有 6 个允许读取的原始 JSON 的实际 bytes / SHA、精确身份及事件时间；原始证据未修改。

| 冻结文件 | SHA256 |
| --- | --- |
| apps/api/src/local-execution.ts | `0eb45d9c496a556f6b9ce7985a33a7869311823daf8d4005ccb6915ac5cbda64` |
| apps/api/src/execution-policy.ts | `b394f89a26369bb87ff4b4cfaa35ec673c2fde57cca89336bf8b57a20319689f` |
| tests/local-operation-heartbeat.test.ts | `9b190c0e09626960c9838157c3cdcb77fb3458e6f687115f0c9035430b147748` |
| services/agent-runtime/product-runtime.mjs（未改） | `9c9747ad48fdd8cacbee02947e04e544c3a69ce0566bde7d6c40e715c550e05b` |

这是工程回归，不是员工或真实模型验收，也没有执行服务重载或新的真实运行。PGlite 不能证明独立 PostgreSQL 连接的行锁时序；已有桌面连接错误的取消和 15 秒 HTTP timeout 仍保留。
