# 企业能力补齐：固定版插件复用核对

日期：2026-10-23。用户已授权实现剩余功能，沿用已批准的企业基础设计。此次先核对现有源码与安装包，再查官方实现；本文中的可复用不代表已接通或验收。

固定运行时为 DSH `0.1.5-rc.1` / Cordis `4.0.2`。不把 GitHub master 的新能力当成当前安装能力。现有 13 个未提交文件已原样备份及记录 SHA256，后续增量保留。

| 需求 | 已有实现与复用选择 | 为伍需要补充的连接 |
| --- | --- | --- |
| 并发隔离与恢复 | OpenShell、现有工作区/CAS、DSH session/checkpoint、fs-native-extensions 1.5.1 | 完整 writer 覆盖、来源独占捕获、任务恢复 provenance、结果不明时保留占用；不是新建执行器 |
| 人员和部门权限 | openid-client 6.8.8、express-session 1.19.0、connect-pg-simple 10.0.0，现有身份表与审计 outbox | 管理界面、当前资源成员权限、来源限制、每次新效果前撤权检查 |
| 外部动作恢复 | 现有 operation/receipt 与纯效果合同；DSH 工具执行钩子 | 获批工具的 outcome query/compensation 合同与 UI，未知结果不自动重放 |
| 部门长期接活 | 现有 PostgreSQL coordinator、队列/预算；systemd timer 可复用 | 持久唤醒、退避、并发限制、可信授权来源；固定版 DSH Schedule 仅存活会话投递，不用它假冒冷启动恢复 |
| 经验成为 Skill/工具 | 已接 DSH skill registry/provider/lazy load、已有知识版本和 SkillX 隔离提炼 | 来源与授权传递、评测门禁、批准发布和复用反馈；不另建 Skill 引擎 |
| 插件扩展 | 已上线工具 bundle 安装、DSH 原生工具注册；社区市场可作发现源 | 区分工具、服务、原生网页插件的兼容合同；按命名空间/version 授权，不能通配放开后注册工具 |
| 评测与观测 | 已有 Promptfoo 0.124.1 离线桥、durable trace、audit v2/outbox、OTel SDK | 业务接线、脱敏查询、投影消费及可选导出；固定版 DSH OTel backend 不提供持续 emit |
| 存储与维护 | 现有存储盘点、retentionAdvice、备份与受控恢复，systemd timer | 周期只读健康报告、配额/轮换/失败记录；不把 output-retention 库当作磁盘垃圾回收器 |

## 核对出的兼容边界

- Schedule 工具在 `agent/created` 后注册，晚于现有员工工具定义冻结；不能用工具名前缀豁免解决。Jobs 是进程内 registry，重启不会恢复进程；暂不装第二套后台执行管理。
- DSH 授权插件管理插件凭据，不提供真人部门 RBAC。现有 API 精确盘点为 145 条（141 admin、4 device）；旧 A2 计划的 142 条须随实施校准。
- A2 旧计划提出的审计模块已由 `audit-events.ts` / `audit-outbox.ts` 实现；新增业务直接调用 audit v2，不再创建第二套审计。
- `dsh-plugin-package-inventory-deepseek` 是向官方 DeepSeek API 附带包库存的诊断扩展，不是插件搜索服务；本轮不启用它。
- 原生网页市场依赖 DSH Web Host Loader 与 client，不能直接插入为伍 React 页面。兼容工具可以沿现有安装机制使用；服务/网页插件仍需明确隔离、授权和生命周期适配。
- OpenShell 0.1.2 缺 expected-ID 条件删除；自动回收不能靠按名字删除或 NotFound 推断安全。相关门禁保留，另行验证可复用的受支持接口。

## 来源

- [DSH 官方仓库与社区插件发现入口](https://github.com/deepseek-ai/deepseek-harness)
- [Checkpoint 原生接口](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-checkpoint-policy)
- [Skill 注册接口](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/skill)
- [Schedule 上游文档](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/schedule/schedule)（与固定版存在差异）
- [Jobs 生命周期](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/jobs-local)
- [原生插件管理器](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/boot/plugin-manager)
- [社区市场原作者仓库](https://github.com/w2112515/dsh-plugin-marketplace)
- [Promptfoo 官方仓库](https://github.com/promptfoo/promptfoo)
- [systemd timer 官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)

本地核对依据：`services/agent-runtime/employee-hosts.mjs`、`employee-tool-access.mjs`、`approved-skills.mjs`、`native-plugin-tools.mjs`、对应 node_modules 类型与实现，以及现有企业身份/观测/质量研究。运行时 package-lock SHA256：`a82ccb7ab88ecbb05f672d6d60b4b8bcc668b8e073491c209d98b87625576a3c`。
