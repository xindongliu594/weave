# Windows 本机启动器退出诊断（2026-10-05）

当前结论：根因未定位。最近两个启动器的生命周期记录都停在 `workbench-ready`，没有普通 JavaScript 异常、API 子进程退出或启动器正常退出记录。应优先区分启动器原生异常与外部强制结束；尚无证据可归因于预算、代理余额、栈溢出、Codex Job 回收或特定 Node 版本。

本报告的诊断阶段只读取相关源码、运行元数据和 Windows 进程信息；没有修改源码、数据库、凭据或权限，没有启动、停止服务或浏览器，没有模型调用。根代理另行启动的 Node 24.19 观察实例与本诊断分开记录。该阶段新增证据只有本说明和下述受授权的有限观察 JSONL。随后根代理另行授权实现生产静态模式，完成结果见 [静态模式阶段验证](local-production-static-stage-2026-10-05.md)；下文候选与验证差距保留为实施前记录。

## 已核对的退出路径

- `scripts/local.mjs` 等待显式 `stopped` 信号，无服务运行时限或定时重启；启动锁仅处理已退出进程留下的锁。API 意外退出会写 `api-exit`、请求关闭，然后走 `finally`；普通未捕获 JS 异常有 `uncaughtExceptionMonitor`；正常进程退出有同步 `launcher-exit`。
- `scripts/local-api.ts` 收到停止消息、父 IPC 断开或 SIGINT/SIGTERM 时关闭服务。API 子进程普通失败本身不足以解释父启动器完全没有退出记录；父启动器先死亡可使 API 失去 IPC 和数据库。
- `.data/start-mvp-controlled-20261004.cmd` 仅直接运行系统 Node，再记录实际子进程退出码，没有循环、超时、`taskkill` 或进程名称清理。最后记录 `Child exit code: -1073740791`，对应 `0xC0000409`。这条文本不提供异常调用栈或 FAST_FAIL 子码，不能据此认定栈溢出。
- 2026-10-05 的旧启动器 10344 / API 1876 于 11:16:25.836 UTC 就绪；44220 / API 28648 于 11:24:19.159 UTC 就绪。二者后面都没有相应退出生命周期记录。其实际退出时间和第二组 Node 的原生退出码本诊断无法事后取得。早先 `4294967295` / `-1` 记录包括根代理明确执行的受控重载，不能批量当作自动故障。

Microsoft 的 [__fastfail 说明](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail?view=msvc-170) 说明 `0xC0000409` 可表示 fast fail，其首个异常参数才区分原因，并且常规异常处理器不会执行。这里缺少该参数和 dump；[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess) 也接受调用者提供的退出状态，状态值本身不是调用者证据。

## 当前进程与 Job：11:37:32.845 UTC 的只读原生查询

| 对象 | PID | 创建时间 UTC | 直接父进程 | 任意 Job 成员 |
| --- | ---: | --- | --- | --- |
| 新启动器，bundled Node 24.19 | 19192 | 11:34:18.389797 | pwsh 28312 | 是 |
| 新 API，bundled Node 24.19 | 34352 | 11:34:20.591437 | 启动器 19192 | 是 |
| 新启动器的 PowerShell | 28312 | 11:34:17.246706 | codex 33880 | 是 |
| Codex 执行器 | 33880 | 00:32:44.965545 | ChatGPT 8392 | 是 |
| Codex 桌面进程 | 8392 | 00:32:37.565522 | 已不存在的 9556 | 是 |
| Cockpit 本地代理 | 19296 | 11:18:10.006677 | cockpit-tools 44156 | 是 |
| Cockpit 客户端 | 44156 | 04:04:38.439785 | explorer 13584 | 是 |

