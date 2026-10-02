# 为伍 Windows 网页 MVP 验收报告

验证日期：2026-10-02；收尾日期：2026-10-03（北京时间）。最新 GitHub 基线为 `0befc094953880b6b3ede88506f6fa3e41088e85`，工作分支为 `codex/weiwu-mvp-validation`。本报告包含基线后的本机修复与实际验证，不表示这些修改已经推送到 GitHub。

**结论：代码可在 Windows 本机启动，已有真实 Todo 正常完成证据，真实受控中断后的恢复机制及 QA 续跑已通过；本次新项目的经理验收尚未完成，且有一笔已发出的模型调用费用不明。因此全部 MVP 验收标准尚未满足，目标仍受阻，不能标记为完成。**

报告区分四种状态：**通过**表示有实际证据；**失败**表示本次执行未成功；**受阻**表示后续动作依赖明确的外部输入；**未验证**表示没有对应实测。已有失败档案、原始员工文件、凭据和设备授权均保留。工程回归使用本地测试；真实业务证据使用原已配置中转站，没有以固定响应替代真实模型验收，也没有由 Codex 补写员工交付文件。

## 验收清单

| 优先级 | 必须项 | 状态 | 实测与证据 |
|---|---|---|---|
| P0 | Windows 本机启动、网页独立操作 | 通过 | 最新代码沿用原数据目录启动；`local:check` 通过；正常和恢复页面在 IAB 实际操作。启动说明见 [local-run.md](local-run.md)。 |
| P0 | 持续多轮需求、修改团队、确认后才创建 | 通过 | 真实网页 4 轮：自然讨论 → 不完整候选失败 → 完整预览 → 修改部门名称/开发岗位。确认前部门 1、项目 5；明确确认后部门 2、项目 6。新项目 `9975fd32-a91a-4081-90c5-21159c51a1a4`。 |
| P0 | 正常路径：真实开发、独立测试、经理验收 | 通过（既有成果复验） | Run `99551bf3-94f0-464a-8cd7-6935ad679ab8` 的开发、QA、经理均 completed；45 次真实请求、45 次结算；5 个员工文件未改。独立复测 2/2，网页下载 README 哈希一致。 |
| P0 | 新项目端到端完成 | 受阻；最后 Run 为 failed | 恢复子 Run 开发、独立测试及 QA review 已完成，经理节点 claimed 后在批准的期限内中断；一笔真实调用待账单核对。不能把 QA pass 写成经理交付完成。 |
| P0 | 受控中断、服务重启、断点恢复 | 通过（恢复机制） | 父/子 Run 保存完整 4 节点 DAG、已完成开发、25 次历史调用、已用费用、4 个精确文件版本及任务上下文；开发没有新调用或重复验收；未完成 QA 实际续跑。审计 6/6，见 [恢复证据](test-evidence/mvp-recovery-2026-10-02.json)。 |
| P1 | 结果不明操作不盲目重放 | 通过（保护行为）；真实费用对账受阻 | 受控中断时没有在途本机操作；旧审批在重启后取消。子 Run 的不明模型收据保留，恢复入口被费用核对门禁阻止；未重复发送。成本门禁 5/5、本机回执 7/7。 |
| P1 | 知识授权、检索、固定版本、恢复引用 | 通过（隔离资料实验） | 共享、员工私有和单员工运行输入分别检索/读取；越权拒绝；当前 v2 不替代已批准 v1；目标恢复及再重启后引用仍为 v1。见 [数据证据](test-evidence/mvp-data-2026-10-02.json)。 |
| P1 | 备份在隔离目录恢复关键数据与文件 | 通过（隔离资料实验） | 源导出 → 全新目标数据库/目录恢复 → 目标关闭并重新打开。错误密码被拒绝；关键表数、DAG、合成记账、日志和嵌套文件/Vault 哈希一致。源数据保留，未用原环境做恢复实验。 |
| P2 | 节点、员工、审批、费用、失败、恢复及文件可理解/可获取 | 通过（已操作主流程） | 中文节点状态、审批归属、累计/本次费用、失效范围拦截、恢复来源、真实命令输出、文件预览和下载均已检查。停止后状态和不明费用禁用恢复也有本地回归。 |
| P2 | 相关测试、类型检查与构建 | 通过 | 最新标准 `npm run build` 通过，包含 TypeScript；74 项 portable runtime、18 项 UI/启动回归、7 项 native 回执、5 项费用门禁、7 项 deadline/adapter 均通过。详见后文输出位置。 |
| 边界 | 多人部署、独立 PostgreSQL 后端锁竞争、Docker 路径 | 未验证 | 本轮聚焦单用户 Windows 网页/PGlite/本机 Node 执行器，不扩展桌面、手机、图数据库或自进化系统。 |

