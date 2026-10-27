# 原六项 MVP 范围缺口（只读复核）

整体仍未完成；首页历史真实成果有效，无须为 Go 重付费重复创建团队。此表仅读取已保存源码、报告、网页截图和原始 API 字节，核对 23 份两 Run 原始来源的大小/SHA、完整事件序号、创建 snapshot SHA 与真实命令计数。没有查询 live 状态、操作浏览器/数据库/服务、调用模型或修改员工文件、主报告、phase-state。

| 原验收项 | 已证明的真实范围 | 尚缺具体证据 | 最小补证路径 |
| --- | --- | --- | --- |
| 1. 需求与组队 | 10/4 实际失败草案→有效预览→修改 QA 职责→确认。确认前 2 部门/6 项目，确认后 3/7。10/5 两个现有验收项目各有真实 Home chat 与 201 确认；恢复第二轮绑定首轮 previewId、修改员工模型后才确认。规划模型为 Astra，非 Go；确认新增 usage 均为空。 | 原目标的多轮、补充/修改、确认才创建已有历史证据。本项不新增“Go Home 整套重测”或“保存后同队更新”条件。 | 保留历史链及模型来源即可，不创建第三项目、不重复付费。 |
| 2. 真实执行与交付 | 历史 Todo `99551bf3…` 完整成功仍有效。正常 Go v8 同版修复续跑也有独立历史审核。最新保存 normal v11 `9878e368…` 有真实 dev seal；两次开发命令分别 11/12、exit1 和 12/12、exit0。 | v11 在 QA 输入绑定时 `VERSION_MISMATCH: server.mjs` 失败，QA 命令未执行、复审/经理未完成，不能用开发通过代替独立验收。缺两个最终 Todo 各自全部 DAG、五文件、真实 CLI/HTTP 独立测试、复审与经理接受。 | 在两个现有项目内由 AI 确认新合同并实际执行，逐次审批原命令；最终分别保存原全量 Run、完整回执及五文件下载 SHA。不改员工成果补通过。 |
| 3. 断点恢复 | 10/2、10/4 真实恢复机制成果保留，包括完成 dev 不重跑、DAG/文件/预算/调用继承。 | 当前恢复 v8 `c92961f2…` 是 3600 秒 deadline failure，6800 events、18 request/18 wire/18 host calls；受控 stop 全部 0POST，不能当 controlled restart。后续保存项目 v9 DRAFT，无后续 v10 实际 Run 证明。缺新父 Run 受控边界、准确停服/重启身份、同版 child、dev 不重跑和全部后续节点。 | 在实际未来恢复父 Run 的 dev accepted / 首次 QA 待批且无在途边界及原 deadline 内及时受控停止，保存两侧原件后重启并只恢复一次。原 c929 失败/意图不改写、不再 stop；沿用原累计费用和调用限额。 |
| 4. 网页可用性与状态 | 历史实际网页已显示失败草案、待确认、正式保存、命令审批、失败、文件/SHA、费用编号及断连/重连。当前源码分别表达无方案、草案失败、待确认、已保存。 | 当前发布的无方案初态只读截图待 root 补；两个最终 Run 当前 mapping/状态、真实测试面板与五文件下载尚缺。源码/SSR fixture 不算当前实际网页证据。 | `#overview` 只读保存当前无候选初态，0 模型/0 创建；最终两 Run 页面与下载按实际 ID/SHA 核对。`尚未生成团队方案` 文案仅在已有讨论且无 preview/draftIssue 时显示，空会话截图应如实写“无方案初态”。 |
| 5. 知识与数据 | 10/4 真实恢复员工 v1 citations/current v2 已保存。当前恢复项目 10/5 网页 setup 原件含同一 private marker：QA search200 返回完整 v1 私有正文，developer search200 []；完整请求、响应 SHA、部门/员工授权可复用。旧真实业务备份恢复/重开有效；10/5 全目录真实备份 1503 文件/202999631 字节、34 表、两次只读重开和员工开发 8/8 也有效。 | 当前恢复路径缺实际 stop 后两样本 v2 更新、父/子固定 v1、恢复员工真实 read/citations；normal 明确零知识，不须私有 KB。旧备份不含后续最终两 Run 与最新代码/build，缺最新全量代码/数据 manifest、两 Run 恢复指纹、独立测试副本复测及原服务重启记录。 | 复用现有两知识样本与 setup，恢复路径完成 v1固定/v2当前实证；最终按既有 Go 全量离线备份预案安全停服后一次全量复制、两 Run 顺序审核和新 execution 副本复测。在线整体上限仍 50 MiB，capture 的 128 MiB 不扩大在线备份能力。 |
| 6. 工程验证与整体结论 | 历史及新协议/预算/合同/quote/路由/大档案工程回归有效，P0 producer+旧 SHA 已正式 build/加载（root 提供事实）。 | 工程 fixture、helper 准备、quote200、生成/确认200都不能代替员工真实执行、受控恢复或最新备份。原 unknown/provider 账单未核实，不能由本地单价账本或保留预留推出供应方实收费。 | 最终只按对应源码/build SHA、两实际 final capture、网页/知识/备份原件作总判定；缺项保持 blocked，原失败与所有未知费用保留。 |

预算继续是原两个项目、各路径最高 $5、合计新增最高 $10。保存的 normal 项目 cap 为 $4.17970，09:55 UTC 费用帧 available 为 $2.3255923、unknown 预留 $0.096526；恢复 cap $4.77489，09:15 UTC 保存帧 available $4.3192043。这些是历史项目净预算，不能当作现在整个路径/阶段的新支出额度。付费动作仍由 root 在实际 quote、阶段累计已登记费用加全部保留预留均符合原门时执行；上述只读截图与离线备份/副本复测无需模型费用。此审计没有授权新增项目或调用。

首页关键原件：

- [确认前数量](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/new-api-unconfirmed-team-2026-10-04.json)，SHA `d2072d5226671c0b50beba62c19b3c4d3e03a3061102abd9e94f17ba5386c10c`；[修改后仍未保存](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/new-api-before-confirm-2026-10-04.json)，SHA `a1e2764508f650c3948f45d34889254d114997b0a2afba9d367915fd011913a8`；[确认后正式 ID/数量](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/new-api-confirmed-team-2026-10-04.json)，SHA `a8d8ebac2fac5e5fdbf029f1e12ab5e81c8992903e6983749545f69c18f74f4a`。
- [恢复 Home 实际第二轮](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-recovery-send-2026-10-05T12-26-24-602Z-772be376.json)、[恢复确认](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-recovery-confirm-2026-10-05T12-30-00-700Z-6093fcc2.json)、[正常确认](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-normal-confirm-2026-10-05T12-35-46-626Z-5bfc26b6.json)。这些真实来源使用 Astra，不计作 Go 首页调用。
- [全部来源 SHA 与 raw 核验](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-original-scope-gap-readonly-2026-10-06.json)。旧主报告和 Root 当前阶段记录保持原件，最终后续证据由 root 另行交付。
