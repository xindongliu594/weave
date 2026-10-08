# 为伍 MVP 验收进度

> 最新进度：2026-10-07 已完成正常交付、受控重启恢复及隔离备份验收；后续首页对话预算变更也已验证。[最终报告](mvp-acceptance-2026-10-07.md)与[使用说明](mvp-windows-quickstart-2026-10-07.md)为当前入口。2026-10-08 继续完善 README 和最终 Harness 架构图，提交前检查单独记录；下文保留完整推进历史。

2026-10-06 11:18：正常 AI 新方案 v7、Go DeepSeek真实 Run `95959d2c-3e0a-491a-9d98-469223fe6f59` 已运行；旧 v5 开发12/12后QA截断失败的证据保留。已修截断错误和任务费用反馈，62/62 + 8/8 + 33/33、类型/构建通过，原数据安全重载后 4310 健康。恢复方案 v6 因模型无效JSON暂留原案；完整QA/经理、同版本受控重启、固定知识引用、新备份仍未通过。[接续点](validation/go-live-stage-2026-10-06.md)。

2026-10-06 10:34：正常 v5 的真实 Go Run `90f0e832-f423-42f3-abc0-c0749a07b90f` 已启动，员工生成三份开发交付物，开发测试待网页审批。首次脚本因审批卡片加载时序中止，0 POST，正在修等待；尚无本次 QA、经理或重启恢复通过证据。[接续记录](validation/go-live-stage-2026-10-06.md)。

2026-10-06 最新：新 Go DeepSeek 的真实文本和工具往返已通过，AI 新方案经网页确认，正常/恢复原项目都为 v5，原总 $10 与未知费用保留。服务 4310 已恢复；Go 员工完整 QA/经理、受控重启与最终新备份仍未验证。[当天接续点](validation/go-live-stage-2026-10-06.md)。

2026-10-05 21:45 当前阶段：用户允许 Go 可用模型替代缺少的 Astra/Sol，由 AI 重规划，原总 $10 / 每路径 $5 / 每日 $20 与未知预留保留。[Go 真实网页配置及目录](test-evidence/opencode-go-web-configuration-2026-10-05T13-29-43-137Z-ada61878.json)通过：新网关 v1，HTTP200/36 模型，含 Luna、无 Astra/Sol，36 项价格缺失；0 推理，旧模型/项目/部门及实际 usage284 的 SHA 不变。现有 Chat 适配正在补 Go Luna 所需 Responses，本阶段尚未重规划、切员工或恢复。[旧正常真实失败](validation/funded-normal-real-failure-2026-10-05.md)及[502 只读诊断](validation/funded-normal-sol-502-diagnosis-2026-10-05T13-29-15Z.md)已落盘，开发2/2、QA首轮502和未知$0.096526已核，账单身份未匹配；完整QA/经理、受控恢复和最终新备份未通过。[当前阶段](validation/funded-acceptance-stage-2026-10-05.md)。下方保留此前状态与证据范围。

2026-10-05 21:23 当前阶段：两份项目已正式网页确认。正常 v2/cap $4.23970 的 Run `8d5b4848-1f57-491f-9647-80ff3ed577af` 已 failed：根代理观测 dev 三文件完成、真实测试 2/2 exit0，首个 Sol QA 请求 502、未知预留 $0.096526；独立 QA/复审/经理尚未通过，终态原始证据正在补齐。恢复项目 v3/cap $4.77489 已完成少量知识授权/检索网页验证，仍 draft、无 Run；员工固定版本引用及受控重启后完成未验证。当前静态服务由根代理报告为 launcher19012/API30276、API59967/web4310，原授权保持。费用观察合计 $1.5967666（配置登记 $0.7399406 + 未知预留 $0.856826），最新账本仍待核对，不代表中转站账单。[当前阶段及证据范围](validation/funded-acceptance-stage-2026-10-05.md)。下方保留所有旧阶段、费用与 PID 历史。

2026-10-05 20:14 最新接续点：已有Node24.19当前保持服务运行。恢复路径真实Astra200返回四节点候选、登记$0.22511，但员工全Astra不符用户分工，尚未确认；已修复提示词歧义（15/15+tsc），待加载后真实修订。首次断线保留未知费并开始新需求的真实网页验证通过，正常cap=$4.23970，恢复下一候选cap=$4.77489；273份usage、两未知预留$0.76030全部保留。生产网页构建通过，正在完成静态模式验证后受控重载；新正式project/run还没有创建。[最新阶段](validation/funded-acceptance-stage-2026-10-05.md)。下方状态与PID均为历史接续记录。

2026-10-05 19:33 最新接续点：追加真实验收已获总$10批准。首页Astra/Luna/Sol明确模型选择已修复；组织规划改为180秒，14/14本地回归、类型检查和构建通过。首轮90秒超时未知预留$0.37821；后续独立请求遇本机启动器异常退出，新增未知预留$0.38209，合计$0.76030，均未结算或清零。两份新正式项目仍未创建，真实员工QA/经理和本阶段重启完成路径仍未验证。当前4310服务在稳定性排查期间已停止，正在进行零费用Node版本/启动器诊断。原v6、272份usage和交付文件保留。[本阶段记录](validation/funded-acceptance-stage-2026-10-05.md)。下方所有运行与服务PID为历史状态，不能当作当前状态。

