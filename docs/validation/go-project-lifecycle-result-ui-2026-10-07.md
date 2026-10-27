# 项目生命周期标签与经理结果证据加强

本次仅修改网页展示，保留数据库状态、校验结果、批准门禁、员工文件和原始运行回复。

## 项目标签

实际正常项目 `4938eab8-26ed-4f60-9413-d979f05fa968` v14 已 `COMPLETED`。执行后的剩余额度不足以再次完整执行，后端重新计算 `validation.valid=false`。旧项目列表直接用校验字段显示“待完善方案”，覆盖了真实完成状态。

现在列表和最近项目卡片共同使用 `ProjectStatusTag`：COMPLETED/FAILED/INTERRUPTED/RUNNING/QUEUED/CANCELLED 优先显示实际生命周期；仅 DRAFT 根据校验显示“基础校验通过”或“待完善方案”。完成页明确下方校验用于再次执行。批准按钮原 validation、费用、版本与运行状态限制未改，不能借标签修复绕过预算。

实际封存 projects/state 的原字节 SHA 经核对，本地渲染显示“已完成”，`validation.valid` 仍为 false；经理结果仍对应实际 #6999 和报告 SHA。

## 经理主结果门禁加强

此前版本仅经理产物检查完整，其他任务只核对完成/accepted 身份，空输出 seal 仍可能被选为主经理结果。现在全部批准节点都必须具备：

- 同 run/task/attempt 及相符版本的接收证据；继承节点须明确 completed attempt 和 matching checkpoint。
- 输出和输入完全覆盖声明文件、路径唯一，所有 SHA 与大小完整有效。复核 outputs=[] 合法，但不能产生额外未声明文件。
- 固定输入 SHA 与合同相符；产物输入的 producerTaskId、SHA、大小与该来源任务的接收输出匹配。
- 继承来源仅允许 recovery.sourceRunId 或该节点明确 historyRunId，输出还要匹配 recovery.files 的 accepted 状态、producer、SHA、size。没有可证祖先锚则回到原始运行回复并明确交接尚未核对，不能凭任意 runId 字符串提升。

新反例覆盖 dev 空输出/坏 SHA、缺输入、错误 producer/hash/size、复核额外输出、继承错来源/attempt/库存。原经理回复和协调回复均完整保留，未修改运行档案或员工结果。

## 验证

相关纯 UI/项目同步/规划/运行结果测试 **63/63 PASS，0 skip**；类型检查 **exit 0**；本地 Vite 构建 **exit 0**，生成 `index-DobGv_PR.js`。Vite 按此前已验证的祖先目录读取需求经自动审批提升运行，只更新工作区构建产物。

最初扩大回归时误加入依赖独立 PostgreSQL `127.0.0.1:55432` 的 plan-readiness；其前置连接被拒绝，未读取原库。原失败日志保留，未重复该外部路径；本次未修改审批逻辑，最终回归聚焦纯 UI 范围。

证据：

- `docs/test-evidence/go-normal-v14-project-result-local-render-final-2026-10-07.json`（实际封存数据、0 live）
- `docs/test-evidence/go-project-lifecycle-result-ui-tests-2026-10-07-final-v2.txt`
- `docs/test-evidence/go-project-lifecycle-result-ui-types-2026-10-07-final-v2.txt`
- `docs/test-evidence/go-project-lifecycle-result-ui-build-2026-10-07-final-v2.txt`
- `docs/test-evidence/go-project-lifecycle-result-ui-manifest-2026-10-07.json`

本文件不宣布浏览器二次验收完成。主代理已有前版真实经理结果截图；此加强版及项目标签需刷新后再次记录。没有重启服务、调用真实模型/API/Cua或写原数据。
