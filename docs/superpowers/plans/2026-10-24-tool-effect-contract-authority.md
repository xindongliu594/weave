# C1 持久合同审核与调用准入 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and TDD. 本片已授权，不提交。

**Goal:** 管理员核对服务端固定候选→审核登记→冻结快照→真实 DSH 调用前复核→退役阻断形成业务闭环。
**Architecture:** 复用严格 EffectContract、audit v2 capability.configure、现有 DSH registry/guard/B2 body boundary。API 管理不相信客户端 source/readOnly 声明，source provider 从真实安装/发布清单生成固定候选；未注入 provider 拒绝审核与准入。
**Tech Stack:** 现有 TypeScript/ESM、PostgreSQL、DSH 0.1.5-rc.1，无新增依赖。
**Spec:** C1 总计划 Task 1/3、企业基础设计；上一片 `2026-10-24-tool-effect-catalog-slice.md`。

## 文件/接口与边界

- 新 `apps/api/src/tool-effect-contracts.ts`，独立 `migrateToolEffectContracts(db)`；`ToolEffectContractService({db,resolveBinding,admissionTimeoutMs?})` 提供 candidate/review/list/retire/snapshot/assertSnapshot/withAdmission。候选由可信 resolver 独立返回完整合同，HTTP 只提交 namespace/toolName/expectedDigest，不能提交审核身份、来源、效果或 schema。
- 新 `tests/tool-effect-contracts.test.ts`、`services/agent-runtime/tool-effect-admission.test.mjs`；API/DB/真实 DSH 测试不调用模型。原 audit-events.ts、db.ts、app.ts、路由 catalog、product-schema 和 local-execution 不改。
- 必要 runtime 文件：tool-definition-effects.mjs/.d.mts，employee-tool-access/capabilities/hosts；host.mjs、product-runtime.mjs/.d.mts 透传 effect snapshot 与服务回调。合同模式复用现有 task-tool-boundary 防止 after-guard 修改，coordinator 接受实际 factory 转发凭证而非直接绕过入口。
- 数据语义不可修改/删除；退役仅单向 CAS。审核与退役复核当前管理员 status/role/issuer/subject/epoch，在同一事务写 audit+outbox。snapshot 与每次准入核对 DB 活跃记录、digest、当前可信 source 候选，未知/漂移/退役拒绝。
- withAdmission 限定一条调用、最多 30s（可缩短），持合同 SHARE 锁防退役跨检查/调用间隙。caller abort/timeout 使信号取消并释放事务；已进入 invoke 的超时不能标 notExecuted，原 runtime 继续负责执行追踪。
- 第一片只准入已审核 free read；未知费用、metered、provider-key 拒绝。workspace/external 可以审核固定合同但调用返回 TOOL_EFFECT_INTENT_REQUIRED，待 Task 2 持久 intent 接线；无 effectContractVersion 的旧快照保留原路径，不升级其效果保证。

## 步骤

- [x] RED：真实 DB/HTTP 拒绝非管理员/过期 epoch/客户端伪造候选，审核审计同事务回滚，immutable/CAS/退休旧快照，source/schema 变化、缺可信 provider、unknown/metered/provider-key；read 计数一次。
- [x] 最小 SQL/API service 与明确 router 挂载接口。审核成功必须来自 server candidate，不把插件 annotations 当审核。
- [x] RED→GREEN 实际 DSH 两层 Host：缺合同/替换/退役零 body，合法 fixed read 一次，既有员工授权仍先核对；取消/超时释放事务，协调直调不旁路。
- [x] PGlite 13 pass / 1 native-only skip；缓存 PostgreSQL 17.10 14/14、0 skip，真实锁竞争通过，自有随机 cluster 已停止清理。runtime 93/93 回归。
- [x] 向父交接 migration/router/source provider/runtime callbacks，停止编辑供复审；未实现 intent/receipt/query/compensation 明确留项。

## 本片完成证据与接线边界

详见 `.superpowers/sdd/2026-10-23-enterprise-plugin-completion/tool-effect-authority-handoff.md`。本片实现可挂载的业务 service/router 和真实 DSH 调用前合同门禁；全应用 HTTP、可信生产 resolver、计划批准时 snapshot 与 ProductDshRuntime 的 effectAuthority 注入由父任务串行接线。没有 provider 时拒绝候选审核与调用，旧运行不自动获得合同保证。事务 COMMIT 未知或 ROLLBACK 失败丢弃连接并保留首错；取消发生在 COMMIT 等待期间也不报告成功。