更新：2026-10-03（Asia/Shanghai）。基线：GitHub `origin/main` 的 `0befc094953880b6b3ede88506f6fa3e41088e85`。本工作区验收分支：`codex/weiwu-mvp-validation`。

2026-10-05 最新接续点：见 [当天验收续报](mvp-acceptance-2026-10-05.md) 和 [上下文、恢复与并发阶段](validation/context-recovery-stage-2026-10-05.md)。个人中转站 v6 开发已完成，真实独立 QA/复审/经理及本轮受控恢复完成仍未通过；零费用新恢复预检已具体证明四完整文件路径受原余额阻断。当前服务 4310、API PID 46548、launcher 44216，0 active runs，原数据和费用不变。相关运行器86/86、隔离操作并发7/7、tsc/Vite通过；不得当真实模型验收。下方历史阶段与其原证据保留。

## 已保留的成果

- 更新前工作区无未提交修改；主检出源码、已有业务记录、凭据及员工交付文件保留。本轮在原数据目录通过产品流程新增运行及审批记录，没有重置或覆盖恢复。
- 新版已有 Windows `start-local.cmd` / 持久 PGlite、本机命令逐次审批、多轮组织对话、完整 DAG 检查点恢复及版本化知识。
- 已复验原始 Todo 完成记录：项目 `782ecdd3-8235-4c32-95b8-d6f3fd1cabe3`，运行 `99551bf3-94f0-464a-8cd7-6935ad679ab8`。原档案、5 个员工交付文件与镜像哈希一致；最新网页和原文件实际 CLI/HTTP 复测通过。
- 此前失败项目、费用待核对记录及失败交付保留，不算成功证据。

## 按优先级执行的清单

| 优先级 | 项目 | 当前状态 | 所需证据 |
|---|---|---|---|
| P0 | 最新源码本机启动与主流程回归 | 通过 | `local:check`、相关本地测试、最终类型检查与构建；[日志](validation/) |
| P0 | 多轮需求、方案修改、失败状态、确认后创建 | 通过 | 真实网页 4 轮；确认前部门/项目 1/5，确认后 2/6；[截图](test-evidence/mvp-screenshots.json) |
| P0 | 真实 Todo 开发、独立测试、经理验收 | 既有正常完成通过；新项目经理受阻 | 原 Run 三节点与 45 次真实请求/结算、5 文件；新 Run 经理调用不明，待账单核对 |
| P0 | 受控中断及服务重启恢复 | 恢复机制通过；新最终交付受阻 | 父/子 Run 完整 DAG、完成开发不重复、4 个文件版本、预算调用继承、真实 QA 续跑；[6 项审计](test-evidence/mvp-recovery-2026-10-02.json) |
| P1 | 未知外部操作与费用不得盲目重放 | 保护行为通过；一笔真实对账受阻 | 回执及费用负面测试，两个恢复按钮实际禁用；未重发或清零 |
| P1 | 知识授权、检索、固定版本、恢复引用 | 通过（隔离资料） | 真实产品 API、授权拒绝、v2 更新仍固定 v1、恢复与再重启引用；[数据证据](test-evidence/mvp-data-2026-10-02.json) |
| P1 | 隔离备份恢复 | 通过（隔离资料） | 三个进程、源/目标独立目录、错误口令拒绝、关键数据/DAG/文件哈希一致 |
| P2 | 当前节点、员工、审批、费用、失败、恢复、交付入口 | 主流程通过 | IAB 实际操作、下载原文件哈希一致、预览及真实测试输出、修后费用门禁截图 |
| P2 | 简明启动说明、修复清单、验收报告与限制 | 已交付当前版本；整体验收未完成 | [使用说明](mvp-quickstart.md)、[修复清单](mvp-fixed-issues.md)、[验收报告](mvp-acceptance-2026-10-02.md) |

## 约束与继续位置

- 不由 Codex 编写或修补员工 Todo 交付物；所有付费验证沿用现有预算和权限。
- 数据实验使用隔离目录，不恢复覆盖正常 `.data/local`；不输出明文凭据。
- 原始数据位置：`C:/Users/JJ/Desktop/la/agent_department/.data/local`。
- Tabbit 稳定入口诊断及列表均无输出并退出，浏览器连接受阻；继续完成本地与 API 工作，使用可用浏览器验证时记录实际后端。
- 当前继续点：供应方确认 `f9752aa6-f045-4b96-9edb-43be3087b2ed` 的输入/输出 Token 与核对依据后，在网页记录实际用量，再从 `c9b1f703-b2a6-4bf0-8318-ad2b15ce911e` 恢复经理节点。没有账单不能继续模型调用；已有三完成节点、文件、费用、调用记录保留。

