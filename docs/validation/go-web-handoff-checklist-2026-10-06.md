# Go 网页交接只读检查清单（2026-10-06）

审查时间：2026-10-06 12:57 +08:00。只读检查当前源码、已保存真实 Edge 页面证据；本轮未访问真实 API、模型、数据库或员工工作区，未启动服务。本文记录修复前结论。根任务随后授权的 UI 修复须另附源回归报告，不能据此补写真实验收通过。

整体交付仍待验收。父任务已报告开发与独立 QA（7/7）accepted；复审的本地状态读取超时正在修复，经理、受控恢复、知识 v2 和新备份尚未通过。本文没有用 fixture 替代真实结果。

## 已保存页面能够证明什么

[真实 inspect JSON](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-run-web-normal-inspect-2026-10-06T04-33-06-405Z-ab769b6c.json) 与 [页面截图](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/screenshots/funded-run-web-normal-inspect-2026-10-06T04-33-06-405Z-ab769b6c.png) 记录正常项目 `4938eab8-26ed-4f60-9413-d979f05fa968`、方案 v8、Run `0947ae05-5c3c-47d0-969b-5c8a739118f1`，状态为失败、3133 条事件。截图显示复审任务以及 `agent_teams_status` 的 `ABORTED` 原因，有明确中文失败说明和“返回项目修改方案”入口。

截图中的项目费用是当时值：已记录 `$0.848147`、预算 `$4.17970`、未知费用预留 `$0.096526`、净可用 `$3.235027`；本次 Run 已记录 `$0.218602`。顶部 `$1.98374` 是工作空间已记录费用，不能当作项目费用或厂商账单。inspect 明确没有请求带预留过期维护的 `/costs`，因此不能从这张截图验证全局预算余量。

截图仅覆盖页面顶部，尚未展示完整任务图、审批、所有文件下载、恢复检查和知识引用。JSON 保存的时间线文本同时出现方案任务 `dev` 与原生任务 `t1`，也显示“加载后续事件”。两种编号并存是实际证据；下面描述的 UI 缺陷仍需对应浏览器证据。

PNG SHA256：`444fbdf7fbddf3b738140699ced2358220df745e89f14db6d78bfb223409a8b2`。

## 源码确认的操作问题及最小修复

| 项目 | 触发与影响 | 最小修复建议 | 现有证据边界 |
| --- | --- | --- | --- |
| P1 停止后的详情未刷新 | [RunCenter.tsx:58](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/RunCenter.tsx:58) 只轮询运行中的状态；[RunExtras.tsx:18](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/RunExtras.tsx:18) 的“刷新审批与交付”只刷新审批、产物、本机回执。终态出现迟到回执后，父详情的 unknownOperations、summary、recovery 仍可能旧；恢复检查返回新操作编号，和旧 props 生成的 key 不相等，按钮持续失效。整页刷新能重读，但局部“刷新”无法解除。 | 父组件提供详情刷新，终态手动刷新同时更新完整 summary/recovery/metadata；合并已经加载的 events，保留 cursor。继续保留费用和未知操作的确认门禁。 | 源码路径明确；提供的截图没有证明本次恰好遇到迟到结果变化。 |
| P2 原生编号与批准编号未统一 | [RunExtras.tsx:36](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/RunExtras.tsx:36) 直接展示 team.tasks 原生编号；[run-handoff.ts:21](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/run-handoff.ts:21) 按 handoff 的批准 taskId 查状态。`t1` 与 `dev` 不等时，当前交接失败可能只留历史，任务依赖、员工状态对应关系难以核对。API summary 没有 task-mapping。 | 使用实际 run/task-mapping 或 seed_id，将批准任务合同和原生状态对应起来；DAG、状态、交接统一批准编号，保留原生编号便于追溯。不能把未核验的 native completed 直接称为 accepted。 | 保存文本证实两类编号；截图未覆盖任务图或交接横幅。 |
| P2 长运行的岗位查看依赖分页 | [RunCenter.tsx:79](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/RunCenter.tsx:79) 员工列表只从当前已加载 events 推导；直接打开长终态运行时首批 300 条之外的 QA/复审会话可能尚未出现。 | 员工岗位入口先显示批准 snapshot 的全部角色；会话过滤仍按实际已归属的会话。可独立于上述最小修复另行处理。 | 源码与 3133 条运行明确；没有后半页截图证明本次员工缺项。 |

