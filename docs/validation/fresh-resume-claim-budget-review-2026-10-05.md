# 真实 claim 阻断与精简后独立预检

截至 2026-10-05 13:03（Asia/Shanghai），**product-only 描述精简已通过实际 native 隔离验证，但没有证明当前余额能支付连续 QA；不应再次盲目付费恢复。** 此报告补充 [上一阶段首轮审查](fresh-resume-budget-review-2026-10-05.md)，保留先前结论发生时的证据，不覆盖旧记录。

## 已发生的真实运行

主代理通过网页获 202，创建 `5114bb4f-7ac4-413d-a80f-aceeace8bdec`，继承 `1e6a2c30-3e8c-46fd-9c31-d2557768eb9a` 的 dev completed。独立只读其关闭归档，确认一次 Sol wire、一次已登记结算：收据 `7f882dba-d0c9-40e8-9c14-da54c52b349f`，input 7501/output 54、登记 $0.015542；原首轮 28777B、预留 $0.073602，与之前 native 预检相符。

员工实际选择 **`agent_teams_claim_task`**，实参 `{"task_id":"t2"}`。这是本已 claimed 的内部原生任务；其回执 `task_details` 8876B、render 8984B，仍含“先不用生成团队方案或保存”和“尚未确认保存”等旧规划内容。随后第二步原始 envelope 67271B、精简前预留 $0.150590；保留当前系统、最新合同快照和最新完整 assistant/tool 组后，独立计算最低仍为 38172B、$0.092392，超过当时 $0.0857132。独立调用现有纯 fitter 复现 `BUDGET_CONTEXT_LIMIT`，**没有第二次 wire 或供应方请求**。这次失败发生在本机费用门禁，不能归因为新的中转站连接失败。

公开费用查询前后保持登记 $0.3664174、未知保留 $0.0278694、净额 $0.0857132、pending 0/uncertain 2。原总额 $0.48、方案 21/37 次已用/上限、QA 4/14 次、已有开发和员工文件均保留；没有 QA 命令审批、QA 完成或经理完成证据。网页动作来源见 [主代理真实网页记录](../test-evidence/my-gateway-budget-feedback-resume-2026-10-05.json)；其 `readinessAfter` 是调用进行前的早期快照，最新金额以本次独立 [只读原归档与费用审计](../test-evidence/fresh-resume-budget-first-sol-claim-source-audit-2026-10-05.json) 为准，输出见 [source audit 日志](fresh-resume-claim-source-audit-2026-10-05.txt)。

## 独立隔离重建

[审查 helper](../test-evidence/helpers/audit-fresh-resume-budget-2026-10-05.mjs) 新增可选 `--source-run=5114bb4f-7ac4-413d-a80f-aceeace8bdec`。仅允许此前备份来源及这次明确授权的关闭运行：不枚举原数据目录、不打开原 DB、不读取 Key/master。其余同版本历史仍从已关闭的隔离 backup snapshot 读取；实际历史算法重建 21 次调用，QA 4 次/$0.08356。

新 native team/session 只写本 workspace 的随机 scratch；文件/命令 sandbox 与模型外网调用硬阻断。原归档、四份员工文件 SHA 和公开账本逐字段前后不变。首个 fake Sol 响应只返回真实源记录的同名 claim 与实参，随后由本地 **真实 native 工具和 renderer** 生成完整回执，没有注入虚构、截短或固定 tool result。所有 fake usage 只改变隔离 adapter 内存，未写入产品账本。

调用实际 production mapper：`teamTaskPlan(tasks,{hostContext:true,assertHostContext:()=>host.assertApprovedTaskContext(tasks)})`。compact 仅在可靠宿主断言成立时启用；完整输入/输出 JSON、其他 typed contract 字段、最新 snapshot 与持久化保持不变，源码归属主代理/runtime agent。捕获期间源码 SHA 稳定：handoff `3ac6a06abc854b6073b2ed236a6c58564716e9cc823e5c13fd08c51d067a2787`，product-runtime `f41ecc91e051800c8a8ff0b8b8fe5e8eacc879f1942ec624c2101687c22caad5`，host `f3b31b02808b90d3d889eed2800c3042052a8c5d6c418099238757c59fc7988e`；完整 20 项 SHA 见证据。

## 修复生效，剩余金额仍紧

compact 的真实 claim `task_details` 降为 **2445B**，旧规划/等待确认标记都消失。latest snapshot 保留完整 requirement 4627B（SHA `839bed6bc6ef0efa722e577ff62376baa78c0d6996ef73c8501e31eb12b31de7`）、原批准 task 合同 SHA、完整恢复上下文 SHA `ea3b15468df6452ab0208a81eff2573e0ea716f502c96cf4b90fe359f2433cb9` 与四份文件 SHA。dev 仍只恢复，不重派。预算、模型费率 2/10、输出上限 1400、JSON 字节加 1024 的预留公式及所有门禁都未扩大。

| 隔离敏感性场景 | 第一次新请求 | claim 后第二次新请求 | 结果 |
| --- | ---: | ---: | --- |
| 40/10 fake usage，模拟 $0.00018 | 29095B，预留 $0.074238 | 31952B，预留 $0.079952；模拟余额 $0.0855332 | 可预留；20/20 上下文、SHA、预算与 session/trace/wire 校验通过 |
| 使用旧真实 7501/54，仅作 $0.015542 敏感性 | 同上 | 受保护最低 31954B、$0.079956；模拟余额 $0.0701712 | 发出前拒绝；18/18 合同、完整需求/恢复、归档 candidate、费用/次数变化与预期拒绝断言通过 |

第一行 [最终 JSON](../test-evidence/fresh-resume-budget-first-sol-claim-compact-probe-final-2026-10-05.json) 与 [输出](fresh-resume-claim-compact-probe-final-2026-10-05.txt) 中，首轮 native seq 7/trace seq 37、次轮 native seq 15/trace seq 55，真实 session 持久化文本/source SHA 对上实际构造的 wire。没有使用占位需求、合同或恢复输入来降低金额。

第二行 [最终 JSON](../test-evidence/fresh-resume-budget-first-sol-claim-compact-source-fee-final-2026-10-05.json) 与 [输出](fresh-resume-claim-compact-source-fee-final-2026-10-05.txt) 中，只有一次本地 fake fetch；第二次未到费用注册、wire 或 fetch。完整次轮 snapshot 已归档，能与**未发送 candidate** 的文本/source SHA 对照；`archivedSecondContextMatchesWire` 和 `latestSnapshotRetained` 为 false，是没有发送请求，不是合同或恢复信息被丢弃。证据明确区分 candidate 与已发 wire，不把拒绝标成付费成功。

## 下一步

当前第一笔虽可预留，精简 claim 后仍仅容纳约 **$0.00576** 的第一笔实际费用，才有足够余额进入第二笔保守预留；未计后续员工文件、知识、改写、真实测试或经理费用。旧真实费用 $0.015542 是敏感性观测，不能预测所有新响应，也不能用 $0.00018 的低费 fixture 声称连续运行可行。

应先通过准确账单核对历史 uncertain 金额，或继续只读检查可消除的重复运行上下文，并获得有依据的本地连续请求预检。未明确降低下一步门槛或获得准确账单释放预留前，保持当前运行停止和原余额，不继续重复付费试探。未知金额不能按 0，不能提高额度/输出/调用上限、削弱恢复门禁或由 Codex 补写员工产物。当前真实 QA、复审、经理与完整 Todo 交付仍未完成。