## 第一阶段验证结果

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- Vite 构建：通过（1,674 模块）。Windows 沙箱首次限制 esbuild 读取父目录，使用正常权限后通过；根依赖安装尚在执行，未将安装中缺失 `.bin/tsc` 归因源码缺陷。
- 规则检查：29/29；非 Docker 运行时：72/72。
- 组织对话 API：11/11；同团队方案更新：7/7；真实 API/DSH、本机命令与恢复本地集成：17/17。此组模型均为固定协议服务，不作为真实模型验收。
- `local:check`：本机实际文件/命令、审批、重启持久化以及显式停用不会被启动重新授权，全部通过。
- 原始真实 Todo 完成档案重新核对：完整性 `ok`，3 个节点完成，45 次真实模型请求及结算，$0.0654913。5 份交付文件与工作区、封存镜像及宿主哈希一致。
- 员工原始 `todo.test.mjs` 和 `acceptance.test.mjs` 独立复测 2/2 通过（含 Windows CLI 和真实 HTTP）；未修改员工交付。
- 证据：`.data/mvp-evidence/preserved-real-todo.json`、`.data/mvp-evidence/preserved-todo-tests.txt`。
- 网页真实多轮对话第一轮自然澄清，第二轮生成资料不完整并保留回复/明确失败提示；两轮后部门仍 1 个、项目仍 5 个，没有未确认创建。第三轮请求精简完整候选，继续验证。
- 浏览器实际使用 Codex 内置浏览器（IAB）；Tabbit 不可用。前次进度提到 Chrome 是候选，实际后端以此为准。
- 自动审批拒绝复制已有凭据主密钥到隔离目录（风险为扩大敏感凭据暴露）。已停止该路径，直接沿用原本机工作台与原目录凭据，不复制或重新录入。

## 第二阶段：真实网页及阻断修复

- 在可用 IAB 中完成 4 轮真实需求对话：自然澄清 → 不完整候选失败 → 精简完整候选 → 修改部门名称和开发岗位。确认前没有创建；点击确认后新增一部门、一项目，再进入执行方案。项目 `9975fd32-a91a-4081-90c5-21159c51a1a4`。
- 原始方案把 inScope/outOfScope 填成自然语言，旧校验放行后，真实 Run `a79b1893-3c69-43f2-8439-094593148e82` 被文件权限门禁拒绝，5 次调用、$0.0040931；零交付，不计成功。
- 修复共享文件合同校验：输出必须落在允许路径中且不在禁止路径中；组织提示词及 Schema 明确路径语义。网页为 verification/work 等有输出的任务提供范围编辑。最新网页已实际拦住旧方案，全部错误可见且运行按钮禁用。
- 通过网页仅修正文件范围，保存 v3；保持 $0.48、80 次总调用、35 次默认任务调用、单并发及逐次命令审批。旧失败费用保留。新真实 Run `1cc083f3-1ca0-4eec-8230-29a2fe7617f3` 已完成开发节点；单元测试首次失败后由员工自行修改，再次实际测试通过。Codex 未编辑员工交付物。
- 直接使用最新分支及 `--data-dir` 重启原目录；设备 ID 和 grant ID 与原环境相同，无密钥复制或权限重新授予。服务地址仍为 `http://127.0.0.1:4310/`。
- 修复 Windows 回执短暂占用时的原子重命名：只有限重试保存回执，不重放底层操作；持久失败仍保留 executing 状态并拒绝重放。7/7 本机执行测试通过，含丢失回执和进程重启、短暂/永久锁定。
- 网页状态/费用/范围编辑 10/10，启动参数 5/5，共享规则 30/30，组织对话 11/11、方案更新 7/7、产品流程 17/17。标准 `npm run build` 通过（1,676 模块）。根依赖锁定安装完成，39 分钟主要耗于 ONNX 包下载；运行时依赖安装完成。
- 隔离知识/备份/恢复验证已通过：3 个真实 PGlite 进程，授权过滤、v2 更新后仍固定 v1、恢复引用、错误口令拒绝、完整 DAG/合成用量及文件哈希保留；原数据未打开，0 付费模型调用。证据 `docs/test-evidence/mvp-data-2026-10-02.json`；不能当作真实模型执行证据。
- 真实恢复继续点：等待 QA 测试命令未批准、所有模型费用落账、无 queued/claimed/started 本机操作；保存受控中断前证据，再终止 API、重启，并在网页恢复。

## 第三阶段：受控恢复、真实续跑与收尾

