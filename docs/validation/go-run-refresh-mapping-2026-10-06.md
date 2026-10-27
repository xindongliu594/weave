# Go 执行详情刷新与任务编号 UI 回归（2026-10-06）

已完成根任务授权的两处局部 UI 修复。最终本地回归 **31/31 通过**（新增 11 项、既有 20 项），`tsc --noEmit` 与 `git diff --check` 均 exit 0；测试前后记录的 15 个输入文件 SHA256 全部一致。源码与测试现已冻结，生产网页构建和真实浏览器复验由根任务执行。

这是源回归结果，不能作为 Go 模型、经理验收、受控恢复、知识 v2、费用结算或备份成功的真实证据。本轮没有访问真实 API、模型、数据库、原始运行目录或员工文件，没有操作浏览器，没有启动/停止进程，没有执行员工测试命令或生产构建。

修复前的只读结论、真实失败截图范围、首页模型保存机制、用户步骤和待补证据仍保存在 [交接检查清单](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-web-handoff-checklist-2026-10-06.md)，未把其中待验收项改为通过。

## 变更与行为

- `RunCenter.tsx` 提供详情刷新，使用现有只读 `GET /runs/:id?after=<已加载 cursor>`。返回的全量 summary/recovery/metadata 更新当前详情，已加载事件合并并按 seq 去重；游标保持向前，较旧的重叠响应不能回退 metadata。同一详情的其他 Run 或方案版本响应不参与合并。
- `RunExtras.tsx` 的“刷新审批与交付”同时刷新父详情与费用读取；按钮名称保持。未知操作编号列表变化时清除旧外部操作 ACK 和旧恢复检查结果。费用、pending、净余额、调用上限及恢复条件匹配守卫保留，刷新不提交恢复或模型调用。
- 新纯模块 `run-detail-view.ts` 使用已加载的 `run/task-mapping`，以及 summary 中真实返工 bindings、原生 `seed_id`/`profileSeedId`，将 live 状态对应批准任务合同。DAG 和交接使用批准 taskId，显示原生编号供追溯；最新返工编号优先于旧已完成节点，缺少最新状态时显示待调度。
- 原生 `completed` 只有准确 taskId/attempt 的当前 Run 宿主 accepted 才显示“已完成”。批准快照中显式继承的 recovery.completed 与 handoffCheckpoints 必须同一任务尝试；合法祖先 seal 可以沿多次恢复继承。外部 accepted 事件不能替代当前批准快照的继承 seal。若 record 有 planVersion，还须匹配当前方案。未核验的完成显示“等待交接核验”，未映射节点单列“未关联批准任务”。此视图不替代后端对文件 SHA、依赖和权限的验证。
- 根任务另外明确授权 `tests/run-status.test.ts` 仅将费用入口期望从 `#settings` 对齐为已存在的 `#usage`；其恢复按钮 disabled 断言未修改。其他 API、契约、policy、首页默认模型和冻结审计工具未改。

## 验证与失败记录

最终命令（当前工作区、固定本机 Node）：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --import tsx --test tests/run-refresh-mapping.test.ts tests/run-events.test.ts tests/run-handoff-ui.test.ts tests/run-status.test.ts tests/recovery-conditions-ui.test.ts tests/cost-carryover-ui.test.ts
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/typescript/bin/tsc --noEmit
```

新增纯 fixture/SSR 回归覆盖终态迟到结果、全量 metadata、分页重叠、Run/版本隔离、恢复 key 与费用/ACK 失效、批准 DAG/岗位不被原生字段改写、最新返工覆盖旧完成、准确 attempt/Run/版本接受、直接及多次继承检查点、未映射节点、实际 RunExtras 渲染且无任何动作。没有网络 fixture、模型调用或实际网页操作。

首轮原结果是 28/30、exit 1：新增 SSR 断言误期待静态渲染不存在的 HTML 注释；旧 run-status 测试仍期待 `#settings`，而修复前源码已使用 `#usage`。原失败工具输出摘录保存在 [first-failure.txt](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06-first-failure.txt)，明确标注摘录而非完整 stdout。修复前 `RunExtras.tsx` SHA 为 `3a79b946978a99f402da79cc0fa54cbd02dfed47d9ceade33357e87e75911672`。首次纠正后 30/30 的 [日志](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06.txt) 和 TypeScript 日志保留；加入多次恢复 fixture 后，最终 [31/31 日志](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06-final.txt) 与 [TypeScript 日志](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06-final-tsc.txt) 单独保存。

## 冻结快照

完整测试输入 SHA 与前后验证时间见 [sourceSHA.json](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-run-refresh-mapping-2026-10-06-sourceSHA.json)。

| 本轮变更文件 | SHA256 |
| --- | --- |
| apps/web/src/RunCenter.tsx | `89b8fa13e6c0957fb0be5a29c6f99cff2bae2d214f7b803848d404c5305a155a` |
| apps/web/src/RunExtras.tsx | `ba49cc904db20dcda7bd921c1b89c8641cfdcd287f36ab5ff4ef94dae98c66f0` |
| apps/web/src/run-detail-view.ts | `1a003468695cc698511ed4efab57ea94890c7d18b2bdccb54b683bbb90ada8f8` |
| tests/run-refresh-mapping.test.ts | `90a4c9236bbb0a4b21c4752e8290154a20606c97183f0b4661f20d65459e11b6` |
| tests/run-status.test.ts | `dac42afb75467114d56b8d55ed1f9326e2c26c81b517d2532af0dca52b2ec707` |

仍需根任务真实浏览器检查停止后刷新、已批准任务图、交接横幅与迟到操作 ACK 更新。长终态运行的完整员工岗位列表仍依赖事件分页，是交接清单中的独立 P2 项，本轮没有扩大到该界面重构。首页仍必须显式选择 Go DeepSeek；未读取或修改实际 sessionStorage。
