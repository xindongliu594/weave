# 原生插件接入：实现与验收记录

本轮将原版 DSH 工具型插件接入了为伍的员工授权、任务版本、OpenShell 和交付记录。新版已部署 JJ。**组件验证通过；真实模型员工验收与完整网页操作验收仍未完成。** 不将组件脚本生成的文件算作员工业务交付。

## 已实现与实际复用

- 固定 DSH 0.1.5-rc.1 / Cordis 原生 `tools.register`、`schemas`、`execute`、`restrict`、`guard`。原有八工具固定名单扩展为受安装目录约束的命名空间工具；同名定义被替换、伪用员工身份、后注册或作用域工具均不能扩大原授权。
- 复用原版 **@huiliyi37/dsh-office@0.2.4**，未重写或修改 DOCX、XLSX、PPTX 业务实现。使用已核对原安装产物与 esbuild 形成沙箱入口；原插件在沙箱内的 DSH Context 中注册和执行，API 不导入其业务代码。
- 目录保存来源、版本、配置、依赖锁摘要、原生参数 schema、文件效果和安装包摘要。任务批准绑定实际版本，升级只影响新快照；旧版本丢失、损坏、撤权会拒绝执行。坏包仍可停用，不阻断其他命名空间。
- 员工的 `capability_search` 从获授权的 DSH schemas 中发现原生工具。公司 Skill 继续走已有 DSH Skill provider；没有新增第二套技能执行引擎。
- OpenShell 继续使用固定 Node 24.19 镜像、UID/GID 1000、1 CPU、512 MiB、原网络隔离与审批。文件工具额外使用 Node 权限与本次调用文件副本；检查声明的产物后才发布到项目目录。插件无法借文件通配符、目录授权或写权限改动其他任务原文件。
- 调用复用既有操作日志、结果未知禁止重放、workspaceRevision、HandoffGate、二进制 SHA256 与交付列表。临时运行目录在调用结束时移除；失败保留审计。
- 网页增加已安装插件的启用/停用、来源版本与错误状态；部门员工和项目策略从目录读取可授权工具。原工具与 MCP、公司 Skill 的现有权限保持。
- 备份包含当前及历史快照引用的原版安装包；隔离恢复验证保留两个版本，原目录未覆盖。恢复后的插件授权默认停用。

## 实测证据

| 验证 | 结果 | 证据与限制 |
|---|---|---|
| 员工 Host、Skill、发现与文件边界 | 11/11 通过 | `host-tests.txt`；本地工程测试，0 模型 |
| 安装目录、绑定、撤权、篡改与隔离恢复 | 6/6 通过 | `catalog-tests.txt`；含本机目录映射回归 |
| 需求规划、备份扩展、本机操作生命周期接口 | 27/27 通过 | `api-tests.txt`；隔离 PGlite、测试模型响应，不作真实模型验收 |
| 规划目录只包含获授权工具 | 20/20 需求对话回归通过 | `selected-tools-api-tests.txt`；目录收窄后重新通过类型检查；真实规划前报价见 `real-readiness.json` |
| 既有 OpenShell 执行器回归 | 23/23 通过 | `openshell-tests.txt`；输送层 fixture，真实沙箱另列 |
| 原版插件 + EmployeeHostFactory + HandoffGate | 7 次调用、5 项检查通过 | 运行 `6488ee7b-6608-4b4b-a79b-5fae17bf7575`；文件封存、授权发现、拒绝写入、Host 重开、独立 OOXML 检查 |
| JJ 真实 OpenShell | 7 次调用通过 | 运行 `e7b66fcc-7bb7-42bf-ab37-551a5c323ba1`；三种文件生成与回读、不同执行器进程续读、同沙箱/版本、拒绝重复操作、独立 OOXML 检查 |
| JJ 测试资源回收 | 通过 | 两次测试沙箱均有明确回收回执；失败与成功文件仍保留在各自 validation 目录 |
| TypeScript / Vite | 通过 | 构建保留已有大 chunk 警告；无构建错误 |
| 新版生产启动 | 通过 | `deployment.json`；数据库 connected、插件 available，安装后默认未启用 |
| 浏览器完整主流程 | **未通过当前验证** | 内置浏览器显示新面板，但 API 请求超时，不能作为网页可用性通过证据 |
| 新办公项目真实员工、QA、经理 | **验收进行中** | 初次规划已实际完成；真实员工编号错误已修复并恢复，恢复轮次成功创建/回读 Word，但达到原节点次数。最终运行 `c6516254-6ab0-44c3-88f8-f9e86ac81592` 已在剩余上限内批准，QA/经理最终结果待独立核对 |