- 父 Run `1cc083f3-1ca0-4eec-8230-29a2fe7617f3`：开发 completed、QA 等待审批；25 次请求/25 次结算、$0.0243660，无在途本机操作。保存现场，停止 API 后用原目录重启；状态 interrupted，调用、费用及四文件哈希一致，旧审批取消。
- 网页恢复创建子 Run `c9b1f703-b2a6-4bf0-8318-ad2b15ce911e`。完整四节点 DAG、25 次历史调用和每任务费用继承；开发新增调用为 0；四文件精确恢复。QA verification 实际 1/1；QA review 实际复验 2/2 + 1/1、verdict=pass。恢复机制审计 6/6 通过。
- 子 Run 新请求 18 次、已结算 17 次、已知新费用 $0.0187921；新项目累计已知 $0.0486989。经理于批准的 1800 秒期限中断，最后状态 failed、经理节点 claimed；不把前三节点完成当成全项目完成。
- 不明模型收据 `f9752aa6-f045-4b96-9edb-43be3087b2ed`：`gpt-6-luna`、北京时间 2026-10-02 23:22:40–23:22:50、`CALL_INTERRUPTED`、`dispatched=true`、预留 $0.0102812。已向用户请求供应方账单的输入/输出 Token 和依据，尚未取得；没有清零、再次发送或扩大预算。新项目经理真实验收因此受阻。
- 修复网页读取缓存/超时、串行轮询及事件去重、审批与附件刷新、历史审批折叠、真实测试回执展示、停止时员工状态和费用阻止恢复。最终浏览器读取员工 README 成功、刷新按钮恢复可用、没有新 console error/warn；两个恢复按钮仍禁用。较窄桌面窗口的恢复提示与按钮排版已修正并截图。
- 当前最终构建、类型检查及 diff 检查通过。Portable runtime 74/74；网页/启动 18/18；规则 30/30；native 回执 7/7；费用 5/5；deadline/adapter 7/7；`local:check` 通过。最后一次产品流程 17/17、0 失败/0 跳过、退出码 0；[完整输出](validation/product-flow.txt)包含 UTC 起止时间，墙钟 154.649 秒。模型替身用于本地回归，实际 API/DSH 和本机命令执行；不替代付费业务证据。
- 归档了 10 张实际网页截图、5 份真实运行状态和合同/调用/费用/文件元数据、11 份原生测试回执（含失败与员工复测）。[截图清单](test-evidence/mvp-screenshots.json)、[真实运行汇总](test-evidence/mvp-real-runs.json)、[实际命令输出](validation/real-todo-native-tests.txt)、[原文件独立复测](validation/preserved-todo-tests.txt)。员工交付写入数为 0；归档复制没有派发模型或修改用户数据。
- 可运行代码和简明说明已完成，原服务仍在 `http://127.0.0.1:4310/`。整体验收尚未完成：实际费用对账与新经理完成后，还须补齐最终 Run 和交付证据。
- [最终只读收尾状态](test-evidence/mvp-handoff-state.json)：三个已完成节点、一个经理待完成节点、无待审批或在途本机操作；真实待核对模型收据仍保留，四文件下载哈希再次通过。原始输出字符串保留在 Run JSON，命令展示副本仅清理行尾空白。
# 2026-10-05 18:12 继续点：规划候选已验证，追加真实验收已获预算批准

- 项目规划同源费用 GET、候选生成、明确确认保存及完整历史来源已完成。API 47 pass/2 skipped、历史 11/11、网页相关 54/54、构建和实际 Edge 通过；固定协议替身不计真实验收。[阶段报告](validation/project-planning-candidate-stage-2026-10-05.md)。
- 当前服务 launcher 28380、API 12040、port 61369，网页 4310。原项目 v6/$0.48、272 usage、21 calls、dev 完成和四文件 SHA 不变。本阶段 0 真模型请求；旧服务 PID 记录保留。
- 用户明确回复“批准新增总上限 $10”：两份新验收项目各最高 $5，含真实 Astra 规划/Luna/Sol 执行，原每日 $20 与命令审批规则不变，旧项目/未知预留不变。[批准与具体方案](validation/real-acceptance-budget-proposal-2026-10-05.md)。
- 下一步优先修复首页允许员工模型选择（原仅隐式允许规划模型），随后通过网页进行真实候选确认、正常完成与受控中断恢复；尚未创建这两份新项目。开发文件/独立测试/经理报告必须由员工生成。


2026-10-06 12:34：当前 Go 正常 v8 的开发和独立QA均已实际7/7 accepted；复审启动被内部15秒status截止与27秒冷恢复冲突中断，经理未执行。正在本地修复status生命周期和24次已占用尝试/23条wire的恢复计数；上限、已完成节点、旧unknown预留和员工文件保留。阶段证据见 docs/validation/go-v8-review-dispatch-stage-2026-10-06.md。受控恢复、知识版本及新成果备份尚未通过。

2026-10-06 13:31：Go同v8真实恢复f0f68b82已completed，继承24调用最终42，dev/qa_verify新wire0、四文件SHA不变；复审两测试7/7，员工经理报告12475字节PASS。原字节证据go-normal-v8-resumed-20261006-131623-7dfd8f29，新版网页只读inspect05-21-07-058Z-732598e5。完整不中断正常v9已启动1e91d7d2，开发3/3 accepted、QA正在生成；AI重分配预算，原cap4.1797及总10不变。受控恢复方案v8候选已生成，正在缓存确认；尚未做受控停服/知识v2/新backup，不能把同v8修复续跑代替全部验收。

