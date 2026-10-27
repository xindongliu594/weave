# 规划报价 POST 与响应语义回归（2026-10-06）

本次修复已冻结，尚未由本报告执行正式构建或加载。源码和测试的完整 SHA256 见 [sourceSHA manifest](planning-quote-post-2026-10-06-sourceSHA.json)，冻结时间为 `2026-10-06T10:12:28.6891145Z`。所有验证均为本地隔离测试；真实服务、原数据库、员工文件和付费模型调用均未操作。

真实问题证据保留在 `docs/test-evidence/go-long-planning-quote-http-diagnostic-2026-10-06.json`：合法的 3840 字规划调整经 URL 编码后超过 Node 默认 16384 字节头部上限，旧 GET 返回 HTTP431 空响应。本次新增 `POST /api/projects/:id/planning-quote`，网页将原报价字段放入 JSON 正文；旧 GET 继续支持。两者复用同一 `inspectProjectPlanning`、`REPEATABLE READ READ ONLY` 事务和权限/预算检查。POST 使用原严格 `projectPlanningInputSchema`，仍只允许最多 4000 字，无截断或放宽权限；报价不调用模型，也不写幂等键。报价响应字段保持原样。

网页可将只读报价的 HTTP431/503 空体或非 JSON 响应报告为带具体 HTTP 状态的 `ApiError`。具有副作用的请求遇到空体或非 JSON 响应时仍是结果未知的普通协议错误：原请求编号和参数保留，不清理 pending、不自动重试。结构正确的拒绝响应保留原有处理。真实规划生成与组织对话的 pending 保存/恢复流程均有动态回归。

规划系统提示明确区分本次任务产物与外部固定导入文件。本次产物的 inputs 只填 `path` 和 `producerTaskId`，由宿主在本次 accepted seal 后绑定 SHA；不得复制 executionHistory 或旧运行的文件 SHA。只有用户明确选定的外部固定导入文件使用给定 `sha256` 且不填 producer。原 schema、批准、预算和执行门禁未放宽；合同验证器由另一项修复负责。

验证结果：

- 新增隔离 API/proxy 回归 3/3：真实默认限制 HTTP server 及官方静态代理均复现 3840/4000 中文 GET431 空体；POST200 完整返回正文。逐表比较全部 public 数据表确认请求前后完全一致，含使用方额外提供幂等键的情况；provider fixture 调用数为 0。短 GET 与 POST 除 checkedAt 外等价，4001 字、额外字段、错误类型与越权模型仍拒绝，原费用上限仍生效；实际规划消息包验证新 producer 提示。
- 原项目规划和组织 session API 回归 27/27，加上上述新回归共 30/30，见 `planning-quote-post-2026-10-06-api-final.txt`。
- 响应、规划 UI、组织 draft、静态代理回归 45/45，见 `planning-quote-post-2026-10-06-unknown-response-final.txt`；包括合法 4000 字单次 POST、无幂等键、未知 mutation 响应保留原 pending 身份且无重发。
- 实际组织 UI 回归 15/15，见 `planning-quote-post-2026-10-06-organization-ui-final.txt`。合计唯一测试 90/90 通过。
- 最终 TypeScript 检查退出码 0，日志 `planning-quote-post-2026-10-06-tsc-final.txt` 为空；最终检查已包含修正后的 quote fixture `checkedAt`。

原始失败日志全部保留：`tsc-first.txt` 为 Response fixture 的 Buffer 类型问题；`tsc-response-fixture.txt` 为 quote fixture 缺少 checkedAt；`unknown-response-first.txt` 为组织 session 测试使用普通单元入口，隔离数据库防护在连接前拒绝。上述问题已修正，并按正确隔离入口重新验证。默认 Vite 配置加载器的构建因 sandbox 读取父目录被拒，保留于 `planning-quote-post-2026-10-06-build.txt`；未修改配置或扩大访问。此前 native 配置加载器的临时隔离构建成功（1688 modules），日志 `planning-quote-post-2026-10-06-build-native.txt`，但该构建早于最后的未知响应改动，不能作为当前冻结源码的正式构建证明。主任务将在全部 P0 源冻结后统一完成正式构建和 idle 加载。

旧冻结业务 helpers 原样保留；新 normal/recovery successor 应明确允许只读 quote POST，保持其余 mutation guard、审批和预算边界。此报告未执行任何 helper。