精简证据位于 [evidence/native-capabilities-2026-10-18](evidence/native-capabilities-2026-10-18)。实际文件保留：

- Windows 组件：`.data/native-capability-tests/component-4/artifacts/`。
- JJ 组件：`/home/jj/.local/share/weiwu/validation/native-capabilities-20261018-v2/artifacts/`。
- JJ 发布：`/home/jj/.local/share/weiwu/releases/weiwu-native-capabilities-20261018`。
- 固定插件：`/home/jj/.local/share/weiwu/data/pilot/native-plugins/b5f22d348f38f55c912bde3bb6d55e4bd6df09ca64dedbf10f0ba10535173df4/`。
- 部署前一致性备份：`/home/jj/.local/share/weiwu/backups/native-capabilities-predeploy-20261018-v2/`；原发布保留。

## 本轮发现并修复的问题

1. 固定工具白名单不能覆盖后来注册的工具；改用原生不可放宽的 guard 与身份、定义绑定。工厂在第一次员工准入时固定定义，允许 DSH agent-teams 先完成原生注册。
2. 员工 wrapper 仅按名字转发时，可在协调器被同名替换；转发前再核对协调器定义身份，恢复也保留检查。
3. Node 文件权限可将 `*` 或现有目录放大成读取范围；拒绝这些授权路径，并把读写限制到本次副本，成功前核对输入未变化及输出声明。
4. 坏安装包原本无法从网页停用；停用改按已登记身份撤销，目录合并磁盘与登记状态。
5. 原生 raw-register 的输出 schema 与 `defineTool` shorthand 不同；改用实际 JSON schema。
6. 本机启动器的 DATA_DIR 指向 credentials；统一安装目录优先采用 LOCAL_WORKSPACE_ROOT。第一次部署检查失败已自动回退，修正并新增回归后第二次部署通过。
7. 验证脚本没有指定 Excel sheet，又以包含元数据的 wrapper 做宽泛文本断言；修正为指定 Sheet1、只检查原生结果正文。首轮 JJ 失败证据保留，未修改插件来迎合测试。
8. 项目只授权 Word，但规划目录包含整个 Office 包的 Excel/PPT schema，导致规划预留超出 $0.02。改为只传入本次获授权的工具元数据，保留 8192 输出。输入从 44,023 降到 33,457 字节，预留从 $0.0230373 降到 $0.0198675；这是请求报价改善，不是模型实际 Token 或速度提升证据。
9. 真实 AI 候选将 DOCX 标成 `format:text`，方案通过但最终交接一定失败。补充 schema 提示并提前拒绝 Office 二进制文件的 text/json 声明；沿用既有省略 format 的二进制文件封存与独立内容检查。20 项文件合同/Host 回归通过。原 AI 候选保留，仅通过正常方案编辑 API 删除该错误字段，没有补写交付文件。
10. 真实员工 `employee-2` 与原部门编号 `writer` 不同，原生工具入队错误地比较 `assigneeId`，三次拒绝后停止。按既有任务合同约定优先匹配运行时 `assignee`，新增真实 LocalOperationService 入队回归，覆盖正确别名、越界路径和错误负责人拒绝；整组 5/5 通过。原版插件没有修改。
11. 网页读取插件目录失败时同时显示“尚未安装”，容易把连接故障当成没有插件。区分正在加载、读取失败和成功空目录；类型检查和构建通过。

## 真实验收续跑位置

