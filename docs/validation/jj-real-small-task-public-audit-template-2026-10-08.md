# JJ 真实小任务独立审计（待最终运行证据）

本文件是待填模板，不是最终通过报告。只有明确运行 ID 的完整原始审计包和网页证据齐备后，才能把相应项目改为通过。

## 当前已核实的阶段事实

- JJ 网页服务、DeepSeek 真实连接与工具往返已验证；员工仍在 JJ 用户权限的 Node 执行器运行。OpenShell 管理网关 mTLS 正常，员工隔离探针仍因 ImagePullFailed 受阻；不宣称 OS 隔离或长期部门已通过。
- v8 Run `5513740d-bc77-4f8e-bda2-54845b960e41` 已失败：首次真实 QA 为12项、10通过、2失败；涉及小数断言和空字符串接受。放宽空输入要求的复测被拒绝，经理未验收成功。旧文件、失败日志和费用保留。此次阶段快照累计登记 `$0.5395047`、holds=0；这是当时状态，不是后续实时金额。
- v9 正式方案预检通过，三个任务/三个员工，单次输出8192、contextBytes128000、项目上限 `$1.90`；本轮 JJ 总授权 `$2`。v9 明确空/纯空白必须非零拒绝，小数使用容差，经理须完整原生提交。该 PASS 仅证明方案准入，不证明业务完成。
- Root 已通过网页启动 v9 Run `f86bfd4f-265d-43f4-ad30-5c5c1140dd92`，正在开发/QA/经理流程。已知启动阶段不能填作 completed；独立最终审计尚未执行。

事实来源：本地 `v8-after-qa-denial.json`、`normal-v8-qa-first-output.json`、`v9-preflight-final.json`；原件在 JJ metadata/logs。模板未发送模型请求、未写业务数据库或补写员工交付物。

## 最终结果（等待实际包）

| 项目 | 正常路径 | 受控恢复路径 |
| --- | --- | --- |
| 项目/方案版本 | `4ae5cce4-73c1-420a-987f-83db54d196f2` / v9，最终状态待审计 | 待填同一批准版本 |
| 运行 ID | `f86bfd4f-265d-43f4-ad30-5c5c1140dd92`，最终验收待执行 | 待填 parent / child |
| 独立审计包目录与 SHA256 | 待填 | 待填 |
| 三名员工的真实模型回执 | 待验证 | T1沿用、T2/T3待验证 |
| 交付文件与实际字节 SHA | 待验证 | 恢复原始3文件及最终SHA待验证 |
| QA 当前版本真实测试 | 待填 counts / exitCode / revision | 待填 counts / exitCode / revision |
| T2宿主交接、经理原生提交及T3通过 | 待验证 | 待验证 |
| 停机/重开来源及版本绑定 | 正常路径不适用 | 待验证，不能借用旧v4证明 |
| 已完成开发节点未重放 | 正常路径不适用 | 待验证 |
| 本轮费用、旧费用继承、未知预留 | 待填实际快照，不能写0重置旧费用 | 待填实际快照与调用继承 |
| 网页审批、结果和下载截图 | 待验证 | 待验证 |

审计必须同时证明 snapshot project/version/policy、批准真实 Go route、非fixture、原生任务映射、员工身份/session/attempt的真实wire和已落账费用。QA须关联同run的批准命令、已启动操作、完整输出counts与SHA、当前workspaceRevision和T2接受；不能引用上一版的通过记录。经理须有成功的原生 `agent_teams_update_task`、同attempt的正式pass审查、T3宿主接收和原生completed状态，普通最终回复或mail不算完成。

## 可复现入口

私有 `make-explicit-audit-command.py` 只根据人工明确的 UUID、版本、模式打印可审阅命令，不执行、不开SSH、不取最新运行。Root先上传并核对正式审计脚本SHA，再在JJ运行所打印命令。正常模式指定 `--normal-run`；恢复模式指定不同parent/child和两个proof文件名。结果 `passed/failed/partial` 与原始包必须保留，不为出报告重复付费请求。

停机和重开证明均须绑定实际 `sourceRunId=parent`、projectId、planVersion及policy（context128000/maxBudget1.9）；冲突snapshotVersion、旧证明或其它来源一律不能通过。最终报告应另列真实失败和仍受阻事项，禁止把本模板的待填项目当作证据。

费用表记录宿主依据已收到 Token 用量和固定报价计算的预算账本。没有独立供应商账单核对时，不把这些金额写成已核实的供应商 invoice。
