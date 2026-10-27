# 最终离线备份执行预案（只读准备，2026-10-05）

本阶段只读取现有 helper、旧证据和安全测试；**没有访问原数据库目录、执行备份、停止服务或修改 helper**。原数据源仍为 `C:\Users\JJ\Desktop\la\agent_department\.data\local`。两个新项目为：正常 `4938eab8-26ed-4f60-9413-d979f05fa968`；恢复 `3e101c24-87e6-43ea-80f9-a2c4b0b410f4`。最终 Run 尚未产生，下面的 Run ID 必须由完成后的实际记录填入，不能使用项目 ID 代替。

## 已核对的旧能力与限制

[旧实际备份](../test-evidence/my-gateway-full-backup-2026-10-05.json)在 02:56:14.902 UTC 完成：1,503 文件、202,999,631 字节、34 张业务表，原 Run `1e6a2c30-3e8c-46fd-9c31-d2557768eb9a`；恢复库只读重开两次一致，员工开发测试 8/8。这不能代替新项目的备份或付费验收。

[现有 helper](../../scripts/verify-mvp-full-offline-backup.mjs)支持的实际 CLI 参数只有 `--confirmed-stopped`、单个 `--run-id=<UUID>`、`--fixture`、`--help` 及内部 `--worker`。不存在 `--source`、`--destination`、`--report-prefix`、`--project-id` 或多 Run 参数；不要传入未实现的参数当作有效守卫。

必须避开以下限制：真实报告名固定为 `my-gateway-full-backup-2026-10-05.json`，当前旧文件已存在，而且防覆盖检查在复制、重开和开发测试之后才执行。因此不能直接在当前源码根目录重跑。文件清单仅保存聚合 SHA，没有逐文件 manifest；整份备份不包含工作台源码或 `dist/web`。它只审计一个指定 Run 和开发测试，静态 limitation 仍沿用旧“QA/经理未完成”说明，不能拿该文字判断新运行状态。

## 阶段 1：完成运行并核对停服

根代理先记录两个最终 Run ID、项目/版本/状态、已用费用与全部未知预留、调用次数、DAG 完成节点、文件 SHA、固定知识版本及实际命令回执。应从已验证网页/API 保存基线，不能以直接修改数据库补状态。

停服前须无 queued/running Run、pending 模型收据、waiting/replying 经理消息、active 自动计划、queued/claimed/started 本机操作或 running 能力测试。未知费用不清零、不删除；已明确保留的 uncertain 收据继续计入原费用边界。

按本轮既有精确 PID 停服方法核对 launcher/API 的命令、数据目录、父链与 UTC 创建时间，持有匹配的原生句柄后只停止该实例，等待 API、PGlite 与 launcher 清理完成。随后验证原进程已退出且源 `launcher.lock`、`database/postmaster.pid` 不存在。不能删除锁文件冒充关闭，也不能仅凭不存在锁就推断进程已关闭。`--confirmed-stopped` 是该事实成立后的确认旗标，不提供进程级停服保障。

## 阶段 2：使用同一 helper，在新审计根运行

推荐一次全量数据复制覆盖两个项目，使用新目录 `.data/final-full-backup-audit-20261005-<GUID>`；其下保留 helper 生成的 `.data/full-offline-backup/<GUID>/{snapshot,restore,execution}`。这是现有 helper 的原样副本，不是第三份备份实现。新审计根中的 `docs/test-evidence` 与 `docs/validation` 必须为空，避免固定报告名与旧证据相撞。PGlite 可从上级当前仓库的 `node_modules` 解析；依赖不可用时停止，不安装新软件作为临时绕行。

以下仅为未来执行命令，**本阶段未执行**。`$verifiedNodeExecutable` 使用本轮实际验证过的 Node 可执行文件；最终 Run ID 由根代理填写：

```powershell
$workspaceRoot = (Resolve-Path -LiteralPath '.').Path
$auditRoot = Join-Path $workspaceRoot ('.data\final-full-backup-audit-20261005-' + [guid]::NewGuid().ToString())
$normalRunId = '<正常项目实际最终 Run UUID>'
$recoveryRunId = '<恢复项目实际最终 Run UUID>'
```

在创建目录前，复用原 helper 导出的 `checkedRoot($workspaceRoot/.data)` 与 `newDirectory($auditRoot)` 校验无目录链接、目标严格位于工作区 `.data` 内且不存在。然后仅创建 `scripts`、空 `docs/test-evidence`、空 `docs/validation`，用 `Copy-Item -LiteralPath` 原样复制 helper 到 `$auditRoot/scripts/verify-mvp-full-offline-backup.mjs`。源和副本 SHA256 都应为 `edd2e7f549876a471d466562bb78939ab14a8482ff3733468aae9ccf152d824e`；不符即重新审查，不跳过校验。