## 正常完成的真实 Todo

项目：`782ecdd3-8235-4c32-95b8-d6f3fd1cabe3`。Run：`99551bf3-94f0-464a-8cd7-6935ad679ab8`。档案完整性 `ok`，开发、独立 QA、经理三节点均完成。模型为原中转站 `gpt-6-luna`。本次 Run 45 次真实请求/45 次结算，按配置单价计算 $0.0654913；原项目含规划及早期失败累计已知 $0.1011722。两者不是同一费用口径，也不等于中转站最终账单。

开发测试先失败，再由员工修正后通过；独立测试包含真实 Windows CLI 子进程启动及 HTTP 接口/错误场景。最新代码使用原文件复测 `node --test todo.test.mjs acceptance.test.mjs`，2 项通过、0 失败。没有修改这些交付物，也没有把本地 fixture 输出归入此真实 Run。

原文件目录：

```text
C:\Users\JJ\Desktop\la\agent_department\.data\local\workspaces\99551bf3-94f0-464a-8cd7-6935ad679ab8
```

宿主成果镜像及不可变档案：原数据目录的 `runs/99551bf3-94f0-464a-8cd7-6935ad679ab8/artifacts/`、`snapshot.json` 和 `events.jsonl`。

| 员工文件 | SHA-256 |
|---|---|
| `server.mjs` | `b00757f5bba4d727ba1d12b634d75bddc6910cded858be91e435fe84ae0eb6c1` |
| `todo.test.mjs` | `8ec8fcbf90506aafd48f95899d9499ec057431ffe993595fec33f24131e029b0` |
| `README.md` | `e8956545c45f475e45fb70d34dad9dde949da9f55c0e0ddc676505c4b39f3826` |
| `acceptance.test.mjs` | `04ce1d73e5c8d8add5c069aca61747cc0c381bbfc87cc1a7a4c6eea5509586b6` |
| `acceptance-report.md` | `e1f2ceeddb13a938fe5019398fc3eac04cf1fa4976c807f688a774c457a5c085` |

通过网页下载的 `C:\Users\JJ\Downloads\README.md` 为 863 字节，哈希与表中原文件相同；[下载证据](test-evidence/mvp-browser-download.json) 已保存。正常页面入口为 `http://127.0.0.1:4310/#run/99551bf3-94f0-464a-8cd7-6935ad679ab8`，需工作台正在运行。

原员工 `acceptance-report.md` 有一次测试耗时叙述误差，保留原样。真实报告后复验以宿主 `handoff/command-observed` seq 2969、退出码 0 为准，不能以报告文字替代命令证据。Todo 使用内存保存数据，进程重启会清空 Todo；该限制与工作台项目恢复是不同对象。

稳定证据：[原成功 Run 审计](test-evidence/mvp-preserved-real-todo.json)、[真实 Run 状态与回执归档](test-evidence/mvp-real-runs.json)、[原员工 2/2 独立复测](validation/preserved-todo-tests.txt)、[11 份真实本机命令输出](validation/real-todo-native-tests.txt)，以及 [原真实完成记录](todo-demo-acceptance-2026-10-02.md)。11 份输出完整保留首次失败、员工修正及成功复测，不是 11 次全部通过。早期 [真实失败记录](real-todo-validation-2026-10-02.md) 记录的是其他尝试，不替代本次状态。