- 项目：`5b0f9606-859f-4c63-96b3-4e7e0d7412ec`；初次报价为 v1、已用/预留均 0。已完成初次规划与两轮实际运行，当前为保留原成本后的 v3，最终运行 `c6516254-6ab0-44c3-88f8-f9e86ac81592`。
- JJ 控制器：`/home/jj/.local/share/weiwu/staging/native-real-acceptance.py`；状态：`/home/jj/.local/share/weiwu/validation/native-real-20261018/state.json`。每个写请求先保存分派记录；已有请求标签拒绝重发。
- 继续顺序：读取状态、`finalRun` 和项目账本 → 独立核对该运行的员工/QA/经理正式完成记录 → 解析员工原 DOCX 与两份 JSON、核对 SHA256、调用与费用 → 浏览器最后检查。`paid-plan`、`approve-run`、`recover-alias-fix`、`save-remaining-caps`、`approve-remaining-caps` 均已返回，不得再分派。
- 网络证据：Windows 路由指向 Tailscale；中继 ping 330–370 ms，SSH/网页传输仍间歇超时。用户确认可以连接后已成功读取请求状态及健康信息。发布修复时在没有活动运行的情况下正常重启用户服务；没有修改网络配置或扩大监听范围。
- 旧 6 笔未知预留不变；本次授权无需再询问。不得将组件产物复制进去冒充员工交付。

### 网络恢复后的实际运行

初次 AI 规划收据 `f64ed4e9-e6ae-4e1c-8c07-0622487b7dde`，候选 `6c6d7987-1f85-4698-ae1d-af269e07a474`。规划费用 $0.0052059，未追加规划请求。

- `7da3a959-aee5-4b3c-8650-138e4adc6ec3`：真实员工已发现并选择原版 Word 工具；上述员工编号错误造成 3 次 `notExecuted` 拒绝，0 未知外部操作。执行 5 次模型请求、$0.0141321。失败与原始调用记录保留。
- 修复部署后，通过原恢复入口续跑 `ede9a1d8-75af-495b-9931-88aec362e0a9`。追加 4 次请求、$0.0134793，达到原 AI 节点 9 次上限，QA/经理尚未开始；累计 $0.0328173、净余 $0.3671827，无本项目未知费用。
- 在用户原总 32 次/节点 16 次和 $0.40 内，使用现有方案编辑、重新批准入口安排剩余阶段：旧 9 次不抹除，新方案最多 23 次，writer 最多 7 次、QA/经理各 8 次。原方案的业务任务和权限不变；旧版没有任何已正式完成节点，部分未封存文件留在原运行，不能冒充新运行成果。没有新增规划调用或直接修改数据库。实际派发和最终结果继续记录，不将“已批准”当作验收通过。

## 使用方式与当前限制

1. 启动 JJ 的 `weiwu-jj.service`，Windows 通过 `scripts/deployment/connect-jj.ps1` 连接后打开 `http://127.0.0.1:4312/`。
2. “浏览器与 MCP”页面下方的“原生插件工具”查看原版 Office 安装版本；启用后，在部门员工与项目策略中分别勾选所需工具。
3. 选择 **OpenShell 隔离执行设备**。让 AI 规划任务和明确文件输入输出，检查方案后批准；同名工具不是授予权限，执行仍核对安装版本和合同。
4. 从执行记录查看工具回执与交付文件；停用插件阻止后续调用。恢复保留原绑定版本，不能用新版自动替换旧版。

当前只接入已审阅的文件工具型插件；没有承诺任意 npm 包、后台服务或 DSH 原生网页插件无需适配。DSH 原生安装与包管理已有实现，本轮沙箱打包器消费其安装产物；**网页一键搜索/安装市场插件尚未实现**。公司 MCP 仍沿用已有只读 Streamable HTTP 接入；自动发布可执行经验工具、其他类型插件单独验收。

`xlsx_recalc` 原版不持久化公式缓存，保留之前 WPS 实际计算证据，不宣称服务端预览具有完整 Excel 引擎。此次仅独立检查文件格式和正文，没有验证 Word/PPT 的桌面排版。

用户已批准 [真实验收安排](native-capability-real-acceptance-proposal-2026-10-18.md)：在累计 $3.41 内给新项目最多 $0.40，包含规划和纠正。原 6 笔未知费用保留；下一步网络恢复后按同一授权继续，不能重复扣费规划或补写交付物。
