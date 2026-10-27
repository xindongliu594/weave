# JJ 交接文档只读复核

范围：只读当前 quickstart、部署 acceptance/progress 及本地回收 JSON；没有修改主文档、远程状态或调用模型。下表定位基于本次读取的版本，Root 更新后行号可能变化。

## 需要更新

| 文件与位置 | 过期说法 | 建议当前表述 |
| --- | --- | --- |
| quickstart 第21行、首次配置步骤1/2 | Key/模型均未迁移；本轮没有付费请求 | 唯一 Go Key 已在明确授权后通过 SSH 迁移，DeepSeek Flash 配置及选项已保存。连接测试通过由 Root 实际网页验证；用户可直接继续需求组建，不要求重新填 Key 或重复付费测试。历史项目、费用、原设备授权没有整体迁移。 |
| acceptance 第20行 | pilot 无 Key/模型，付费调用0 | JJ 已有真实 DeepSeek 接口/组队调用；当前小任务仍处于需求与团队方案阶段，尚无正式部门/项目，不标开发、独立 QA、经理或真实业务重启验收通过。 |
| acceptance 第90行；progress 第48行 | Key 迁移许可等待回复，迁移未执行，无真实调用 | 将审批拒绝保留为有日期的历史记录，并追加明确授权后的实际成功迁移与调用结果。不要继续作为当前阻塞。 |
| acceptance 第74/104行 | 下一步才启动管理网关；先隔离再迁移接口 | 网关已 connected/authenticated、Linger=yes；隔离探针因 Docker daemon 下载镜像超时而受阻。真实小任务在现有 JJ Node 执行器继续，沙箱准入与执行适配另行验证，不把无关路径绑定为串行阻塞。 |
| progress 第12/24/36/38/40–42行 | 272项、关闭问题正在修、网关尚未上线、模型0、Linger=no、等待本机 apply | 标为“实施初期历史记录”，文档开头提供当前状态：274项阶段一回归、关闭已修、网关认证成功、Linger=yes、有真实调用。保留失败与旧状态，不覆盖原证据。 |
| quickstart 停机快照；acceptance 备份段 | 旧阶段一快照容易被理解为当前配置的完整恢复点 | 明确该快照生成于 Key 迁移和后续组队之前，只证明当时 pilot 的隔离恢复，不覆盖新凭据、调用账本或团队候选。当前业务数据备份若尚未完成，明确待验证。 |

## 当前可证实的范围

`.data/research/jj-simple-task-2026-10-08/go-config-verified.json` 成功输出证明 Go URL、`hasCredential=true`、新模型 ID `c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051`、`deepseek-v4.1-flash`、授权 SSH 复制以及没有复制原设备授权。`go-model-options-copied.json` 保存 chat-completions、thinking disabled、context 131072。注意这些是复制时回执，模型状态当时仍是 untested；不能只引用此文件来证明后来的连接测试成功。Root 已报告网页真实测试成功，主报告应连接其已有测试回执或截图，避免为了文档补证据重复请求。

`stage-before-confirm.json` 的远程快照名为 `simple-business-stage-20261008T091205.json`：usageRows=8、登记费用约 `$0.011379`、未结算额=0、departments=0、projects=0。这是 2026-10-08 09:12:05 UTC 的阶段证据，不是持续更新的实时余额，也不是独立核实的供应商账单。更早 `business-before-confirm.json` 为6条记录、约 `$0.0059508`，不应用它覆盖较新快照。

`go-config-copied.json` 保留了首次 `KeyError: 'model'` 失败；当前结论应以随后 `go-config-verified.json` 成功回执为准，不能删除失败或把首条失败当最终迁移结果。

原 `$10` 授权、旧未知费用预留和本轮 `$0.50` 小任务边界仍需保留；`budget-admission.json` 的 `$4.4661802` 是迁移前审计基线，不因 JJ 独立新库从零计数而成为新额度，也不应无时间标记写成后续实时剩余额度。

## 应保留的准确限制

- 当前业务员工仍用 JJ 用户权限的 Node 执行器，尚未接入 OpenShell OS 隔离；gateway 持有 Docker socket 不表示员工执行已经隔离。
- `weiwu-probe-0e69d0d` 已登记但 Error/ImagePullFailed，configuration admission pending。存储的 effective policy 不能代替实际 UID、Landlock/文件越界、网络拒绝、取消与恢复测试；这些均未运行。
- OpenRig0.6.6 私有安装、CLI/SQLite ABI 验证通过；setup/up/daemon/provider 未执行，长期部门未启用。
- 登录自启和 Linger=yes 不等于无人登录开机、休眠恢复或连续24小时验证通过。
- Windows 既有真实 Todo 成功/恢复证据仍保留；不拿它或阶段一固定协议检查代替 JJ 当前真实小任务验收。

建议 quickstart 用“网页已运行、Go/DeepSeek已配置、当前小任务仍组队”的简短状态引导用户，工程失败与历史过程保留在验收报告，并明确下一次正式团队确认之后才创建部门/项目。
