# 企业执行边界：任务工作副本、成果合并与工具副作用契约

日期：2026-10-20。调查基线：`4fc763983ce0aae292052ec87c88b7f563a1fac2`，同时读取当前工作区源码；工作区已有其他改动，本报告不整理或覆盖它们。范围：静态源码、固定发行版官方资料与插件目录调查；未访问生产、启动沙箱、安装依赖、调用付费模型或修改实现。

## 1. 选用结论

**复用现有 OpenShell 0.1.2，为每个 task attempt 建立独立沙箱工作副本；只导入获授权输入和该 attempt 的合法恢复文件，可信侧验证导出并做 CAS 合并。** 不重新实现容器引擎，不升级 DSH，不把 Git worktree、改变 cwd、进程内队列或事后文件哈希称为安全隔离。

当前 `/sandbox` 是整个 run 的共享可写目录。终端已经修改其他员工成果后，`handoff.observe()` 才能检测到越界。因此新增边界必须让原 run 成果、其他 task 沙箱、可信回执目录、主机授权目录和管理凭据在不可信子进程启动前不可达。独立沙箱里可以修改输入的**副本**，但合并不得改变非输出路径；原输入版本由可信存储保留。

企业模式要求 `task-attempt-openshell-v1` 的执行证明。OpenShell 不可用、身份/策略不符、任务合同不完整、没有容量或结果未知时直接阻止派发。原兼容 native/demo/Docker 路径可保留给明确的旧模式；企业模式不得自动退回共享目录、本机 shell 或仅 Node permission。

需要为伍补充的是任务身份绑定、受限导入/导出、合并日志、共享副作用分类与核对契约。这些属于授权及交付集成，现成沙箱或 DSH 插件没有代替本项目的批准方案、费用账本和交付版本。

## 2. 固定版本与复用证据