2026-10-06 13:54：正常v9 Run1e91d7d2开发/独立QA均3/3 accepted，但复审最后CLI回执未确认，3941events终态failed/OUTCOME_UNKNOWN；native op2982099d cancelled已有真实lateResult.ok=true/exit0，禁止直接重放。原字节证据 go-normal-v9-outcome-unknown-20261006-135406-aeb07003，正定位signal/lease/回执时序并在源端安全处理。费用/原产物/两完成节点保留；这轮不中断正常仍未通过。恢复v8已确认、未运行；知识和backup仍待完成。

## 2026-10-06 14:44（北京时间）：修复加载后正常路径 v10

已加载已开始操作的心跳修复；18/18 本地回归及类型检查通过。AI 经网页重新生成并确认正常 v10，项目费用上限仍为 4.17970 美元；全阶段新增上限 10 美元不变。唯一批准创建 Run 17af4ec6-379e-47bc-9b6b-0afd16d49869，全新工作区。只读实际回执：开发 6/6、exit0，独立 QA 执行中；复审和经理尚未验收，不提前计为通过。旧 v9 OUTCOME_UNKNOWN 与迟到成功原样保留，未重放。根代理同步整理交付文档，恢复 v8、知识新旧版本和最新隔离备份仍待执行。

证据：docs/test-evidence/go-heartbeat-normal-generate-2026-10-06T06-31-05-736Z-a029de67.json；go-heartbeat-normal-confirm-2026-10-06T06-32-35-063Z-4926d956.json；funded-run-web-normal-approve-2026-10-06T06-33-37-751Z-986d6325.json；go-normal-v10-watch-2026-10-06T06-39-19-845Z-51bc751f.json。


## 2026-10-06 14:58：v10 实际失败与备份守卫窄修复

Run17af4ec6-379e-47bc-9b6b-0afd16d49869 开发6/6、QA重验6/6与独立CLI4/4真实exit0；复审第二审批d51504e5-dafa-4acd-be11-84a1e9f4cc56唯一POST200，随后只读/runs确认statusfailed、events3047、设备离线。web4310与API62701 health200、原36612/47856进程仍存活；正在核对第一次错误的实际stage，不能按观测失败推断原因或重放命令。经理未完成。原失败和迟到结果保留。

备份验证器新增显式loopback-fetch模式，仅在新execution副本使用；原默认和restore worker仍拒模型fetch。实际本地12/12回归，script新SHA d244812c9139e4df270f1f37cf49a2f1f56540c4f62fdb9b9747128709e6a163，报告docs/validation/full-offline-backup-loopback-fetch-2026-10-06.md；未进行本轮真实备份。


## 2026-10-06 15:47：准入修复已加载，准备正常v11

同一次准入最多10秒等待真实认证心跳，事务rollback/release后重查全部硬门禁；caller signal贯通，模型reservation/wire和本机enqueue/start不重复。局部61PASS/2既有PG锁SKIP、tsc0，冻结docs/validation/local-device-admission-2026-10-06-sourceSHA.json。原服务PID47856/36612已异常消失而标记尚在，原因未验证；初次启动参数在开库前被拒记录保留，修正后由正式入口处理stale owner并成功恢复。没有Root手删标记或改DB。

新launcher48320/API32792/internal63555/web4310。440usage与原v10 raw完全一致，原费用/预留一致，无activeRun或modelautoResume；完整startup证明docs/test-evidence/go-unclean-service-corrected-start-20261006-154414-a9fa9ba3.json。本次不是受控重启验收。已给独占操作agent加载signal，只执行新正常v11一条付费链，旧v10.failed保持；恢复v8、知识v2和最终backup尚待实际完成。


2026-10-06 17:20：停止验收脚本修正及最终失败记录
- Recovery v8 run c92961f2-5573-4299-82c2-daa7ee13dca5 因已批准3600秒时限失败，四次验收停止尝试均0 POST，不能算受控中断成功。最终原始14份GET、完整6800事件、4员工文件及SHA已保存；18 request/wire/usage/host调用一致；开发3/3通过，QA及经理未完成。
- 新 generic first-parent stop 工具真实离线浏览器6/6通过，包括25秒前置检查不提前关闭、唯一停止POST/202和结果未知拒重放；仍需真实中转站重启续跑验收。
- 使用精确PID/启动时间/原数据目录守卫安全重启，加载冻结 planning parser修复。459条用量、项目和运行metadata保持，未新增模型调用、未清未知费用。加载证明：docs/test-evidence/go-planning-parser-loaded-2026-10-06.json。
- normal_operator 开始NEW正常路径v11生成，使用既有新增总上限10美元/每场景5美元/每日20美元；旧失败、未知占用和员工文件完整保留。

2026-10-06 17:52：正常v11真实运行与两项实际问题
- NEW网页guarded审批202/1POST，normal v11 Run9878e368-9ebe-443d-8c2f-59ba3e5b4274开始员工执行；旧0POST和永久意图保持，当前尚未整项验收。
- 运行列表缓存10PASS/tsc0已精确idle加载。原26条同字节SHA目录，3次耗时4510/4508/4476ms变为71/23/30ms；461用量与项目/Run metadata重启前后保持。报告 docs/validation/go-run-list-cache-live-2026-10-06.md。
- Recovery9真实生成确认保留；复审预算.11低于已知同类.1151883/.1273356，新增真实Token/费用反馈拟交AI重新分配。Recovery10生成尝试0POST/0新费用，长GET quote16572bytes超过Node16KiB，实际431空响应已抓；正在本地实现RO POST正文预检，不截断需求或增额度，当前不重启运行中的normal。

