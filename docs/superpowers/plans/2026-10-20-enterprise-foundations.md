# 企业基础能力总实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Use each subsystem's detailed plan; do not implement from a heading alone.

**Goal:** 完成企业内部多人落地所需的十项 Agent 基础能力及实际验收。

**Architecture:** 延续 DSH 0.1.5-rc.1、OpenShell 0.1.2、PostgreSQL 与现有网页；优先集成成熟身份、评测及观测组件。以身份主体、授权快照、任务工作区、operation ID、checkpoint 和证据 ID 连接各模块。

**Tech Stack:** TypeScript/Express/React/PostgreSQL、DSH、OpenShell、OIDC/openid-client、Promptfoo、OpenTelemetry、systemd。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`

## Global Constraints

- 保留既有数据、未提交成果、凭据、旧权限、历史费用与未知预留；不自动提高 API 金额或次数。
- 服务部署仍在 JJ；不在 JJ 加载大型语言模型。
- 新功能先核对固定版本和成熟复用方案，再完成详细计划，之后实现。
- 业务 API 先鉴权授权再幂等处理；未知 route failclosed；机器凭据不等同于真人。
- 员工副作用未知时禁止重放；恢复不回滚账本和外部效果。
- 不以单元测试、模拟模型或说明文档替代真实部署及业务验收。
- 本计划保持全部十项范围，分阶段完成必须记录剩余工作。

## Review Focus

- 权限在会话/运行期间被撤回：下一次访问及恢复必须拒绝，缓存不能漏数据。
- 员工利用路径、软链接、进程或重复请求越界：原始成果与其他员工目录必须未改变。
- 外部动作已成功但结果丢失：只做核对，不能重放动作或重复扣费。
- 重启发生在提交/持久化/归档中途：恢复确定状态，不能误报完成。
- 磁盘不足、评测/观测服务不可达、证据被删除：明确降级或阻断，不静默放行发布。

## 交付顺序与依赖

| 阶段 | 内容及责任边界 | 依赖 | 状态 |
| --- | --- | --- | --- |
| A1 | 真人身份、会话、CSRF、主体隔离的请求缓存 | 研究和协议选择 | 计划中 |
| A2 | 全路由资源权限、成员管理、审批 actor、登录网页 | A1 | 未开始 |
| B1 | 任务私有工作区、输入清单、可信输出 CAS 合并 | 执行研究 | 计划中 |
| B2 | OpenShell task attempt 沙箱、DSH guard、checkpoint 接通 | B1 | 未开始 |
| C1 | 统一工具 operation 合同、结果核对与补偿授权 | A1、B1 | 未开始 |
| C2 | 步骤/分支/循环 checkpoint、重启一致性、目标与上下文合同 | B2、C1 | 未开始 |
| D1 | 固定数据集、Promptfoo provider、确定性与真实业务 Eval | 评测研究 | 计划中 |
| D2 | 可归责审计、关联 trace、脱敏 OTLP、容量与卡住告警 | A2、C1 | 未开始 |
| E1 | 持久唤醒、退避、自动安全恢复、排空和并发竞争 | C2、D2 | 未开始 |
| E2 | 知识撤回/替代、经验审核、复用量化及工具发布 | A2、D1 | 未开始 |
| F1 | 周期维护、加密备份演练、密钥轮换与发布回滚 | A2、C2、D2 | 未开始 |
| F2 | JJ 集成部署、企业网页主流程、真实小任务/故障验收与交付 | 所有阶段 | 未开始 |

### Task 1: 身份与会话基础

- [ ] 完成 `2026-10-20-enterprise-identity.md` 详细计划；落 schema/principal/OIDC/session/CSRF 和主体幂等隔离。
- [ ] 测试错误 issuer/state/nonce、会话轮换/撤销、跨主体幂等键、企业配置缺失。
- [ ] 独立评审后继续全路由资源权限；A1 不代表 A2 已完成。

### Task 2: 员工隔离基础

- [ ] 完成任务工作区的详细计划；先纯文件/真实子进程负面测试，再接固定 OpenShell。
- [ ] 验证 task-only 结果不能直接走删除缺失文件的 `mirrorFiles`；可信合并必须保留其他员工成果。
- [ ] 验证恢复、清理和版本固定；真实 OpenShell 攻击测试后才能声称员工隔离完成。

### Task 3: 质量与监管基础

- [ ] 完成评测详细计划；版本化数据集、Promptfoo provider、证据断言与发布门禁。
- [ ] 所有真实请求经原预算/审批链路；离线 fixture 与真实业务报告分开。
- [ ] 接人员审计、OTLP 导出与看板，验证敏感数据和导出故障。

### Task 4: 长任务、知识和运维收口

- [ ] 按依赖逐项为 C/E/F 编写详细计划，并纳入前序统一合同；禁止临时另造旁路。
- [ ] 运行并发/中断/网络未知/磁盘满/权限吊销/备份恢复等故障场景。
- [ ] JJ 部署、浏览器验证、真实业务验收，记录运行 ID、文件哈希、命令输出、费用和截图。
- [ ] 完成使用、部署、升级、故障恢复与权限手册，推送代码及允许分享的证据。

## 验收记录

本轮尚未新增付费模型请求。旧步骤恢复项目及预算不足状态保留，不能将本轮企业功能授权视为额外付费授权。总体目标不在 A/B/D 首模块完成后提前关闭。
