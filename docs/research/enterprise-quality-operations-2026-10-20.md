# 企业质量、观测与数据维护复用调研

日期：2026-10-20。源码基线：`4fc763983ce0aae292052ec87c88b7f563a1fac2`。本轮仅核对本地源码、固定 npm 包、官方文档和官方 GitHub；没有安装新依赖、启动生产/远程服务、调用模型、清理数据或改业务源码。本文的接口与文件建议是后续实现计划，不是已完成能力。

## 选型结论

1. **评测选 Promptfoo，独立安装到评测目录。** 复用其 JS provider、声明式案例、确定性断言、JSON/JUnit/HTML 报告；只补为伍异步运行 API、证据关联和发布门禁适配。常规 CI 仅使用隔离假模型/固定回执，不获取真实模型密钥。真实端到端评测必须另有新预算与明确执行授权，完整走为伍 API。
2. **观测保留现有 durable trace 与账本。** 固定 DSH OTel 后端仅为反馈授权后的会话日志上传，不能把它打开即宣称生产追踪已接通。持续生产观测可将现有 trace 的脱敏摘要映射到 OTel 标准日志/指标，通过薄 exporter 复用 SDK/Collector；不再写一次会话捕获或另立收费账本。
3. **运维选 systemd timer + 既有维护 API。** 首先周期性盘点、记录备份健康和生成建议；清理由现有 preview/confirm/reconcile 做边界检查。定时器本身不能成为删除授权，不能定时绕过现有冷备停机条件。
4. **知识生命周期复用现有文档修订、哈希、软删除、vault 归档与索引。** 自有代码只补引用关系、过期/失效建议、版本化处置单和恢复验收。LLM 推理继续使用网页配置 API；不加载本地大语言模型。已有轻量索引/嵌入不因本调研重新安装。

## 已有实现和缺口

| 范围 | 已核实源码能力 | 本轮确认的缺口 |
|---|---|---|
| 规则评测 | `apps/api/src/automation-learning.ts:107` 的 `evaluateImprovement` 对外部提交的 before/after 文本做规则评分，明确 `modelExecuted:false`；已有 evaluations/reviews 和采纳版本检查 | 不能证明员工、工具或真实模型实际执行；缺少固定样本版本、运行 ID/输出哈希绑定、独立发布 gate |
| 完整运行 | `apps/api/src/app.ts:391` 的 `POST /api/projects/:id/approve` 接收 `version`、`retainUncertainCosts`，事务内检查计划、模型路由、预算、权限、执行目标，返回 `{id,status}`；同项目版本已有运行则返回 existing | 外部评测器需要按真实路由适配，并区分新执行、读取旧运行和缓存；不能将 existing 运行算成新实跑 |
| 运行证据 | `GET /api/runs/:id` 提供事件游标；`run-management.ts` 提供 export、artifacts、单件下载；`run-evidence.mjs` 已有输出摘要及 SHA；`trace.mjs` 以 sourceKey 固定 DSH session 事件身份 | 脱敏质量摘要与 CI/版本 manifest 的共同关联尚需补齐 |
| CI | `.github/workflows/core.yml` 已在三平台跑 portable core，另有隔离 PostgreSQL/Docker 作业 | 尚无选定评测器的锁定依赖、版本化案例与报告 artifact |
| 保留 | `storage-retention.mjs` 只读建议：完成热日志 24 小时，副本/沙箱 7 天，发布保留最新 3 个，备份最近 30 天及最新 3 份；最多最近 50 个运行 | 不是自动删除策略；缺周期健康历史、失败可见性，旧发布与备份仍需人工核对 |
| 清理保护 | `storage-governance.ts` 已有 scopeHash、30 分钟预览有效期、文件身份/哈希重验、空闲/费用/设备检查、started/partial 状态与只核对不续删 | 不应另写目录递归删除器；周期维护如需自动执行，应先增加有范围、版本、额度和撤销语义的政策授权 |
| 备份 | `backup.ts` 在线加密导出在一致性锁内，活动运行/模型预留阻止备份，限 50 MiB；`backup-checkpoints.ts` 校验跨运行检查点引用；冷备脚本已有隔离恢复检查 | 需周期调度和成功/跳过/失败记录；已有在线接口不适合无限增长数据；没有因 timer 而自动取得停止生产的授权 |
| 知识 | `knowledge.ts:70–75` 当前文档引用 `knowledge_revisions` 的 version/SHA，提供版本列表，删除为带 version 的软删除并归档 vault；已有检索配置与索引 API | 缺定期 freshness/review 提示、废弃与历史运行引用关系检查、索引代际与恢复证明的统一摘要 |

