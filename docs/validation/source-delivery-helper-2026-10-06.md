# 源码交付复制工具准备记录

本次仅新增 `scripts/prepare-source-delivery.mjs` 和 `tests/source-delivery.test.mjs`，完成离线 builder 及合成目录回归；没有生成当前工程的最终源码 bundle、读取原数据或凭据、访问 API/模型、停止或启动服务。原工程、原数据备份器及已冻结业务 helpers 均保留。最终交付是否通过仍取决于主任务的实际场景验收和独立数据备份。

已复核原 `final-offline-backup-plan-2026-10-05.md` 的 code payload 步骤及 `final-go-offline-backup-plan-2026-10-06.md` 更新。本工具准备实际源码副本和逐文件 `code-manifest.json`；数据仍使用现有离线备份器，两个清单不能互相替代。原数据 helper 的旧固定报告名和停服守卫未更改。

固定递归白名单为 `apps`、`packages`、`services/agent-runtime`、`scripts`、`tests`；固定根文件为 package/lock、tsconfig、Vite、README 和现有启动入口。另明确包含 `services/embedding/local.mjs`、`local.d.mts`、`model-lock.json`：知识模块直接依赖这些源码，不包含模型缓存。`--include-web-build` 显式选取当前 `dist/web`，`--document=docs/…` 逐个选择公开 Markdown/JSON 使用说明、报告或冻结 manifest；没有自动收集整个 docs。

拒绝越界路径、Windows ADS/保留名、符号链接/junction、硬链接和非普通文件。递归过程跳过 node_modules、.git、.data、.env、private/credentials/secrets 目录、明显凭据文件以及 journal/数据库/归档文件；明确拒绝选择 test-evidence。不会读取被排除条目的正文。不支持的文件类型直接拒绝，不默默漏掉未知源码。固定上限为 20,000 文件/目录、单文件 64 MiB、总计 512 MiB、单选文档 2 MiB。

`--copy` 创建工作区直下全新 `source-delivery-<UTC>-<UUID>/code`，不覆盖或删除现有目录。复制前计算每个真实文件的字节 SHA256 及完整 size/mtimeNs/ctimeNs/ino/dev/mode/nlink identity；读前、读后和 inventory 结束均复核 identity。每个副本由原字节写入；随后独立重读完整副本验证路径、字节、SHA 和空目录，再重新读取完整所选源清单及 SHA/stat。全通过才写入 `code-manifest.json` 的 `verified-source-copy`；复制期间失败保留新目录并写 `failed-source-copy` 记录，不生成 verified manifest。这个状态只证明本次源码副本一致性，不是最终产品验收或数据恢复声明。

未来执行示例（本次未执行；最终报告路径由主任务实际状态决定）：

```powershell
& $verifiedNodeExecutable scripts/prepare-source-delivery.mjs --inventory --include-web-build --document=docs/local-run.md
& $verifiedNodeExecutable scripts/prepare-source-delivery.mjs --copy --include-web-build --document=docs/local-run.md --document=docs/validation/<实际最终报告>.md
```

不得把示例占位符直接用于交付。主任务最后使用冻结的实际源码和网页构建运行，保存返回的唯一 destination、逐文件清单和 manifest SHA；若要放入独立数据备份 group，原备份器导出的 `inventory`/`copyTree` 仍可对这一实际 code payload 进行后续复制核对。最终源码目录与数据目录继续分别明确标识。

Node 24.19 隔离回归 8/8 通过，见 `source-delivery-helper-2026-10-06-final-v2.txt`：真实字节相同和逐项 hash、原源不变/新目录唯一、空目录保留、全部排除项、显式 build/docs、路径/源/文档/root junction、硬链接、字节上限、未支持格式、同 size 恢复 mtime、添加/删除文件，以及真实 fs.watch 在复制启动后改源导致 failed 且无 verified manifest。CLI 缺少显式操作或含未知参数均在复制前拒绝，help 不执行复制。

`node --check` 退出 0；最终 `tsc --noEmit` 退出 0，日志 `source-delivery-helper-2026-10-06-tsc.txt` 为空。保留首轮 `first.txt`（凭据文件名正则边界遗漏，已修）和第二轮 `final.txt`（fixture 名 secret.json 被增强规则提前排除，已换成普通文件以真正验证 junction），两份 7/8 日志不作为通过证据。最终源码 SHA 见 `source-delivery-helper-2026-10-06-sourceSHA.json`。