## 新项目的失败、受控中断和恢复

新项目：`9975fd32-a91a-4081-90c5-21159c51a1a4`。审批策略保持 $0.48 总预算、80 次模型调用、35 次默认单任务调用、1800 秒、并发 1 和逐次命令审批，没有提高额度。

| Run | 状态 | 真实请求/结算 | 已知费用 | 实际结果 |
|---|---|---:|---:|---|
| `a79b1893-3c69-43f2-8439-094593148e82` | 失败 | 5 次调用 | $0.0040931 | 旧方案把自然语言写进文件 scope，合法交付被 `OUT_OF_SCOPE` 阻止；零交付。已修复校验/编辑，网页保存 v3。 |
| `1cc083f3-1ca0-4eec-8230-29a2fe7617f3` | 受控中断后 interrupted | 25/25 | $0.0243660 | 开发员工自己修正首次失败的测试，真实开发测试 2/2 通过；QA 等待审批时中断。该时点项目已知费用 $0.0299068。 |
| `c9b1f703-b2a6-4bf0-8318-ad2b15ce911e` | 最后状态 failed；经理完成受阻 | 18/17 新调用 | $0.0187921 新费用 | 继承 25 历史调用及已完成开发；QA verification 1/1，QA review 两组复验 2/2 + 1/1，verdict=pass；经理未完成。 |

中断选择在 QA 待审批、没有在途本机操作、所有此前费用已落账时进行。保存现场后停止 API，再用最新代码及原数据目录重启。父 Run 状态转为 interrupted；调用、费用、四文件哈希不变；旧审批取消。网页恢复创建子 Run，没有直接重放旧审批或结果不明操作。

[恢复审计](test-evidence/mvp-recovery-2026-10-02.json) 的六项通过证据包括：档案完整；原完整 DAG/策略不变；完成的开发节点被还原且新增开发调用为 0；接受文件和未完成 QA 文件精确恢复；全局/任务调用及费用继承；QA 未完成任务真实继续执行。子 Run 的初始剩余执行预算为 $0.4500932，来自 $0.48 减去启动前项目已用 $0.0299068，而非重置累计费用。

父、子原始目录均在 `C:\Users\JJ\Desktop\la\agent_department\.data\local\runs/<Run ID>/` 和 `workspaces/<Run ID>/`。审计保存的四文件为 `server.mjs`、`todo.test.mjs`、`README.md`、`acceptance.test.mjs`；各自完整哈希见恢复 JSON。Codex 未补写经理报告或其他员工交付。

经理节点在原批准的 1800 秒期限结束时中断。当前新项目已知费用 $0.0486989，另有以下**不能当作零费用**的已发出调用：

- 收据 ID：`f9752aa6-f045-4b96-9edb-43be3087b2ed`。
- 模型：`gpt-6-luna`；北京时间 2026-10-02 23:22:40–23:22:50。
- 错误：`CALL_INTERRUPTED`；`dispatched=true`；预留 $0.0102812。
- 需要中转站账单中的实际输入 Token、输出 Token 及核对依据，才能填写网页费用核对表单；只有费用总额不足以直接核对。当前未取得，已向用户请求。

该收据保持不明状态，未重复发出、未清零，也没有把预留当成已结算收费。原全局另外两笔不明预留保持原样。**在本笔账单对清且经理节点有真实完成证据前，不得宣称新项目或全部目标完成。**

本轮正常、重启前、重启后、刚恢复及最终停止的五份实际状态已复制至 [mvp-real-runs.json](test-evidence/mvp-real-runs.json)，包含批准合同、DAG、费用、原本机操作回执和源文件哈希。对应 [真实命令输出](validation/real-todo-native-tests.txt) 保存开发失败后复测，以及恢复后 QA 测试和 review 复验。原快照仍在工作区 `.data/mvp-evidence/`：`1cc083f3-...-before-restart.json`、`1cc083f3-...-after-restart.json`、`c9b1f703-...-resumed.json`、`c9b1f703-...-stopped.json`，完整文件名对应上述 Run ID。复验脚本为 `scripts/verify-mvp-recovery.mjs`；它读取保存的证据及档案，不代替员工执行。

