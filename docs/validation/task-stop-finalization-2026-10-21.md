# 任务终态维护、网页核对与连续项目验证

本批已完成本地工程验证及独立复审，补齐任务验收后的停止收尾、未知结果核对和网页显示。**尚未部署 JJ；任务级执行 profile 继续关闭。** 这不是整个企业基础计划或真实模型验收完成声明。

延续固定 DSH Host/员工工具边界、OpenShell executor/journal、PostgreSQL CAS、既有身份/CSRF 和 React 页面。没有新增执行引擎、队列、依赖或付费调用。设备和 API 的前置证据分别见 [设备停止](terminal-stop-device-2026-10-20.md)、[Host 准入](terminal-host-admission-2026-10-20.md)及 [API 终态收尾](terminal-api-2026-10-21.md)。

## 本批解决的问题

- 原始模型请求尚未结算、最后费用记录失败或最终检查点未保存时，不能提前认定业务验收完成。只忽略运行时自己的准确停止对象，其他模型/费用错误仍保留。
- 验收后清理超时、Host 关闭未结束或档案追加失败，不再把已经验收的业务改成失败；明确记录维护待核对或记录不完整。同步关闭工具及员工准入，保留同一个关闭 Promise，未结束前阻止新项目启动。
- 协调器遇到尚未结束的 Host 清理时，保持下一项目排队。只有原租约有效、项目/尝试未变化且没有操作或模型/用量事实的未启动 claim，才允许回到原队列；竞态取消仍保持取消。
- 运行页与容量页从已有 SQL 和档案生成维护视图，不新建状态库。核对入口只查询已有 `stopId`，每次重验当前管理员、CSRF、设备与原绑定；不会新发停止、启动或删除。
- 页面显示任务、尝试、代次、沙箱和部分工作版本。请求进行时禁用按钮，成功或失败后重新读取；没有原停止意向、身份不完整或错运行数据均无操作按钮。确认停止仅表示运行名额释放，文件与磁盘仍保留。
- 档案缺失、JSON 损坏、日志缺失或日志归档元数据损坏时，已知 SQL 运行仍可查看，明确显示档案不完整、维护未核对。该视图不能授权恢复或停止核对，也不会伪造事件、交付物或验收通过。

## 实际验证

下表为不同层的证据，不将有重叠的测试数量相加作为总覆盖率。

| 验证层 | 结果与边界 |
| --- | --- |
| 实际 DSH/Host 终态与收尾 | 13/13；原始模型结算、最后检查点失败、归档失败、准入关闭、原关闭 Promise 隔离和准备回调 |
| 相关运行时回归 | 27/27，退出 0；最初四项本机 HTTP 连接失败保留，允许 loopback 后同组通过 |
| 协调器 SQL 与租约 | 新增 19/19、既有 9/9；串行隔离 PGlite，不冒充独立原生 PostgreSQL 并发 |
| 实际 HTTP/SQL 核对 | 8/8，含四种损坏档案子场景；另有鉴权/幂等相关 3/3 |
| 投影、网页逻辑、容量和刷新 | 41/41；原投影两个问题与错运行问题均先复现再修复。容量精确关联的五项测试包含在相关证据中 |
| 浏览器 | 实际 React 运行页和容量页，8 个行为通过；接口为隔离虚构数据，0 控制台错误、4 次准确原请求，未重复提交 |
| 类型与生产构建 | `npm run build` 退出 0，含 `tsc --noEmit`；保留现有大于 500 kB 的构建块提示 |
| 独立审查 | 运行时/协调器三个问题、HTTP 损坏档案问题已修复后复审通过；原未通过报告保留 |

浏览器验证采用现有应用内浏览器。Tabbit 稳定启动器返回 69，未进入浏览器会话；隔离 Vite 首次扫描范围过大导致页面超时，收窄为单个夹具入口后完成点验。测试服务已停止，不改变生产配置。

截图均带工程夹具标识：[待核对](evidence/task-stop-finalization-2026-10-21/terminal-browser-pending.png)、[核对后](evidence/task-stop-finalization-2026-10-21/terminal-browser-stopped.png)、[授权拒绝](evidence/task-stop-finalization-2026-10-21/terminal-browser-denied.png)、[容量页](evidence/task-stop-finalization-2026-10-21/terminal-browser-storage.png)。

