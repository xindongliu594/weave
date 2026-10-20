# 企业登录网页接线：阶段验收

2026-10-20，基线 d38cfa7。本记录只覆盖身份网页接线、兼容启动和身份持久化；企业基础十项仍未完成，JJ 企业模式未启用。

## 实际修改

- 网页先确认 `/auth/session`，通过后才挂载业务页面。区分本机单人、管理员、待开通、停用、暂未开放的成员、未登录及服务不可用；不因连接失败退回本机管理员。
- 不安全方法统一带 CSRF，包括规划报价 POST；保留原请求编号、未知写入和费用语义，不自动重发。
- 身份变化取消读取、清空三个全局快照、卸载预览与业务组件；晚到响应不能跨账号发布。需求、规划和 OpenRig 草稿按账号保存，原本机草稿保留原键，不自动移交企业账号。
- 登录 POST 返回受信 OIDC 授权 URL 的 JSON，再由浏览器导航；回调仍由服务端验证 state、nonce、PKCE、issuer、签名等。
- 补全静态、开发及演示启动器的 `/auth` 代理，全部指向各自实际 API 端口。
- 独立复核发现并修复退出结果不明后自动轮询重新打开旧账号、开发代理串到默认端口、页面恢复时先显示旧身份的问题。退出未确认时保持关闭，只允许用户明确刷新核对；pagehide/pageshow 在重验前关闭业务页。
- 实际浏览器发现“无部门”首页空值判断白屏：`undefined === undefined` 后读取 null.offset。显式非空判断修复，并保留真实 React 渲染回归。

## 已验证

| 层次 | 命令/方法 | 结果 |
| --- | --- | --- |
| 前端、启动配置、空首页和原交互 | `node --import tsx --test tests/identity-session.test.ts tests/identity-reset.test.ts tests/identity-gate.test.ts tests/api-response.test.ts tests/project-sync.test.ts tests/health-sync.test.ts tests/usage-sync.test.ts tests/local-auth-proxy.test.ts tests/department-workbench-empty.test.ts tests/identity-postgres-guard.test.ts tests/local-launcher.test.ts tests/openrig-workbench-ui.test.ts` | 62/62，0 skipped |
| 实际 createApp 边界及主体幂等 | `node scripts/test-integration.mjs tests/api-enterprise-boundary.test.ts tests/api-idempotency.test.ts` | 1+2 项通过；PGlite 隔离，非原生并发证明 |
| 静态宿主/代理 | `node --import tsx --test tests/local-static-web.test.ts` | 15/15；来源、原字节、未知写入不重放及实际构建文件保持 |
| 原生 PostgreSQL 身份/TLS | 同一独占测试集群执行 `tests/identity-postgres-guard.test.ts`、`tests/identity-store.test.ts`、`tests/identity-oidc.test.ts` | 29/29，0 skipped；含并行回调、登出与延迟保存、会话轮换、重建服务、管理员 bootstrap |
| 类型与构建 | `npm run build` | 退出 0；保留现有 Vite 单块 >500 kB 提示 |
| 独立审查 | 代码、身份测试夹具及失败清理分别复核 | 已修复的缺陷均复核，无剩余确定 P1/P2；范围见原报告 |

原生集群 ID：7f00ee2d-c412-4052-a98d-907063de1b8c，PostgreSQL 17.10。两个真实 backend PID 为 44964、1264；服务器返回后者被前者行锁阻塞，提交后释放。测试库仅回环，生成的测试凭据不进入命令行或证据。集群已停止，临时数据及密码已删除。

首次原生运行 27/29：维护测试以若干 SELECT 1 猜测后台清理已完成，独立连接下不成立。改为等待实际 `drainMaintenance()` Promise，保留每批最多 500 条等原断言；未改变权限或 SQL 条件。失败实例已确认停止、保留小型日志后清理。独立审查还修复了探针第二次连接/ROLLBACK 失败时可能卡住清理的问题。

浏览器使用本轮独占 127.0.0.1:62524 的实际构建页面：初始会话不可用时业务读取为 0；合成 pending 身份只显示“等待管理员开通”；本机模式显示空工作空间创建入口；再切回 pending 后业务界面消失。测试 tab 和临时宿主已关闭。这个服务明确是 **UI-only 合成夹具**，不代表实际 IdP 浏览器登录或真实员工验收。协议/TLS 证明来自上述真实 oidc-provider 与 PostgreSQL 测试，不把两种证据混算。

## 证据与未完成门禁

小型原始输出、源文件 SHA、复核报告及截图在 [证据目录](evidence/enterprise-identity-2026-10-20/)。截图仅含虚构测试身份和空工作空间。原生二进制与一次性数据不进入仓库或产品依赖。

仍须完成：实际企业 HTTPS/受信 CA 浏览器登录回调、跨用户及 BFCache/直接下载验证、实际 IdP 与预批准设备启动、A2 部门资源权限、JJ 发布和业务验收。当前所有业务 API 仍保持已有管理员范围，成员提示不等于成员权限已完成。原生 Windows PG 环境没有已验证 pgvector，不能据此宣称全产品迁移、成果 CAS 并发或 OpenShell 隔离已通过；探针不是通用发布 runner。

本轮付费模型调用 0，生产/JJ 变更 0；原预算、历史费用和未知预留未调整。