审批卡会显示完整 arguments 并提供批准/拒绝；真实测试区保留失败和复测输出；Run 交付物提供逐文件下载与文本预览。目前没有源证据说明这些入口本身不能操作。文件行和“已核验的文件版本”仅显示 SHA 前缀，人工核对完整哈希要用完整追溯或下载清单；[WorkFilesCenter.tsx:12](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/WorkFilesCenter.tsx:12) 已有完整 SHA 复制入口，可供后续小改复用。未验证“大档案导出是否超时”，不将猜测列为已发生缺陷。

恢复的默认拒绝、费用预留保留和重新检查机制应继续保留。`pending` 费用阻断、unknown 外部操作需单独核对、净预算与历史调用上限约束都是当前操作语义。功能验收与财务核对须分开：历史 Astra `$0.7603`、GLM 400 `$0.0016958` 及其他 unknown 按原账本保留；厂商账单未知继续 blocked，不能靠网页“已记录”金额或功能完成吞掉财务阻断。

## 首页默认模型的真实机制

[OrganizationChat.tsx:118](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/OrganizationChat.tsx:118) 在 modelId 为空时选择第一个 available 模型，未指定 Astra 或 Go；[app.ts:47](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/api/src/app.ts:47) 目录按模型 UUID 排序，不能推断首项是 Go。

当前标签页的 `sessionStorage` 键 `agent-department:organization-chat:v1` 保存 modelId、设置和对话。已保存 Astra 若仍可用，会继续被选中；不可用时显示“原模型不可用，请重新选择”，不会自动换成 Go。未读取真实标签页存储，因此不能说该页面当前一定保存 Astra。[App.tsx:106](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/App.tsx:106) 的“新建项目”只回首页，首页对话一直挂载；[OrganizationChat.tsx:73](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/OrganizationChat.tsx:73) 的“新需求”也保留模型、policy 和回复费用上限。

选择“负责组建的模型 → Go · DeepSeek V4.1 Flash”会加入允许模型列表，但不会删除旧列表中的 Astra/Luna/Sol。需要展开“组建设置 → 员工与后续规划可用模型”，明确取消旧模型并保留 Go，再发送需求。已存方案仍需检查每个岗位的模型，选择组建模型不会改写旧方案。

若有 pending 请求，模型和设置被锁定。“继续获取回复”沿用原正文与请求编号；或在请求不忙时选择“保留未知费用，开始新需求”，将完整旧请求归档到本标签页待核对记录，再明确选择 Go。不得改旧请求正文/编号或删除未知费用来绕过。

## 待补的真实浏览器与交付证据

- [ ] 首页截图：旧草稿和空草稿分别显示实际选项；明确选择 Go 后，负责组建下拉、允许模型列表、候选岗位模型、确认方案版本一致。不要为取截图重复收费生成。
- [ ] 执行详情首屏与下半页：准确 Run ID、方案版本、4 个批准任务、依赖、岗位、attempt、accepted/blocked 与原生编号对应；直接打开长终态运行时能找到全部岗位。
- [ ] 审批：实际唯一 pending 卡、完整 command/expectedWorkspaceRevision、一次批准与真实本机回执绑定。命令退出码、测试计数和当时所有文件 SHA 同时成立；失败/复测都保留。
- [ ] 复审与经理：独立只读复审、经理真正接受当前输出，随后运行完成；不能用 dev/QA accepted 或 Node exit0 替代后两项。
- [ ] 刷新与恢复：停止后收到迟到回执时刷新能更新列表与 key；默认未勾 unknown 费用拒绝；明确保留后仍受原净预算与调用次数限制。实际子 Run 延用已核验检查点，dev 无重复，未确认外部动作无自动重放。须保留 parent/child/receipt 和费用历史链。
- [ ] 下载：每个实际交付文件的下载字节、完整 SHA 与最终 accepted manifest 相等；README 与实现、两份测试文件及报告齐全。页面逐文件下载；没有源码提供的“一键 ZIP”承诺。按实际 README 核对 Todo 启动命令与端口。
- [ ] 知识：批准时 v1 的真实引用可回读；当前 v2 文档、grants 和拒绝未授权访问证据真实绑定。当前未完成。
- [ ] 财务：所有 unknown/orphan 原样保留，模型 pending 为零后再做受控维护读取；全局原 `$10` cap 和项目净余额分别核对；厂商账单仍未知时独立 blocked。
- [ ] 备份与重启：根任务按原服务 identity 停服后备份当前代码与全部数据；新交付代码/数据绝对路径、manifest 字节 SHA、两个真实 worker/Run 的读取和恢复证据。当前新备份未完成。

