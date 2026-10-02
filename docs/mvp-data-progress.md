# MVP 知识与数据验证进度

基线：`0befc094953880b6b3ede88506f6fa3e41088e85`，Windows 本机，2026-10-02。仅使用新建的隔离 PGlite 数据库与资料目录，没有打开原始业务数据库、复制原始凭据或调用模型。

## 已通过

- `node scripts/verify-mvp-data.mjs`：源目录生成少量共享、员工私有及单员工运行输入资料；权限校验同时覆盖检索和直接读取，越权授权被拒绝。
- 当前资料更新至版本二后，已批准快照及运行引用 API 仍读取版本一；任务恢复上下文保留版本、切片和 SHA-256，前置任务内部记录不向下游开放。
- 从源目录通过实际 `/api/backup/export` 导出加密备份，再通过实际 `/api/backup/restore` 写入**不同的全新数据库与目录**。错误密码先被拒绝，目标仍为空。源数据保留。
- 恢复后的关键表记录数、完整测试 DAG、合成费用与调用记账、档案日志完整性、嵌套文件及 Vault 资料 SHA-256 与源一致。
- 关闭目标数据库及服务进程，再打开持久数据库、启动新服务进程，重复上述引用和文件核验通过。
- 原有 `tests/knowledge.test.ts`（1/1）、`tests/extensions-backup.test.ts`（3/3）、`services/agent-runtime/checkpoint-context.test.mjs`（1/1）通过。包含晚切片检索、缺失版本拒绝、备份修复引用、扩展表恢复及运行中付费操作阻止备份。
- 更新夹具后 `tests/run-input.test.ts`（1/1）通过；`node node_modules/typescript/bin/tsc --noEmit` 通过。

## 证据与复验

- 持久汇总：[`docs/test-evidence/mvp-data-2026-10-02.json`](test-evidence/mvp-data-2026-10-02.json)。记录源/目标目录、运行 ID、表记录数、固定引用及所有档案文件哈希。
- 本次实验根目录：`.data/mvp-data-2VcfFZ`；`source/database` 与 `target/database` 是独立持久数据库，`source/runs` 与 `target/runs` 为档案。目录含 fixture 资料，非用户真实资料。
- 父运行：`07d6bd05-10dd-4fa1-a00b-77f1b8a5cf4d`。该运行是显式标注的本地数据 fixture，**不能作为真实模型执行或 Todo 交付验收**。
- 逐阶段 `source.log`、`restore.log`、`reopen.log` 与 JSON、加密 fixture 备份均在实验根目录保存。
- 复验：`node scripts/verify-mvp-data.mjs`。每次创建新隔离目录；不会覆盖已有目录或原环境。

## 发现与修复

- 备份恢复成功提示与 Vault 使用提示仍假设服务位于 Mac，已改为本机/当前目录说明，适用于 Windows。
- `tests/run-input.test.ts` 使用默认占位任务批准运行，与新版 `PLAN_NOT_READY` 审批规则不一致；已将 fixture 改为明确的资料授权、版本和引用任务，保持产品规则。

## 边界与继续位置

- 此实验使用真实产品 API、数据库 schema、加密备份与文件读取，但底层数据库是 PGlite 单连接；未验证独立 PostgreSQL 后端间锁竞争。
- 合成记账用于验证数据保留，不声称真实收费模型调用。没有补写员工 Todo 交付物。
- 独立测试资料证明知识和备份数据路径；真实 Todo/真实恢复验收由主流程证据单独说明。
- 本阶段已完成。主流程报告需分别引用本地数据证据与真实模型/员工交付证据。
