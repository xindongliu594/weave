# 任务驱动组织：设计阶段核对记录

日期：2026-10-18；本地工作树 `codex/weiwu-mvp-validation`。

本阶段仅调研、只读源代码检查和编写设计/计划。未修改产品代码、未部署 JJ、未新增付费模型调用，未创建员工或项目。旧 Cortex 试验与现有运行证据保持。

## 已通过

- 设计独立 builder check：`/root/organization_design_builder_check`；只读审阅，返回 `nothing important left`。这表示没有阻塞实施规划的问题，不是实现审查或产品验收。
- 现有纯单元回归：

```text
node --import tsx --test --test-reporter=spec tests/task-contracts.test.ts tests/planning-acceptance.test.ts
tests 12
pass 12
fail 0
cancelled 0
skipped 0
exit code 0
```

覆盖文件合同解析、生产/消费依赖、旧 hash、并行写冲突、输出权限范围、独立审查、受限返工、真实 Node 测试数要求和 Office 二进制检查限制。没有固定响应替代真实模型验收的结论。

## 受阻的复核尝试

- 协作集成测试曾直接启动，未先准备仓库隔离数据库，访问 `127.0.0.1:55432` 时发生 EACCES。该启动方式不适用；实施阶段应使用 `scripts/test-integration.mjs`。不将结果计为产品逻辑回归。
- 运行时返工复核遇 Windows 深层临时目录 `MoveFileExW EACCES`。尚未在受控临时目录或 JJ 复核；不宣称通过，也不修改生产沙箱权限绕过。

## 未执行

- 新功能代码、类型检查/构建、浏览器操作、新入口真实规划与员工交付、重启恢复。
- 模板发布检索和任意运行中重规划，均为后续独立阶段。

实施入口：[第一段计划](../superpowers/plans/2026-10-18-task-driven-organization.md)。最重要的事实修正：已有手动跨部门员工借用；此次补自动推荐与主部门参与员工筛选，不重造执行器。