## 固定 DSH 遥测包实际接口

固定版本来自 `services/agent-runtime/package-lock.json`，不能用上游最新文档推断当前能力。

| 包 | 固定版本/安装位置 | 已核实 API 与限制 |
|---|---|---|
| `@deepseek-ai/dsh-session-telemetry` | `0.1.5-rc.1`，runtime 顶层 `node_modules` | `SessionTelemetryBackend`、`SessionTelemetryCoordinator(ctx,sink,{capture:'live'|'on-demand',includeHistory})`；sink 为非阻塞 `emit`、可选 `flush`、`shutdown`；sharing 为 `full/feedback-only/disabled` |
| `@deepseek-ai/dsh-session-telemetry-otel` | `0.1.5-rc.1`，嵌套于 `dsh-base/node_modules` | default `OpenTelemetrySessionBackend`；Config 仅 `mode`、`exporter`、`processor`、`shutdownTimeoutMillis`；mode 只有 `FEEDBACK_ONLY` 和 `DISABLED`；exporter.url 必须是完整 HTTP(S) OTLP **logs** endpoint |
| OTel JS | 锁定 `api=1.9.1`、`api-logs/sdk-logs/exporter-logs-otlp-http=0.220.0`、`resources=2.9.0` | SDK 管理批处理、队列、重试；DSH 外层 shutdown 默认 3000 ms；进程崩溃仍可能丢失队列，不能替代财务或交付证据 |

关键源码是已安装包的 `lib/index.js`、`lib/types/index.d.ts` 与 `lib/types/coordinator.d.ts`。包 repository 指向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，其 npm `repository.directory` 为 `packages/session/session-telemetry`。当前官方插件库存本地文件及 GitHub 检索没有提供已验证可直接接入为伍评测全链路的插件证据；这不是断言市场上不存在此类插件。

`FEEDBACK_ONLY` 只在新的 canonical `feedback/record`、本会话 `feedback/message-put/delete` 或 cold `feedback/committed` 后捕获至该反馈的前缀，包含历史上下文；后续事件等待下次反馈。此后端的公开 `emit(record)` 故意为空操作。`DISABLED` 不创建 SDK transport。**不得通过伪造反馈、改 mode 值或直接调用 emit 来启用持续上传。**

脱敏扩展点的真实类型/源码名称是 **`session-telemetry/record`**，不是 README 某处写成的 `sessionTelemetry/record`。默认没有脱敏规则；throw 时该条外发副本 fail-closed，canonical 日志不修改。`sharing` 是配置披露，不是成功投递回执。重复事件接收端按 `(session.id,session.format_version,event.seq)` 去重。

为伍当前 `host.mjs`/`product-runtime.mjs` 没有显式挂载上述 telemetry 后端，`trace.mjs` 已在 `session/event`、`tools/pre-execute` 等边界记录持久档案。因此建议先从档案导出有限摘要（run/task/attempt、耗时、tokens、已确认费用、结果状态、代码版本），再按需要映射为 OTel logs/metrics。若后续直接使用 DSH live seam，则需另一个正常注册的 backend、明确授权模式和脱敏策略；它不是打开已有反馈后端，也不应和该后端重复注册同一服务。

本轮文件 SHA256（用于固定调查对象）：

- runtime lock：`c2e74a3afbc4b844d09da2bcbb75b0cf7a14057a77a40ad90cea97c77fd1bbdf`
- telemetry seam `lib/index.js`：`59282ea9663d033b5efe8ef9928fce89044e0a2ce7c278ec88ee0cde66c0b2f6`
- OTel backend `lib/index.js`：`30345e02f98f06f468600c5e6c83651f7c0c42ade11cb9e0d76eb54c393aaab7`

## 成熟评测实现比较

