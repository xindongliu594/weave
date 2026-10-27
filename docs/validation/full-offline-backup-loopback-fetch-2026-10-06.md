# 离线备份测试的显式 loopback-fetch 模式

仅修改 `scripts/verify-mvp-full-offline-backup.mjs` 与 `tests/full-offline-backup.test.mjs`。默认 `networkGuardCode()` 继续拒绝所有 fetch；显式 `networkGuardCode({ allowLoopbackFetch: true })` 允许新建 execution 副本内的本地 HTTP 测试。main 在复制恢复交付物到全新 execution 目录后才启用此模式，两个 restore worker 的 fetch 禁令和读库范围未改变。没有执行真实备份、原 API/服务/模型或读取/运行员工交付。

显式模式将 string / URL / Request 构成同一 Request，再检查其绝对 URL：协议仅 http/https，主机仅 `127.0.0.1`、`localhost`、`::1`，拒绝 URL 用户凭据、未知对象、相对 URL及已解码的提供商路径。提供商路径包含既有 v1 / Chat / Responses / 费用接口，及 models/providers、版本接口、生成/embedding/messages 入口。`redirect:error` 始终覆盖调用方选择，连本地重定向也不跟随。原 Socket 和 HTTP/HTTPS request/get 守卫代码保留，TLS 校验未放宽。

原执行环境的 OS 白名单抽出为 `executionEnv`，仍丢弃凭据、代理和先前 NODE_OPTIONS，仅加入本次 guard preload。preload 通过 NODE_OPTIONS 继承到测试启动的 native 子进程。main 输出增加 `employeeTest.networkMode='loopback-fetch'` 与 `fetchRedirectsBlocked=true`，测试命令及验收范围仍为原开发测试。

本地最终 **12/12，0 失败，sourceStable=true**（原 8 + 新增 4）：

- 两个明确 loopback HTTP fixture 运行真实 CRUD，覆盖 string / URL / Request、IPv4 / localhost / IPv6；native 子进程继承 guard 和净化后的环境。测试创建、更新、删除的记录实际从 fixture 返回，synthetic credential / proxy 均不存在于子进程环境。
- 外部地址、未知/相对 URL、用户凭据和编码提供商路径全部拒绝；fetch 到外部 Socket 的 attempt 为 0，loopback provider fixture 收到的请求为 0。原 Socket / HTTP 拒绝行为仍通过。
- 外部、提供商及本地重定向仅访问初始路径，不跟随目标；调用方 follow / manual 不能覆盖 error 模式。
- preload 已显式允许 loopback 的隔离 restore worker 仍覆盖 fetch，拒绝本地和外部请求；只打开 fresh synthetic PGlite。

既有目标目录、源码关闭标记、opaque 凭据、junction、pending reservation 和默认严格网络用例全部保留并通过。fixture 目录按原测试约定留在 workspace `.data/full-offline-backup-safety-tests/<随机UUID>`，仅含新建 synthetic 数据，不代表真实员工或真实模型验收。

复现命令：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test tests/full-offline-backup.test.mjs
```

原初 SHA256（同时保存于 `full-offline-backup-loopback-fetch-2026-10-06-before.json`）：

| 文件 | 原初 SHA256 | 冻结 SHA256 |
| --- | --- | --- |
| scripts/verify-mvp-full-offline-backup.mjs | `edd2e7f549876a471d466562bb78939ab14a8482ff3733468aae9ccf152d824e` | `d244812c9139e4df270f1f37cf49a2f1f56540c4f62fdb9b9747128709e6a163` |
| tests/full-offline-backup.test.mjs | `e54dca544a0c334af79ac09d2f102400de1002e605942734ebf3774554da4fd3` | `514b562a7476231e00c9ae922d2f4c4c0c75056fb4fa3e8b41173c1d06274b6d` |

最终完整测试日志为同名前缀 `.txt`，测试前后 SHA / 退出码 / 稳定检查为 `-sources.json`。本次没有修改四个冻结的 Go 操作 helper；真实备份 CLI、明确关闭确认、原数据库禁止打开、全新 copy/restore/execution、既有报告禁止覆盖等守卫未改变。最终实际审计应复制冻结 `d244…` 源，测试本身未运行真实 main。
