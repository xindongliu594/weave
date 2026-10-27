# 项目规划候选、费用与历史：阶段实际验证

2026-10-05 18:12（北京时间）已把冻结源码加载到原本机工作台并通过实际 Edge 只读复核。当前 launcher 28380、API 12040、API port 61369，网页仍为 http://127.0.0.1:4310/。此阶段新增付费请求为零，没有恢复旧项目、修改原费用或员工交付；不构成真实 QA、经理或受控中断完成证据。

## 修复后的可操作流程

项目页面选择规划模型和单次限额/输出上限，先“检查规划费用”，再“生成 AI 候选（会计费）”，最后由用户确认保存或丢弃。候选生成不保存项目新版本，失败不替换原方案；确认一次才写入新版本。未通过执行校验的候选可明确保存为草稿，不能直接运行。

只读费用预检与付费发送共用请求拼装及预留公式，包含完整已保存方案、实际调用/费用、核验完成节点、文件 SHA、固定资料与历史授权。旧版本、缺失档案、未接受文件或未归属用量不推定为完成或零。提交前再次核验；金额、参数或同长度 SHA/节点/调用历史变化均需要重新检查。候选保存不自动继承执行检查点。

生成和确认使用各自稳定的请求键。回复不明时保留原请求，通过“继续读取同一生成请求”处理；不自动发送另一份付费生成。已发生费用和未知预留保留。

## 实际检查与证据

| 检查 | 结果 | 原始证据 |
| --- | --- | --- |
| 费用 GET 无副作用、候选不覆盖、并发确认一次、过期/跨项目/权限/运行中/失败门禁 | 47 pass、0 fail、2 skipped；独立 PostgreSQL 连接锁用例当前环境跳过 | [API 相关最终回归](project-planning-api-final-2026-10-05.txt) |
| 完整合同、当前版本、真实 SHA、wire/usage/hold 归属、知识来源及档案损坏 | 11/11 | [历史模块报告](planning-execution-context-2026-10-05.md)、[原始输出](planning-execution-context-2026-10-05.txt) |
| 网页费用、候选确认、原请求恢复、历史变化阻断 POST | 新规划 15/15，合并相关消费者 54/54，不相加 | [UI 报告及日志](project-planning-candidate-ui-2026-10-05.md) |
| 费用/执行净额与运行记录相关回归 | 17/17 | [原始输出](project-planning-cost-admission-2026-10-05.txt) |
| 类型检查和生产构建 | exit 0、1687 模块；仍有单个 JS 包大于 500 kB 的构建提醒 | [构建输出](project-planning-build-2026-10-05.txt) |
| 新内存 PGlite + 实际 Edge + 实际构建页面 | 费用检查零请求；生成/丢弃均保持 v1；确认后 v2/DRAFT、0 runs；非法 JSON 保留 v2 和已记费用。3 次本地协议替身、0 真模型，0 页面错误 | [浏览器结构化证据](../test-evidence/project-planning-isolated-web-final-2026-10-05.json)、[输出](project-planning-isolated-web-final-2026-10-05.txt) |
| 原工作台只读 Edge 与原数据复核 | 原 v6/$0.48、272 条完整 usage、snapshot/journal/四文件 SHA 不变。dev 已接受、21 次累计调用；三个开发文件 accepted，独立测试仍为 fixed_input | [实际只读核对](../test-evidence/project-planning-live-web-2026-10-05.json)、[加载身份与前置门禁](../test-evidence/planning-candidate-service-reload-2026-10-05.json) |

隔离浏览器第一轮因测试数据未提供工具能力证据而不能得到有效候选，脚本错误寻找“确认保存候选为新版本”后超时。网页正确显示候选未通过；补齐隔离协议证据后通过。保留 [首轮失败](project-planning-isolated-web-2026-10-05.txt) 和 [首轮截图](../test-evidence/screenshots/project-planning-candidate-unconfirmed-2026-10-05.png)。真实只读核对第一轮误把两份知识文档和四份导入资料合计预期为 2；实际正确保留 6 个来源，修正检查后通过，保留 [首次断言输出](project-planning-live-web-2026-10-05.txt)。没有通过修改业务数据满足断言。

## 原项目的确切费用状态

原 v6 已登记 $0.3664174、未知预留 $0.0278694、净额 $0.0857132。Astra 5,000 输出上限和 49,799 保守输入字节按配置 10/50 USD 每百万 Token 预留 **$0.74799**；默认单次规划限额 $0.048。网页显示 COST_PENDING、CALL_BUDGET_EXCEEDED、BUDGET_EXCEEDED 并禁用生成按钮，0 POST。配置单价和字节预留不等于中转站账单或账户余额。

历史知识包含 2 份 v2 知识文档和 4 份 v1 原导入资料，共 6 个来源；15 条有任务/位置来源的历史引用分别保留。私有知识文档只授权 QA，没有改用当前 v3。它们是档案核对，不是新恢复员工已重新引用的证明。

已实际查看的截图：[未确认候选](../test-evidence/screenshots/project-planning-candidate-unconfirmed-final-2026-10-05.png)、[确认保存](../test-evidence/screenshots/project-planning-candidate-confirmed-final-2026-10-05.png)、[生成失败保留](../test-evidence/screenshots/project-planning-invalid-reply-preserved-final-2026-10-05.png)、[原 v6 实际费用与历史阻断](../test-evidence/screenshots/project-planning-live-budget-blocked-2026-10-05.png)。

## 下一阶段

用户已明确批准 [两份新验收项目各最高 $5、新增合计最高 $10](real-acceptance-budget-proposal-2026-10-05.md)，由真实 Astra 分配预算、Luna/Sol 执行；旧项目和未知费用继续保留。真实正常完成、受控中断恢复、恢复后员工固定引用仍需新的实际运行证明。在创建前发现首页缺少执行模型允许列表，正在补上可操作网页入口，不通过改数据库或将 Astra 强行用于所有员工绕过。
