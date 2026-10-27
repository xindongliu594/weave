任务费用反馈已完成，源码于 2026-10-06T03:04:47Z 冻结。此次仅修改 `packages/contracts/index.ts` 的 `validatePlan`，并新增隔离回归测试。

原错误“任务执行估算（含 20% 预留）超过该任务的费用上限”与任务费用检查、严格比较、总体估算均保留。其后追加每个超限任务的名称、ID、原公式计算后的金额和未舍入的任务上限。现有 `GeneratedPlanView` 已逐条渲染 `validation.errors`，无需改网页源码。

本案追加反馈：
> 任务「独立真实CLI子进程HTTP验收」（qa_verify）：执行估算（含 20% 预留）$0.151200 超过任务费用上限 $0.15。

300,000 输入、30,000 输出按 $0.3/$1.2 每百万 Token 计算为 $0.126；含 20% 预留并按原公式向上取整至百万分之一美元，得到 $0.1512。原候选总体估算仍为 $0.37296。没有调整任务上限、项目预算、模型价格或候选内容。

| 回归 | 结果 |
| --- | --- |
| NEW 单元、PGlite/API、现有页面 SSR | 8/8，exit 0 |
| 既有 policy 与 planning UI | 33/33，exit 0 |
| 项目 GET 与批准前校验 | 明细可见；422 PLAN_NOT_READY；零模型请求、收据及员工工作 |
| 本地假模型生成候选 | HTTP 200、valid=false、明细可见；已保存方案、策略、版本、状态不变 |
| 费用边界 | 相等通过；micro-dollar 向上取整严格保留；cap 不舍入；多任务全部指出；价格缺失仍未知 |

首次新增测试为 7/8：测试读取了不存在的 `error` 字段，实际 API AppError 返回 `message`。仅修正测试取值后 8/8；初次失败日志保留在同名 .txt。业务验证未放宽。

所有 API 场景使用全新内存 PGlite、临时本机服务及凭证为空的 loopback 假模型；HTTP 出站只允许这两个 fixture 来源。仅一次合成模型响应，没有访问原服务、原数据库、真实 Key、付费 API 或员工交付物。网页验证为现有组件静态渲染，尚未验证真实页面 reload；最终类型检查与 build 由 root 在冻结后执行。工程回归不能当作真实员工运行或受控中断实证。

| 文件 | SHA256 |
| --- | --- |
| contracts 修改前（含已有各 agent 修改） | a77639df16b4e1865222d872d8b1a487bab19a1b0390ac5fe9e4162543faf468 |
| packages/contracts/index.ts 冻结 | f25847d5f909c44805b08f8f52bf9c36d9ee63d056e1c921bff71c4c5c961f56 |
| tests/task-budget-feedback.test.ts 冻结 | de74916ab1174d331365c1e464c2800fd93f14ad52684db051518716e0284b3a |
| apps/web/src/ProjectPlanning.tsx，前后未变 | 34c74aaacb9f1d99e035716042ada9c6c12b841d014e1a0346d929357c43ee36 |
| NEW stop helper，前后未变 | 22f928e9262c34b86971b07891e20adfa06457a7500f762ec6db0da2dfa37baf |
| 已存实际 HTTP200 invalid 候选证据，未重放 | 886e7cdffb6d6f7387a4bee6ec56094a81d427d936378c1d845d1b772292334e |

完整命令日志与结构化边界证据见同名 .txt/.json。