2026-10-06 18:00：真实交接发现producer输入错误
- Normal11 Run9878e368-9ebe-443d-8c2f-59ba3e5b4274已failed，1022连续事件/两真实开发终端/三员工文件均封存。首测试12中11pass1fail由员工自行修正，随后12/12exit0、accepted975；Codex未改员工文件。
- AI新候选把旧v10 SHA贴到新的producer输入，宿主在QA前正确VERSION_MISMATCH；QA/复审/经理未通过。调用11 admission/request vs9 wire/usage差额保留，child真实已记录.0773679，旧unknown.096526保持。
- 本地改动正在把producer+固定旧SHA提前在方案合同校验拒绝，并让后续AI生成新方案；旧Run/候选/文件不strip、不提升成功、不重放。
- quote合法3840中文说明真实HTTP431根因已抓，RO POST正文修复及隔离proxy/API测试正在进行。normal12与recovery10后续均需修复实际加载及NEW明确quote守卫才能发起。

证据更正：recovery10的0POST/GET431报告仅记录计算出来的claimPath，实际该路径ENOENT，未到generate POST route创建wx。未创建、删除或覆盖该路径，不把计算路径当永久意图实证。recovery9生成/确认、normal11原启动及实际successor的现存意图继续完整保留。

2026-10-06 18:30：修复加载与预检脚本第二阶段
- quote POST/未知mutation身份保护90PASS、producer新方案校验24PASS；正式Node24.19类型与Vite构建exit0（1688 modules，531.81KB bundle提示保留）。精确idle重启API43528/launcher10676，470usage、所有已存项目字段与Run metadata保持；derived validation由新冻结规则独立重算，旧错误plan未手改。
- 实际原3840中文说明 readonly quote POST200/allowedtrue，前后usage/projects/runs原bytes相同，0新模型调用。证据 go-long-quote-post-actual-2026-10-06.json。
- normal12启动脚本8865已终态0paid；首quote200，生成前正常第二次只读重核被脚本single-quote限制误拒，没有发出模型请求，新增费用0，仍v11。此前“等待模型”表述已纠正。报告 go-normal-v12-two-quote-block-2026-10-06.json；计算paidclaim路径实际ENOENT，未创建/删除。
- 接续：normal_operator 准备共享两阶段只读quote守卫和两NEW wrapper，先测试实际client/HTTP流程及双raw保存/变化0paid/未知不重放，Root再授权真实normal12；recovery10等待正常路径，无付费重叠。device_admission准备源码副本inventory/copy工具；最新受控恢复、知识v2与备份仍未实测。

## 2026-10-06 19:03 源证据阶段记录

正常 v12 Run `566c813d-6fc9-409a-b945-ec9d5afea4fe` 正在 qa_verify；开发真实 9/9 exit0 已 accepted726，QA 首次独立 11/10/1 exit1 保留，员工自己修正后 acceptance 最新 exit0，尚无 QA accepted、review 或经理通过证据。19:03:40 的已保存 watch 记录无待审批、无活动本机操作，1 个在途模型预留；此为阶段帧，不算完整验收。原未知费用继续保留。README 中宽泛停止全部 Node 的建议已记录问题，未执行、未由 Root 代写。

DSH/AgentTeams 已有停止与会话/团队恢复能力；具体适配问题、已修工程故障和仍缺受控服务重启验收范围见 `docs/validation/dsh-stop-resume-boundary-2026-10-06.md`。本次仅代码/文档核对与阶段保存，没有新增付费调用、审批或服务停止。

## 2026-10-06 19:20 租约中断与隔离修复

v12真实终态 interrupted：开发accepted726、QAaccepted2720，最终9/9与11/11；复审尚无wire即LEASE_LOST，经理未执行。完整2867事件、4员工文件、25wire/usage与26宿主调用封存并独立审核，旧unknown .096526保留。原API/launcher未重启，不能标受控恢复。

追加档案每条全读的性能修复44/44相关回归通过；相同封存副本旧40事件15.53秒、新76.6毫秒，所有fsync/完整严格读取保留。own-active租约回收故障已离线复现，单独修复测试中。此时生产尚未加载新修复，无恢复或新增付费动作。

## 2026-10-06 19:40 修复实际加载

档案/原生45项与租约/状态/设备竞争30项全部通过；统一Node24.19 tsc及生产build exit0。精确停止原ownedAPI43528/launcher10676后启动新API47712/launcher49916，原数据目录保持；readonly post-reload逐项核对496usage、项目和运行metadata原样，费用和权限不清除，不自动恢复。证明见 `go-owned-service-20261006-193931-6918e570.json` 与 `go-idle-reload-verified-2026-10-06T11-39-52-339Z-1076fcdc/sources.json`。

