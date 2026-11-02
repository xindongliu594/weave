# 恢复来源事实：只读隔离、档案前缀和 SQL 历史

本批继续执行 2026-10-21-task-recovery-source.md 的 Task 2，保留企业执行门禁，不新增公开 API。另一个对话负责成员工作台、观测和评测，本批不修改这些模块。

## 复用与范围

已核对当前原生 fence 的 source 模式，以及注册 writer 的实际接线；沿用已安装 fs-native-extensions、AsyncLocalStorage、trace-store/readJournal 和原有恢复 codec。上游参考：[原生文件锁](https://github.com/holepunchto/fs-native-extensions)、[PostgreSQL 17 锁语义](https://www.postgresql.org/docs/17/explicit-locking.html)。不安装新引擎。通用组件不认识为伍自己的 SQL scope、员工验收和权限，所以只补这层连接。

三个独立工作项：

1. 在现有 ArchiveWriterManager 增加 withSource(runId, callback, options) / assertSource(runId)。沿用原生 source 锁；只能顶层取得，不能借用 writer/maintenance/root 权限，不能写档案；回调完成后权限失效。读校验失败应释放读锁，原生锁身份/释放失败仍须关闭失败。实际跨进程验证 writer→source→writer 的排斥、失败 writer 阻断、脱离回调无权限。
2. 新增私有档案前缀读取小函数：调用真实 manager.assertSource，核对源 ID、唯一 seq1 run/created、原始 snapshot SHA、SQL 快照脱敏后的精确对应和完整连续事件前缀；固定早期与末尾事件，不裁切到所选 CP。不写源、不签发来源批准。不把格式摘要称作 SQL 原操作或权限验证。
3. 只读审计当前 SQL schema/历史投影与 Oct21 合同差异；据此补最小完整历史读取/摘要单元（若接口与锁合同尚不能安全固定，明确保留缺口，不伪造成功）。SQL NULL、微秒时间、失败/取消/迟到/accepted_stop 必须保留，禁止凭据原文进入公开摘要。

任务 1、2 文件隔离并行；3 先只读审计。根任务审查接口后集成，重型数据库测试串行。每项先记录有效 RED，再实现和 GREEN；独立审查、相关回归、类型检查与构建后记录证据。

2026-10-30 裁定：第三项本批只实现严格纯投影/摘要，不新增 SQL collector。当前迁移比旧预检多授权/导入边界，以及 runtime effect 的六列；全部纳入新投影。native source→费用独占→project/run→operation/device/task 的事务和当前权限锁仍需下一步独立组合，不能由调用方声称已锁替代。本单元接收的微秒时间须已由 SQL 显式转成六位 UTC 文本；不把 pg Date 丢失精度后的值补齐成微秒。记录未知状态以固定历史，不放行未知操作。历史格式有明确上限，超界整体拒绝，不截断。实际 SQL 读取和门禁不算本批完成。

## 本批不宣称的能力

本批基础单元不是 captureLiveTaskRecoverySource 的完整认证：原 scope/claim/result/merge、历史工作区重建、保留 B 的输入与验收、当前权限和 child 批准身份仍须组合验真。Task 3 的 NULL-only 初始化和网页续跑不得提前开放。无真实模型调用，不调整预算、不提交、不部署，不改旧检查点摘要算法。
