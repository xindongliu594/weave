# 任务级检查点恢复：来源校验与完整成果初始化

> 使用 superpowers:subagent-driven-development 或 executing-plans，按依赖串行实现；相关数据库测试只占用一个执行槽。总体企业 profile 保持关闭。

## 目标与复用选择

在新运行中恢复未完成员工 A 的旧检查点，保留独立员工 B 后来提交并验收的成果。原运行的文件、费用、调用和验收记录不变；结果未知的操作阻止恢复。已完成节点不重新执行，未完成节点的旧测试或终端批准不冒充新执行证据。

已有调研与独立审查支持先完成私有来源校验和初始化，再接产品。沿用以下固定实现：

- DSH `0.1.5-rc.1` 的 checkpoint-policy 与 JSONL persistence：持久化 session、flush barrier；不把 session revision 当作数据库 CAS。参考 [官方 persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence)，适用性以本机固定包源码为准。
- AgentTeams `0.1.20` 的 staged team restore：保留已完成节点身份。参考 [维护者项目](https://github.com/NanmiCoder/dsh-agent-teams)，不升级依赖。
- 为伍已有 `step-checkpoints.mjs`、SHA 对象存储、`task-workspace.cjs` 纯合并规划、`task-original-commit.ts` 原操作验真与 PostgreSQL project→run 锁。

这些组件已经负责通用持久化与合并。需补的是为伍自身 SQL scope/claim/result、文件版本、授权和员工验收关系的连接；没有在已查官方插件和固定依赖中发现能直接替代此连接的插件。不新增恢复引擎、文件存储或调度系统。

前置合同：[Task 5 接续裁定](2026-10-20-task-checkpoint-v2-integration.md) 的“恢复/carrier 独立审查后的继续门禁”。本地源码调研保存在 `.superpowers/sdd/2026-10-21-task-recovery/reuse-contract-audit.md`；此前 review addendum 只批准私有 codec/source initializer，不批准产品恢复或备份 carrier。

## 不变边界

- 累计 $3.41、七笔旧未知费用、现有权限、2 running / 128 retained 上限不变。本批只做无付费工程验证。
- 首批只接受停止的、非恢复的 live parent，并须有正向原 SQL 操作/合并/scope/checkpoint 证明。NULL、空表、裸初始 head、档案 `integrity:ok` 都不构成证明。
- 所选 A 的文件路径集合发生变化则明确拒绝；首批只回退相同路径的内容。B 依赖被回退的 A 版本时拒绝，不丢 B 验收、不重跑 B。完整依赖失效/分支重算仍属 C2。
- 所有 SQL unknown、late/pending merge、scope unknown、非 stopped 的 accepted_stop 均阻断；JSONL finished 或人工确认不能覆盖这些事实。
- 原检查点 v1/v2 摘要算法不改。新摘要只用于新记录。恢复材料使用 `authority` 字段，不能放宽归档器对 `authorization`/凭据的脱敏。
- 不改 retry、runtime、scope admission、live reader、备份或公开 profile gate，直到后续接线与实际验收完成。

## Task 1：私有严格记录格式

**文件：** 新增 `apps/api/src/task-recovery-state.ts`、`tests/task-recovery-state.test.ts`。不改数据库、HTTP、shared runtime 类型或既有 codec。

使用现有 Zod、`local-executor.cjs` 的路径/manifest 规范和 Node SHA256。导出私有解码函数及所需新记录摘要函数，明确注释：格式和摘要通过不证明来源真实、更不授予恢复或执行权限。函数不访问文件、数据库、模型或设备。

严格类型（所有嵌套 exact keys，无未知字段透传）：

```ts
type Key = { runId: UUID; taskId: Text; attemptId: Text; generation: PositiveInt };
type Head = {
  version: 1; revision: SHA256; manifest: Manifest;
  mergeId: UUID | null; receipt: TaskMergeReceipt | null;
};
type Approval = {
  version: 1; mode: 'live-sql-v1'; sourceRunId: UUID;
  sourceHead: Head;
  sourceCheckpoint: { key: Key; id: UUID; sha256: SHA256; seq: PositiveInt };
  sourceHistoryDigest: SHA256;
  sourceArchiveCursor: {
    seq: PositiveInt; eventSha256: SHA256; prefixSha256: SHA256; snapshotSha256: SHA256;
  };
  authority: {
    projectId: UUID; planVersion: PositiveInt; taskId: Text;
    contractHash: SHA256; permissionHash: SHA256; capabilityHash: SHA256;
    resourceRevision: PositiveInt;
    backend: {
      kind: 'openshell'; version: '0.1.2'; gateway: Text; image: Text;
      policySha256: SHA256; fingerprint: SHA256;
    };
  };
};
type Initialization = {
  version: 1; childRunId: UUID; approvalDigest: SHA256; source: Approval;
  readPaths: Path[]; writePaths: Path[];
  checkpointWorkRevision: SHA256; plannerScopeHash: SHA256;
  delta: { path: Path; beforeSha256: SHA256 | null; afterSha256: SHA256; size: SafeNonnegativeInt }[];
  initialHead: Head; digest: SHA256;
};
type TaskEvidenceV1 = {
  version: 1; recoveryInitialization: Initialization | null; sourceHistory: null;
};
```

约束：

1. UUID 为现有小写规范；SHA256 为 64 位小写十六进制；正整数须安全；普通 identity 文本 1–240 字符，gateway/image 最多 1024，无前后空白或控制字符。gateway/image 是身份绑定数据，codec 不建立网络连接或宣称它已授权。
2. Manifest 与原算法同序、同字段，最多 128 文件、单件 5 MiB、合计 20 MiB；路径复用原 Windows 别名/链接路径规则，拒绝重复、前缀冲突和未规范排序。revision 必须等于原 manifest 算法摘要，不能换成新递归排序摘要。
3. Head 的非 NULL mergeId 要求严格 committed receipt：operationId=mergeId、afterRevision=revision、key.runId 对应 head 的所属 run；NULL mergeId 要求 NULL receipt。Approval 的 sourceHead 进一步要求非 NULL mergeId。sourceCheckpoint.key.runId=sourceRunId，authority.taskId=checkpoint.key.taskId，checkpoint.seq≤archiveCursor.seq。
4. childRunId≠sourceRunId；initialHead 必须 mergeId/receipt 均为 NULL，不复制父回执。read/write/delta 均规范排序、最多 128，delta 仅含 writePaths；delta 的 before 与 sourceHead 原项、after/size 与 initialHead 对应项一致，未列入 delta 的项保持原 manifest，拒绝擅自删路径。哈希相同的伪变更拒绝。实际 A 工作路径集合与依赖正确性仍由 Task 2 验证。
5. 新记录编码最多 512 KiB；拒绝 undefined、非有限数、非 JSON 值、非普通对象、稀疏数组和循环引用，不悄悄清除字段或补默认值。拒绝归档器会改写的内容；`authority` 归档往返应保持不变。原有脱敏函数不修改。
6. `D(v)` 为 UTF-8 递归排序对象键 JSON 的 SHA256；数组次序保留。approvalDigest=`D({kind:'task-recovery-source',version:1,record:source})`；digest=`D({kind:'task-recovery-initialization',version:1,record:initializationWithoutDigest})`。所有结构、身份、manifest 与交叉字段验证通过后才验摘要。
7. 非 NULL sourceHistory、未知版本、旧 `authorization` 字段、伪造 verified/认证标记都拒绝。整个 SQL 列 NULL 与合法 V1 空记录是不同输入，不通过解码制造 live 认证。

验收：

- [x] 先 RED：合法往返及摘要稳定，源/目标身份、错误 generation/seq/receipt、未知字段、非法文件路径/体积、错误 revision、变更越界/删文件、非 JSON/过大记录、归档脱敏变形分别拒绝。
- [x] 仅新增两文件实现；测试同时验证输入不被修补/变更，既有 v1/v2/stop codec 回归保持。
- [x] 独立审查 spec 与质量；保存命令、exit、源码哈希。只证明格式正确，不宣称已恢复任何项目。

2026-10-21：12 项新 codec 测试通过，相关四文件回归 44 通过 / 1 原有迁移跳过；随后修正 TypeScript 收窄错误，新 codec 重测 12/12，类型检查与构建通过。独立审查无 P0–P2。原失败、跳过及最终源文件哈希保留于 [验收记录](../../validation/task-recovery-source-codec-2026-10-21.md)。

## Task 2：可信 live 来源核对

在原 project→source/child run 锁内，从真正 SQL/档案读取，而不是接收调用方“已验证历史”。验证原 scope/claim/result/committed merge、所选 v2 CP 的完整 key/session/触发边界、当前完整 head、所有 retained accepted 及固定输入。复用原历史验真小函数，不为停止验证器加入通用忽略开关。

固定完整连续事件前缀及 run/created snapshot 摘要；SQL 历史纳入所有 scope、accepted_stop 与所有 operation（包含未决、失败和 null），不是只取 committed 行。旧 last-event 摘要单独不足以固定早期 accepted/rework。

从源最新完整文件集构建 A 回退候选，复用 planner；保证 B 字节与有效验收关系。源权限/backend/capability 当前有效。Task 1 不替代这些正向事实。

实现前在该批 brief 冻结实际 SQL 投影、唯一 snapshot、源静止 fence、锁顺序和具体可信入口；沿前置审查裁定，不能以未定义的数据库/归档跨进程原子性假设开工。

2026-10-21 预检确认现有 SQL 终态、单进程 Map 和日志归档均不能提供 writer 静止保证。因此 Task 2/3 的成功入口暂不实施，先补跨进程写入隔离。现成 `fs-native-extensions@1.5.1` 已通过 Windows/JJ 隔离验证，产品接线仍未完成；详见 [复用调研](../../research/task-recovery-writer-fence-2026-10-21.md)。这不改变恢复门禁、费用或权限。

## Task 3：NULL-only 初始化与丢应答补证

增加 additive nullable `project_runs.task_evidence`，不回填旧行或复制 live operation。复制并核验 child SHA 对象后重查全部 source/权限 pins，再以同一 SQL UPDATE/COMMIT 原子发布 initialHead + 初始化 marker；head 与 marker 必须同时为 NULL，原 task_evidence 精确匹配。

COMMIT 结果不明时丢弃原连接，只读核对同一 child；不得重放设备动作。marker 已存在时验证原批准与真实 child 后续 merge 链，child head 前进后只能补证/重建当前缓存，不能退回初始 head。归档事件使用原 sourceKey 幂等追加。source 和全部费用不变。

## Task 4：工程链与后续产品接线

- [ ] 真实 Product/Host/HTTP/SQL 工程源：A旧CP→A后改→独立B提交→child仅回A；另测B依赖失效、路径新增、unknown stop、早期事件改写、撤权、坏对象和错身份均拒绝。
- [ ] 注入对象复制、SQL发布、COMMIT应答、事件/缓存失败；双实例竞争只能一份 head+marker；child前进后补证不回退。
- [ ] PGlite 与原生 PostgreSQL 证据分别记录；这些不能替代 JJ/OpenShell/真实模型。
- [ ] 独立审查后，再冻结并接新 checkpoint input origin、完整 source generation、选择器/上下文、retry/coordinator、runtime/admission、停止/finalizer 与 live reader。
- [ ] carrier 与隔离保留导入另列合同；全部 profile 开放条件和 JJ 小任务验收满足后才交付网页可用恢复。

执行顺序是 Task 1 → Task 2 → Task 3 → Task 4；后续接线未完成不能把私有 helper 当作恢复功能完成。自动沙箱回收缺少固定协议的条件删除能力，已记录为独立受阻项，不妨碍本批来源与完整成果恢复工作。