## 知识与隔离备份

使用少量明确标记的测试资料，实验根目录为工作区 `.data/mvp-data-2VcfFZ`。`source/database` 与 `target/database` 是两个独立持久 PGlite 数据库；每阶段在新服务进程中运行真实产品 API。数据实验不打开原始用户数据库，不复制原始凭据，不调用收费模型。

共享、员工私有、单员工临时输入同时覆盖检索与直接读取；非法授权被拒绝。将当前文档更新为版本二后，已批准快照、切片 SHA-256 及引用接口仍返回版本一。恢复上下文保留引用元数据，下游不能借恢复历史读取前置员工私有记录。缺失固定版本会明确报错，不替换成当前资料。

通过实际 `/api/backup/export` 导出加密 fixture 备份，再通过 `/api/backup/restore` 恢复至全新的目标数据库和目录。错误密码先被拒绝，目标仍为空。恢复后表记录数、完整测试 DAG、合成费用/调用记账、档案完整性、嵌套文件及 Vault 文件哈希一致。关闭目标数据库和服务，再从持久目录重新打开，重复核验通过。源目录和原业务环境均保留。

证据：[mvp-data-2026-10-02.json](test-evidence/mvp-data-2026-10-02.json)，逐阶段 `source.log`、`restore.log`、`reopen.log` 与 JSON 均在实验根目录。复验命令：

```powershell
node scripts/verify-mvp-data.mjs
```

每次复验创建新目录。数据 fixture Run 为 `07d6bd05-10dd-4fa1-a00b-77f1b8a5cf4d`，恢复上下文 Run 为 `e79d2e1c-578a-4dfd-abf3-003979d386be`。它们的合成记账只证明数据保存，不是收费模型执行；备份中的测试文件不是员工 Todo 交付。PGlite 单后台不能验证独立 PostgreSQL 后端之间的锁竞争。

## 已修复问题

| 问题 | 修复及验证 |
|---|---|
| 多轮补充需求后，自然追问可能重新解锁旧方案确认 | 保留旧预览并锁定确认，只有新有效预览解锁；未发送输入、结果不明请求也阻止确认。真实 4 轮及组织回归验证。 |
| 无方案、失败草案、正式方案状态混淆 | 分别显示状态，保留自然回复/失败原因，可继续讨论；确认前没有部门或项目增加。 |
| 文件合同允许自然语言 scope，执行才失败 | 提前验证路径、输出与允许/禁止范围关系；提示词明确路径语义；网页让有范围/输出的各任务类型可编辑。真实旧方案被网页拦截，修正保存 v3 后执行。 |
| 恢复页把本次费用当累计，或旧档案推算未知累计 | 展示启动前已用、本次、累计和剩余额度；历史证据不足只展示已知值。 |
| 停止后仍像员工正在工作，未知费用允许点击恢复；窄窗口费用卡片挤压 | 明确中断位置；不明费用禁用两个恢复动作并给出费用核对入口；提示和按钮可换行。最终网页截图核验两个恢复按钮禁用且排版可读。 |
| 分页/轮询重叠导致日志重复或遗漏，切换 Run 短暂显示旧附件 | 合并事件去重；按 Run 重建附件区；附件读取失败明确提示。 |
| Windows 回执文件短暂被占用时保存失败 | 有限重试原子重命名，只重试回执保存；底层操作不重复。永久失败保留结果不明，重启拒绝重放。 |
| 期限中断被工具包装成其他错误，取消时尚未发送请求被误报为未知收费 | 保留批准期限作为停止原因；在持久预留后、真正发出前再次检查取消；已发出但无回执仍保留不明费用。 |
| 换代码副本需要复制原凭据/数据库 | 增加绝对 `--data-dir` 参数，沿用原数据与授权；锁阻止双开；本地检查禁止覆盖参数。 |
| 备份/Vault 提示仍假设 Mac，知识 fixture 未适配新版审批规则 | 改为本机/当前目录说明；资料 fixture 使用明确任务契约，保留 `PLAN_NOT_READY` 规则。 |

