# 企业审计合同：共享写入层验收

范围为 D2 Task 1：扩展现有 human_audit_events/audit_outbox，不是整套审计服务或企业交付完成。复用 PostgreSQL 事务和现有 append-only 表；不增加活动运行 JSONL 写入者。

## 已实现并验证

- 严格区分真实发起主体和员工执行归属；新批准、dispatch、merge 等成功事件必须带当前授权证据。接口只校验该证据的结构，真正授权仍由后续 A2/C1 校验点提供。
- 审计和 outbox 由同一条 CTE 写入，调用方事务回滚时一起回滚；单独调用也不会留下只有审计而没有 outbox 的半条记录。
- source event ID 重复时核对完整标准化内容与 outbox/投影关联，冲突拒绝；原业务动作不会因此重放。
- 身份旧调用保持私有兼容路径和 schema 1；历史 actor 不补写、任意 reason 原文不进入摘要。实际 bootstrap/OIDC 身份边界产生受限的 schema 2 身份证据，不能用来授权业务变更。
- 有界字段、严格 action/changes 联合、getter/原型/循环/非有限数字拒绝。task.merge 版本使用实际 canonical SHA256，不能混用普通数字版本。

## 实际证据

父任务最终运行：`IDENTITY_TEST_DIRECT_PGLITE=1 node scripts/test-integration.mjs tests/audit-events.test.ts tests/identity-store.test.ts`。audit 14/14、identity 12/12，共 **26/26、0 failed、0 skipped**。真实执行 SQL 的隔离 PGlite 数据库，包含业务回滚、审计失败、outbox 失败、重复迁移、历史保护、同源冲突、关联损坏及旧 API 兼容。

独立审查先复现 `task.merge` 错将 SHA 当数字而拒绝真实事件，修正后独立复验实际 `revision()` 回归 1/1，通过。保留初审与复审记录。早期并行测试两次在用例启动前出现原生 V8 内存错误，不能计为通过；序列运行最终通过。

父任务 `npm run build` 退出 0，类型检查及 Vite 构建通过（10.41 秒）；保留现有大于 500 kB 的 chunk 优化提示。本轮源码摘要、测试输出、构建和独立报告位于 `docs/validation/evidence/enterprise-audit-contract-2026-10-20/`。

## 尚未验证或实现

- 原生 PostgreSQL 的此模块多连接提交/投影竞争，不能由 PGlite 代替。
- Task 2 outbox projector、Task 3 业务接线、A2 成员资源权限、OTLP/网页查询/告警、备份恢复兼容尚未完成。当前不能声称所有业务已具备可归责审计。
- 投影 published 标记必须和投影行一致。后续合法保留/清理必须协调该不变量，不能删掉投影又留下已发布标记；缺失或损坏关联当前拒绝重复写入。
- 现有 UPDATE/DELETE 保护不等于防 TRUNCATE。旧备份恢复的级联截表风险已在 D2 Task 8 明确，不能用于生产审计恢复。

此阶段没有新增模型调用、预算或 JJ 生产操作。十项企业基础能力总目标保持进行中。