Root授权normal_operator NEW normal13 helper一次真实生成/缓存确认/首次批准及同Run字面测试审批，AI重估预算并由员工自行纠正README停止说明；恢复项目不并行付费。旧v12终态、调用占用及原始文件继续保留，当前仍未满足完整正常/受控恢复/最新备份验收。

## 2026-10-06 19:48 已知规划结构失败

normal13尝试两次readonly quote200、fresh globalpending0、唯一paidPOST后返回422 PLANNING_SCHEMA_INVALID。provider200/finishstop，10559输入、3534输出、$0.0074085已结算并封存。原正式v12及全部Run字节不变，未确认、未审批、不重放旧key。具体失败字段无法从旧诊断还原，因为safeParse后parsed.error被丢弃；当前补安全schema路径/约束诊断，保留原输出hash和费用，不输出模型全文或秘密值。详细封存 `docs/validation/go-normal-v13-schema-rejection-2026-10-06.json`，本次不能标实际正常验收成功。

## 2026-10-06 20:12 真实恢复父 Run 已停止

Go真实生成恢复v10合法方案并缓存确认（确认不新增推理）；AI额度dev .18/QA .30/review .28/manager .15。真实首次批准Run `0453cd06-caf6-4fee-91f3-cccb55340a68`，开发6/6 exit0 accepted1102。首QA命令0894126e等待审批且未执行时，实际网页唯一停止POST返回202，Run最终cancelled/integrityok/2432events。完整停止前后raw保留，原stop报告因costs派生运行预留下降而unverified：差额4.150841恰为executionBudget4.3012943-本Run已用.1504533；正在独立核对其余所有账单/操作/文件/调用，并补精确投影验证，不重发停止或豁免真实费用变化。

实际IAB已确认页面显示已取消、停止时QA节点、开发通过、本机回执/四文件/知识v1与恢复入口，截图及完整AX已保存。网页已点击只读恢复条件检查，未恢复。知识catalog尚未更新v2、尚未服务重启和同版续跑，不算完整恢复验收。安全结构诊断66/66、统一types/build0已完成，待此受控服务重启一起加载。

## 2026-10-06 20:34 受控停止验证闭合，知识升级入口检查

独立98项全量原件审计和NEW只读release reconciliation均已验证唯一POST202与取消终态，完整调用/账单/原文件/知识v1不变，准确计算global+本部门活动Run预留释放4.150841。原unverified报告保留；NEW报告 `go-controlled-stop-release-reconciled-2026-10-06T12-33-29-183Z-be369391.json`，不重放原stop意图。真实恢复条件页面通过：1完成节点、18/100已用、82剩余、$4.150841净可用；图 `screenshots/go-recovery-v10-web-recovery-check-2026-10-06.jpg`。恢复员工README实际只给同窗Ctrl+C，原bytes不改。

NEW知识升级入口第一次启动exit1，只有安全preflight generic输出，无结果report；当前device_admission仅用实际immutable输入定位，不自动重试。知识v2、停止后的服务重启、同版续跑仍未完成。66项安全规划字段诊断已通过并完成正式types/build0，待该受控服务重启加载。Goal继续保持完整六项，尚未标MVP完成。

## 2026-10-07 实际推进

- 原服务退出，使用现有启动器恢复原数据目录；健康接口200、原516条用量、项目/费用保留。
- 复用已安装官方 session-checkpoint-policy 0.1.5-rc.1，在会话所属 EmployeeHost 挂载；35/35回归、类型检查0、构建0（首次沙箱目录权限失败保留，授权构建成功）。无需升级依赖。
- Cua网页实际更新共享/QA私有两测试资料为v2；原v1历史/PIN、父Run2432事件、18调用、费用/文件/授权不变，独立188次SHA绑定审核通过。证据：docs/test-evidence/go-knowledge-manual-2026-10-07-2da72e92/result.json。
- 受控重启原本机服务，launcher40800/API50380，源数据锁自然关闭；重启后原档案与v1历史/当前v2验证通过。proof：go-owned-service-20261007-094835-cfc82f9b.json。
- Cua网页同v10续跑唯一child559a026b-804c-48ab-b343-9ec2ed102b15（parent0453cd06-caf6-4fee-91f3-cccb55340a68）。保留dev完成节点，正在真实QA自行修复/复测；所有新命令逐条网页审批。尚未QA/复核/经理全部完成，不记总验收通过。
- 现有知识验收NEW脚本正文exact label定位错误已最小修复，真实React textarea离线DOM2/2通过；原永久wx意图和0PUT失败证据全部保留，本轮实际更新使用Cua而非重放旧CLI。

