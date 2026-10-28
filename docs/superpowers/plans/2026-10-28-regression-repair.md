# Weave 逐项回归修复计划

> 按顺序执行，每项先复现、定位、修复、定向验证，再进入下一项。沿用 systematic-debugging、test-driven-development 与 executing-plans。

**目标：** 逐项收敛 `38435f6` 主分支快照已记录的回归失败，保留权限、费用、档案与写入保护规则。

**范围：** 优先复用已有测试、原生 DSH 生命周期与隔离数据库；本轮修复不引入新插件、架构或业务功能。仅确定性本地测试，不调用付费模型、不动生产数据、不默认部署 JJ。

## 顺序与验收

1. 冷恢复取消/超时测试夹具：显式断言 `RUNTIME_WRITER_DRAIN_UNPROVEN`、未结束写入仍阻断、完成前驱保留、后继请求未执行；清理始终执行，测试不依赖强制退出。运行完整 lifecycle 与相邻宿主/写入保护测试。
2. 旧 API 规划与追溯测试：先读取实际状态码、错误与当前权限/导出合同，再判断是夹具过期还是功能问题；禁止放松校验迎合旧断言。验证 `tests/api.test.ts` 全文件及相关授权测试。
3. 备份/能力/身份等其余失败：按首次真实失败逐项归因，环境要求与产品故障分开记录；不把 PGlite 当独立 PostgreSQL 锁竞争，不为测试重装资源或放宽权限。
4. 对已修范围完成类型检查、构建与独立审查，保存阶段记录；之后再安排获准的 JJ 部署与真实小任务验收。

## 执行记录

- 2026-10-28：开始时工作区干净，基线 `38435f6`。冷恢复取消单项原夹具以 `--test-force-exit` 复现：0/1 通过，错误 `RUNTIME_WRITER_DRAIN_UNPROVEN`。强制退出仅用于已知泄漏的红阶段，绿色验证必须自然退出。日志本地保留 `.private/regression-fixes-20261028/lifecycle-red.log`。
- 后续结果按项补充，不覆盖失败记录。
- 第一项完成：生命周期 5/5、相邻宿主/准入/验证写入 21/21，均 0 跳过并自然退出。只调整旧夹具的预期与清理，未改 DSH 或生产守卫。受限模式的文件锁祖先目录读取失败单列保留；正常本机权限相邻测试通过。绿色日志 `lifecycle-green-restricted.log`、`lifecycle-neighbors-native.log`。
- 第二项的知识授权部分完成：旧预期复现 422 `KNOWLEDGE_GRANT_INVALID`；更新为保存即拒绝并核对版本、方案、历史、模型请求数不变，另建立真实测试空间、保存合法授权后撤回，验证批准再次拒绝且无运行创建。相依 2/2 通过，日志 `api-grant-red.log`、`api-grant-green-native.log`。
- 第二项的追溯部分完成：无数据库来源的档案导出返回 404 已复现；补齐分页夹具的真实项目/方案/运行登记，同时保留无来源拒绝断言。完整 API 14/14 通过。中间一次夹具缺少员工字段影响后续列表，已补齐并全文件重测；失败与最终日志分别保留 `api-full-green.log`、`api-full-final.log`。
- 第三项开始：31MiB 备份测试复现旧 `before-restore-*` 查找位置不匹配；改按已提交恢复收据定位运行目录旁的旧档案，另核对控制 manifest 哈希和 committed 记录。红阶段日志 `backup-size-red.log`。
- 备份大小部分完成：31MiB 加密导出/恢复/再导出、50MiB 超限拒绝 2/2 通过；旧文件按数据库恢复操作编号定位，manifest SHA 与 committed 控制记录均匹配。日志 `backup-size-green.log`。未据此替代原生 PostgreSQL 中断恢复或企业新备份验收。
- 第五项完成（产品缺陷）：公司知识无所属部门时，知识版本的 SQL 范围聚合产生 `[null]`，写入链将其当作非法部门而误报 404。复用相邻 candidate 分支的非 NULL 聚合方式，只改共享查询一处。新增最小测试先复现 `[null]`；绿色覆盖空范围、继承 A 部门、owner/admin 写入及 member/auditor/device/system 的 viewer/operator 拒绝。原公司方法更新、固定版本和归档行为不改预期。授权/公司能力/来源闭包四文件 43/43，日志 `company-scope-red.log`、`company-scope-green.log`。
- 第六项完成（夹具）：协议测试原先在监听前 full shutdown，身份关闭后 6 个请求均 503；改为已有 shutdownBackground 并等待 ready，最后仍完整关闭。Responses/Chat 协议、账单预留与未知结果不重试 6/6；身份初始化/关闭屏障 4/4；加固后的资料权限 17/17，均零跳过。日志 `completion-protocol-red.log`、`completion-protocol-green.log`。
- 第七项完成（夹具）：部门工作台旧独立路由没有 principal，5 项均 401，且手造表缺少当前来源校验字段。复用隔离 runner 和正式 migrate，显式提供测试专属 local-owner 依赖；生产 httpPrincipal 不改，另断言无身份仍 401。工作台 5/5，相邻完整资源项目路由 20/20，日志 `workbench-red.log`、`workbench-green.log`。
- 七项均已完成独立审查，无 Critical/Important 问题；最终类型检查与构建退出 0，保留既有 chunk 大小提示。本阶段共 14 份文件、120 个不重复用例有绿色证据，不将重复运行的授权 17 项或规划 2 项重复计数。全部为确定性工程验证，真实模型调用为 0。
- 下一批仍按顺序处理员工历史/执行策略/扩展备份旧回归。特别保留 `BACKUP_SOURCE_IDENTITY_UNSUPPORTED` 企业身份与审计备份保护：不能清空审计记录或拆掉门禁来制造通过。嵌入资源未装、独立 PostgreSQL 并发、JJ 新部署及真实员工验收另列，不由本阶段替代。