所有这些产品修复都与员工生成的 Todo 文件分开；未手工修补员工交付、替换验收输出或扩大已有权限。

## 工程验证与网页证据

| 检查 | 结果 | 输出位置 |
|---|---:|---|
| 标准 `npm run build`（包含 TypeScript 与 Vite） | 通过；1677 模块 | [final-build.txt](validation/final-build.txt)、[typecheck.txt](validation/typecheck.txt) |
| Portable runtime | 74/74 | [runtime-portable.txt](validation/runtime-portable.txt) |
| 网页状态、费用、事件、合同编辑及启动参数 | 18/18 | [ui-regression.txt](validation/ui-regression.txt) |
| 本机执行、回执丢失、进程重启及 Windows 短暂/永久占用 | 7/7 | [local-receipts.txt](validation/local-receipts.txt) |
| 费用预留、不明收费、恢复门禁与备份保护 | 5/5 | [cost-gate.txt](validation/cost-gate.txt) |
| Deadline 与模型 adapter | 7/7 | [deadline-receipts.txt](validation/deadline-receipts.txt) |
| 组织对话/同团队更新 API（模型替身） | 11/11 + 7/7 | [organization-api.txt](validation/web/organization-api.txt) |
| 知识、运行输入、扩展备份、恢复上下文 | 6/6 | [数据阶段记录](mvp-data-progress.md)及隔离目录日志/JSON |
| `npm run local:check` | 通过 | [local-check.txt](validation/local-check.txt)；独立 `.data/local-check/31c5d67e-530b-4157-ba87-034b1b364906/verification.json` |
| 产品 API/DSH、本机命令及恢复回归（模型替身） | 最新独立复跑 17/17；退出码 0 | [product-flow.txt](validation/product-flow.txt)，154.649 秒；真实 API/本机命令，模型仍为替身，不算真实模型验收 |
| 原员工 Todo 文件独立复测 | 2/2 | [preserved-todo-tests.txt](validation/preserved-todo-tests.txt) |
| 真中转站正常完成、受控重启、QA 续跑及网页下载 | 见各 Run 明细 | [真实 Run 归档](test-evidence/mvp-real-runs.json)、[11 份原始命令输出](validation/real-todo-native-tests.txt)、[恢复审计](test-evidence/mvp-recovery-2026-10-02.json)、[下载哈希](test-evidence/mvp-browser-download.json)；经理结尾仍受阻 |

测试分组可能有重叠，不将表内数量相加作为独立总用例数。固定协议服务仅用于开发回归。实际浏览器为 Codex 内置浏览器 IAB；Tabbit 不可用，本轮没有以 Tabbit 名义记录网页验证。

10 张必要截图已归档至 `docs/test-evidence/screenshots/`，并逐一核对源文件与副本 SHA-256；[截图索引](test-evidence/mvp-screenshots.json) 保存浏览器、Run、源路径、大小、哈希及 `copyVerified=true`。稳定入口包括：

- [团队完整预览](test-evidence/screenshots/team-preview.jpg)、[旧路径方案被拦截](test-evidence/screenshots/invalid-scope-blocked.jpg)。
- [正常 Run 完成及费用](test-evidence/screenshots/normal-completed.jpg)、[正常真实测试](test-evidence/screenshots/normal-native-tests.jpg)、[原员工 README](test-evidence/screenshots/normal-delivery-readme.jpg)。
- [中断前开发完成、QA 待审批](test-evidence/screenshots/before-restart.jpg)、[恢复后真实测试](test-evidence/screenshots/recovery-native-tests.jpg)、[恢复文件与运行说明](test-evidence/screenshots/recovery-delivery-readme.jpg)。
- [最终停止原因](test-evidence/screenshots/recovery-cost-gate.jpg)、[最终费用核对门禁与窄窗口排版](test-evidence/screenshots/recovery-cost-gate-controls.jpg)：最后一图显示两个恢复入口禁用。

