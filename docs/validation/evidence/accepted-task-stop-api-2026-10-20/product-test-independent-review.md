# Accepted-stop 产品测试独立代码审查

结论：**PASS（测试实现与验收口径）**。本审查由 API 实现负责人只读检查独立产品测试负责人的文件；不是对自己 API 实现的独立审查，也不替代本批最终匹配源码的运行记录。

审查文件：`tests/task-accepted-stop-product-flow.test.ts`、`tests/helpers/task-openshell-product-fixture.cjs`。同时核对设备既有 `stopAcceptedTask` / `reconcileAcceptedTaskStop` 的调用接缝。

## 已核对

- 开发 A、QA B、经理 C 均为真实 distinct native task，各自 claim/in_progress、实际 task workspace prepare、文件读写、真实 Node 测试及 completed；断言 key、attemptId、sandboxId 三者分别不同。经理不是只有协调动作。
- SQL 仅初始化批准快照、设备及原输入，成功 local operation 走真实 HTTP poll/claimToken/start/result、canonical CAS；accepted 和 v2 node checkpoint 由 ProductDshRuntime / Host / Handoff 生成，没有 seed 成功 scope、merge、accepted 或 CP。
- transport fixture 运行生产 OpenShellDeviceExecutor、schema-2 journal、维护队列、容量门禁和 CLI 所携带的 REMOTE_SCRIPT。VM 仅映射文件根及已明确标注的 UID/cgroup/CLI；命令测试启动实际 Node 子进程并读取真实工作区文件。
- 正常停止只能从 LocalRunExecutor 的可信 maintenance provider 抵达设备，不从产品测试直连 stop。transport 的 stop 分支是外部 CLI 效果边界，钩子核对已 fsync 的 stop_intent 和 SQL dispatching。
- 正常链断言 accepted → v2 node CP → SQL prepared → stop_intent / dispatching → 单一 stop → 原 sandboxId get → 下一 prepare；两槽原门禁、三 scope 保留、work manifest / storage / SQL scope / committed_outputs / operation raw claim-result-merge 事实均有不变性或 SHA 比较。
- interleave 案例使 B 先有真实 prepare，再在 A 验收后提交；断言停止 A 时当前完整 head 已含 B 的 qa.json，A identity 仍为旧 partial revision，避免用 B receipt 替代 A。
- response-loss 在实际 stop 后返回失败，保持 journal intent / unknown 与 SQL 未决 marker。冷设备与冷 API bind 只核对原 ID；明确禁止 stop/start/create/exec/delete 重放，最终记录同 identity stopped，下一任务普通授权仍失败。
- 旧第三槽失败是变更前捕获的历史 RED；当前源码有 mandatory provider guard，正常最终测试明确跳过历史 baseline。该 baseline 不能冒充当前源码可重复的成功用例。
- 断言始终 profile CLOSED；模型响应是本机固定 fixture，无保存的模型配置、usage 或 reservation；共享旧 sandbox fallback 被显式拒绝。

## 证据与限制

已查看先前正常、interleave、response-loss 运行材料；最终源码四项 API 审查修复后的 matching 三产品用例由产品负责人重新运行中，本报告不提前认定该最终运行通过。未独立重复启动产品套件。

CLI 网关、mTLS、UID/cgroup 和物理隔离仍是 fixture，PGlite 不是原生 PostgreSQL。最终 C 的已验收 scope 仍可能占一个 running 槽，跨 run 终态停止是 root 单独规划的后续门禁；本测试 PASS 不表示整个 Task 5、Task 6 或跨 run 容量闭合。

本审查未改生产/测试源，未执行 Git、安装、JJ、真实模型或付费操作。

## Legacy provider 适配补审

已另只读检查 `tests/task-sandbox-flow.test.ts:96` 起的显式 legacy maintenance adapter 与第四参数注入。adapter 绑定原 workspaces 中准确 key/sandboxId/部分 work revision，调用 beforeDispatch 后才保存原 identity 停止事实；reconcile 只能返回原 identity，重复不新建 effect。旧 storage inspection/retirement/reconciliation 均显式报意外调用，inventory 来自原 fixture workspaces。该段是为保留既有三模式 HTTP/CAS 回归提供明确依赖，没有跳过生产 mandatory provider 检查；它仍是手写设备 fixture，不能替代 sibling 的真实 executor/journal/容量证据。本补审未重跑测试。
