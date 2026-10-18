# DSH 办公插件与公司 Skill 共用入口：组件验证

日期：2026-10-18。结论：**原版办公插件可在为伍固定 DSH 上注册并调用，公司方法可共用原生 Skill 入口；还未达到生产办公交付验收。** 本轮只改本地探针和文档，未部署 JJ、未改产品依赖或数据库、未请求付费模型。

**后续实际打开验证已通过，修正初次判定：** 插件生成的原 XLSX 可以由本机 WPS 正常计算，修改输入后会重算，保存后含正确缓存。初次把“未保存公式缓存”扩大为“Excel 不可用”的判断过严；它只限制不具备重算能力的读取/预览路径，不应阻断所有办公插件接入。原始证据保留，新增实测见文末。

## 实际复用内容

选择 [omdsh-dev/dsh-office](https://github.com/omdsh-dev/dsh-office) 对应的 [npm @huiliyi37/dsh-office](https://www.npmjs.com/package/@huiliyi37/dsh-office)。GitHub main manifest 为 0.2.5，但 npm 查询该版本返回 404，实际固定可下载版 **0.2.4**（Apache-2.0）。已核对 tarball SHA512；安装包 46 个文件与原 tarball 逐字节一致。独立依赖锁文件随探针保存，安装禁用生命周期脚本。没有自行实现 Word、Excel、PPT 引擎，也没有修改上游业务代码。

运行环境：Windows、Node v24.15.0、DSH 0.1.5-rc.1。最终组件运行 ID：`55328e77-d9b7-46ed-8d3f-4b42ab4abe02`，子进程耗时 **3725 ms**（一次样例耗时，不是性能基准），12 次原生工具调用，其中 3 次是预期拒绝。模型 adapter 调用 **0** 次。

## 证据结果

| 项目 | 实际结果 | 边界 |
| --- | --- | --- |
| 原版插件注册 | 注册 10 个 DOCX/XLSX/PPTX 工具 | PDF 已关闭；没有完整调用所有 10 个工具 |
| 公司与上游 Skill | 原生同一目录列出 `weiwu-company` 和 `filesystem` 来源，两者经 `skill` 按需加载 | 公司内容是明确的试验 fixture，固定 v3/hash；不是员工新提炼的业务经验 |
| Word | 创建/回读中文报告；独立解析 OOXML，核对标题、真实表格及 10/2 数值 | 未验证桌面 Office 排版或渲染 |
| Excel | 创建/回读工作表；独立核对 A2=10、B2=2、C2=`B2/A2`；后续 WPS 实际打开、改值和保存验证通过 | 插件自己不保存公式缓存；WPS 可计算并保存。服务端无重算预览仍需处理 |
| PPT | 创建/回读中文汇报；独立解析实际两页和目标正文 | 未验证排版、图片、编辑及真实 Office 打开 |
| 原生工具权限 | 未授权上下文隐藏全部 10 个办公工具，DOCX 调用返回 `UNKNOWN_TOOL` | 仅为探针显式配置的 native restrict，产品动态授权尚未接通 |
| 公司方法权限 | 未授权员工没有 skill 工具；伪用另一员工上下文被 `SKILL_PERMISSION_DENIED` 拒绝 | 不代表任意插件已纳入现有产品权限模型 |
| 文件访问 | 无敏感内容的旁路文件拒读；目录外 DOCX 写入被拒，父进程确认文件未生成 | Node 文件权限实验；未验证 OpenShell 或网络隔离 |
| 原有 Skill 回归 | 2/2 通过，覆盖固定正文、员工隔离、审计及冷恢复 | 既有本地 fixture 测试，不是新增办公插件的持久化验收 |

最终 `probeCompleted=true`，9 项正向检查通过；`acceptancePassed=false`，`productionReady=false`，退出码 2。保持这个结果，不补写 Excel 缓存冒充插件能力。原版 `lib/excel.js` 的 `xlsxRecalc` 只读取、求值并返回检查状态，没有保存工作簿；其返回成功与“缓存未持久化”并不矛盾。这是交付需求上的能力缺口，不能仅凭该状态宣称表格结果已保存。

上段的 `acceptancePassed=false` 是初次探针对额外“缓存必须已保存”要求的结果，**不代表 XLSX 格式/公式错误，也不代表 WPS 无法使用**。缓存是上次计算结果，公式本身另存于 `<f>`；参见 [Microsoft Open XML 公式说明](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas)。插件自带 Skill 将 `xlsx_recalc` 定义为公式重算门禁，没有声明持久化缓存。后续原生消费端测试单独记录，不覆盖旧结果。

## 产物与复现

完整原始本地输出在 `.data/plugin-pilot-20261018/runs/55328e77-d9b7-46ed-8d3f-4b42ab4abe02/`，包括 `report.docx`（9843 B）、`metrics.xlsx`（6529 B）、`brief.pptx`（51803 B）。均为探针调用原版插件产生的测试样例，不计入员工业务交付。每份文件 SHA256 见结果证据。

提交的精简证据位于 [evidence/dsh-office-plugin-pilot-2026-10-18](evidence/dsh-office-plugin-pilot-2026-10-18)：result、receipt、stdout/stderr、source-audit 和 Skill 回归输出。仅省略 result 中上游 Skill 的完整正文，保留字节数和 SHA256；原始结果仍保留本地。复现见 [探针说明](../../scripts/validation/dsh-office-plugin-pilot/README.md)。生产代码没有变更，本轮运行了两个 MJS 语法检查、原包对比和相关 Skill 集成回归；未重跑全仓类型检查/构建。

## 过程问题与修复

1. 首次直接调用生产 Host，在 Node 权限模式下因 trace-store 的 `fsync` 被禁而失败（运行 `25fb5b4a-ff97-49cd-8ff7-3f4b50c89717`）。保留生产持久化实现；将试验缩为原生 DSH 内存组合。**办公插件的 EmployeeHostFactory 接入、持久化、冷恢复仍未验。**
2. 首次组合遗漏 agent-loop，补挂现有组件后继续；未创建新调度器。
3. 独立审阅指出最初的整仓读取许可过宽。已收紧到必需脚本/元数据/依赖/本次输出目录，并增加非敏感旁路文件的拒读断言。早期结果不能作为当前权限保证。清空环境变量不能代替文件权限或网络边界。
4. 加强拒绝测试到明确 `UNKNOWN_TOOL`，补真实 DOCX 表格、Excel 输入与公式、实际 PPT 页数断言。收紧读权限后，探针原先尝试检查目录外文件存在性也被拒；改由父进程核对该文件未生成，未放宽子进程权限。
5. 托管 Windows 为测试子进程覆写了无效 TEMP 路径，初次 Skill 回归在 mkdtemp 前失败。改在测试进程内部设置专用临时目录，既有测试 2/2 通过，没有修改产品以适配此环境问题。

试验准备安装了 252 个依赖；部分传递依赖有弃用提示。这不等于安全审计通过。Node 24 权限模式不限制网络，也不能作为不可信插件的完整安全边界；本轮没有网络监测，不能断言插件依赖完全没有联网。

## 下一步最小生产接入

按“先调研、再计划、再实现”推进一条共用机制：

1. 核对固定 DSH 的 plugin-manager/profile 接口，复用安装、启停、工具注册；保存来源、命名空间、固定版本和完整性摘要。
2. 将当前固定八工具的权限过滤扩展为已批准插件工具目录，安装与员工授权分开；新注册工具默认不可见、不可调用，恢复使用原快照。
3. 原版办公工具直接使用 node:fs，需要放到有明确输入输出目录的沙箱执行边界，再关联为伍产物与审计。复用 OpenShell/DSH 执行机制，不把注册到 Host 当成已隔离。
4. 网页连接启用状态、员工授权、文件下载与真实失败原因。公司 Skill 继续用现有 DSH provider；公司 MCP/插件按各自标准进入同一能力目录。
5. 先验证一个员工获授权调用原版办公插件、独立检查文件，并覆盖拒绝访问及恢复固定版本。Excel 持久重算优先评估现有引擎或上游支持；视觉渲染与真实员工选择另行实际验证。

本轮没有接入后台监控服务、原生 DSH 网页插件，也没有实现自动发布可执行经验工具。不能从这个样例推断所有插件都可无适配使用。既有金额、次数、权限和未知费用保持原状。

## 后续 WPS 原生计算验证

用户要求实际再试。直接复用本机已安装的 WPS 表格，通过它提供的 Excel COM 兼容接口，仅打开原样例的独立副本。接口自报 `Microsoft Excel 12.0`，但程序路径位于 `Kingsoft/WPSOFF~1/.../office6`，因此证据明确归属 **WPS，不能声称 Microsoft Excel 实测通过**。Windows 默认托管沙箱拒绝 COM；在正常用户权限下完成测试，无管理员修改、无新软件安装。

运行 ID：`a5680cc6-fc6a-4d02-997f-39f03f380387`。5 项检查通过，付费模型调用 0：

1. 原样例 C2 保持公式 `=B2/A2`，A2=10、B2=2 时得到 **0.2**。
2. 将副本 B2 改为 5，计算结果更新为 **0.5**，不是预填静态结果。
3. 将副本 A2 改为 0，显示 **#DIV/0!**，错误未被掩盖。
4. 恢复 10/2 并保存副本，原样例哈希保持不变。
5. 独立打开保存副本的 ZIP/XML，C2 同时保留公式 `B2/A2` 和缓存数值 **0.2**。副本 SHA256：`2740c6d9cf4510e6bd92ba3a1d5a3ba756cc57b1d8426edeca39589e4224f866`。

脚本：[check-native-recalculation.ps1](../../scripts/validation/dsh-office-plugin-pilot/check-native-recalculation.ps1)。原插件生成的 6529 B 样例随脚本保留，SHA256 `61acccd39daea48bee04d970d39f0e7da59a813848161969f3a7c10dbd861469`，与首次工具产物一致。结果：[native-consumer-result.json](evidence/dsh-office-plugin-pilot-2026-10-18/native-consumer-result.json)。首次消费端试运行 `b2dd2de1-2724-4fcc-a37b-fc05353f0d74` 同样通过，原始记录保留在本地忽略目录。

**修正后的接入结论：继续复用原版插件；不需要为这个例子重写 Excel 或修改上游。** 本机 WPS 是独立测试消费者，未纳入 JJ 生产环境。网页服务端预览若只读缓存，需要另接已有重算能力或明确提示；本轮未验证该路径，也没有验证 WPS 视觉排版、复杂函数或任意第三方工作簿。接下来的主工作仍是统一插件授权与执行连接。