## 中文用户步骤草稿（实际验收完成后使用）

1. 从最终交付的代码目录启动 `start-local-production.cmd`。源码要求 PATH 中有 Node 22.19+（22.x）或 24+ 与 npm；首次缺依赖时先执行 `npm ci`、`npm --prefix services/agent-runtime ci`。窗口保留，默认打开 `http://127.0.0.1:4310/`；已有服务时使用已有页面。
2. 沿用本轮项目时，根任务必须给出最终数据目录。在最终代码目录的 PowerShell 执行 `./start-local-production.cmd "--data-dir=<最终绝对数据目录>"`。省略参数会使用该代码目录下 `.data/local`，不会自动寻找另一份库。停止使用 Ctrl+C；不要删除启动锁。当前审查代码目录是 `C:\Users\JJ\.codex\worktrees\f57c\agent_department`，最终备份位置待根任务确认。
3. 在“模型目录”检查 Go · DeepSeek V4.1 Flash 的文本可用和已保存工具往返测试结果。配置为 `deepseek-v4.1-flash`、Chat Completions、显式“关闭 thinking”；不必为了查看结果再次触发收费测试。
4. 到“需求组建”，明确选择“负责组建的模型 → Go · DeepSeek V4.1 Flash”。展开“组建设置”，核对预算、回复费用上限以及“员工与后续规划可用模型”，取消不打算使用的旧模型，然后描述需求。网页保存的旧模型不会自动替换。
5. 检查 AI 返回的各岗位、任务依赖、工具授权、验收标准和模型，再点“确认组建团队”。保存方案后到“项目与方案”，基础校验通过、费用条件满足才点“批准并运行”；这一步开始真实收费执行。
6. 在“执行记录”逐次检查命令审批，只批准本方案规定的命令与完整参数。本轮 Todo 的两条测试命令是 `node --test todo.test.mjs` 与 `node --test acceptance.test.mjs`；以实际批准版本为准。查看最终文件版本对应的测试计数、独立复审和经理结果。
7. 失败时先看原始原因、本机回执、已有产物与费用，刷新详情，再点“检查恢复条件”。核对 unknown 费用与外部动作后才决定保留预留并“恢复未完成任务”；该选择继续占用原预算。“完整重试”会重做全部任务。
8. 经理验收完成后，从该 Run 的“交付物”逐文件下载并保存完整追溯；按交付 README 启动 Todo。“文件与项目导入”用于参考素材的独立快照，不是 Run 产物下载入口。新导入文件还须在方案中选择并授权员工。

启动语义依据：[start-local-production.cmd](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/start-local-production.cmd)、[scripts/local.mjs:9](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/scripts/local.mjs:9)。没有执行这些命令。Todo 自身 README/启动端口未在此只读任务核验，故未编写启动参数。

## 审查源快照 SHA256

| 文件 | SHA256（修复前） |
| --- | --- |
| apps/web/src/RunCenter.tsx | `57d924abeaee05bbb8dc34606363cac62008550beb12d36195331d905795c966` |
| apps/web/src/RunExtras.tsx | `3a79b946978a99f402da79cc0fa54cbd02dfed47d9ceade33357e87e75911672` |
| apps/web/src/RecoveryConditions.tsx | `e48b869ba520a9107ca2f82d165889540abc27d53b8518e3f6f0b6e0f70e9314` |
| apps/web/src/WorkFilesCenter.tsx | `7d779b5dbcf193a0816d3faaa31c1d395c50adca9af94611c53e9980081a4350` |
| apps/web/src/OrganizationChat.tsx | `2192514039ba55c4cd49c036b7b63e143cc9ca1944d91eef5425d64a82b49d9d` |
| apps/web/src/App.tsx | `d024441ec9a70236a08f4dae67c5f63a22d5c6954064f4be63cb85e25ce3633a` |
| apps/web/src/run-handoff.ts | `7c73523ea0daea8d7ff9274fbf7039ddcdeebc34043ff7c2a80b16b001cb0e18` |
| scripts/local.mjs | `79c9d0dc4b3b5921d4b07c6ccd71fd028b2703370f99f19a55b5d13e36550049` |
| start-local-production.cmd | `cb93d44b1d98f473b55693affde606e50f60f060227f9add4d366e2b4b0949d8` |
