# 三项目共享 executor fixture 独立只读审查

审查者：`/root/accepted_stop_product_flow/review_three_project_fixture`。结论：**PASS（静态审查），无 must-fix**。

审查范围为 `tests/task-accepted-stop-product-flow.test.ts` 当前新增终态与三项目测试，SHA `5875aff4764cd84d03513ea8ae7932ba2c2aa33efdcefcb20a79e9e5d14445a2`；设备 helper 本批无 diff。审查者阅读了 AGENTS.md、已冻结 terminal finalization 合同及直接相关实现，未改文件、未运行测试、PG 或 Node 重任务。

- 三轮位于同一个 test；只有开头的 beforeEach 清理隔离数据库。fixture 确实复用同一 device ID、grant、token、真实 OpenShellDeviceExecutor 对象及其 journal；后两轮部门/设备行只读核对，没有重建或写入成功事实。
- 每轮均真实运行 A 开发、B 独立 QA、C 经理，通过既有 Product/Host/Handoff/HTTP/CAS 和真实 Node 文件测试。每轮三个 scope 均要求 stopped，C 要求最终 durable team checkpoint → accepted-stop → run/finished 的顺序。
- 后续每轮重新读取前面项目完整 SQL run/scopes/operations，覆盖原 claims/result/merge；重新读取并验证 canonical head/对象、事件文件、device journal 文件及实际文件 manifest，再与前轮摘要完全比较。
- 累计九个 distinct key/sandbox、九个 accepted-stop，running 观察保持原两槽；没有扩大生产容量、预算或改源，也不以清库/删 scope 释放资源。
- saveEvidence 使用 terminal+runId 新文件名，不覆盖旧证据；模型、CLI、UID/cgroup、网关/mTLS 明确为工程 fixture，真实 JJ/OpenShell、原生 PostgreSQL与付费模型不在本证明范围。

这是测试实现的独立审查，不是运行成功证明。实际单项目、连续三项目及必要回归的 explicit exit/source SHA 由 parent 的串行 runner 分别记录；之前进程异常不会因此改记为通过。
