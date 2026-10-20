# 任务沙箱接线验收：本地工程阶段

本报告对应 B2 Task 4。新企业 task-attempt-openshell-v1 启动 profile 仍关闭；Task 5 的消费者/checkpoint v2/备份与 Task 6 的真实 PostgreSQL、OpenShell、JJ 验收尚未完成。本地工程夹具不替代真实模型或物理沙箱证明。

## 接入现有链路的内容

- 沿用 DSH 注册和执行接口，在协调 Host 与员工 Host 注册前安装共用边界；精确固定实际 definition、执行主体和调用身份。后注册、scope shadow、await 后换定义、嵌套或后台调用都不能仅凭同名获得权限。
- Host 从真实 AgentTeams 状态注册员工/task/attempt/session，服务端决定 generation；模型参数不能选择该身份。文件、终端和 native 插件使用 prepareTask 的可信 scope。
- prepare 复用同一 key 的持久记录和 sandbox identity，后续只滚动 scope；未知操作或未知合并阻止新派发和绕过式换 generation。
- 终端批准保留完整 canonical 版本和公开 scope。等待后重新校验；变化就拒绝旧批准。SQL 原参数不改写，设备参数单独换为该任务部分工作副本的版本。
- 设备 poll 显式选择公开字段，不传播私有 canonical 文件清单；native 的固定 bundle 和读写范围仍由可信安装记录及合同计算。
- 设备完成、导出校验、canonical 合并提交、任务接受分别记录。Handoff 只消费已提交且匹配的证明；任务命令证据绑定授权输入/输出版本，无关员工文件变化不会误使其失效。
- 新 generation、合同/权限/能力变化会废弃旧命令证据；正式交接在 mutex 内复核当前任务及可信 scope，纯知识任务也能在完成边界准备和交接。
- ProductDshRuntime 必须使用 task OpenShell 执行器，先由 committed head 初始化缓存再给 supervisor/Handoff 读取；缺接口时拒绝，无共享 RunSandbox fallback。新 profile 恢复仍明确拒绝。

## 已发现并修复

1. DSH 的原 guard 后仍有异步 middleware，最终 body 会重新选择 definition；只有前置 guard 不能封住这个空隙。共用注册适配在实际 body 入口再核对原准入。
2. scope hash 包含完整 canonical 基线，无关 B 提交可能改变 hash 而不改变 A 文件。设备原来错误拒绝这种变化；删除该错误条件，保留准确 binding/key/读写范围、固定输入及当前任务版本校验。
3. 新 generation 原来可能沿用相同文件下的旧命令证据；现明确废弃。下游摘要同时改为核对任务版本及对应 generation，保留完整 canonical 接受版本。
4. 纯知识任务没有文件操作，原来无法在完成时取得 scope；现由真实完成边界刷新。等待 mutex 或 prepare 期间任务变化也会拒绝旧交接。
5. 完整 Runtime→HTTP 测试发现文件工具也携带 canonical expectedWorkspaceRevision，而设备需要部分工作副本版本。API 现对所有非 prepare 任务工具校验公开 scope 和 canonical 版本，再只转换传输参数；原 SQL/批准参数保持。

## 已验证与进行中

| 检查层 | 当前实际结果 | 边界 |
| --- | --- | --- |
| 父任务运行时/guard/审批/Handoff/证据/checkpoint 兼容 | 60/60、0 skipped | 两项链接测试先被 Windows 文件沙箱阻止创建，使用同一隔离目录允许权限复验全部通过，未修改断言 |
| 独立运行时复审 | PASS；54/54；旧交接固定场景 7/7 | 复现并关闭知识任务交接问题；不声称物理 OS 隔离 |
| API 桥接 | 11/11 HTTP/PGlite | 模型、用量、模型预留记录均为零 |
| 既有 canonical/设备协议 | 父任务最终 17/17、8/8、5/5 | 连同最后文件映射修复后的 11 项 bridge，共 41/41；PGlite 不证明真实 PG 行锁 |
| scope/业务结果/backend 单测 | 31/31 | 独立 backend 复验 4/4 |
| 设备执行器 | 36/36 | CLI 与设备为工程夹具；真实 OpenShell 待 Task 6 |
| 实际 ProductDshRuntime→Host→HTTP→canonical→Handoff 三例 | 3/3，77.3 秒；36 个 operation、6 个工程 sandboxId、7 条审批 | 固定模型响应与设备夹具；实际调用队列/提交/接受，不是预填成功行，不能称为真实模型员工业务 |

可分享证据在 `docs/validation/evidence/task-sandbox-integration-2026-10-20/`；原始阶段记录保留在 `.superpowers/sdd/2026-10-20-task-sandbox-integration/`。三份固定工程需求分别完成连续写入/依赖导入、无关提交后的 scope 更新、旧审批零派发及新审批成功。完整链测试输出保留各 run/operation/approval/key/sandboxId/scope/canonical revision，原临时 DB 和工作区由测试隔离清理。完整链测试已获独立源码/证据审查 PASS，审查者未重跑该 77.3 秒套件。

对应 runId：正常依赖 `a02f030a-c9bc-432b-8e69-bdc977207df3`，无关提交 `dc9e4aab-abc1-40fa-9634-72ed13c2576e`，审批更新 `e14d08f1-aaae-4212-8655-799c584b61d6`。这些是已清理的临时工程运行，网页生产库中没有这些项目。

父任务最终 `npm run build` 退出 0，类型检查与 Vite 8.58 秒构建通过，保留既有大 chunk 提示。一次中间构建因并行 D2 新增测试缺少 `.mjs` 类型声明失败；相应实现者补了真实窄声明后同命令通过，没有放宽类型检查。当前结论为 **Task 4 本地接线层通过**；完整 B2 仍未完成。

## 后续门禁

Task 5 必须统一从 committed canonical 读取列表/下载/规划/恢复/备份，落实 checkpoint v2、task key 维护、未知保留和不覆写其他员工成果。当前 v1 兼容测试不等于完成新 profile 恢复。Task 6 必须验证实际 PostgreSQL 多连接 CAS、JJ OpenShell 的进程/文件/容量边界及产品网页/真实业务。

本阶段保留已有数据、运行和七笔未知费用。没有新增付费模型请求、提高预算或修改 JJ 生产服务。
