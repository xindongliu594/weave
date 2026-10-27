本次实际受控停止已完成：父 Run `0453cd06-caf6-4fee-91f3-cccb55340a68` 收到唯一一次取消 POST、HTTP 202，最终 public state 与完整 archive 均为 `cancelled`，2432 条连续事件、integrity `ok`。不得重放。原停止报告仍保留 `unverified` 及原失败信息；本报告只解释已保存的真实停止，不修改原件或工具。

独立只读核验通过 98 项断言。冻结停止工具 `916bd285…` 的原 `stoppedCheckpointProof` 在第 244 行重现同一失败。全量费用对象的递归差异严格只有下面两处，其余字段完全相等：

| 字段 | 停止前 | 停止后 | 减少 |
|---|---:|---:|---:|
| `/costs.reserved` | 5.4215139 | 1.2706729 | 4.150841 |
| `/costs.departments/4/reserved`，部门 `f16bb7ee-6868-417d-a9c6-9229d7fa7339` | 4.150841 | 0 | 4.150841 |

该数恰为本 Run 的启动执行额度 `4.3012943` 减去 18 笔已结算运行用量 `0.15045329999999998`。[/costs 路由](C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/api/src/cost-router.ts:26) 使用 [dailyTotals](C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/api/src/cost-control.ts:23)：只有 `queued/running` Run 贡献剩余执行额度预留。取消移除了这项派生的每日运行预留；这不是新增费用、退费或模型调用预留的人工结算。每日 spent `2.1153801` 不变；所有部门 spent、10 条 open receipt、20 条 recent receipt 的金额、状态、完整 history 与 provider reconciliation 对象均严格不变。没有第二项费用差额。

[冻结工具第 244 行](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/stop-go-funded-run-first-parent-web-2026-10-06.mjs:244) 把包含上述派生汇总的 `costsFrame` 一并要求严格相等，因此误报。未放宽该原函数：已独立逐项核对它在此断言前的真实 after 检查及其后的全部不变条件。

| 核验范围 | 保存原件中的结果 |
|---|---|
| 来源与实际操作 | before/after 文件原字节 SHA 校验；实际 Go generation、confirmation、首次批准完整绑定一致。永久 stop intent 保留。唯一请求 `/runs/0453cd06-caf6-4fee-91f3-cccb55340a68/cancel`，正文 `{}`，HTTP 202。 |
| 完整历史与 DAG | 2411 条旧事件全部是 after 的精确前缀。dev 在 seq 1102 的原 accepted seal 和完成身份不变；只有 dev 完成，QA/review/manager 均未完成。 |
| 真实开发回执 | 原命令 `node --test todo.test.mjs`、批准 `7adcbea3-bed0-422c-8925-34963e91220c`、native operation `ef1d5566-e39e-47bd-9ce3-0cdacedf5af6`、宿主 observation 和完整输出 SHA 精确对应，6/6、exit 0、无失败/跳过。 |
| 首次 QA 边界 | `0894126e-3694-462c-9050-cc7430c7b9cc` 是独立 QA 首次 terminal approval；仅 `pending → cancelled`，从未 enqueue/start。seq 2423 的真实取消错误 `[object Object]` 原样保留，不能当作已执行测试。 |
| 调用与预算 | 18 个唯一 registered request 各自对应唯一 wire、provider HTTP 200、settled billing、finish 与实际 usage；前后完全相同，无未发出注册缺口。调用限额仍 100，已用 18。最终 checkpoint 2431 是 source-end 当前预算，后续 accounting events 为 0。 |
| 项目账务与资助范围 | recorded `0.624049`、model hold `0`、available `4.150841` 不变；原 `4.77489` 上限及 immutable admission 不变。oldReadiness、全部 ledger/phaseBudget 原字段严格相等，原未知款项未豁免或结清。 |
| 员工文件 | 4 个当前 manifest/download 项严格不变；每个 captured `artifact_write` 内容的实际 UTF-8 字节数和 SHA 与 HTTP 下载 SHA 一致。开发三文件仍匹配原 accepted seal；QA 的 `acceptance.test.mjs` 已写入但未 accepted。 |
| 本机操作 | 8 个 native operation 全部 completed/started/ok，lateResult 均为 null；前后全对象相等。完整 archive unresolvedOperations 与公开 unknownOperations 均为 0；停止增量没有 queue/start、model 或 billing 事件。 |
| 知识固定 | snapshot 全对象不变；共享、QA 私有文档均固定 v1。开发 shared 及 QA shared/private 共 3 次真实成功 knowledge_read 与 5 条引用事件精确匹配授权的 document/version/SHA/source。尚无 v2 更新或恢复后引用证明。 |
| 页面旁证 | Root 保存的真实 IAB AX 与截图绑定同 Run，显示取消、v10、完成 1、18/100 剩余 82、费用与 raw 一致；20:13:35 的本地恢复条件通过。这只是页面旁证，不代替原始停止档案，也不证明恢复已发生。 |

机器报告：[完整字段差异、98 项核验、HTTP body/source SHA、18 次调用链和文件证据](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-recovery-v10-controlled-stop-reconciliation-2026-10-06.json)，SHA `8b18bbe449036f481df2d4e956875ddc37ff75888199b3fccb1d33b3a33be35b`。

关键原件 SHA：

| 原件 | SHA-256 |
|---|---|
| [原停止报告](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-funded-controlled-stop-2026-10-06T12-02-25-461Z-50f1c04b.json) | `20b1f1f9fa10021f4180feb56cbb32e52ab5d16e234f2aba842e58b8333a8b35` |
| [before，40,230,430 bytes](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-funded-controlled-stop-2026-10-06T12-02-25-461Z-50f1c04b-before.json) | `a1e9a97bff45c702c43cb39427d0862142a643938263d896ea3527a6c1d6b106` |
| [after，40,483,352 bytes](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-funded-controlled-stop-2026-10-06T12-02-25-461Z-50f1c04b-after.json) | `3470ca951d849d2afc92051d63f6dbd2df54f37377f17de72a778a462f4b3bff` |
| [永久 stop intent](C:/Users/JJ/.codex/worktrees/f57c/agent_department/.data/funded-acceptance/web-operation-guards/stop-0453cd06-caf6-4fee-91f3-cccb55340a68.json) | `26c818ed2d6cc594ea27b8923a1be2c0ebad1e877a93ad75f1a8aad6b8bcbe68` |
| [冻结停止工具](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/stop-go-funded-run-first-parent-web-2026-10-06.mjs) | `916bd2856d336edf2e82d9c98777c696f0e03df8a498136070c8b865b2164335` |

本审计未操作 live HTTP、浏览器、数据库、模型、服务或员工文件，未修改源代码、原报告、永久 intent 或 Root 主报告。完整保存帧及其中 compact HTTP body 的大小/SHA 与原 source metadata 相符；整个 `/projects` HTTP 响应没有单独原字节文件，已用实际 Go generation/confirmation、首次批准和完整 snapshot 核对选中项目。

此处只认定已保存的受控取消及派生预留释放可精确解释。KBv2 升级、服务重启、子 Run 恢复、最终 QA/review/manager、两条 Todo 路径与 MVP 总体验收仍须后续真实证据。
