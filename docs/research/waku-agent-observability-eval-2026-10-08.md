# WakuAgent：Agent 监视、Eval 与为伍复用调研

日期：2026-10-08（北京时间）。项目已确认为 [ShenSeanChen/waku-agent](https://github.com/ShenSeanChen/waku-agent)。本轮只读审查文档和公开源码，没有安装、运行 Waku、运行评测、调用模型、上传公司资料、修改业务代码或当前数据。

GitHub API 本次确认的 main 提交为 [`763d3e79f34a2deca805e815b3b230188579e16b`](https://github.com/ShenSeanChen/waku-agent/commit/763d3e79f34a2deca805e815b3b230188579e16b)，提交时间 2026-10-07T06:24:38Z。核心源码结论以该提交为准；网页的 main/历史列表出现不同时间缓存，未把它们当作同一版本。版本字段为 0.1.8，要求 Python ≥3.11；不据此声称 PyPI 安装或 Windows 业务验收已经完成。[依赖](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/pyproject.toml)、[版本字段](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/__init__.py)。

## 1. 结论

Waku 的价值是把执行、观测、逐回合检查、语义评分及发布回归放在可读的闭环中。它适合作为为伍监管体验和评测流程的主要参考，并有 MIT 代码可选取复用。它不是已经兼容 DSH 的监控插件，也没有替代为伍的员工审批、任务合同、恢复及预算账本。

建议优先复用事件/评分的关联方式、失败定位、确定性与语义评测分层以及评测历史；使用现成 OTel 和评测库。保留已验证的员工执行及原始证据，通过薄的只读适配层提供部门/员工/任务视图。其品牌设计系统不能直接搬进另一个产品，费用和门禁也不能原样接管我们的验收规则。

## 2. Agent 监视做得好的部分

| 能力 | 实际落点 | 对为伍的价值 |
| --- | --- | --- |
| 按回合看执行 | turn 与 loop、模型、工具、耗时、Token、费用和错误关联 | 让用户从一个任务进入具体失败步骤，不必从原始日志寻找 |
| 观测维度分开 | Turns、Tools、Memory、Spend；工具有来源分类，记忆有检索/写入/取舍信息 | 区分慢在模型、工具、资料访问还是重试；看到花费实际发生在哪里 |
| 执行与评价相连 | 每轮评分可回到对应 turn，语义 Judge 另有 score 记录 | 从异常/失败回合挑选评测案例，检查改动是否改善 |
| 回归历史 | 最新 gate 报告与追加历史分开 | 避免只展示一次绿色结果，保留各次失败与评分 |

源码对应 [observability.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/observability.py)、[tracing.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/tracing.py)、[turn_evals.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/turn_evals.py)、[release_gate.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/release_gate.py)。[使用说明](https://github.com/ShenSeanChen/waku-agent/blob/main/docs/tour.md)提供界面布局背景；本轮没有启动浏览器体验，不能报告实际可用性/性能结果。

## 3. Eval：值得复用分层，但门禁需要适配

### 确定性回归

离线套件使用 ScriptedClient 固定模型响应，但部分测试运行真正的 loop、本地工具及 SQLite/ICS 文件。这是工程回归，不是所有内容都由 mock 替代，也不是已验证真实模型业务质量。真实模型测试还要求 Key 与 WAKU_RUN_LIVE_EVALS=1。[helpers.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/evals/helpers.py)、[test_tool_trigger.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/evals/deterministic/test_tool_trigger.py)。

为伍可复用这种分层方式，把已有真实 CLI/HTTP、文件 SHA、权限、预算、恢复和知识固定版本证据转为脱敏固定案例。Waku 的日历/个人助手案例不能直接成为研发部门的验收集。

### 语义 Judge

发布质量测试使用 DeepEval GEval，示例阈值为 0.6；逐回合 grounding judge 使用 0.7，最高 300 输出 Token。评分本身需要真实模型调用。阈值是 Waku 的案例配置，不能当作我们经过校准的合格线。[test_response_quality.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/evals/judge/test_response_quality.py)、[turn_evals.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/turn_evals.py)。

可参考它的 rubric 和案例组织，评分引擎复用 DeepEval 或前一轮候选 Promptfoo，择一落地，不另写通用 Judge 引擎。若复用原 Python 套件，需要独立评测进程及 DSH 输出适配；若继续 TS/Node 管线，先验证现成 SDK/CLI 的案例与结果格式。两条都尚未运行。

### 每回合检查不是硬执行门禁

spend claim、one report、grounded numbers、errors handled、under budget 五项 turn checks 是事后启发式检查，结果有 pass/fail/n/a；不会阻止工具调用，也不证明研发测试成功。[turn_evals.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/turn_evals.py)。

可采用这种自动提示，但为伍的关键判断要绑定真实数据：当前文件版本、实际命令退出码、审批回执、accepted seal、知识引用和费用收据。n/a、未知、跳过都不能显示为通过。

### Release gate 的具体限制

本次固定源码仅检查 pytest 退出码。没有 Key 时语义 suite 标 skipped，但最终仍输出 GATE OPEN；内部 skip 也不是闭门条件。hosted_docker 第三套件不在该 gate 内，发布 workflow 主要运行确定性 suite。[release_gate.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/release_gate.py)、[release.yml](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/.github/workflows/release.yml)。

为伍应复用现成 runner，加自己的必要套件清单和结果映射：核对实际执行数、版本、必需案例及 skip/fail/unverified 状态，再决定项目/发布是否符合要求。现有真实项目验收不能由这个 gate 的退出码取代。

## 4. 不能照搬的费用、重试、数据与安全边界

| 边界 | 固定源码观察 | 为伍所需适配 |
| --- | --- | --- |
| 未知调用 | metered.create 的调用异常不写 usage 行，缺少 usage 时 Token 取 0 | 继续保留每次意图、未知收据及预留；缺失 Token 不当作未收费 |
| 历史单价 | 展示时按当前价格表重算 Token 费用 | 原账本固定调用时价格；显示估算与供应方核对状态 |
| Judge 重试 | 回合 Judge 异常释放 claim 可再试；arena Judge 任意异常最多四次模型重试，最终 None 不令比赛失败 | 所有付费评测走批准额度；结果未知时停止并核对，失败/缺证据显式记录 |
| 隐私 | 工具参数有脱敏，但用户内容和工具完整结果仍可进入 trace | 白名单导出、权限与敏感正文控制；不把公司资料默认送 Judge/云追踪 |
| 长期读取 | dashboard/observability 扫描全部 trace 文件；usage 全文读取；live events 也读取完整当日文件 | 使用既有运行存储，增量索引、分页及归档；少量显示行不等于少量读取 |

来源：[tracing.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/tracing.py)、[pricing.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/pricing.py)、[arena judge.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/judge.py)、[turn_evals.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/turn_evals.py)、[dashboard.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/dashboard.py)、[observability.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/observability.py)。

dashboard 默认 loopback，未提供公司的登录/员工授权。特别核对过 SQL：旧注释仍说任意 SQL，但实际 run_query 只接受单个 SELECT/WITH、SQLite mode=ro、最多 200 行，不能把旧注释当成可写 SQL 漏洞。本次只检查实现，没有进行安全利用或运行测试。[固定 dashboard.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/dashboard.py)。

## 5. 部署、模型、记忆与许可

- 本地 dashboard 是 Python 标准库服务器与静态前端，直接读取 Waku state.db、JSONL，并能调用自己的 agent/Judge；没有找到通用 DSH 事件摄取协议。它有轻量本地部署的价值，但接为伍仍需要事件与接口适配。[dashboard.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/dashboard.py)。
- tracing extra 采用 Phoenix/OTel；当前实际 exporter 是 gRPC、insecure=True。与 Langfuse 共用 OTel 并不等于云端认证/TLS及协议接入已完成。[tracing.py](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/ops/tracing.py)、[pyproject.toml](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/pyproject.toml)。
- providers.toml 确有 OpenCode Go 的 OpenAI-compatible 入口，前缀为 https://opencode.ai/zen/go/v1。这是源码兼容入口，不是我们的 Key、模型能力、流式 usage 和成本控制已经实测通过。[providers.toml](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/waku/providers.toml)。
- 本地原文/trace 保存在电脑，不表示推理全离线；模型和选用的托管记忆/Judge 仍涉及外发。公司资料继续按授权和任务版本管理，不整体换成个人助手的自动记忆。
- Python 评测和 Makefile 不是 TS/DSH 插件。Makefile 有 POSIX 命令，Windows 需对应入口；兼容性、资源占用、沙箱、数据恢复和真实 Go 流程均未实跑。[Makefile](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/Makefile)。
- 主代码 MIT；LICENSE-BRAND 单列设计系统、标志和名称，不能未经许可搬到另一个产品。字体 OFL；hosted/ 为 ELv2，不属同一 MIT 范围。复用代码时保留通知，为伍继续使用自己的视觉系统。[代码许可](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/LICENSE)、[品牌许可](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/LICENSE-BRAND)、[hosted许可](https://github.com/ShenSeanChen/waku-agent/blob/763d3e79f34a2deca805e815b3b230188579e16b/hosted/LICENSE)。

## 6. 最小复用方案与验证顺序（尚未实施）

1. 定义一份只读监管投影，包含部门/员工/Run/task/attempt/request、工具、版本、审批、已知费用/未知预留及实际测试。复用已有追踪原件，不新增一个自动改变任务状态的 Waku 数据库。
2. 选择 MIT 事件解析、展示和评分历史模块做隔离适配验证；复用现有为伍样式，排除受限设计资产。先比较保留 Python 旁路与直接适配 TS 接口的总负担，不能先把 Python agent 打开后让它绕过原审批运行。
3. 保留已选的现成评测 runner，采用 Waku 的分层与评分来源设计。为研发部门建立固定脱敏案例；必须评测状态有通过、失败、未验证和受阻，不只一个绿色总分。
4. 先用原正常/失败/恢复证据离线验证：版本和测试是否一致、能否找到阻塞和最耗时/最昂贵步骤、未知费用是否完整呈现、缺 Key/skip 是否被标未验证、日志归档后链接是否有效。
5. 需要真实 Judge 时另在受控额度内验证调用与费用；没有批准前不连接现有 Key 做 paid eval。最终再进入长期研发部门的 72 小时/7 天试点，不把 Waku 的个人助手示例当作已满足部门验收。

与其他候选分工：Paperclip 继续作为公司/部门管理层候选，Waku 作为本地监管 UX 与评测闭环参考，OTel/Phoenix/Langfuse及现成 eval 库承担通用基础设施。它们不需要全部安装。先前总体方案见 [长期研发部门调研](long-running-rd-reuse-2026-10-07.md)。
