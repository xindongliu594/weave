恢复和规划反馈的调用计数已修复并冻结。逐 Run 的全局及同 task 调用数分别取持久化 model_reservations 登记与 archived wire 数量的 max，不把两者相加，也不再叠加 snapshot.budgetHistory。登记成功的 undispatched/released 调用仍占原额度；本案隔离重建中恢复和规划均为24（wire23+登记24），qa_review 继承1。

共享计数核对 receipt project/run/version 与档案 ID/owner/显式版本；legacy 无 usageId/receipt 的 wire 行为保留，旧档案未记录 planVersion 时采用已严格查询的 owning run row version。cancel-before-start 缺档且存在登记时拒绝，不能推定0。部分 legacy task 归属若导致 task max 合计超过 run global max，也明确拒绝，不生成负数或伪造0。

budgetHistory 返回 callsBasis=`durable-admissions-and-archived-wire-requests`，规划使用同一计数实现，run-evidence 只传播该已知 basis；老快照仍使用 `archived-model-wire-request-count` fallback。费用、held、daily、预算上限及金额公式均未改。隔离测试前后完整数据比较验证原 amount/status/history 保持不变。

| 回归 | 结果 |
| --- | --- |
| NEW admission/PGlite | 12/12 exit0 |
| 既有 planning execution context | 11/11 exit0 |
| 既有 recovery conditions/API | 7/7 exit0 |
| run-evidence pure | 6/6 exit0 |

共36项通过。覆盖 wire+同receipt不双计、登记未发出、跨项目/版本、多次resume不叠加入场历史、旧wire-only、缺档cancel已有登记、所有权矛盾、未知hold保留、API规划与恢复反馈一致及新旧basis。测试仅用全新内存PGlite/临时隔离fixture；真实API/原库/模型/Key/员工文件操作0。

旧 planning fixture 在新计数下先运行并保留了10/11失败输出：其 latest Run 原wire1，但存在qa pending及unattributed uncertain两条登记，新总数应5而非4、unattributed应2而非1。root授权后只同步这两个期望并加basis断言，所有金额、所有权和数据不变断言保留，重跑11/11通过。完整初次和最终输出在 .txt。

| 冻结源 | SHA256 |
| --- | --- |
| budget-history.ts | 6b14d08758d1914377aba4f1d45611c0edbaa60f8cfd134dfaf758bd1fb68adf |
| planning-execution-context.ts | 1a981c25b6ec51cea6029d033eb64dfa15820493f502b0e657bc6ffb6fa6b6e0 |
| run-evidence.mjs | 6985ab3fd12379f2022c46d7e230f85dcc899d9b61e5c6ad2405a24a2bce7737 |
| NEW admission test | dcd96db26a9a6a5d561910ba658dedacf0068198b0818a96d721e4bd65581fb8 |

其他相关测试及 unchanged operator/stop/KV SHA 见同名 .json；最终type/build及原服务reload由root执行。工程回归不能证明实际恢复或员工验收已完成。冻结时间 2026-10-06T04:44:51Z。
