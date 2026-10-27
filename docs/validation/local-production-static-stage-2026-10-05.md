# Windows 生产静态网页阶段验证（2026-10-05）

生产静态模式已实现、源码已冻结。通过 `--production` 使用已构建的真实网页和同源本机 API，运行时不启动 Vite/HMR；默认开发启动方式继续兼容。本阶段解决发布版本对开发热更新的依赖，**没有把此前原生退出根因标为已解决，也不是员工 Todo 真实验收或运行 DAG 恢复验收**。

在项目目录中先构建，再启动：

```powershell
npm run build
npm run local -- --production
```

如需沿用指定数据，添加 `--data-dir="已有绝对路径"`；必须先结束占用该目录的实例。当前静态模式复用原本机 PGlite、API 子进程、设备和审批机制，不修改权限或预算。构建缺失会在创建本机数据和启动 API 前给出 `npm run build` 指引。`local:check` 验证 API 和执行器，不得当作静态网页通过证明；与 `--production` 混用会明确拒绝。

## 实现与验证

`scripts/local.mjs` 新增静态模式选择、启动前构建检查和生命周期 `webMode` 字段；已有启动锁、数据目录、API 意外退出处理及关停流程保留。`scripts/local-static-web.mjs` 提供仅绑定 `127.0.0.1` 的原生 HTTP 宿主，沿用 `request-origin.ts` 的本机 / Origin 边界，按流代理 `/api` 并保留正文、query、幂等键、原状态和端到端头。静态资源有正确 MIME、HEAD、SPA fallback；API 错误、缺失 assets 和越界路径不会变成首页。关闭时中止未结束的代理请求并释放网页端口。

| 检测 | 实际结果 | 输出 |
| --- | --- | --- |
| 静态宿主 11 项、本机启动器 6 项、Origin 配置 1 项 | 18 / 18 通过，0 失败 / 跳过 | [首轮回归](local-static-web-tests-first-2026-10-05.txt) |
| TypeScript `tsc --noEmit` | 退出码 0，无诊断 | [类型检查](local-static-web-types-first-2026-10-05.txt) |
| 实际完整 `--production` CLI、真实 API、同目录重启 | 4 阶段通过，退出码 0，0 模型调用 | [最终 CLI 输出](local-static-cli-final-2026-10-05.txt)、[实际证据 JSON](../test-evidence/local-static-cli-2026-10-05T12-16-41.835Z-5f47ecb5.json) |
| 根代理全项目生产构建 | 通过，1687 modules；本阶段未另行重复构建 | [构建输出](funded-production-web-build-final-2026-10-05.txt) |

回归包含真实 HTTP 正文和重复幂等键、上游 403 / 404、Host / Origin 拒绝、编码路径 / 目录链接逃逸拒绝、流式响应首块在结束前到达、API 不可达 502、关闭后端口重新绑定，以及真实 `dist/web` 首页和 JS 字节比对。这些本地协议检测没有调用模型或接触原始数据库。

## 独立完整启动证据

2026-10-05 12:16:41.842–12:16:57.965 UTC，使用现成 Node **v24.19.0**。验证命令：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' docs/test-evidence/helpers/verify-local-static-cli-2026-10-05.mjs
```

实际启动参数（两次沿用同一隔离目录和网页端口）：

```text
C:\Users\JJ\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe scripts/local.mjs --production --web-port=61341 --data-dir=C:\Users\JJ\.codex\worktrees\f57c\agent_department\.data\local-static-cli\isolated-FMs94d
```

保留的隔离数据位于 `.data/local-static-cli/isolated-FMs94d`。首次启动为 launcher **30068** / API **18196**；重启为 launcher **34848** / API **31172**。真实 API 同一幂等键 `d6814f45-b1ec-4a4b-b4ee-aa8311b00f80` 创建并回读同一测试 gateway `11e13a45-3ea9-4c49-afe1-b281d7b292d0`，始终只有一条配置；该地址是不可用的 `https://example.invalid/v1`，没有连接或模型测试。目录中配置模型、usage 和 run 均为 0。

