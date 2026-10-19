# 五小时工程加固计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证并修复已有主流程，重点证明正常状态、步骤恢复、数据保护和网页交付之间的一致性。

**Architecture:** 沿用现有 DSH 会话、DAG、内容寻址检查点与统一能力授权。使用已有隔离测试及真实 OpenShell；不另建引擎。当前会话顺序执行，在独立复核时使用一个审阅代理。

**Tech Stack:** Node 24、TypeScript、Python 验收脚本、React、PGlite、固定 DSH/OpenShell。

**Spec:** `docs/superpowers/specs/2026-10-20-mvp-hardening-design.md`

## Global Constraints

- 保留历史、凭据、未知预留、已有修改及员工原始产物；不覆盖生产做恢复实验。
- 原累计 $3.41、每日 $20 与权限不变。新增真实调用分配确认前 modelCalls=0。
- 真实验收与固定替身测试分开报告；工程测试不等于模型质量。
- 既有单次/总容量门禁与最新费用历史不回退；结果未知不自动重放。
- 使用现有已隔离 worktree；不碰无关未跟踪文件，不逐小时重新跑无变化测试。

## Review Focus

1. 备份包含清单但漏掉 checkpoint-objects：恢复后必须读回并校验全部内容。
2. 较早检查点之后有新费用/外部操作：恢复文件可选旧版本，费用与操作账本必须最新。
3. 清理/归档把活跃恢复依赖当成可删副本：必须保留来源并给出拒绝原因。
4. 停止或网络断开时工具结果未知：不得重发未知操作或假装取消费用。
5. 网页换选点之后沿用旧确认：预检/确认绑定选中点；失败信息明确，不出现假完成。

## 时间安排（约 300 分钟，可按阻塞调整先后）

| 工作 | 预计 | 结果 |
| --- | ---: | --- |
| 基线、缺口、复用与计划 | 20 分钟 | 当前部署/费用/已验证范围清单 |
| 步骤恢复与真实小任务准备/验收 | 100 分钟 | 状态对账、原始证据、网页恢复 |
| 备份与容量联动 | 60 分钟 | 隔离恢复、内容一致性、保护负例 |
| 权限及网页错误/交付 | 50 分钟 | 相关 API/页面测试、必要截图 |
| 综合检查、复核、说明与发布 | 70 分钟 | 修复代码、报告、可继续工作记录 |

## Task 1：核实基线并准备可审阅验收

**Files:** 复用 `scripts/validation/acceptance-loop/{driver.py,control-service.py,control-planning-budget.py}`；本轮仅在 `scripts/validation/step-checkpoints/` 增加必要的案例适配。证据放 `docs/validation/evidence/mvp-hardening-2026-10-20/`，私有运行正文留 JJ。

- [x] 核对 git、当前 JJ 发布、health、用量/未知预留/活动运行，只输出非敏感摘要。
- [x] 验收适配须核对：员工产出、3 个独立角色、QA 纯只读测试、无额外工具、可复用合同字段、金额/次数上限、一次性 dispatch 记录；用既有测试驱动验证拒绝错误候选。
- [x] 旧 `atAcceptedBoundary` 只适合节点交接后；本轮新增小型测试适配，在指定 QA 成功命令已写入有效步骤检查点、尚未 accepted 时阻断下一请求。当前 release、证据目录与费用基线显式指定，不沿用旧目录。
- [x] 先完成零付费演练和硬预算守卫，再请求具体 $0.18 分配；不能重跑旧温度项目伪装新检查点。

## Task 2：验证步骤恢复与正常状态

**Files:** 复用 `services/agent-runtime/{step-checkpoints.mjs,supervisor.mjs,checkpoint-context.mjs}`、`apps/api/src/step-checkpoint-recovery.ts`、`tests/{checkpoint-branch.test.ts,recovery-conditions.test.ts,run-lineage-evidence-api.test.ts}`。仅在发现故障时修改相应共同入口并加针对性回归。

- [x] 运行边界相关现有测试；补缺失的正常状态/重启读回断言，避免镜像实现的无效测试。
- [x] 独立临时档案中对比正常 runtime/status、DAG、attempt、文件和回执，再做进程重建；损坏、后续失败、未知操作应拒绝。
- [ ] 授权后运行真实纯函数任务，在 QA 已成功测试后停点；没有稳定停点则先修仪器，不冒险中断在途模型。
- [ ] 网页恢复同一批准任务，核对开发不重跑、QA 测试执行总数 1、继承证据指向原回执、费用与调用完整；QA/经理真实交接，记录 ID 与截图。

## Task 3：备份与容量保护联动

**Files:** `tests/extensions-backup.test.ts`、`services/agent-runtime/storage-governance.test.mjs`；必要故障修复在对应 `backup.ts` 或存储共享模块。复用 `scripts/test-integration.mjs`。

- [x] 在扩展备份夹具写入步骤检查点和两代来源链，导出/隔离恢复后比较清单/对象/引用与原 SHA，并执行继承校验。测试只使用临时数据。
- [x] 缺失/损坏对象或来源档案在 staging 阶段拒绝，数据库/目标档案不变，临时 staging 清理；原始回执、最新用量和未知预留保留。
- [x] 确认日志归档与工作区副本清理后步骤对象仍能完整读回。
- [x] 命令：`node scripts/test-integration.mjs tests/extensions-backup.test.ts tests/storage-governance.test.ts`；通过以退出码 0 与实际断言为准，不用生产数据库。
- [x] 若当前一致备份具备安全独立验证入口，再校验其关键数据及交付；否则明确仅隔离夹具通过，不制造生产恢复结论。

## Task 4：权限、失败入口与交付可读性

**Files:** 复用 `tests/{native-capability-store.test.ts,knowledge.test.ts,recovery-conditions-ui.test.ts,run-recovery-confirmation.test.ts,run-extras-errors.test.ts}`；发现主流程问题后修改对应 API/React 组件。

- [x] 核对现授权与历史授权变化时的知识/工具访问拒绝，以及检查点继承拒绝；只补有实际缺口的测试。
- [x] 验证停止、换选点、预算不足、未知工具结果与交付下载视图；文案说明下一步，不泄漏凭据。
- [ ] 浏览器：交付路径已通过；新真实项目的选点恢复仍等待预算分配，其余使用对应函数/API。

## Task 5：复核与交付

**Files:** `docs/validation/mvp-hardening-2026-10-20.md`、`docs/delivery-acceptance-quickstart.md`（需要时更新）、相关代码/测试。

- [x] 新变更运行对应测试，最后一次类型检查/构建；Windows/JJ 差异按实际环境列明。
- [x] 一次全差异独立复核，重要问题修复后验证；不复制无关项目目录。
- [x] 有产品修复则按已有备份/无在途调用/固定依赖方式发布 JJ，保留回滚版本；纯测试无需发布服务。
- [x] 精确列文件提交，扫描证据敏感内容后按现有授权推送；不把私有原始数据自动上传。工程提交 `b0196ef` 已推送当前分支，共 81 个明确文件。
- [ ] 报告区分通过、失败、未验证、受阻，记录实际时间/运行 ID/费用/文件。五小时到点时保存状态；未完成目标不标记完成。