| 候选 | 官方能力 | 适用性/决定 |
|---|---|---|
| Promptfoo | [MIT CLI/库与官方仓库](https://github.com/promptfoo/promptfoo)；[JS provider](https://www.promptfoo.dev/docs/providers/custom-api/) 暴露 `id()` / `callApi()` 并允许 output/error/metadata/cost/tokenUsage | 选择。异步 JS 适合等待为伍任务终态；无须另部署数据库和常驻网页。它本身依赖并非零，须放独立目录锁定，安装验收前不声称体积/性能已测 |
| Promptfoo HTTP provider | [HTTP provider](https://www.promptfoo.dev/docs/providers/http/) 可配置请求与响应处理 | 简单调用可用；为伍包含版本、批准、轮询、未知结果和证据核对，选 JS 薄适配更清晰，不把整条业务流程塞进模板 |
| Langfuse | [SDK experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) 可用本地/平台 datasets 和 task 函数评测应用；[离线评测](https://langfuse.com/docs/evaluation/get-started/offline) 能关联 task trace、评分、dataset run | 能接现有 API；未来需要统一交互分析时保留候选。当前不作为首批基础设施 |
| Langfuse 自托管 | [官方 Compose 指南](https://langfuse.com/self-hosting/deployment/docker-compose) VM 建议 4 核、16 GiB、足够磁盘；文档指出 Compose 不自带高可用/备份。其 [ClickHouse 说明](https://github.com/langfuse/langfuse-docs/blob/main/content/self-hosting/deployment/infrastructure/clickhouse.mdx) 明确需要 ClickHouse | 对轻量 JJ 首批目标额外运维偏重；不是“加一个 SDK”就获得完整平台。云端数据上传也不是本次授权范围 |

[Promptfoo 断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/) 提供确定性字符串/JSON/JS 断言及模型评分；本次仅选确定性断言。其 [CI 文档](https://www.promptfoo.dev/docs/integrations/ci-cd/) 提供 JSON/JUnit/HTML 报告与 gate。照官方能力复用，但示例中的 `@latest`、`--share`、直连模型密钥不照搬：为伍采用精确版本 lock、私有 artifact、代理 API 与明确预算。

关闭 CLI 自带使用遥测和更新检查：`PROMPTFOO_DISABLE_TELEMETRY=1`、`PROMPTFOO_DISABLE_UPDATE=1`，依据 [官方设置](https://www.promptfoo.dev/docs/configuration/telemetry/)。这只控制 CLI 的相应行为，不等于完整禁网；CI 仍需保证 provider/defaultTest 不含 OpenAI 等直连 provider 或模型型断言，且 fixture 路径拒绝外部请求。

## 第一可独立实现模块：版本化评测桥与发布门禁

### 文件边界

- 新增 `tools/evaluations/package.json`、`package-lock.json`：独立 Promptfoo 精确版本，先做安装兼容与许可证/依赖检查，再记入 manifest；本调研不臆定未验证版本。
- 新增 `tools/evaluations/weiwu-provider.mjs`：标准 JS provider，只负责 API 生命周期适配。
- 新增 `tools/evaluations/datasets/<suite>/<version>.json` 与对应 manifest：固定测试数据和来源，不接受运行时改写的“同一版本”。
- 新增 `tools/evaluations/promptfooconfig.yaml`：显式 provider + 确定性断言；生产预算不放进 YAML。
- 新增 `tools/evaluations/report-manifest.mjs`、`release-gate.mjs`：绑定结果到源码、依赖、案例和真实证据，不重写 Promptfoo 的断言引擎。
- 新增 `tests/evaluation-bridge.test.mjs`、`tests/evaluation-release-gate.test.mjs`，复用现有隔离服务/固定 provider 回执；待通过后在 `.github/workflows/core.yml` 增加独立离线 job。仅为连接现有 API 无需先建新数据库或网页。

### provider 接口和默认行为

`new WeiwuProvider({config:{mode,baseUrl,projectId,projectVersion,runId,datasetSha256,authorizationFile,timeoutMs}})`，实现 `id()` 与 `async callApi(prompt,context)`。

- 缺省 `mode='replay'`，只读已保存、已脱敏且哈希核对的案例。`mode='inspect'` 只 GET 已有 run 与证据。两者返回 metadata 中 `executionKind='fixture'|'existing-run'`、`modelExecuted=false`（本次调用没有执行模型），不得冒充新运行。
- `mode='execute'` 必须显式启用并有对应批次的新执行授权/预算标识；缺授权在任何变更请求前报错。授权文件只承载引用、批准范围和上限，不存模型或网关密钥。长期应由企业权限模块提供服务端可验证的评测批次授权；在它完成前，该模式只能由已授权操作者手动触发，不能把可编辑 JSON 当安全凭据。
- 即使 execute，provider 也不接收/注入模型 API 密钥，不使用 Promptfoo 默认云 provider。只调用已配置为伍 API；网关和模型版本、权限、每日金额/次数、未知费用由原服务器检查。`retainUncertainCosts` 默认为 false，不自动放宽、补预算、重试或代批准工具。
- 请求 API 的身份/Origin 沿用产品已支持机制；当前 `request-origin.ts` 是请求来源保护，不能当多用户认证。不得伪造浏览器头绕检查；企业认证接口未完成时不宣称“任意外部 CI 可安全连生产”。

### 已核实的执行顺序

1. 案例先绑定**已准备好的具体项目与版本**，读取 `GET /api/projects/:id/cost-readiness`。普通确定性回归不额外触发 AI 规划。
2. 显式 execute 时调用 `POST /api/projects/:id/approve`，body `{version,retainUncertainCosts:false}`，使用同一 eval case 派生的稳定 `Idempotency-Key`。服务器返回 `{id,status,existing?}`；existing 标记只能视为引用旧结果。不同样本/重复试验需新准备的隔离项目/版本，不能静默借用同版本旧结果。
3. `GET /api/runs/:id` 以游标读取至终态；失败、费用未知、等待工具批准等记录为 blocked/error，而不是模型低分。超时只停止本评测等待；若要取消，单独使用已有 `POST /api/runs/:id/cancel` 并核对结果，不把网络中断当外部动作已撤销。
4. 使用 `/api/runs/:id/export`、`/artifacts` 与 `/artifact` 核对档案完整性、输出哈希、验收结果及账本引用。不能只拿最后一段自然语言声明判成功。费用仅取已确认原收据；未知费用字段保留 unknown，不以零替代。Promptfoo 的 cost 是显示副本，不能成为财务事实源。
5. 若评测范围明确包括 AI 规划，另按已有 `/planning-quote` → `/generate` → `/generated-plan/confirm`，把规划预算/usage 一起纳入授权与证据；不把模型规划混入免费前置准备。

当前源码没有通用 `/estimate` 或 `/run` 启动路由，后续实现不得按该猜测调用。`idempotency.ts` 对同 key 不同 fingerprint 返回 409，对处理中/结果未知不自动重放；评测器应保留该语义。

### dataset 与 run manifest

使用 JSON schema/Zod 校验一个明确版本的普通文档即可，无须新建“评测平台”。建议字段：

```text
format: weiwu-evaluation-v1
evaluationId, createdAt, mode, executionKind, modelExecuted
source: {gitSha, dirty, rootLockSha256, runtimeLockSha256, evaluatorLockSha256}
dataset: {id, version, sha256, caseIds, sourceEvidenceRefs, redactionPolicyVersion}
criteria: {version, sha256, requiredCaseIds, expectedEvidenceKinds}
target: {projectId, projectVersion, snapshotSha256, runId, existing,
         modelRouteVersions, capabilityVersions, knowledgeRevisionRefs}
authorization: {batchId, budgetApprovalId, allowedProjectIds, expiresAt}
evidence: {archiveIntegrity, traceDigest, artifactDigests,
           usageReceiptRefs, confirmedCost, unknownCost, outcomeUnknown}
outputs: {promptfooJsonSha256, junitSha256, reportSha256}
result: {pass, fail, error, blocked, skipped, gateStatus, reasons}
```

`modelExecuted` 来自本轮执行证据，不能由调用者任意声称；fixture 与真实运行明确区分。项目快照中的模型/能力/知识版本是事实源，manifest 拷贝并核验引用。文件 SHA 只能证明内容未变，不能自行证明授权与来源；需同时核对运行归属、服务器回执与原版本。

发布 gate 必须拒绝：源码/lock/dataset/rubric 不匹配，缺必需案例，空结果、仅 skipped/blocked，出现 error/unknownCost/outcomeUnknown，档案或产物哈希不完整，非有限分数，以及将 fixture/existing/cache 标为 fresh live。阈值必须由固定 rubric 定义，不能在失败后改阈值覆盖原结果；候选与基线必须用同一 dataset/rubric，差异分别保存。离线 gate 通过只证明工程边界；若发布范围要求新的真实质量验收，则缺新预算/实跑时标 `live-evidence-required`，不冒称完成。

### 最小测试与实际验收

1. 无 execute 授权、缺版本、hash 不符、普通 fixture 配置混入付费断言时，零变更 HTTP 请求、零模型请求；缺省模式固定验证这一点。
2. 本地隔离 HTTP fixture 覆盖批准→queued/running/completed→分页事件→artifact/usage 证据；断言 provider 实际走完这些边界。该测试证明适配流程，不证明真实模型质量。
3. 409 版本变化、402/422 预算拒绝、工具等待批准、超时、unknown cost、unknown outcome、duplicate/existing 必须保持可区分，不自动 approve/retry/retain。
4. 同 Idempotency-Key 丢响应重查不产生第二次批准；不同 fingerprint 拒绝。新 run ID/旧 existing、报告篡改、dataset 篡改均使 gate 失败。
5. CI 产出脱敏 JSON/JUnit/HTML + manifest，仅上传私有 CI artifact；失败也保存报告且 job 非零退出。CI 不保存生产原始会话、凭证、下载链接签名。
6. 有明确新预算后，单个真实小案例从批准、员工模型调用、工具收据、产物验收、已确认费用到 manifest 全链路验收；在此之前将 live 验证列为未执行。

## 运维和知识生命周期分步落点

### 维护调度与备份

现有 `scripts/deployment/weiwu-jj.service` 证明项目采用 systemd 用户服务的部署形式，**不是本轮探测到的生产现状**。复用 [systemd timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) 的 `OnCalendar`、`Persistent`、`RandomizedDelaySec`；配套 oneshot service，同一 service 活跃时不会再起一份。`Persistent` 只补触发，不保证备份成功；任务必须自记成功时间、跳过原因、耗时和产物摘要。JJ 版本未远程探测，安装前要核对本机 man/systemd-analyze，不直接使用网页最新专有选项。

首批建议新增 `scripts/maintenance/report.mjs`、`weiwu-maintenance.service/.timer`，仅读取 `/api/storage`、`/api/storage/retention` 及已有备份 manifest，输出受权限保护的健康报告。没有变化时只更新健康状态，不每次创建 storage preview，避免撞到 1000 条/16 MiB 元数据保护上限。

在线备份 timer 只在明确启用且提供既有加密密码的安全获取方式后调用 `/api/backup/export`；活动运行返回 409 时记录 skipped，不能自动停止员工。先写临时文件，校验格式/大小/哈希再原子重命名；定期隔离 restore 验证成功才标记 recoverable。密码不写 argv、日志或报告。超过 50 MiB 走既有冷备流程，`verify-mvp-full-offline-backup.mjs --confirmed-stopped` 需要真实停机条件，不能把 flag 当作停机事实。不要定时复制运行中的物理数据库目录。

清理继续复用 `POST /api/storage/preview`、`POST /api/storage/cleanups/:id/confirm`、`POST /api/storage/cleanups/:id/reconcile`，并保留 completed/partial/interrupted 的幂等读取和中断核对。不得将过期建议直接变成删除，不能自动清理 canonical 交付、原始费用/审批、恢复检查点、失败/未知现场。备份留存政策也必须先校验恢复证据及引用，保留当前/共享依赖发布；不删除被其他发布软链接引用的 node_modules。

### 知识生命周期

成熟复用对象就是仓库已有知识修订与数据库事务，无须引入新的向量库/知识平台。第一步做只读审核清单：source、document/version/SHA、owner/department、最近索引代际、复核时间、被哪些 run/skill 引用；建议更新、撤回或重建索引时生成具体版本处置单。

第二步在现有 `knowledge.ts` 版本校验和 vault lock 内执行软删除/归档，保留 `knowledge_revisions`、固定快照和引用证明，索引视作可重建派生数据。活动运行和可恢复 run 对旧 revision 的引用应阻止物理清除；新运行授权必须按当前员工权限重新判定，不能因为旧快照曾可用就授予新的访问权限。对已撤销资料的历史执行读取语义需复用既有权限逻辑逐项验证，不在本轮宣称已全部覆盖。

验收应包含：更新后旧 run 引用仍可按规则核验，删除后新检索不再返回该资料，无权员工搜不到受限内容，索引代际落后可见，重复归档幂等，备份隔离恢复后版本/SHA/引用/检索结果一致；轻量嵌入或重排仅在现有资源政策下测试，不启动本地大语言模型。

## 验证状态

- **已核实**：上表本地源码与固定包 API、文件哈希、官方 Promptfoo/Langfuse/systemd 文档及其适用边界。
- **未执行**：Promptfoo 安装/运行、真实 API 端到端评测、持续 OTLP exporter、JJ 资源测量/systemd 版本检查、timer 安装、生产备份/恢复、知识生命周期新实现。
- **后续门槛**：真实模型评测须另有新预算；外部 CI 连生产前须具备服务端可验证的企业身份/评测授权。本文不把历史预算、fixture 成功或外部工具成本估算当作这两项证据。