## 三个项目连续运行

同一个测试中保留同一个实际 `OpenShellDeviceExecutor`、journal、授权和数据库，连续完成三份开发 → 独立 QA → 经理项目，不在项目间清库或重建设备。

| 场景 | Run ID | 整个进程耗时 |
| --- | --- | --- |
| 正常三个节点 | `254ed4e3-50b7-491e-b438-4cda5c18de3d` | 89.802 秒 |
| 连续项目 1 | `700a1662-55ce-46f0-9ef0-bd8ae2dff6e3` | 三份合计 268.829 秒 |
| 连续项目 2 | `aacad647-9b83-44df-844d-d38ac156f20b` | 同上 |
| 连续项目 3 | `233e8499-eae2-45f7-afd5-ab235fdcdc59` | 同上 |
| A 旧部分版本与 B 新完整版本交错 | `5778901e-8d5f-456f-8cb1-58358a6344cb` | 168.016 秒 |
| 停止回执丢失后的原 ID 冷核对 | `034697fb-7552-4426-995b-6339bb5e02c8` | 32.771 秒 |

四个进程均为退出 0、无信号退出、无 wrapper 超时，各一个测试通过且无跳过。连续项目最终有九个独立 stopped scope、九笔原停止记录和 57 笔原 HTTP/CAS 操作及 claims；每次后续项目都复读并比较原 SQL 行、claim 哈希、完整工作版本、对象、事件、设备日志和实际文件 SHA。最大观察运行数为 1，没有提高原来的 2 个运行名额、128 个保留 scope 或磁盘预留。

这是实际 Product/Host/Handoff/HTTP/CAS 和设备执行器路径，文件及 Node 子进程测试真实执行；模型响应、CLI/gateway/mTLS、UID/cgroup 与 PGlite 服务是工程夹具。回执丢失案例只验证冷核对边界，不称为又一份完成项目。没有 Codex 手写真实员工交付或把固定模型响应当真实 API 验收。

四个场景的 20 份源码起止和跨场景 SHA 相同。其后只有 `app.ts` 的损坏档案 GET fallback 发生变化，另经上述八项 HTTP 检查与独立复审；其他 19 份当前源码保持匹配。保留此前 185 秒进程失败及缺最终退出记录的历史尝试，不用本轮通过覆盖它们。

## 证据及复现

- [本批 manifest](evidence/task-stop-finalization-2026-10-21/manifest.json)：25 份源文件、原始 RED/GREEN、独立审查、构建与浏览器证据的 SHA。源码 `sha256` 对应测试时工作区字节，`sha256Lf` 对应 Git 统一换行后的内容；证据保留原始字节。
- [连续项目 manifest](evidence/task-stop-finalization-product-2026-10-21/manifest.json)及 [说明](evidence/task-stop-finalization-product-2026-10-21/README.md)：精确命令、起止 SHA、退出结果、有界事实摘要和脱敏说明。
- 原始模型/权限凭据、完整 claim token、完整权限证明及重复大体积 trace 不进入本批公开证据。原私有证据保留。

代码相关检查可使用 `npm run build`、`node --test services/agent-runtime/terminal-finalization.test.mjs`；SQL/Product 验证按证据里的 runner 串行执行，不能同时启动多个 PGlite 重测试。网页夹具的三份 `terminal-browser-*` HTML/TSX/server 文件恢复到 manifest 的原相对目录后可启动，使用隔离端口 4479；不连接生产数据库或保存的模型 API。

仍需完成：历史失败/被替代任务现场的停止资格、准确 task key 的容量/回收、恢复与备份载体、Task 6 的 JJ/OpenShell 实机攻击及恢复测试。原生 PostgreSQL 独立连接并发、真实模型验收、企业资源授权等其他阶段继续按 [总计划](../superpowers/plans/2026-10-20-enterprise-foundations.md)推进。累计 $3.41、七笔未知费用和已有权限边界不变。