```powershell
& $verifiedNodeExecutable (Join-Path $auditRoot 'scripts/verify-mvp-full-offline-backup.mjs') --confirmed-stopped "--run-id=$normalRunId"
if ($LASTEXITCODE -ne 0) { throw '最终备份验证失败；保留该目录和错误证据，不覆盖重试' }
```

helper 拒绝存活标记、链接/目录逃逸与已存在目标，限 200,000 文件/10 GiB、每表 250,000 行；复制前后核对源文件路径、大小、mtime 与目录，非凭据文件逐项 SHA256 相同。只打开 `restore/database` 两次，拒绝其中任何活动任务；不加载应用、迁移、设备、模型或账单客户端。原凭据和设备授权保持密文/不透明复制，不解密、不重用、不把正文或密钥写入证据。保留 untouched `snapshot`，因为恢复引擎重开可改变 `restore` 的物理启动文件。

只有 `copy-complete-original-can-restart` 的复制稳定性检查通过后，原环境才可以用相同数据和生产入口重新启动；恢复审计和文件测试继续在独立副本进行。重新启动不能自动重放旧未知外部操作。

## 阶段 3：复用导出函数补两 Run 和实际清单

从新审计根的报告读取实际 `copyProof.snapshot`、`copyProof.restore` 与 group，不能猜 helper 随机 UUID。用原 helper 已导出的函数顺序执行下列补充，而不是新增备份器：

1. `worker(restore, recoveryRunId)` 只读打开同一恢复库两次。断言两份结果一致，`run.projectId` 为恢复项目 UUID，`run.id` 是实际最终 Run，状态为实际完成状态；业务指纹、费用/未知收据、知识版本和 workfiles 与正常 Run 两次审计相同。正常报告同样须核对正常项目 UUID、最终 Run ID 与完成状态。所有 worker 顺序关闭后才开下一只，不能并行打开同一个 PGlite 库。
2. 对 untouched `snapshot` 执行 `content(await inventory(snapshot, true))`，把实际 `directories/files/path/bytes/opaque/sha256` 清单写入新的 `data-manifest.json`。opaque 凭据项只列路径、大小和标记。按 helper 的递归键排序 canonical 规则求聚合 SHA，并与 `copyProof.contentManifestSha256` 比较，不把不同序列化顺序导致的哈希当数据变化。
3. 根代理先形成最终冻结的工作台代码 payload，含实际 `apps`、`packages`、`scripts`、运行器源码和 lockfile、根 package/lock/config、两个 Windows 启动入口、使用说明和 **当前 `dist/web`**；排除 `.git`、`node_modules`、所有工作/恢复 `.data` 和明文环境凭据。payload 必须是实际文件，不能只是拟定清单。用同一 `inventory` 检查后，以 `copyTree(codePayloadRoot, group/code)` 保存到全新目的地，比较两份 `content`；把真实字节清单保存为 `code-manifest.json`，关联构建与源码冻结 SHA。
4. 从 data manifest 列出两个最终 Run 的 `runs/<RunID>/artifacts` 文件及所有继承来源文件，核对开发、独立测试、经理报告与最终运行交接清单的实际 SHA。恢复引用的原 Run/KB 固定版本也保留，不能只列当前最新文档。把两项目的 worker 输出与清单写到新的最终阶段报告，引用原 helper 报告，但明确其静态旧 limitation 不是新 QA/经理状态。

原 helper 全量源复制会包含全部历史 DAG、调用、费用、知识版本、journal 和 workspaces；第二 Run 审计补足明确身份，不能用“全库有复制”代替该 Run 的实际核对。声明验收时还要关联根代理已经取得的真实模型与网页证据；文件和库恢复不证明员工成功执行。

## 阶段 4：交付文件在独立 execution 中核验

helper 自动在 `execution` 副本运行正常 Run 的 `node --test todo.test.mjs`，只验证开发测试。两条最终路径的独立 QA 必须按员工实际 README/批准合同中的命令验证；使用新 `execution-normal-qa`、`execution-recovery-qa` 目录，通过同一 `copyTree` 复制员工 artifacts，不能在 untouched snapshot、restore artifacts 或原工作区运行。

沿用已导出的 `networkGuardCode()`、清空业务凭据环境、明确子进程超时和输出上限，保留命令、退出码与完整结果。该 Node 网络守卫不等同 Windows OS 沙箱。复跑后再核对保存的员工 artifacts 清单不变；源服务健康检查不发推理、不重用历史命令审批。任何一步失败保留其目录与输出，标为失败/未验证，不覆盖原数据或旧 1,503 文件备份。

本预案的实际结果仅为只读审查完成。新的全量备份、两 Run 恢复、最终代码 manifest、独立测试复跑和重启健康均等待主代理在最终运行与安全停服后执行。
