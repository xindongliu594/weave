# 完整任务恢复接续

沿用 `2026-10-21-task-recovery-source.md` 的来源、初始化与产品合同，保留已完成 codec、native source guard、archive/history primitives；不重造引擎。2026-11-01 用户授权完成四项，先按依赖完成来源、再初始化、运行/网页、实际中断重启证据。新 paid call 须落在既有明确授权及剩余额度内，不将“开始”解释成提额。

## 1 可信来源

- 可信入口 `captureLiveTaskRecoverySource(writers,{sourceRunId,checkpointId,childRunId},signal)` 只收定位信息。实际 factory Manager 的 source guard → 独占财务锁 918275 → project → sorted runs → sorted operations → devices → sorted scopes → sorted actors/native namespaces/current permission locks。
- 显式投影当前 run22/scope18/operation24 列；SQL UTC 六位微秒时间，source_bounds 是资料约束，不误认为 restored 标志。源只接受停止、非恢复的 live parent；queued child 关系及已批准快照从 SQL 读取。
- provenance helper 校验所有原 claim/result/merge、完整 full-ref 链，NULL 根须 genuine prepare 正向绑定。scope helper 复用纯 workspace builder，核对历史固定输入、CP、A 同路径回退及 B 独立验收。
- 已完成归档锁和当前权限仍须真实取得；所有 unknown/late/未停止 marker 拒绝。source capture 不是执行许可，不改费用或调用数。child 仍需原 admission 的预算/费用门禁。

## 2 初始化

新增 nullable task_evidence，不回填，不复制操作。复制 child 对象并复核 source pins 后，head+marker 同 SQL UPDATE/COMMIT 发布。应答未知仅观察补证；child 后续 head 前进不回退。原 source 与费用不变。

## 3 执行/网页

基于初始化证明接现有 origin/session/team/selector/coordinator/admission；completed 不重跑。网页解释恢复范围、费用、阻断原因并使用同一 API。profile 在完整消费者链及验证前保持关闭。

## 4 验收

优先接口/SQL/功能测试，真实 A旧CP→A后改→独立B验收→恢复候选保留B；再 fault/cancel/concurrency/COMMIT-response tests。PGlite、nativePG、JJ/OpenShell、真实模型证据分开记录。最后必要浏览器抽查。不能以私有 helper 通过冒充用户可用。

## 分工

Root: SQL collector/fixture/集成及后续初始化；provenance agent: 新 provenance module/tests；scope agent: scope module/tests 及 task-execution 纯 builder 抽取；initializer agent: 初始化锁与消费者定向审计。DB 测试仅一个槽。其他对话的 members/observability/eval 不改。