截图只说明网页可见状态，不能替代真实命令结果或费用收据。原件保留在工作区 `.data/mvp-evidence/`。

## 启动与用户操作

环境要求和完整说明见 [local-run.md](local-run.md)。首次使用安装项目锁定依赖，再运行 `npm run build` 和 `npm run local`，或双击 `start-local.cmd`。网页默认 `http://127.0.0.1:4310/`，模型计算由配置的 API 服务完成；本机入口不提供模型。

本次代码位于 `C:\Users\JJ\.codex\worktrees\f57c\agent_department`；保留的原主数据位于 `C:\Users\JJ\Desktop\la\agent_department\.data\local`。停止访问原目录的上一套服务后，在本次代码目录启动：

```powershell
npm run local -- '--data-dir=C:\Users\JJ\Desktop\la\agent_department\.data\local'
```

不复制密钥、不手改数据库，原设备和目录授权继续核验；锁会拒绝两套服务同时使用同一数据库。主密钥复制曾被自动审批拒绝，原因为扩大敏感凭据暴露；该路径已弃用，采用上述原目录启动。

用户操作顺序：首页多轮讨论需求并检查最新团队/任务预览 → 明确确认保存 → 打开项目核对具体文件范围、工具与预算 → 批准执行 → 在网页逐次审批实际命令 → 阅读真实结果、文件预览和下载 → 对已停止运行检查中断原因/费用/操作状态，再使用恢复入口。未确认费用需要先在费用页核对；恢复页面不会把不明操作当作安全重跑。

已完成 Todo 可从执行页下载文件并按员工 README 启动：`node server.mjs`；测试命令为 `node --test todo.test.mjs`、`node --test acceptance.test.mjs`。这些操作无需补写交付文件。本次新项目暂时只能领取开发/QA已产生的四个文件，不能把它们称为经理验收完成的最终交付。

## 剩余限制与完成条件

1. 新项目经理验收未完成。必须先取得收据 `f9752aa6-f045-4b96-9edb-43be3087b2ed` 的账单实际输入/输出 Token 及核对依据，完成网页费用核对；不得擅自提高预算、清零或重放。随后仍需在批准边界内完成经理真实验收并保存证据。
2. 正常完成证据来自保留的真实成功 Run，并已用最新网页/原文件复验；这不能替代本次新项目的经理结尾，也不保证任意需求都能自动成功。
3. 本机数据入口与隔离备份采用 PGlite 单后台；多人、独立 PostgreSQL 后端锁竞争、Docker/远程部署不在本轮实测范围。在线备份大小限制及敏感凭据保护继续沿用现有实现。
4. 知识及备份采用小量 fixture，证明授权/版本/恢复路径；本轮真实 Todo 没有授权知识库，因此真实模型在恢复后读取知识的付费场景未验证，不能据数据 fixture 额外声称已通过。
5. 原员工验收报告存在上述文字误差，文件仍保留原始版本；以宿主真实回执和复测为准。产品流程 17/17 的最新回归已完成，模型替身测试仍不能替代经理的真实完成证据。

收尾时再次通过正在运行的产品 API 只读核对：[收尾状态](test-evidence/mvp-handoff-state.json) 保存三个 completed 节点、经理 claimed、18/17 请求与结算、原四文件下载哈希、待核对收据及费用门禁；没有待审批或在途本机操作。命令展示副本只清理行尾空白，精确原始输出字符串仍保存在真实 Run JSON 和原不可变档案。

可启动代码、使用说明、修复清单和现有证据已提供。**只有不明账单完成核对、新经理节点实际完成并补齐对应证据，才可把全部 MVP 验收改为完成。**
