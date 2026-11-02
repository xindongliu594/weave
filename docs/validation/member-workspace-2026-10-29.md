# 成员只读工作台验证（2026-10-29）

## 交付范围

普通 active member 在 IdentityGate 获得独立只读部门、项目、运行列表。管理员 App 不挂载；`identityAuthorized`、通用 `api()`、principalStorage 的管理员边界未放宽。auditor 仍无业务入口并显示准确提示。管理页文案同步当前只读事实。

新 transport 仅接收 departments/projects/runs 枚举，固定 GET/same-origin/no-store，没有 actor header、写请求或任意 URL。沿用会话 generation/abort 和共有响应解析。刷新立即清列表；身份变化、退出、卸载清空并取消读取；同一会话刷新资源时重新由后端校验成员资格。401 使会话失效，403/404 清空列表并显示拒绝提示；失败不重试。项目/运行按服务端每页100条分页，迟到请求与旧 principal 的响应正文不能覆盖新结果。

独立审查发现初版上述“失败不重试”结论未覆盖真实会话发布链路，P2 修复后现限定为：自动会话刷新只重验 idle/ready，loading 不重启请求，error 保留至用户主动刷新；真实身份变化仍由 generation/reset 清空并取消旧请求。初版曾在每次同身份 session publication 时重启所有资源请求，可能使 15–30 秒合法读取持续被中止，也会在失败后自动重试。以下补充 RED/GREEN 修正该证据缺口。

这不是完整成员执行工作台：未接 artifacts、正文、下载、运行详情、执行、审批、重试、取消、部门管理、人员和预算。后端授权为唯一依据，前端不推断部门角色和 canApprove。

## 文件

- 修改：`apps/web/src/IdentityGate.tsx`、`identity-session.ts`、`IdentityManagement.tsx`。
- 新增：`apps/web/src/MemberWorkspace.tsx`、`MemberWorkspace-data.ts`。
- 测试：新增 `tests/member-workspace.test.ts`、`member-workspace-ui.test.ts`；同步 `identity-gate.test.ts`、`identity-management-ui.test.ts` 文字预期。
- 调研/计划：`docs/research/2026-10-29-member-workspace.md`、`docs/superpowers/plans/2026-10-29-member-workspace.md`。

## 实际命令与结果

日志目录：`.private/p0-member-workspace-20261029/`。未修改共享后端、依赖、App.tsx 或 styles.css；未分支/提交/推送。

| 层次 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| RED | `node --import tsx --test tests/member-workspace.test.ts tests/member-workspace-ui.test.ts` | exit 1，4 tests / 0 pass / 4 fail：缺新模块、成员入口未实现 | red.log |
| 状态/请求/SSR组件回归 | `node --import tsx --test tests/member-workspace.test.ts tests/member-workspace-ui.test.ts tests/identity-gate.test.ts tests/identity-session.test.ts tests/identity-reset.test.ts tests/identity-management-ui.test.ts` | exit 0，27/27 pass | green.log |
| 全文件隔离HTTP首次 | `node scripts/test-integration.mjs tests/resource-project-routes.test.ts` | exit 1，before hook 连接回环PGlite时报 EACCES；无业务通过结论 | resource-http.log |
| 同命令放行回环后 | 同上 | 前12项输出通过，后续锁顺序测试无新增输出；仅终止本次 owned session 5254，exit 1；**整份 suite 未通过**，未改超时或共享逻辑 | resource-http-elevated.log |
| 定向资源HTTP | `node scripts/test-integration.mjs tests/resource-project-routes.test.ts '--test-name-pattern=lists\|unknown run lineage\|member run list\|fixed historical'` | exit 0，3/3 pass；首个 lists 分支未匹配到额外测试 | resource-http-scoped.log |
| 部门/项目分页HTTP | `node scripts/test-integration.mjs tests/resource-project-routes.test.ts '--test-name-pattern=department, project pagination'` | exit 0，1/1 pass | resource-http-pagination.log |
| 改动空白检查 | `git diff --check -- apps/web/src/IdentityGate.tsx apps/web/src/identity-session.ts apps/web/src/IdentityManagement.tsx tests/identity-gate.test.ts tests/identity-management-ui.test.ts` | exit 0 | 工具输出 |

HTTP证据执行真实 apiAccess 与 handler，但已有 fixture 替换 authenticate 为合成 principal（读取 fixture header），不是生产登录绕过验证，不能冒充真实 OIDC。成员运行列表既有用例还含合成批准/取消及其权限断言；没有调用真实模型。PGlite 单backend不证明独立PostgreSQL锁并发。

新增7项覆盖成员请求白名单、通用管理transport拒绝成员、pending/disabled/auditor拒绝、独立gate与纯只读视图、清旧/迟到/取消、401/403/非法响应、分页、跨principal迟到正文（部分条件合并为同项）。其余20项是原身份会话、reset及管理组件回归。

## 未验证

完整类型检查和构建留给 root 串行执行；本切片未启动真实OIDC、浏览器或部署，未调用真实模型，也未读取生产凭据/数据。SSR+状态测试不能替代实际浏览器交互与视觉证据。整文件HTTP锁测试尚未完成，已如实保留失败/终止证据。

## 独立审查 P2 修复

修改范围仅 `apps/web/src/MemberWorkspace.tsx`、`MemberWorkspace-data.ts`、`tests/member-workspace.test.ts` 及本报告/原计划。新增 `refreshAutomatically()` 区分自动重验与用户 `refresh()`，前者在 loading/error 时直接返回，后者保留清旧和主动重试语义。组件 session effect 使用自动入口，原 generation/reset 与卸载取消逻辑不变。

使用真实 `identitySession.subscribe` 发布回调触发与组件 effect 相同的自动入口；以手动 `identitySession.refresh()` 代替等待15秒，资源 Promise 可控，不使用真实 sleep。RED 为原逻辑（新入口未存在时调用原 refresh）的行为断言：首批 signal 已 aborted；403 后3次读取增长为9次。

| 层次 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| P2 RED | `node --import tsx --test --test-name-pattern='session publication' tests/member-workspace.test.ts` | exit 1，2/2 fail，分别观察到读取取消与失败自动重试 | review-p2-red.log |
| P2 GREEN | 同上 | exit 0，2/2 pass；覆盖pending不取消、ready可重验、403/网络失败不重试、主动刷新可重试 | review-p2-green.log |
| 前端定向回归 | `node --import tsx --test tests/member-workspace.test.ts tests/member-workspace-ui.test.ts tests/identity-gate.test.ts tests/identity-session.test.ts tests/identity-reset.test.ts tests/identity-management-ui.test.ts` | exit 0，29/29 pass（原27项+新增2项） | review-p2-regression.log |

本次未重跑 HTTP、未改共享资源逻辑，原HTTP证据与未完成事项维持原状。独立复核及统一类型检查/构建由 root 组织，当前报告不提前宣称审查通过。
