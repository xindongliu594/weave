# OpenRig 可选 API 本地实现验收

2026-10-09，完成本地实现并冻结供集成。未部署生产服务；未启动新 OpenRig 实例或调用模型。

## 范围

- 新增 `apps/api/src/openrig-router.ts`，`app.ts` 仅增加一行导入和一行注册。
- `openrig-bridge.ts` 新增无网络、无写入的 `peekProject`，员工 ID 兼容为伍现有字符串 ID（最长 180 字符）；项目和部门文件名仍要求 UUID。
- 新增 `tests/openrig-router.test.ts` 和[配置与接口说明](../openrig-integration.md)。
- 不改 RunCoordinator，不新增调度器，不自动同步历史项目，不把队列 done 转为项目验收。

## 验证结果

`node --import tsx --test tests/openrig-bridge.test.ts tests/openrig-router.test.ts`：21/21 通过（12 个模块协议回归、9 个 API 回归），退出码 0。

[最终测试输出](openrig-api-local-output-2026-10-09.txt) 保存该轮实际 stdout。岗位或 daemon 前置检查失败时，仅在尚未进入 enqueue 且无本地 receipt 的确定条件下返回 `notSubmitted:true`；丢失写入响应和未知写入均不返回此字段。回归包含前置失败后正常显式重试，以及未知结果不允许重发。

API 回归使用真实 Express loopback HTTP、真实内存 PostgreSQL 兼容数据库 PGlite、真实持久映射文件；OpenRig 网络侧使用明确标注的协议夹具。覆盖：

1. 默认关闭时无 OpenRig I/O；缺失项目返回 404。
2. 私有配置损坏不会阻止应用路由启动，返回脱敏不可用状态。
3. 未映射项目 GET、最多 100 项的批量映射读取不联网、不创建；排除其他部门项目。
4. HTTP 不能覆盖 endpoint/token/岗位；过期项目版本在网络请求前拒绝。
5. 核对真实部门员工与项目的员工来源，拒绝跨部门身份混用。
6. 同项目三个并发 HTTP 同步只产生一次创建，内容不含系统提示或模型配置；远端 done 不改变为伍运行和账单记录；重新构造路由仍读取相同 ID。
7. 外部创建成功但响应丢失后，路由重启并再次同步只执行 GET，核对同一工作项。
8. 未知写入且远端 404，重启后 GET/POST 均保持未知，绝不再次创建。
9. 网络错误不暴露 token、内部路径或原始堆栈，不阻断其他本地只读状态接口。

首次在受限 Windows 沙箱执行时，本地 HTTP 连接被环境以 EACCES 拒绝。通过自动审阅允许的隔离 loopback 测试重跑后全部通过；没有访问真实模型或生产数据库。

全仓 `node node_modules/typescript/bin/tsc --noEmit` 退出码 0。`git diff --check` 无空白错误（Windows Git 有既有 LF/CRLF 提示）。

## 冻结文件哈希

| 文件 | SHA256 |
| --- | --- |
| `apps/api/src/openrig-bridge.ts` | `f9dc28a60583587119796d01b452d91eee585bb3ce819174e9916701903554de` |
| `apps/api/src/openrig-router.ts` | `cdbc23605ce61a80dcc47916d873849270bdae532878f29910898323d71d4016` |
| `tests/openrig-router.test.ts` | `c34cbe8a622c718bea40b36970251ad2db106d98a6bbb471fc24d1419f3f505f` |

## 后续实际联调

[此前独立真实 daemon 验收](openrig-bridge-actual-2026-10-09.md) 保留了此前模块精确 SHA256 和真实操作证据。本次 API 回归不能替代生产 HTTP/UI 与真实 OpenRig 的联调；需在可选配置启用后核对实际部门、项目、岗位 ID 和 qitem ID。

建议先只绑定一个已经确认的部门，用户明确同步一个现成小项目。验证页面列表不产生远端请求、点击同步只创建一次、刷新后可核对同 ID；再检查 OpenRig 会话仍为空且为伍 run/预算/验收仍来自原入口。未绑定部门继续显示为伍原项目流程。当前多版本工作项替换、官方 claim/closure 与 run 关联仍未接入，配置不能被描述为完整持续调度。