查询只使用 `OpenProcess(PROCESS_QUERY_INFORMATION)`、`IsProcessInJob(NULL)` 和关闭本次查询句柄，没有改变目标。当前只读观察 shell 32020 的 `QueryInformationJobObject(NULL)` 返回 immediate Job flags `0x2800`，包括 `KILL_ON_JOB_CLOSE`；**这是观察 shell 自己的 Job，目标启动器的 Job flags 仍未知**。[该 API 的 NULL 参数](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject) 查询调用进程所属的 immediate Job。布尔值“在任意 Job 中”既不识别 Job，也不证明两个进程在同一 Job。代理和为伍没有直接父子关系，尚无 Cockpit 清理为伍进程的证据。

[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 说明普通子进程可继承父 Job，关闭最后一个带 `KILL_ON_JOB_CLOSE` 的 Job 句柄可结束整个相关进程树。因此 hidden / PTY 两种启动方式都曾失败，不能单独排除 Job 生命周期。但没有旧进程 Job、Job 关闭动作或控制者证据，不能反过来断言 Codex 是原因。旧的 [10 月 4 日诊断](../test-evidence/new-api-launcher-host-audit-2026-10-04.json) 已注明同一证据边界；该日另有实际 OS 重启，不能直接套用到今天。

## 运行时线索与零费用验证

11:38:54.363 UTC 读取 Application 1000 / 1001，自 11:10 UTC 起选定事件为 0。没有所选 Windows 崩溃记录不排除原生异常或强制终止。没有更改 WER、注册表、系统审计策略或调试器。

新启动器已加载 `rollup.win32-x64-msvc.node`，本地包版本 4.63.3，路径为项目 `node_modules/@rollup/rollup-win32-x64-msvc/`；此外读取到的模块均为 Node 或 Windows DLL。PGlite 0.5.8 以 JS / WASM 运行，启动器同时拥有数据库、数据库 socket 和 Vite。原生退出候选包括 Node/V8、WASM 执行与 Rollup 原生解析器；缺少栈，不能确定任何一个有缺陷。API HTTP 拒绝或规划模型失败通常应作为请求失败保留，而不是结束数据库和工作台。

根代理换用现成 bundled Node 24.19.0 启动同一服务（系统 Node 是 24.15.0），未安装软件、未派模型；新实例 11:34:44.082 UTC 就绪。根代理提供的 [原网页请求回读证据](../test-evidence/funded-normal-recover-original-2026-10-05T11-36-29-750Z-56abed2e.json) 显示同一幂等键返回 409、0 新 usage、旧 unknown 费用保留。此结果仅验证回读及当时健康，尚不证明付费规划、全部数据库写入路径或原生问题已修复。

有限只读观察使用现有已验证的 `docs/test-evidence/helpers/watch-local-processes-2026-10-04.ps1`。新增 [原生句柄观察](../test-evidence/windows-launcher-native-observer-2026-10-05-1140.jsonl) 于 11:39:33.0149425 UTC 开始，180 秒，500 毫秒轮询。持有 19192、34352、28312、19296、44156、33880 的只读原生句柄；用 signaled `WaitForSingleObject` 加 `GetExitCodeProcess` 记录已退出状态，防止 PID 复用误认。观察器没有主动停止任何进程；目标 Job flags 继续标为未知。

观察于 11:42:33.1668752 UTC 正常结束，实际时长 180.1115314 秒，观察工具退出码 0。六个目标全窗口存活，0 个 `process-exit`，0 个句柄附加失败 / 原生查询失败。36 份资源样本中最低空闲物理内存为 13,611,016,192 字节，最低可用 commit 为 8,531,492,864 字节，物理负载最高 59%。结束时距该次 `workbench-ready` 约 7 分 49 秒。

11:41 附近一次目标快照：启动器 private 553,566,208 字节 / working set 462,311,424 字节；API private 182,489,088 字节 / working set 173,256,704 字节。上述快照和窗口结果不能证明旧退出瞬间没有 JS 堆、WASM、目标 Job 或系统 commit 限制，不能证明 Node 24.19 修复了故障，也未包含之后根代理新发起的真实规划请求。

建议根代理把此次 Node 版本观察做成一轮有限 A/B，而不是反复重启：保持当前数据、源码、审批和父进程安排，结合只读 GET / 原网页回读记录观察窗口；进程先退出的顺序和实际 native code 比增加重试更有价值。若父 pwsh / Codex 先结束再连带服务结束，继续核对会话回收；若父链活着而 launcher 单独 native fail-fast，优先取得该次栈或 FAST_FAIL 子码再缩小模块。短期存活不能替代真实项目验收。不要给 unknown 请求更换 key 重发，不要根据代理重启时间的巧合补写扣费结果。

## 静态网页启动候选：只读核对，未实施

现成原型在 `docs/test-evidence/helpers/verify-planning-candidate-web-isolated-2026-10-05.mjs:63`：外层 Express 先挂 `express.static(resolve('dist/web'))`，随后 `front.use(app)`，通过一个同源 HTTP 服务提供已构建真实网页与 API。这轮已有实际 Edge 的规划候选 UI / API 证据，没有加载 Vite 开发服务。它是可借用的组合方式，产品启动器当前还没有静态模式；`scripts/demo.mjs` 的正常启动同样使用 Vite。

该 helper 的上一行 `await app.locals.shutdown()` 为隔离测试刻意停用后台服务，不能复制到生产启动路径。`createApp` 末尾会对所有未命中的路径返回 404，因此也不能在现有 app 末尾简单追加静态 middleware。可在 `local-api.ts` 用外层 HTTP app 组合静态网页和原 API，保留原 `app.locals.shutdown()`、本机 client、IPC 和执行审批生命周期；对静态层也保持本机绑定及相关访问边界。若把网页与 API 都绑定到固定网页端口，还须同步 session 元数据和本机 client 所使用的实际端口，不能只改输出 URL。hash 路由已有 `#models` / `#run/...`，无需改成另一套路由设计。

这种产品启动方式可避免启动时导入 Vite/HMR/Rollup 原生解析器，减少运行期依赖；尚不能声称它解决了当前 `0xC0000409`。已经构建的资产应先核对存在，缺失时给出构建说明，不要无声退回开发服务器或后台重新构建正在使用的静态目录。开发模式仍可保留显式入口。

现有验证差距很明确：`tests/local-launcher.test.ts` 的 5 个案例仅检查帮助、参数和启动锁；`local:check` 路径完全跳过网页启动；`demo:check` 也不启动网页。隔离静态 UI helper 的成功覆盖构建网页与规划 API，却没有覆盖生产本机执行器与所有运行生命周期。若根代理实现该候选，至少需要以下零费用实际检测，然后才可使用它继续真实验收：

1. 独立目录中实际静态 local 启动：固定网页端口、`index.html` / JS / CSS / hash 路由、缺失构建与端口占用失败；断言运行进程未加载 Vite/Rollup parser。
2. 同源网页调用真实 local API：连接/权限边界、幂等请求回读、会产生长响应的事件/交付读取；真实本机命令仍等逐次审批，撤回设备权限仍生效。沿用本地固定协议回归仅用于工程检测，不计真实模型验收。
3. 关闭和重启独立环境：工作台/本机 client / API / 数据库都释放，重启保留已完成任务和原授权且不新增重放调用；之后按原目标另外完成真实正常和恢复两条路径。

截至上述只读诊断阶段，没有实施静态模式、修改当前服务或运行上述新增回归，只报告可复用位置与差距。之后已按根代理新任务实现并验证静态模式，见 [完整阶段证据](local-production-static-stage-2026-10-05.md)；该实现没有改变本报告的“原生退出根因未定位”结论。

源码指纹（本次只读）：`scripts/local.mjs` SHA256 `b08683b2d6e1d890cce7752e1055633b24ff39702b45db84edcc4c55a0a92d6d`；`scripts/local-api.ts` `967a0856c617d002318c205c2ac2edba2eb34577bd4a198458ed603b487b9d6f`；`package-lock.json` `017065ee531426b8ff93e1f33c26a92a3ed6e64dfef3b263ab07d79cbd502ddc`。
