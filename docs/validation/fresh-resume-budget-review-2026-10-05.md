# Fresh resume 首轮预算与上下文独立审查

2026-10-05 12:30（Asia/Shanghai）完成。修复后的本地真实 native 重建证明，原方案 fresh resume 的首个 Sol 请求可在原净余额内预留：**$0.073602 < $0.1012552**。这纠正了“旧 wire 下限足以证明所有 fresh resume 都不可行”的判断；**尚未验证真实 QA、复审或经理能连续完成**。

本次只读产品的费用 API、已关闭的隔离备份归档和当前代码。没有创建产品运行、打开或修改原数据库、读取供应方 Key、复用设备授权、改写员工文件、启停主服务或发送真实模型请求。两个 fake fetch 仅观察 native 请求构造和下一步预算反馈；其模拟输出、费用与完成状态不能作为员工验收。

## 依据与原边界

来源运行 `1e6a2c30-3e8c-46fd-9c31-d2557768eb9a`，项目 `dde78f91-2a99-4a63-a9fa-5cb7bab2b8f0`。公共费用查询前后逐字段一致：登记 $0.3508754、两笔 uncertain 保留 $0.0278694、净额度 $0.1012552、pending 0。两笔原收据为 `12ebc7bd-bc11-4948-9142-d778f0e22433`（$0.0222384）和 `4319725c-c6aa-4401-834d-271fb06d4c9e`（$0.005631）；未结算、清零或改写它们。

保留原项目总额 $0.48、37 次方案调用、每任务 14 次、192000 字节上下文、并发 1，以及 Sol 输入/输出费率 2/10 每百万 Token、输出上限 1400。真实历史算法重建 20 次调用；QA 已用 3 次、$0.068018。新原生状态只恢复 `dev` completed，未重执行开发节点。模型、任务、合同和文件版本均来自固定快照。

最终 [JSON 证据](../test-evidence/fresh-resume-budget-first-sol-native-refresh-final-2026-10-05.json)、[验证输出](fresh-resume-budget-native-refresh-final-2026-10-05.txt) 与 [可复现 helper](../test-evidence/helpers/audit-fresh-resume-budget-2026-10-05.mjs) 保存了完整数值、代码 SHA 和隔离 session 路径。业务文件来源为 [完整隔离备份验收](../test-evidence/my-gateway-full-backup-2026-10-05.json) 的关闭 snapshot，未重执行其备份或原数据操作。

## 发现及修复边界

最初带 13 个 schema 的请求预留 $0.089300；限定到员工授权的 10 个 schema 后预留 $0.087452，schema 从 7323B 减少到 6399B。这两份请求仍只有“等待宿主确认任务分派”，缺少当前合同、恢复和预算，因此不能用于证明安全恢复。旧 [首次记录](../test-evidence/fresh-resume-budget-first-sol-2026-10-05.json) 和 [工具过滤后记录](../test-evidence/fresh-resume-budget-first-sol-feedback-scoped-2026-10-05.json) 均保留。

将 protected section 改成每步 native context，仍不能修复首步：框架先 assemble snapshot，随后 native admission 等待团队锁；锁放行时成员已正式提交，但首步继续使用此前 waiting snapshot。独立 [native-context 失败证据](../test-evidence/fresh-resume-budget-first-sol-native-context-2026-10-05.json) 和 [失败输出](fresh-resume-budget-native-context-2026-10-05.txt) 保留，未以通用 fixture 的通过覆盖实际失败。

本次主代理与 runtime agent 修复在 admission 后、enter 决策返回前重建同名 native snapshot，框架照常归档最终 user message；adapter 保护最新带 `department:approved-context` 的官方 snapshot。独立最终重截 **15/15** 检查通过：首、次轮合同 SHA 都是 `d394d92c45a0644b7aa645736db35b76b8fba0f89e4cc5c1c1b746020c82d61e`，与原批准合同逐字段相同（既有 `taskPrompt` 排除规则保留）；objective 835B、验收数组 357B。首、次轮均含四份恢复文件的正确 SHA、原 sourceRunId、当前 task/attempt、历史费用与未知预留。

