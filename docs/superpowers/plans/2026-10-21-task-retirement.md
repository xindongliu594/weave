# 已停止任务沙箱的精确回收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 按批执行，先 RED，再实现，再独立审查。

**Goal:** 网页预览并确认回收已验收、已停止且成果与账目均已保存的单个任务沙箱，释放临时磁盘，保留全部正式成果、检查点与审计。

**Architecture:** 复用现有 OpenShell executor 的 maintenance queue、schema-2 journal、固定 CLI、`storage_cleanups` 预览/确认记录及管理员/CSRF 路由。CLI 名称仅作定位符，返回 ID 必须匹配原 journal；不引入新清理引擎、执行队列、依赖或自动删除定时器。

**Tech Stack:** OpenShell 0.1.2；固定 DSH 0.1.5-rc.1 / AgentTeams 0.1.20；现有 Node、PostgreSQL、Zod、React。

**Spec:** [Task 5 接续裁定](2026-10-20-task-checkpoint-v2-integration.md)、[沙箱整体计划 Task 5/6](2026-10-20-task-sandbox-integration.md)、[停止终态合同](2026-10-20-task-stop-finalization.md)。

## 调研与选择

- 固定 [OpenShell 0.1.2 生命周期文档](https://docs.nvidia.com/openshell/v0.1.2/how-it-works/sandboxes/overview) 提供 stop/start/get/delete；Stopped 保留数据并禁止 exec，删除受理不等于资源已消失。文档不替代 JJ 实测。
- 固定 [CLI 源码](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/run.rs) 与 JJ 安装版 `sandbox get --help` 均确认 get/delete 按名称；旧 fixture 的 UUID selector 是错误假设。`get` 必须复用现有按名称读取并校验 ID 的方法。
- 固定 [服务端源码](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-server/src/grpc/sandbox.rs) 将 sandbox get 的 workspace 撤权映射为同样的 NotFound；NotFound 本身不能证明原资源消失。ListSandboxes 独立鉴权并分页，可作为后续完整观察候选，但本批不实现或假定已验证。
- 固定 [协议](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/proto/openshell.proto) 的 DeleteSandboxRequest 没有 expected ID/resource version 条件。不能简单把旧 ID 删除替换成 name 删除后声称精确回收；先修复现有观察与误报，Task 1–3 继续为候选。
- [DSH 官方项目](https://github.com/deepseek-ai/deepseek-harness) 提供插件宿主；本地 package metadata 核实固定版本。DSH 不持有为伍项目的 SQL 账目、任务版本及成果验收关系，不将通用清理插件作为这些业务证明的替代。
- `openshell-executor.cjs` 已有 `retireStorage/reconcileStorage/confirmAbsent`；旧入口先 `inspectStorage`，会启动 stopped 沙箱，而 accepted-stop 已明确禁止重启。复用队列和查询/删除原语，新增受信任的窄任务入口。
- `storage-lifecycle.ts` 当前按 run ID `.find` 并比较完整 artifacts；同一 run 多任务以及 partial work revision 不适用。沿既有 preview/confirm/reconcile 接口增加 task variant，保留旧 variant。
- `TaskAcceptedStopLifecycle` 已有历史原 claim/result/accepted/v2 checkpoint/原 stopId 的正向核对。API 批复用此验证，不能凭 `accepted:true` 或 SQL `retired` 标记批准删除。
- 失败、放弃、被新 attempt 替代的现场没有同等 accepted 证明。先保留并明确显示，再单独冻结其停止资格；本批通过不代表反复失败/返工容量已解决。

## Global Constraints

- 源码基线 `076fb82`；任务级 profile 仍关闭，Task 6 全部开放条件未满足。
- 累计 $3.41、七笔未知费用、权限、两 running slots、128 retained scopes 均不变；本地工程测试零付费，无生产清理。
- 仅回收已完成运行内已验收并确认 Stopped 的完整 `{runId,taskId,attemptId,generation}`；原 sandboxId、partial workspaceRevision、stopId、proofDigest 必须一致。
- 费用 pending/uncertain、未知操作/merge/stop、活动依赖、档案损坏、缺对象/检查点、权限撤回均保护现场。
- 原正式 canonical 对象、交付、知识引用、检查点、SQL 操作/收据和设备 journal 不删除；删除的是已封存的 OpenShell 临时现场。
- 回收必须由网页管理员预览并确认。没有原 delete intent 不可“核对为已回收”；unknown 仅查询原请求，不重发 delete/start/stop/exec。
- 重测试串行；fixture、原生 PostgreSQL、JJ OS 边界、真实模型分列。

## Review Focus

1. 同 run 不同 task/attempt/generation 不能共享预览、按钮 key 或删除目标。
2. 回收不得启动沙箱，或把旧 accepted-stop 核对再写回 retiring/retired 现场。
3. 最后异步授权检查之后目标、grant、配置或 marker 变化，必须在派发前拒绝。
4. timeout/断连/服务重启后不得重发删除；原 ID 未确认 absent 前保留保守容量。
5. 维护之后 canonical 下载、检查点与原始账目仍完整；SQL retired 不代表物理资源已回收。

## Task 0：修正固定 CLI 协议及旧回收误报

这是现有故障的安全修复，优先于新增回收功能。修改 executor、设备测试、原 Product CLI fixture/断言，以及现有 StorageCenter 的调用提示/禁用状态；API 复用现有错误映射。

- [x] `observeAcceptedTaskStop` 复用 `get(scope,signal)` 的名称定位及原 ID/name 校验；Stopped、policy admission、同一原 stop intent、deadline 和冷核对规则不变。
- [x] 所有相关 fixture 改为真实 name-only get/delete，不再把 UUID 当名称别名；同名不同 ID、撤权 NotFound、冷核对、取消及零 stop 重放有回归。缺名称的 delete 依 `allow_missing:true` 成功空操作，不删除原具名对象。
- [x] `retireStorage` 在任何缓存成功、inspect、CLI、intent 和文件写入之前拒绝当前不具备条件删除能力的固定协议，错误为 `OPENSHELL_RETIREMENT_UNSUPPORTED`、`notExecuted:true`。不得新发 delete，不启动 sealed sandbox。
- [x] 旧 `reconcileStorage` 仅观察已有原 intent：用原 name 查询并核对 ID，明确存在可返回 present；NotFound、鉴权错误、身份变化和其他不明结果均保留 unknown，不返回 retired、不重放、不改写原 journal。缺 intent 仍拒绝。
- [x] 历史 `phase:retired` 不再作为物理缺失证明；对外 scope 列表投影为 unverified，并计入保守容量。原 journal、SQL、正式文件及历史回执不迁移或覆盖。
- [x] 网页的沙箱预览与确认入口同步禁用并解释当前未开放；历史 completed/retired 回执标为物理状态待复核，不再声称已不存在。原副本清理、日志归档及只读核对入口保留。
- [x] 保存 RED/GREEN：desktop 82 项中 75 通过，7 项受限 Windows 权限失败；原样重跑对应两文件 14/14，其中原 7 项通过。OpenShell 64/64、一个 Product 正常工程路径、最终夹具合同 2/2、网页相关 16/16、类型/构建通过。没有声称一次全套 exit 0 或物理验收。

Task 0 独立 spec/quality 审查 PASS，无 P0–P2。完整结果及前后源码边界见 [固定 CLI 协议核对报告](../../validation/openshell-cli-protocol-2026-10-21.md)。Task 1–3 的安全删除协议仍未具备，保持候选；不为此重试生产删除，转入不依赖回收的 [任务恢复来源校验](2026-10-21-task-recovery-source.md)。

## Task 1：设备端已停止任务的回收原语

**状态：候选，禁止按下列旧协议细节直接实现。** Task 0 后还须冻结原 workspace 完整可见性证明和带原 ID 条件的安全删除方式。旧候选中的 ID get/delete 与单 NotFound absent 已被调研否定；保留本文以记录设计演变，不能作为运行能力宣称。

**Files:** 修改 `apps/desktop/openshell-executor.cjs` 和其 `.test.cjs`；不接公共 API，不改变 fixed CLI/policy/config。

受信任接口：

```ts
retireAcceptedTask(key, expected, beforeDispatch, signal?): Promise<TaskRetirementResult>
reconcileAcceptedTaskRetirement(key, expected, signal?): Promise<TaskRetirementResult>
```

`expected` 精确为原 `acceptedStop.identity` 的六个字段，加 `retirementId: UUID`。共七字段：`version,stopId,key,sandboxId,workspaceRevision,proofDigest,retirementId`。此 DTO 仅绑定原始身份；它自身不证明 SQL 资格，fresh dispatch 另要求不可序列化的可信 `beforeDispatch` 回调。入队前验证并深复制，避免调用方改动排队对象。

结果精确为 expected 七字段加 `state:'retired'|'present'`、`replayed:false`。`retired` 只代表同一网关原 ID absent；未知错误不伪造结果。未删除但明确仍存在可返回 present，保留占用。

沿用 scope 内 `retirement` 记录，新任务 variant：

```ts
{
  version: 1,
  identity: expected,
  startedAt: canonicalIsoTime,
  result?: TaskRetirementResult // 只持久 retired 终态
}
```

只允许与 `acceptedStop.stage === 'stopped_confirmed'` 共存，保留其 identity/result 原样。新 variant 严格 key/schema/日期/原 stop identity 交叉验证：无 result 对应 retiring 或 unknown；有完整 retired result 对应 retired。其他组合 fail closed；旧 schema-1 记录不改。

候选 fresh 顺序：共享最多 120 秒 AbortSignal 和原 maintenance queue → 核对当前 grant/config、完整 scope、原 stopped marker且无 operation/commandFence/retirement → 用既有 `observeAcceptedTaskStop` 按名称定位并核对原 ID Stopped → await 可信回调 → 同步重读 journal、grant/config，须与前一快照一致 → fsync 原 intent/retiring → 一次具备原 ID 条件的删除 → 同一 deadline 内核对原 workspace 的完整授权 inventory → fsync retired。**其中条件删除和完整 inventory 尚无已冻结实现，不能派发；固定 CLI 的 name-only delete 不满足这一候选前置。**

查询/派发前后的 signal、配置与原 journal 均核对。delete 或后续查询不确定，保留同一 intent、unknown 和容量。冷 reconcile 只查询原 ID，不调用普通 admit/磁盘 inspect、不创建 intent；当前授权与网关身份仍必须有效。重复 fresh 调用若同一原 retirement 已存在，只走原核对；不同 retirementId/身份拒绝，已 retired 也不能忽略 expected。

accepted-stop 的旧核对入口遇到 retirement 明确拒绝，防止覆盖 retired。普通 execute/export/inspect 继续拒绝封存任务。旧 `retireStorage/reconcileStorage` 必须保持 Task 0 的保护，不能借 legacy 或 cached success 绕过新 variant 校验。

- [ ] 先用实际 executor/journal 和 CLI transport fixture 复现：已 accepted/stopped 的回收被旧 inspect guard 阻止。
- [ ] 正常回收：只有一次 delete，无 start/exec/stop；另一个同 run task 的文件与 journal 不变；原 stop 证明保留。
- [ ] 丢回执/冷重启：只做原 workspace/原 ID 的完整只读观察；present/鉴权错误/错 ID/缺页/分页异常/未确认 absent 不释放容量；确认 absent 后才 retired。
- [ ] 身份/版本/retirementId 错误、坏 journal、回调时 grant/config/scope 变化、预先 absent、队列等待取消均零新 delete。
- [ ] 旧 stop observation、execute/export/inspect 不能改写或复活 retiring/retired scope。
- [ ] 相关原设备回归与独立审查通过，记录精确源码 SHA、退出码及边界后提交。

## Task 2：原 SQL 预览/确认链及网页

**Files:** 现有 `storage-lifecycle.ts`、`storage-governance.ts`、`task-accepted-stop.ts` 窄复用历史验证、shared contracts、`StorageCenter.tsx`；新增 `tests/task-storage-lifecycle.test.ts`，复用 HTTP/产品夹具。

在 Task 1 验证后冻结 API 的持久 proof/preview schema、原 provider 方法绑定、锁/COMMIT 不明协议、跨请求审批和最终同步验证。沿 `storage_cleanups` 写原 intent，`retirementId` 为原 cleanup ID；不另建 live 状态表。已确认 SQL stopped 不足以替代实际设备 Stopped，部分 work revision 不能与完整 canonical revision 混比。

- [ ] 冻结并独立审查实际 schema/事务/验证方法后再编辑 API。
- [ ] 预览只读核对同一原 marker、全部费用/操作、原 CP 和不可变对象，不运行磁盘命令；未知容量保守显示，不用 0 冒充测量。
- [ ] 确认重验身份、权限、依赖和档案，单次原 delete；COMMIT 不明没有新 effect。
- [ ] 网页按完整身份显示“临时现场回收”，明确正式交付/检查点保留；未知提供原回收核对，按钮锁和切换页竞态复用现有组件模式。
- [ ] 实际 HTTP/SQL 测试、同 run 双 scope、撤权/费用变未知/坏对象/回执丢失回归；浏览器确认与拒绝路径。
- [ ] 一份实际工程 Product 项目，回收后下载/CP/SQL/claims 哈希不变；明确使用 fixture 模型，不能作真实模型验收。

## Task 3：独立遗留资格与恢复/实机门禁

- [ ] failed/superseded inactive scope 的停止资格另列正向历史证明和可保存的现场快照，不借用最新 repair 的验收或 CP。
- [ ] 恢复/carrier 纳入停止与回收历史；不激活旧 journal、设备凭据或旧 operation。
- [ ] 按整体 Task 6 在 JJ 隔离目录、独立数据库验证真实 OpenShell 回收/查询/断连与下载；不删除生产 scope，不以源码通过替代实机验收。

本计划为 Task 5 的增量实施合同；Task 1 完成只交付受信任设备原语，Task 2/3 与其他企业基础目标继续保留，profile 不自动开启。
