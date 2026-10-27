# 规划响应解析修复与隔离验证（2026-10-06）

完成本地源码修复；4个源码文件和2个新测试已于 `2026-10-06T08:15:03.057Z` 冻结，精确SHA见 [manifest](planning-output-2026-10-06-sourceSHA.json)。本轮50项独立测试PASS，`tsc --noEmit` exit0。全部既有 admission 冻结文件SHA逐条复核未变。本agent没有访问运行中的原服务、原PGlite、Key或真实provider，也没有重启服务、执行员工代码或修改员工产物。

## 原v11结论保持

原失败的来源为 [只读审计](go-normal-v11-planning-parser-readonly-2026-10-06.json)。唯一付费调用已知settled：10107输入/3845输出，0.0076461，receipt `52a67c7f-5a3f-4c74-b42e-b3ad857bf840`；原formal v10保持。实际模型原文和finishReason未保存，因此本轮不将“可能有外围说明”等局部兼容风险改写为原失败的实际原因。没有同key/body重放、paid重试、补写候选或修改已知422。

## 最小实现

- 新纯函数 `extractPlanningObject` 接受exact对象、一个JSON/无语言围栏、或一个完整对象外的简短说明。逐字符扫描正确处理字符串、转义、嵌套object/array，再只对原候选字节调用一次JSON.parse。没有eval、修补、合并字段或选取多个候选中的某一个。输出最多256KiB、64层嵌套，每侧说明trim后最多512个UTF-16字符；多个对象/外部结构值、多个或不匹配围栏、截断、语法错误、非object、超界均拒绝。
- `app.ts /projects/:id/generate` 只替换提取入口。原 `planSchema`、权限、预算、源版本/fingerprint、候选preview和用户确认流程保持。合法JSON但不符合计划结构仍拒绝，费用保持已知，原计划不被替换。
- `provider.ts` 不再剥掉响应 `finish_reason`，仅保留为安全响应metadata；未知/异常值归为unknown，不回显任意provider字段。没有改Go配置、thinking参数、wire envelope或增加response_format。`length/content_filter` 在可信usage回调完成后明确失败，完整可见JSON也不采用。没有修复请求或第二次收费调用。
- 解析/计划schema失败的安全diagnostic通过原 `receiptTransaction` 写对应已知receipt.context，遵守既有维护/行锁次序；provider提前失败拿不到可信receiptId，因此不猜最后一条receipt。错误handler把安全diagnostic写 `TRACE_ROOT/planning-output-diagnostics/<uuid>.json` 并返回有界reason、position、finishReason、originalOutputSHA、outputBytes。没有保存/公开原文、Key、HTTP body或prompt。SHA针对原decoded字符串的UTF-8字节，非字符串缺失内容按空文本；position是UTF-16索引。所有reason为固定内部枚举文本，不使用JSON.parse的原错误消息。

## 证据与回归

| 检查 | 最终结果 |
| --- | --- |
| 新纯fixtures | 6/6 PASS |
| 新隔离规划API fixtures | 6/6 PASS |
| 原项目规划/净预算/版本/确认/历史保留 | 17/17 PASS |
| 原组织对话/权限/费用/幂等保存/超时 | 15/15 PASS |
| 原Chat/Responses/Go会话/真实wire envelope/费用 | 6/6 PASS |
| TypeScript | exit0 |

纯fixtures覆盖前后说明、单围栏、quoted braces、escaped quotes/backslashes/newlines、中文、嵌套容器、多对象和标量、坏围栏、截断字符串/容器、错误escape/control字符、非法语法、exact byte/depth/outside界线。diagnostic断言输出SHA等于原文本SHA，安全字段不包含合成Key。

API使用fresh in-memory PGlite和loopback provider double；所有后台执行器先关闭。接受后的单候选：唯一wire/settled usage，正式版本1不动；重复同key只重放测试HTTP缓存；显式确认才保存版本2，确认重复不再版本化，无run/local-operation。畸形/多候选/过界/schema错误：唯一wire+settled usage，无preview、无改正式计划；相同key不能再发provider请求。length/filter同样保留已知费用后明确失败。超出模型权限/净预算仍被拒绝。原thinking wire断言为 `thinking:{type:'disabled'}`，response_format继续省略。所有幂等重放只针对新测试库中的fixture，不是原v11请求。

日志：[纯fixtures](planning-output-2026-10-06-pure-first.txt)、[原项目/组织完整回归](planning-output-2026-10-06-api-final.txt)、[最终补充envelope与新API](planning-output-2026-10-06-envelope-final.txt)、[tsc final](planning-output-2026-10-06-tsc-final.txt)。首次局部失败保留：[API first](planning-output-2026-10-06-api-first.txt)（测试误把旧thinking wire断言为enable_thinking，已仅修fixture）、[tsc first](planning-output-2026-10-06-tsc-first.txt)（异步reject控制流缺少return，已修）。

本轮证明本地兼容修复和原门禁没有被放宽，不证明原v11响应是哪类错误，也不作为真实normal交付完成证据。只有root在受控停止/重启后按冻结SHA加载的新不同请求，才可验证真实provider后续行为；本agent没有发起该动作。