真实静态页面 index SHA256 为 `4cf767c80b46785213e1504b2b001d810c0c558e4e912cafee8355750cacb03c`，JS 为 `dcaee8b6bff2ab9b18da6f42d5d69d3fcc446255a03a2cb80b4a1c1caf7b60a4`。实际拒绝测试得到非 JSON 正文 415、外部 Origin 403、外部 Host 403、API 未命中 404。重启后设备 / grant 标识不变，原幂等记录仍回读原创建结果，不产生新增模型调用或运行。

退出守卫在每次操作前核对专用隔离目录、启动器 PID / 命令 / UTC 创建时间、API PID / 命令 / 父启动器和创建顺序，再持有该 API 的原生句柄，并比对 `Get-Process.StartTime` 与 CIM 时间（小于 2 ms）。只结束该次隔离 API，观察现有“API 意外退出 → launcher finally 清理”路径，未操作任何原始或当前真实服务。两次 launcher 都记录 `api-exit(expected=false)`、`launcher-stopped` 和 `launcher-exit`，启动锁删除、网页端口可再次绑定，并可重启同一数据库。预期强制 API 退出产生 native `4294967295` / launcher `-1`，没有被当作正常退出或新的产品故障。

两次启动器在退出前读取到的已加载 Rollup 原生模块均为空。这里只验证 Windows v24.19 和本次运行窗口；不据此声称所有 Node 版本或长时间运行已验证。

## 保留的失败与冻结指纹

首轮完整 CLI 失败证据保留于 [JSON](../test-evidence/local-static-cli-2026-10-05T12-11-26.622Z-85d73c0d.json) 和 [输出](local-static-cli-first-2026-10-05.txt)。当时 Node fetch 没送出测试要求的自定义 Host，验证器错误地期待 403；产品真实原生 HTTP Host 拒绝测试已通过。其清理守卫又因 `[datetime]'…Z'` 与 UTC 时间比较方式不正确而安全拒绝，没有误停进程。验证器改用原生 HTTP 发送该 Host，并用 `DateTimeOffset.UtcDateTime` 作守卫比较；产品代码没有为此改变。该首轮的隔离 API 后续经独立精确 PID / UTC / 父链 / 目录守卫清理，见 [清理证据](../test-evidence/local-static-cli-first-cleanup-2026-10-05.json)；首轮目录 `isolated-QHMRi5` 和原失败证据保留。最终轮使用新的隔离目录。

生产源码首次回归后未再修改；实际 CLI 首尾重新核对均一致：

| 文件 | SHA256 |
| --- | --- |
| `scripts/local.mjs` | `79c9d0dc4b3b5921d4b07c6ccd71fd028b2703370f99f19a55b5d13e36550049` |
| `scripts/local-static-web.mjs` | `375e7eedbd9ca7b42e2d00111241fc6062c656812c538e2f74215a88ccb281bc` |
| `scripts/local-static-web.d.mts` | `19fa6e115f82f0fbb5986bcacc9490082793baae5e43f44dbec0012e550342ed` |
| `tests/local-static-web.test.ts` | `e574eaa2c4dcc6e08b7fac37eb94c25e6205229ecb05f830be1587a1eec3db8b` |
| `tests/local-launcher.test.ts` | `60e6a769b48c75084473010cbb59dc489ed59dc8cd9d1171ae87e8d09c812bff` |
| CLI 验证器 | `ff502c697d485b6671cbf6d375db481f3ff7a7d0cda1abc96da1de9e228c822c` |

前序诊断与 180 秒只读原生观察见 [启动器审计](windows-launcher-audit-2026-10-05.md)。剩余真实 Todo 员工验收与运行 DAG 中断恢复由主流程继续验证，不能用本阶段 0 run 的工程检查代替。
