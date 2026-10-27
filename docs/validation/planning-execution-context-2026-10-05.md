# 规划历史上下文模块：只读工程验证

已新增 [planning-execution-context.ts](../../apps/api/src/planning-execution-context.ts) 和 [专用测试](../../tests/planning-execution-context.test.ts)，冻结接口为 `buildPlanningExecutionContext(db, traceRoot, project)`。根代理接入规划器；本模块没有修改共享 API、原项目/数据库、员工文件或服务，也没有模型调用。

[隔离 PGlite 日志](planning-execution-context-2026-10-05.txt)：最终 **11/11 PASS**、`tsc --noEmit` exit0、scoped diffcheck exit0。本地 fixture 验证了真实 SQL 聚合与临时 archive/文件 SHA，没有把固定模型响应当付费验收。初次扩展回归10/11中的失败是测试将原空 inputs 再设为空，已明确改为不同固定输入；未借此改动生产合同规则。

返回 `available/sourceRun/completedTaskIds/files/budget/unknownOperationIds/knowledge/issues/rules`。需要注意这些字段的具体口径：

- `available` 表示最近运行档案身份和内容可读取；费用、资料各有独立 `available`，部分证据失败不伪造成功。
- `sourceRun` 同时记录 DB status、archiveStatus、integrity、是否当前版本；包含 interrupted。任务合同字段来自当前 taskSchema.shape，完整需求与合同不符时不给当前完成 IDs。文件完成还须通过 completedTasks/resumeHandoff 的接受 attempt 与真实当前输入 SHA 校验。
- `budget` 汇总**当前版本**全部实际 wire、usage 与 pending/uncertain；不会重复累加继承 snapshot.budgetHistory。无 taskId 的金额/次数单列，不猜归属。旧版本未知金额和全部项目实际费用仍由外层 costReadiness 提供并占原上限。历史未能完整核对时不提供0次数/金额；只有无运行或已证明启动前取消才可明确0。
- `knowledge.documents` 保留批准 manifest，`citations` 单列旧版本实际引用，授权绑定原 runtime employee、source employee/department、知识空间与文档。每个独有文档/版本/title/SHA/space/来源指纹均保留；自由 note/vaultPath 等原来源仅留不可变档案，完整 sourceSHA 区分来源，不返回正文或任意 source/context。历史授权不替代新批准的当前权限校验。
- 只返回未知外部操作 ID；不返回原操作参数、route、设备 grant、供应方正文、Key 或原账单 context。历史证据**不自动继承、保存或启动**候选，后续确认与执行仍用独立门禁。

已只读核对原5114闭合档案的 `knowledge.format=document-versions-v2`、两份固定文档及 QA 独占私有授权，未查询原 DB 或调用模型。原 v6 **实际 API planning-quote 的21调用/dev完成/四SHA验证由根代理接入后进行，本报告尚不宣称该 GET 已通过**。当前 $0.0857132 是否覆盖剩余独立 QA、复审和经理仍未证明，详见[剩余路线审计](remaining-mvp-context-route-audit-2026-10-05.md)。

冻结 SHA256：

- module：`5ff3865ae61c838c2776f8d5d9bd761e76b32044fe833571913d082e7f57aedf`
- test：`01161cc25c0c17e97668e9a779a6167af05cf4b2c456106557b3f32c6216a7d4`

接口与实现仍是规划证据，不等同原生首包 prepare、原子 reserve、daily/90%门禁检查、供应方账单核对、QA成功或经理验收。
