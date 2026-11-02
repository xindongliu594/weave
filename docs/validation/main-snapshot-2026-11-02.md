# main 开发快照与 README 更新（2026-11-02）

用户要求将当前最新项目提交并推送 GitHub main，只保留 main，并美化 README。本轮目标为保存可检查的开发快照，不表示所有开发中功能已交付。

## 提交范围

- 保存已有成员工作台、OpenTelemetry 观测、core-v2 评测、写入保护、恢复来源/初始化及正在建设的运行层代码、测试与公开证据。
- README 新增深绿色 Weave 封面、执行流程、七种编排概览、快速启动和能力/证据表；保留目标架构图，修正旧仓库链接，标清企业恢复和长期自主运行的边界。
- 确认本地分支和远端分支均只有 main；两个原有 detached 工作区不属于额外分支，保留其文件。
- 公开验收日志显式加入暂存区，evidence 使用原有逐字节保存方式，避免换行转换破坏摘要。API Key、数据库、node_modules、.private、.superpowers 不进入提交。

## 固定快照验证

基线为 `417b46e5510ab72203d722292e46e1e9b9322b77`。另一个对话同时开发恢复链路，因此从 Git 暂存区导出独立目录，只共享已安装依赖，在这个固定目录中验证；其后新增的工作区改动保持原样。

最初快照构建发现开发中恢复模块的空值收窄和缺失 join 导入。原开发对话随后已经修正，更新暂存中的两份文件后再次导出；原失败输出保留。实际通过验证的 index tree 为 `1d1f9ff7f47366ee644a68bea2a12bfc45762001`。后续只向提交添加本文及本轮验证输出，不改变该树中的业务代码。

| 检查 | 最终结果 |
| --- | --- |
| npm run build | exit0，包含 tsc --noEmit 与 Vite；保留原大于500KB分块提示 |
| npm run test:rules | 34/34，exit0 |
| 成员/身份界面及测试入口定向回归 | 14/14，exit0 |
| 隔离恢复来源 / 初始化 / 运行入口 | 15/15 + 11/11 + 6/6，共32项，组合命令exit0 |
| README 本地文件链接 | 39处存在；SVG通过sharp渲染并目视核对 |
| 已识别的历史输出 name/SHA 清单 | 53份输出逐字节一致；不是对所有历史报告重新验收 |
| 暂存文件筛查 | 未发现真实API Key、私钥、访问令牌或数据库文件 |

定向测试合计80项通过；没有运行全仓套件，不将这些结果当作全部CI通过。恢复工程测试复用 PGlite 与模拟模型，没有调用付费 API，没有访问生产数据。没有执行 JJ、OpenShell、原生 PostgreSQL 来源事务或真实模型恢复验收。企业 task profile 仍关闭，core-v2 的9项待证据状态保留。

命令、原始失败、最终输出和本轮摘要见[证据清单](evidence/main-snapshot-2026-11-02/manifest.json)。主命令如下：

```powershell
npm run build
npm run test:rules
node --import tsx --test tests/member-workspace-ui.test.ts tests/identity-gate.test.ts tests/identity-management-ui.test.ts tests/test-integration-runner.test.mjs tests/product-flow-fixture.test.ts
node scripts/test-integration.mjs tests/task-recovery-source.test.ts tests/task-recovery-initialization.test.ts tests/task-recovery-runtime.test.ts
```

本轮没有部署。固定快照之后另一对话的修改不被覆盖或丢弃，后续应完成各自验证后再提交。
