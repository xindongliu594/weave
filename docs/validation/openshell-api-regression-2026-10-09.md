# OpenShell 设备 API 工程回归

结果：新增隔离 API 集成 **7/7 通过，0 跳过**；执行环境证明单元测试 **3/3 通过，0 跳过**。相关代码尚需由主流程完成构建、部署与真实员工验收。

运行命令：

```powershell
node scripts/test-integration.mjs tests/openshell-api-admission.test.ts
node --import tsx --test tests/execution-backend.test.ts
```

机器证据：[openshell-api-regression-2026-10-09.json](./openshell-api-regression-2026-10-09.json)。完整通过输出：[API 集成](./openshell-api-integration-2026-10-09.txt)、[单元测试](./execution-backend-unit-2026-10-09.txt)。

实际覆盖：

- 原生设备旧配置默认迁移为 native；OpenShell 设备仅接受 Linux，公开设备响应不含凭据。
- 已注册设备不能更改执行环境指纹、授权或平台，不能自行恢复被撤销的授权。
- 运行的已批准方案必须绑定设备 OpenShell 元数据；未绑定或指纹不同的方案在进入操作队列前拒绝。
- 员工必须拥有工具权限；命令必须匹配该员工、该运行、该次批准的完整参数。
- 成功回执必须有合法沙箱身份、非 root UID/GID、固定 Node、1 核 CPU 配额、512 MiB 内存及固定策略哈希；不合格回执不将已开始操作标为成功。
- 合格结果持久保存，完全相同的重传幂等，冲突结果拒绝；网页查询保留执行环境证明并隐藏文件内容与领取凭据。
- 丢失的未开始领取可以重发；已开始而尚未获得结果的操作只返回 orphan，不重新执行，也不调度下一项。
- 撤权后到达的结果保存为迟到证据，运行不被标为成功，设备不重新启用。

本套测试使用新建的内存 PGlite 数据库、loopback HTTP 与声明式执行回执样本，验证实际 API、认证和 SQL 状态变化。没有连接当前为伍数据库，没有模型调用，没有运行 OpenShell 或声称验证物理隔离。回执元数据核对不等同于密码学远程证明。

首次普通沙箱运行因 Windows 对 loopback 的 `EACCES` 失败；获得执行环境放行后重跑。一次额外的“重复使用同一审批 ID 触发唯一约束”尝试使 PGlite socket 出现 `Received unexpected commandComplete message from backend`，其失败日志保留在私有研究目录。最终 7 项用例不包含该约束路径，也不声称覆盖 PostgreSQL 多连接行锁；单次 `/start` 与结果重传语义已实际覆盖。
