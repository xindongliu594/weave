# 规划方案字段诊断修复

本次只修改 `planning-output.ts`、`app.ts` 的最小schema桥以及两份相关测试。没有模型请求、live mutation、原数据库/Key读取、重启或加载，没有修改正式方案schema、权限、预算、模型wire或员工文件。coordinator/state/trace等已冻结源码未修改。

normal13原证据 `docs/test-evidence/go-normal13-two-stage-normal-generate-2026-10-06T11-41-30-743Z-cc95b1a5.json` 的实际响应为422/PLANNING_SCHEMA_INVALID，finishReason stop，输出13750字节、SHA `2c901a23eaebe0075b6e091c6680ad0b09b57dbdd1d905f23362a549f96582d8`，只有reason PLAN_SCHEMA_INVALID及position null。其具体失败字段当时未保存，仍为unknown；不能用fixture或本次代码倒推。原v12和该已知付费失败不改写、不重放，本次没有付费重试。

原因被丢失的位置为 `app.ts:317–318`：`planSchema.safeParse(candidate)` 返回完整issues，但原318行丢弃 `parsed.error.issues` 并新建只有reason的 `PlanningOutputError`。现在将issues传给错误构造器；`planning-output.ts:32–52` 只保留安全摘要，`app.ts:312` 把同份诊断合并入receipt context并追加一次source=planning-output的history。已结算usage和receipt状态不变；localtrace也只有安全诊断。JSON错误位置仍保留原position，schema错误仍为null，不虚构字符位置。

安全白名单：最多12条issues、每条路径最多16段；只保留固定schema字段和0…9999的数组索引。任意record键、未知字段与非数组索引替换为`<field>`。code、expected类型、数字长度/范围、inclusive、静态枚举/格式和少数固定refinement规则分别白名单化；不复制Zod原message、input/received、key/keys、regex pattern或nested union errors。摘要另列issueCount和truncated标记。未知refinement保持通用正式schema约束，不从动态消息拼接模型文本。

`planningSchemaMessage` 仅将上述白名单摘要的前三条转换为有界错误文本，例如`tasks[0].maxOutputTokens：最大 32768（too_big）`。现有网页 `api.ts:14` 保留结构正确HTTP拒绝的message，`ProjectPlanning.tsx` 的working错误处理把它作为React文本显示；没有新增UI流程或自动重发。其它issues保留在诊断清单。正常candidate内容、未知字段原有strip行为和用户确认保存机制均保持原schema行为。

验证结果为66/66，通过日志即首轮实际结果（本次没有失败后隐藏重试）：

- `.unit-first.txt` 38/38：原提取器6、新schema摘要4、API响应5、规划UI23。覆盖真实planSchema的类型/null、长度/数字上限/枚举、secret嵌入、任意record键（即使键恰好叫instructions仍占位）、strict unknown-field摘要、nested union、未知code、50issues cap/字节界限、正常候选不变和原有unknown-field strip。
- `.api-first.txt` 28/28：实际fresh PGlite/loopback API及provider double诊断8、原规划17、quote3。新增诊断测试验证现有web client收到具体安全field message；schema422不产生preview、不保存/批准/执行、不修补候选。receipt恰好一条safe history、context与HTTP诊断相同；同key/body重读只有一个fixture wire，原usage JSON字节SHA和完整receipt不变。20个null任务的摘要cap为12，总计20；顶层null仍按原OBJECT_REQUIRED拒绝。正常候选的明确确认保存、费用/权限/unknown hold门禁和3840/4000中文quote POST回归继续通过。
- `.tsc-first.txt` 最终TypeScript检查退出0且输出0字节，tool session47670确认完成。未执行正式构建或加载；主任务按冻结SHA统一处理。

冻结源码和测试SHA见同前缀 `.sourceSHA.json`。这个改动提高未来错误的可诊断性，不声明修复normal13未知的实际生成字段，也不放宽任何正式方案校验。
