# 首页需求对话与执行预算分离

2026-10-07。按用户要求，首页多轮需求对话不再预估或预留费用，也不按单次、项目或每日执行预算拦截。新对话候选确认不把聊天费用归入执行项目，项目预算完整用于批准后的执行。中转站照常计费，实际 Token 回执仍记录；费用不明不会按零结算。

项目 AI 规划、连接/工具测试与项目执行的预算、审批和权限规则保留。每日执行限额仍是 $20（UTC）；只有服务端明确标记的新对话记录不参与该额度。旧请求、旧预览、已经采用的费用与未知预留不迁移、不清除；旧 pending 请求正文与幂等 key 原样保留，不自动重放。

## 实际验证

- 本地 API 回归：费用10、组织对话16、旧方案更新7、会话兼容10，共43项通过；网页31项通过，合计74个不同测试，无skip。重复跑过的相同测试不重复计数。
- 首次新增对话回归错误地期待每日预算门禁，实际先被严格执行报价拒绝为 PLAN_NOT_READY；原失败日志保留。修正测试断言后16/16通过，没有弱化执行校验。成本回归另行验证每日执行额度和单次执行费用门禁。
- 类型检查退出0，Vite生产构建退出0，当前网页包 `index-ZW2J3FhD.js`。
- 原工作台准确停止旧 API43484/启动器51376、闭库后沿原数据目录重启为启动器3452/API29692。健康/数据库/运行器正常，原637用量、全部项目与Run、两最终项目费用和未知预留原样；没有发真实模型请求或自动恢复项目。
- 真实浏览器检查：组建设置只有项目执行预算，没有单次回复费用输入；费用页明确显示新对话已记录费用及预算计入费用。仅查看和展开页面，未修改用户原草稿/模型或发送付费请求。

## 证据

[独立源码与回归审核](conversation-budget-independent-stage-audit-2026-10-07.md)、[新对话16项回归](conversation-budget-api-recheck-2026-10-07.txt)、[费用/会话/旧方案27项回归](conversation-budget-compatibility-regression-2026-10-07.txt)、[网页31项回归](conversation-budget-web-regression-2026-10-07.txt)、[类型](conversation-budget-types-2026-10-07.txt)、[构建](conversation-budget-build-2026-10-07.txt)。

[受控服务重启](../test-evidence/go-owned-service-20261007-135820-fda280fe.json)、[原数据返回核对](../test-evidence/conversation-budget-reload-2026-10-07/sources.json)、[首页完整浏览器记录](../test-evidence/conversation-budget-home-settings-full-2026-10-07.txt)、[费用区实际文字](../test-evidence/conversation-budget-costs-section-2026-10-07.txt)、[设置截图](../test-evidence/screenshots/conversation-budget-settings-2026-10-07.jpg)。

这次是计费行为的工程回归及实际网页验证，不冒充新的真实模型验收。此前真实 Todo 正常/恢复验收和备份证据仍属于原运行版本；没有为了此改动再次付费重跑。