请求文本同时对上 trace `session/user/message` 和隔离 `session.v3.jsonl` 的原生 user/message：首轮 native seq 7/trace seq 37，文本 SHA `935494711504324010f335ba36ea7f04ab0267c70ce9c50a88d7ce92e939e6b1`；次轮 native seq 15/trace seq 54，文本 SHA `deb4655b44b74ad230c797ec84a74a14e97a43747677c28c2cde67ed62b0e5b2`。完整 source SHA 在最终 JSON 中，排除了仅在 adapter 内注入、未持久化合同的假通过。

最终捕获代码在执行期间未变化；`employee-hosts.mjs` SHA 为 `4465d26a2dcb1afb0a1d6af371c9e8aa1e033c0088f65ac3b405861be097ce84`，`openai-compatible.mjs` 为 `74a261af64a95db9f25783c6a8f38144429c71e413befb6fa68c817e8383efb5`。其余 18 份源码/原生库 SHA 见 JSON。此次审查没有编辑业务源。

## 新首轮与后续风险

真实 native 首轮原始 envelope 43797B，按原公式预留 $0.103642，略高于余额；合法 fee fit 移除一个较早的完整分派消息组，保留完整当前 native snapshot（section 13038B）、系统岗位、当前合同和恢复信息，得到 28777B、2 条消息、10 个工具。预留仍按 `((JSON({messages,tools})字节+1024)*2 + 1400*10)/1e6` 计算，即 $0.073602，剩余 $0.0276532 **是冻结余额，不是已花费用**。生产 `teamTaskPlan` 仍使用完整 description，本次没有以去重或占位任务输入降低估计。

第一笔 fake Sol 用量设为 40/10，模拟费 $0.00018，仅供反馈验证。下一步完整 native snapshot 中 occupied 增 $0.00018、available 减 $0.00018、项目与任务剩余调用各减 1。第二轮在移除两个旧组后 37570B、预留 $0.091188，使用模拟后的净余额 $0.1010752。这个假费用不能预测真实首轮成本。

将真实员工文件完整内容和 SHA 加到首轮请求后，仅用最小文件 JSON、保护完整工具组与最新 snapshot，得到以下**乐观下界**；未计新的知识正文、实际工具包装、模型推理、改写内容、复审或经理费用。

| 下一步保留的完整文件 | 保守预留下界 | 首轮假设费用为 0 的结果 |
| --- | ---: | --- |
| server.mjs | $0.083442 | 可预留，余 $0.0178132 |
| acceptance.test.mjs | $0.086882 | 可预留，余 $0.0143732 |
| 全部四份文件 | $0.115490 | 原净额已不足，拒绝 |

若真实首轮登记达到历史敏感点 $0.017152，完整 server 的上述乐观预留仅余 $0.0006612，acceptance 已不足；历史 $0.024954/$0.025912 两点下，两种单文件方案都不足。这些过去金额是敏感性输入，不能当作新请求预测。模型实际操作顺序、合理的黑盒验证、员工生成的更简洁测试及实际新用量未知，不能由“同时读全部四份文件会被门禁”推断全部执行路径已证明失败，也不能省略原合同要求来声称完成。

## 最低风险下一步

主代理完成构建并加载最终修复后，可在网页以原方案、原预算和显式保留两笔 uncertain 预留做一次受控 fresh resume。首轮入口已由真实 native 零付费重建证明可预留；之后应依据第一笔真实收据和新的完整上下文逐步判断，保持项目/任务/次数/未知外部操作门禁。原生预算反馈已如实标记 QA 原估算 $0.02184 被历史 $0.068018 超出，不能再以余下估算 $0.008136 宣称足够完成。

若下一次完整必要上下文或实际用量触发门禁，应保留员工文件、已用次数、未知预留及失败证据，并明确未完成。不得提高额度、盲目重试未知请求、由 Codex 补写产物或把本次两次 fake fetch 标为真实 QA/经理验收。日预算和产品 DB reserve admission 未在本工具创建真实调用，需在实际网页运行中继续由已有产品门禁核验。