- 受控续跑child559a终态failed（3193事件）；开发零重复，目录v2下员工实际v1引用与累计33调用验证通过。QA最终6/6、8/8，但误用合同alias提交后又受上下文预算拦截，无accepted seal、经理未执行；独立partial审核保留所有失败。
- 上下文最小修复69PASS/types0、独立审核通过；实际失败请求本地预览92403B/$0.0400281，output10000不变，0wire；未加载/真实续跑未验证。
- 正常路径首个新候选被AI错误路由/预算/自引用校验拒绝，已网页丢弃且费用保留。用现有模型范围页面收窄为Go-only保存v13（原AI计划未手改），再次真实生成并确认AI候选为v14，所有模型Go、任务预算AI分配0.60/0.70/0.40/0.35，净可用2.0621962，原unknown.096526保留；尚未启动。证据go-normal14-cua-2026-10-07/result.json。

### 2026-10-07 11:15 实际进度
正常v14 Run 88aa22a9-f887-467c-bf12-91bb57d42361 已完成：7011事件、46真实模型调用、四节点接受，员工五文件完整，开发12/12、QA与复核均12/12+8/8 exit0，旧dev失败保留。本次已登记执行费用0.5079759 USD，原未知预留0.096526不清零。完整raw位于 docs/test-evidence/go-normal-v14-completed-2026-10-07；独立审核中。网页结果显示旧captain站退回复而与实际经理acceptance相冲突，最小UI修复中，未宣称该UI已通过。恢复项目Go-only范围v11已网页保存，两份旧验收资料网页升v3，历史v1/v2和权限保留；AI新方案费用只读预检中，受控最终恢复尚未完成。

### 2026-10-07 11:32 可继续检查点
正常v14独立审核确认真实任务与文件链通过（docs/validation/go-normal-v14-real-acceptance-audit-2026-10-07.json），网页经理结果已修复且实际截图正确，README网页下载SHA吻合。项目列表把已完成错误标为待完善方案（剩余预算不足再执行造成validation invalid），另修复中；不能把重跑费用检查当运行生命周期。文件版本编号已统一至既有本机确定排序，15回归与类型0，旧四文件同内容但legacy locale编号不同事实保留。干净原服务PID36632/API48064，准确停服重启与585usage/全部projects/runMetadata不变已核验，source加载proof见phase。恢复项目两次AI候选QA .32不符实际费用余量已丢弃未保存；请求完整传递已独立本地核对，无虚构prompt根因。短请求按两轮真实费用+下一完整请求最低余量.6185916要求AI自主重新分配，仍在原3.8982893净余额内；本轮真实生成尚未dispatch。

### 2026-10-07 12:02 新受控路径继续执行
恢复正式v12由AI原样生成确认：任务上限dev.15、QA.72、复核.17、经理.13，原cap4.77489不变。父e789b929-6d6c-4b08-8ff0-d560e69bbc78开发6/6接受703，QA已写部分文件但测试命令未执行时一次网页停止；cancelled1391/17calls/4files完整、无未知操作，before顺序GET按event前缀核对。两知识目录3→4、历史与权限保留；原服务受控47436/API30260重启后603usage/全部项目与运行元数据不变，父档案SHA原样/固定pin3。阶段独立审核partial报告已保存。一次网页同版恢复创建child6e860c3c-113c-4245-b400-df85b950769e（控制通道超时但只读确认唯一新child，未重放）；继承dev/checkpoint、17calls和3.7488539预算，QA新attempt真实两测试审批已给，最终仍待运行完成。正常最新63回归UI构建已fresh浏览器核实经理结果6999及同页项目列表显示已完成，原协调回复折叠保留。完整最新备份和源码包尚未执行。

### 2026-10-07T05:20:45.255Z 最终交付闭合
正常 v14 Run 88aa22a9-f887-467c-bf12-91bb57d42361 与受控 v12 子 Run 6e860c3c-113c-4245-b400-df85b950769e 已完成并独立审核，真实测试全部退出0，父开发零重复，知识 pin3 在目录v4/重启后继续引用。最新全量备份隔离恢复通过：1963文件/752356226字节/34表/637用量/十交付文件SHA；原环境不覆盖。原4310工作台正常，无运行自动重放。交付源码373文件/4744460字节精确复制；默认Node24.15固定锁依赖安装、类型+生产构建及新数据4323实际启动/准确关闭均通过，0付费调用。检查脚本空数组误计原失败记录保留，补核未重启。源码ZIP逐条往返SHA核对375条；实际位置见 docs/mvp-delivery-2026-10-07.json。原始卷宗与数据另保留，不随公开源码带出Key。费用未知预留、员工报告表述错误、非OS沙箱和跨机迁移未验证详见最终报告，均未伪装通过。

### 2026-10-07T06:07:35.244Z 用户追加：首页对话不占执行预算
已加载新需求对话专用用量记录模式，无估算/预留/单次或每日预算拦截；新方案不adopt聊天费用进执行项目，旧历史保持。费用/对话/会话兼容/旧更新43项与网页31项，共74个不同测试通过，types/build0。原服务3452/API29692健康，637usage、项目、Run与旧费用不变，新dialog0实际wire。浏览器验证费用输入已移除、执行预算标签与两费用分栏。新源码377文件/4782705字节及ZIP往返SHA通过，旧ZIP保留，见conversation-budget-update-delivery-2026-10-07.json。