| 来源 | 实际核对 | 适用性及限制 |
| --- | --- | --- |
| OpenShell `v0.1.2`，项目已锁 CLI SHA、镜像 digest、基础及有效策略 hash | 本地 `apps/desktop/openshell-executor.cjs`、部署 `scripts/deployment/openshell-v012/` | 继续用现有 CLI transport、admission、UID/GID、CPU/内存核对、无网络策略和生命周期 journal。 |
| DSH `0.1.5-rc.1`、AgentTeams `0.1.20` | `services/agent-runtime/package.json` / lock；本地已安装 `dsh-tools`、`dsh-sandbox` 定义 | 复用原生 registry、`tools.guard`、`tools/execute`、会话持久化。无需另一套工具注册器。 |
| 官方 `dsh-session-checkpoint-policy@0.1.5-rc.1` | 实装位置 `services/agent-runtime/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-checkpoint-policy/`；`employee-hosts.mjs` 已 mount | 模型请求、顶层工具执行和下一 step 前 flush；flush 失败不派发。嵌套工具共享顶层持久边界，仍需要逐副作用身份。 |
| 官方 `dsh-sandbox@0.1.5-rc.1` | `lib/types/index.d.ts` 有 `SandboxProvider.confine(argv, policy)`、`workspaceRoot`、`full/partial` | 同主机文件访问约束接口，不是远程容器抽象；不能把只调用此接口或返回 `partial` 当完整企业隔离。现已有 OpenShell，不另建同机执行后端。 |
| DSH 市场 `dsh-taskboard` 与维护者仓库 | [目录](https://dshplugin.app/plugins/dsh-taskboard)、[维护者说明](https://github.com/cloader/dsh-taskboard) | 任务 worktree、提交及合并可供协作产品参考；维护者明确它依赖协作约定，且 Git 不可用时会回原目录。不能作为本需求的安全边界，不安装。 |

固定 OpenShell 策略的文件访问由 Landlock 强制，文件/身份策略在启动时确定，不能用运行中的网络策略更新来切换任务写权限；`hard_requirement` 不满足时必须失败。详见固定版 [策略概述](https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/docs/how-it-works/policies/overview.mdx)、[策略字段](https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/docs/how-it-works/policies/schema.mdx)、[Landlock 实现](https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/crates/openshell-sandbox/src/sandbox/linux/landlock.rs)。项目当前 `read_write: [/sandbox, /tmp, /dev/null]`，所以同一沙箱换 cwd 不缩小权限。

本地 DSH checkpoint 插件的源码与官方 [checkpoint 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md)一致：持久意图和中断后的未知结果不等于外部服务恰好执行一次。官方 master 只作说明对照，接口可用性以实装 `0.1.5-rc.1` 源码为准。

## 3. 当前链路及必须覆盖的落点

| 文件/接口 | 当前行为 | 接入要求 |
| --- | --- | --- |
| `services/agent-runtime/handoff.mjs`：`begin/beforeFile/observe/exclusive/checkpoint` | 输入固定 SHA；直接文件工具在派发前校验；终端变化在执行后检查；全局工作区 mutex | 保留合同校验与合并锁。加入 `executionScope`，每个 attempt 自有工作区；`observe` 只能观察已验证导出/已提交合并，不能成为原文件的唯一保护。 |
| `services/agent-runtime/product-tools.mjs` | 员工授权、逐次终端审批、工具前 checkpoint、派发及未知结果事件 | 批准内容绑定任务合同、输入/工作副本版本、隔离 profile；任一变化使旧批准失效。 |
| `services/agent-runtime/native-plugin-tools.mjs` | 官方 registry 加载代理定义；调用远端 native worker，任务读写合同检查 | 和 terminal 共用 scope 及副作用契约；插件业务代码保持原样。 |
| `apps/api/src/local-execution.ts`：`LocalOperationService.enqueueAttempt` | 租约/员工/工具/审批再次校验；native 调用从批准快照生成读写列表 | 在此从可信快照生成任务 scope，不接收模型自报 allowed paths；对 terminal 也强制 task/assignee/attempt 绑定。 |
| 同文件 `LocalRunExecutor.execute` | 收到 `result.files` 后直接 `mirrorFiles(root, files)` | **不能直接传 task 子集**：`mirrorFiles` 会删除未出现的旧文件。先验证导出、构造完整合并候选并持久提交，再刷新 canonical 镜像。 |
| `apps/desktop/openshell-executor.cjs` | `stateFile(runId)`，一 run 一沙箱；终端直接 `/sandbox`；nonce/回执/策略双重核验 | scope key 扩为不可混淆的 `(runId, taskId, attemptId, generation)`；保留 runId 的费用/归属意义，不把 taskId 塞进 runId 来伪造兼容。 |
| `apps/desktop/local-client.cjs` | claimed/started/completed/acknowledged 持久回执；重启只重发回执 | 保留 operationId、claimToken 和未知不重放；新增 scope 和结果核对引用，避免重建沙箱时再次执行。 |
| `apps/desktop/native-plugin-worker.cjs` | 私有副本、路径白名单、结果先检查后发布；Node permission 限制插件子进程 | 复用其输入复制/完整结果验证思路。Node permission 是附加约束，不能代替任意 shell 的 OS 边界；多文件发布目前也不是原子事务。 |
| `services/agent-runtime/step-checkpoints.mjs` / `apps/api/src/step-checkpoint-recovery.ts` | 全工作区文件快照；contract/environment hash；未知阻止恢复；新 run 恢复 | 增加任务工作副本与 canonical 成果各自的 manifest，并保留旧 schema 解读。恢复不能覆盖其他员工成果。 |
| `services/agent-runtime/recovery.mjs` | 静态 `READ_ONLY_TOOLS`；按 starts/results 导出未决操作 | 用固定能力版本的副作用契约覆盖新增工具；旧记录仍采用现有保守分类，不从名称推导新工具只读。 |

## 4. OpenShell 0.1.2 实际接口

沿用 CLI 最小，因为项目已具备固定校验和传输；SDK 是可用候选，本轮不引入新依赖。下表的占位符由可信侧产生，员工不得直接选择 gateway、policy、image、sandboxId 或管理命令。

| 阶段 | 固定版 CLI / 本地落点 |
| --- | --- |
| 创建 | `--gateway <fixed> sandbox create --name <persisted-name> --from <pinned-image> --policy <fixed-file> --cpu 1 --memory 512Mi --no-auto-providers --approval-mode manual --detach --no-tty --output json -- /bin/sleep infinity`；复用 `perform` 的创建意图先落盘和一次 dispatch。 |
| 准入 | `sandbox get <name> --output json`，核对 ID、Ready、configuration admission、有效策略 hash；`policy get <name> --full --output json`；复用 `get/admit`。 |
| 导入 | 复用 `sandbox exec --name <name> --workdir /sandbox --no-tty --no-login-shell --timeout 75 -- node -e <trusted-script>`；stdin 仅传受限 manifest/blob，`prepare` 只允许空 workspace，逐文件 `wx`/CAS；不映射 canonical 路径。 |
| 执行 | 同一 exec transport 启动批准 command；workspace 仅属于该 attempt。执行前后核对 scope 与 input/work revision；stdout/stderr 是数据，不是可信回执。 |
| 导出 | 新增可信 `export`/`inspect` 分支，复用当前 `exportFiles` 的普通文件、链接、数量及字节检查；对已完成命令可重复读取导出，不能借核对再运行原 command。 |
| 停止/恢复 | `sandbox stop <name>`、`sandbox start <name>`；复用已确认 stopped 才 start 的规则，再次 admission。stop/start 不恢复进程内存。 |
| 销毁 | `sandbox delete <sandboxId>` 后 `sandbox get <original-id> --output json` 确认原对象消失；复用 `retireStorage/confirmAbsent/reconcileStorage`，仅“删除受理”不能宣称已回收。 |

官方固定版 [生命周期及传输](https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/docs/how-it-works/sandboxes/overview.mdx)提供 create/exec/upload/download/stop/start/delete。upload 会保留 symlink，故不宜直接把任意目录 upload 当本项目安全导入。项目的显式普通文件清单更符合既有合同。

固定版 [TypeScript SDK](https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.2/sdk/typescript/README.md)对应 `client.sandbox.create/waitReady/exec/execStream/delete/waitDeleted`；无 file-transfer RPC，文件通过 CLI tar-over-SSH 或小型 stdin exec。SDK 从 GitHub Packages 分发。当前 CLI 路线已实现需求，不必为此次接入改用 SDK。

**传输上限待实测：** 固定官方文档标明 exec piped stdin 4 MiB，而现项目 remote script 接收上限 29 MiB、文件总量 20 MiB。新模块应在编码后预检传输字节，首版采用较小的已验上限或分块 blob 导入（块、总量、SHA、完整提交均受限）；未做真实边界实验前不得以本地 parser 上限承诺可传 20 MiB。分块中断只能续传/核对相同 blob，不重新执行任务。

## 5. 首个可实施模块：任务清单与 CAS 合并

建议新增一个共享的 `packages/contracts/task-workspace.mjs`（配类型声明及测试），复用现有 `validPath/canonicalManifest/decodeFiles`，避免再引入可配置文件系统框架。该模块负责确定性验证；持久提交仍接现有可信操作服务及 archive，纯函数通过不等于执行隔离已部署。

建议接口（待实现，不是当前已存在 API）：

```ts
createTaskScope(approvedSnapshot, activeAssignment, canonicalManifest, recoveryRef?)
  -> { scope, inputManifest, allowedOutputs, baselineOutputs, contractHash }
validateTaskImport(scope, inputManifest, blobs) -> validatedFiles
validateTaskExport(scope, beforeManifest, exportManifest, blobs) -> boundedDelta
planTaskMerge(scope, boundedDelta, currentCanonicalManifest) -> mergePlan
```

`scope` 至少固定：schema/profile、projectId、planVersion、runId、taskId、attemptId、assignee、generation、contractHash、capability/permission hash、backend/image/policy identity、base canonical revision、input manifest hash、task work revision；由服务端根据批准快照生成，并纳入 operation payload/回执。

输入清单每项固定 `{path,size,sha256,source:{runId,taskId,attemptId,checkpointId?,acceptedRevision?}}`。上游产物必须来自已接受版本；不能因工作区碰巧有同名文件而导入。任务已有输出仅从同一 attempt 或明确可追溯的恢复来源导入。公司知识仍按原授权快照独立注入，不复制完整公司资料。

`baselineOutputs` 保存输出目标在创建 scope 时的 SHA 或 `null`（原本不存在）。导出 delta 的每条变化包含 `{path,beforeSha256,afterSha256,size,operation}`；只允许已批准 outputs 且满足 inScope/outOfScope 的路径。首版默认不支持删除，若必须支持则显式 tombstone 并核对原 SHA；“导出里没出现”不能解释为删除。

验证顺序：

1. 校验 scope 身份、当前租约、能力版本、权限及合同未变化；强制任务隔离 profile。
2. 全量检查输入/导出：路径规范、重复与大小写碰撞、文件/目录前缀冲突、symlink/hardlink、特殊文件、大小/总量/数量、SHA；任何失败都不发布任何文件。
3. 对比副本，拒绝输入非输出文件的修改/删除和未声明输出；内部临时文件如需允许必须置于明确 scratch 区，不混入导出根，不默认忽略未知文件。
4. 在现有全局合并锁内，核对每个输出的当前 canonical SHA 等于 baseline。首版可保守要求完整 base revision 相同；后续可允许其他无关路径更新，但必须仍核对所有目标文件并保留其他路径。
5. 生成**完整**候选 manifest：current canonical + 已验 delta。不能采用 task 导出替换整个 run。
6. 先落盘 merge intent（唯一 mergeId、operationId、旧/新 manifest、blob SHA、scope），再保存已校验 blob，提交唯一新 revision，最后写 merge receipt。消费者只读 committed revision。
7. 丢失应答时按 mergeId 查询结果；不能重复执行原命令。部分发布/磁盘满/崩溃时冻结该 canonical scope，按原 intent 核对再恢复；禁止以“每文件 rename 原子”宣称整个多文件合并原子。

可以先保留整个执行串行，正确性闭环后再把长命令移到各自 task 锁，仅合并使用全局锁。不得为提高并发提前删除原 workspace mutex。

## 6. 检查点、亲缘与恢复兼容

任务检查点应区分三类引用：`inputManifest`（固定来源）、`workManifest`（未发布的副本）、`canonicalRevision/mergeReceipt`（已正式发布）。任务执行成功、导出验证成功、合并成功、经理验收成功分别记录，不能用一个 `completed` 混同。

新 checkpoint version/profile 固定 task scope、input manifest hash、基线输出 SHA、work manifest hash、环境证明、能力版本和原始 operation/merge receipts。恢复关系保存 `{sourceRunId, sourceTaskId, sourceAttemptId, checkpointId, checkpointSha256}`；核对同项目/方案、可信 ancestry、原任务合同及权限。复用原 `checkpointContract`/`checkpointEnvironment`，但加入隔离 profile 与 scope/输入绑定，避免“同镜像、同 UID”被误判成同执行边界。

恢复必须创建新 run/attempt/sandbox，原检查点和原成果不改写。输入上游版本变化、员工能力撤销、插件 bundle 变化、镜像/策略变化都会拒绝原环境证据沿用。可选择重新固定输入后新执行，但不得伪称旧 attempt 原样续跑。未决原操作必须先核对，创建新沙箱不能抹除旧未知状态。

旧 v1 全 run checkpoint 保留读取和备份恢复，不自动贴新隔离标签。升级恢复需先通过旧完整性/未知操作检查，然后只提取新批准合同允许的文件进入新 task sandbox；旧 terminal_test 收据不自动继承为新隔离 profile 的通过证据，首版重新验证。已有 `same-workspace` 测试证据复用只适用于原支持的严格检查；不能因为现在拆成 task workspace 而放宽。

task A 的回退不得回退 B 已提交成果、预算、费用、授权、外部请求或消息。允许恢复 A 副本但合并时再次 CAS；B 与 A 修改同一目标则冲突，交给显式的新版本合并处理。销毁任务沙箱前须确认导出/检查点及所有操作已决，未决沙箱保留诊断引用并计入容量。

## 7. 工具结果核对与补偿的共享契约

契约挂在统一能力目录的固定版本上，产品内建工具、DSH 原生工具代理、MCP、公司插件都走相同门禁；各自加载方式不变。插件 manifest/MCP annotations 是待验证声明，不能自行授予权限。[MCP 官方 schema](https://modelcontextprotocol.io/specification/2025-06-18/schema)明确 annotations 只是提示，不能信任未知服务的 readOnly/idempotent 声明。

建议最小能力契约：

```ts
{
  version: 1,
  capabilityId, namespace, toolName, definitionSha256,
  effect: 'read' | 'workspace' | 'external',
  isolationProfile, permissions, // 固定版本及授权快照
  retry: 'bounded-read' | 'provider-key' | 'never',
  reconciliation: { kind: 'receipt' | 'query' | 'manual', resolverId?, version? },
  compensation: { kind: 'none' | 'operation', capabilityId?, requiresApproval: true }
}
```

`external` 不代表默认可执行；没有已批准资源范围、结果查询机制或人工核对路径的变更工具拒绝准入。只读也可能计费，副作用分类和费用预留是独立维度；保留原金额/次数/未知费用门禁。

复用 DSH 实装的 `ctx.tools.guard(execution => reason | undefined)` 作全局单调拒绝门禁；它在可扩展 pre-execute 后执行，须覆盖后注册工具、scope-local 工具、嵌套调用、无 agent 的后台触发。门禁校验实际身份、固定版本、授权、effect 契约及允许执行边界；默认未知工具拒绝。异步 reservation/receipt 落盘放 `tools/execute` 包裹层和原 API 服务；同步 guard 不能假装完成数据库事务。工具发现列表也过滤，但“不可见”不能代替调用时授权。

每次调用 intent 固定 operationId、rootCallId/parentOperationId、run/task/attempt、principal、capability digest、规范化参数 hash、批准/预算引用、资源版本前置条件、scope manifest、provider idempotency key（若服务真实支持）。DSH 顶层 checkpoint 不替代嵌套外部操作各自的 intent。

状态至少区分 `prepared → dispatched → confirmed | failed-known | unknown`，以及本地输出的 `validated → committed | rejected`。`isError:true`、非零退出码、超时或取消不能自动推断没有副作用。仅可信执行器可声明 notExecuted；模型、任意插件返回值或 stdout 文本不能清除未知记录。

| effect / 情况 | 核对与重试规则 |
| --- | --- |
| 已验证 read | 有界自动重试；若计费仍走费用门禁。恢复沿用原证据范围，不扩大读授权。 |
| workspace | 核对原 sandbox/operation、导出 manifest 与 mergeId。命令可能已改副本，但 canonical 未提交不等于“命令没执行”；不得重跑来猜结果。 |
| external + 原生幂等键 | key 绑定确切服务、账户、资源、参数和能力版本；先查询原 request/receipt。只有服务保证的同 key 重试才可能安全，不能自行生成新 key 重放。 |
| external 无可靠查询 | 保持 unknown，停止依赖节点，展示必要的原请求证据供核对；不得用文件回退清除外部效果。 |
| 收到迟到结果 | 验证原 claim、operation 和参数摘要，追加不可变 reconciliation 记录，保留旧 unknown 历史；撤权后可收证据但不得恢复新执行权限。 |
| 补偿 | 作为新、有独立 operationId/授权/预算的操作，引用原 operationId；先确认原效果，再执行已验证逆操作。补偿也可能 unknown，不能递归自动重试或把原账本删除。 |

工具“成功回执”和业务后置条件分别验证：如本地文件 SHA/格式，远端对象 ID/版本/读回状态。退款、撤销、删除等补偿不能泛化；服务不支持时明确人工处理。此轮只定义共用机制，不逐项重写业务插件。

## 8. 实施顺序与真实验收

1. **清单模块。** 实现 scope/import/export/mergePlan；以现有 fixture 和真实临时文件验证路径、配额、版本及并发负例。此时只报告“合同模块通过”。
2. **可信合并。** 接 `LocalRunExecutor`、local operations、merge intent/receipt，证明 task 子集不会删除其他员工成果；注入写盘/回执中断，验证不会重复执行或读取半提交 revision。
3. **OpenShell task scope。** 在 executor 建立 task-attempt 映射与生命周期，真正以独立 sandboxId 执行 terminal/native plugin，保持原 admission、storage quota、取消、未知不重放；enterprise 路由拒绝全部不支持后端。
4. **checkpoint/恢复。** 新旧 schema、亲缘、输入/权限变更、未决操作、费用保留、恢复后 CAS 与证据继承回归。
5. **全工具契约。** registry guard + 执行 wrapper，验证动态注册/嵌套/后台工具，不只检测原固定名称。
6. **真实隔离验收。** 单独批准的开发 OpenShell 环境执行下列攻击/崩溃探针，并产出两 sandboxId、实际策略、输入/输出 SHA、错误与回执。不得运行在生产目录；不要为测试调用模型。

负例矩阵：

| 负例 | 必须看到的结果 |
| --- | --- |
| A 命令用绝对路径、`../`、另一个 cwd 写 B/宿主目录 | 原路径不在其 namespace 或内核拒绝；B 原文件 inode/内容及 canonical revision 均不变。只看到 handoff 报错不足以通过。 |
| A 猜 B sandboxId / 访问 gateway socket / 宿主凭据 | 子进程无管理凭据/套接字/网络通道，不能操作 B。可信 CLI 留在设备服务。 |
| 修改只读输入副本、创建未声明输出或链接逃逸 | 整份导出拒绝，canonical 零发布；原输入不变。 |
| 硬链接、symlink、FIFO/device、大小写/目录冲突、超量文件 | 导入和导出都拒绝，路径外零访问/写入。 |
| A/B 基于同 SHA 修改同一输出 | 只有先提交者成功，另一方 CAS conflict；不可静默覆盖。 |
| B 已提交其他文件，A 仅导出自己的子集 | B 文件完整保留；不执行 task 子集的全目录 mirror。 |
| 命令后台子进程继续写、迟到输出 | 导出前确认不可信进程停止或隔离为新代；不能在活跃写入者存在时 seal 结果。超时/不确定继续 unknown。 |
| 创建后断连/执行后回执丢失/合并中崩溃 | 原 sandboxId 和 operation/merge intent 可核对；执行次数仍为一次；不可凭重启建立新 identity 再跑。 |
| 仅收到 delete accepted | 状态保持回收中；实际消失后才释放占用/报告完成。 |
| checkpoint 恢复时 B 已完成、输入变版、权限撤销 | 不回退 B；不沿用不匹配证据/授权；CAS 或恢复准入拒绝。 |
| 插件动态注册新名字、scope shadow、嵌套外部调用 | 未授权或缺契约全部在工具体前拒绝；顶层已有授权不自动覆盖子工具。 |
| 新工具伪装 readOnly/idempotent，或外部服务已写后超时 | 声明不能放行；unknown 不自动重发；核对/补偿各有独立证据。 |
| OpenShell 不可用或任务 scope 缺失 | enterprise failclosed，确认 host shell/native/shared sandbox 执行计数为零。 |

验证分层应分别报告：确定性单元测试、真实临时文件集成、mock CLI 协议、真实 OpenShell OS 边界、恢复/完整业务链。只有最后真实隔离及接线证据齐备，才可说“任务写入隔离已接通”；仅纯函数/模拟 transport 通过不能说已部署或已防住不可信命令。

## 9. 本轮状态与剩余风险

已验证：固定源码的现有执行链、DSH 版本/guard/checkpoint 接口、官方 v0.1.2 CLI/SDK 能力及策略静态限制、任务导出与 `mirrorFiles` 的兼容风险。文档提出的接口、schema 和状态均为后续实现建议。

未验证：真实 task-attempt 沙箱间隔离、传输极限、资源/延迟、后台进程清理、跨文件提交崩溃恢复、对外业务核对和补偿。当前 512 MiB/1 CPU 是**每个沙箱**，任务并发必须纳入全局容量与保留上限；不能因为每个容器有限额就认为总量已受控。原项目仍需按后续实现及真实验收，才能获得本报告描述的新增保证。
