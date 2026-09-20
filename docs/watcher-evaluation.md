# Watcher 复用验证

日期：2026-09-20。结论：可以复用统计投影与事件整理逻辑；尚不能把官方 Web 插件视为已兼容本产品前端。本次只做隔离验证，没有修改生产依赖或启用插件。

## 固定来源

- 仓库：https://github.com/aa2246740/dsh-watcher
- 提交：`65f8f1a8db737aa3d1d9440c0416a5cd83b956f9`，package.json 版本 `0.4.4`，MIT。
- README 要求 DSH `0.1.5-rc.2`；本产品实际安装 `0.1.5-rc.1`。peerDependencies 的较宽范围不能替代兼容性实测。
- 克隆位置：`/private/tmp/agent-department-watcher-review`。没有执行仓库安装脚本，没有写入用户 DSH profile。

## 已运行的验证

1. 用本项目已有 esbuild 对临时克隆中的 TypeScript 做转译，输出到其 `lib/types`。这是运行逻辑测试，不是 TypeScript 类型检查或正式构建。
2. 执行 upstream 的 fold、model-trace、performance、insights、history、aggregation、step-timeline 七组测试：77 项通过，0 失败，0 跳过。未宣称 upstream 全套测试通过。
3. 将本产品已有 fixture 运行 `f01e40e7-c7ec-43b1-b19f-7541ccfe764f` 的三个 DSH JSONL 会话交给 `foldEvents` 和 insights engine 回放。
4. 将原始 sessions 复制到另一个临时目录，在本产品真实 `createTeamHost` 上挂载 upstream 提交的 `lib/dsh-watcher.js`，恢复两位员工会话并读取 `watcherInsights` 投影。模型 adapter 一旦被调用就抛错；此次无需 API，没有外部模型请求。

| 会话 | 原始模型 step/start | Watcher 工作步骤 | 原始工具调用 / Watcher 统计 | Watcher 模型调用 |
| --- | ---: | ---: | ---: | ---: |
| writer | 5 | 5 | 4 / 4 | 5 |
| reviewer | 5 | 5 | 4 / 4 | 5 |
| captain | 2 | 4 | 0 / 0 | 2 |

两位员工的运行时投影也分别断言 `calls=5`、`tools=4`、`reported=0`。fixture 没有上报 Token，零个 usage report 不能显示成“实际消耗为零”。

最初将 captain 的工作步骤数与 step/start 数强行判等，断言失败；检查源码后确认 `stepsOf` 按展示项的 turn/step 分组，包含消息所在坐标。两种统计口径不同，UI 不能把工作步骤数直接标为模型请求数。

临时验证脚本：`prepare-probe.mjs`、`replay-probe.mjs`、`host-probe.mjs`；测试输出：`/private/tmp/watcher-tests.log`。这些临时文件可能被系统清理，本文件保留本次验证方法与结果。

## 复用边界

- `src/insights/projection.ts` 注册只读 `watcherInsights`，依赖 sessions / sessionProjections。本次证实其已提交 Host 产物能在当前 rc.1 上挂载、恢复并计算已有员工会话；不是全量 rc.1 兼容声明。
- `src/observation/fold.ts` 的 `foldEvents` 可接收原始 Session 事件，适合作为展示适配候选。它是内部模块，package exports 没有提供独立稳定入口；应固定提交、保留许可证，通过适配层隔离，不能随意深层引用并自动追 latest。
- `src/client/index.tsx` 注入官方会话标题栏与设置页，需要 slots、sessions、uiConversation 及 remote.session。本产品是独立 React 19 页面；Watcher 开发依赖为 React 18。整套 UI 还未挂载或浏览器验证，不能仅安装 npm 包就认定可用。
- 本产品 Run ID、员工身份、角色/任务提示词快照、部门/方案版本及 team 操作记录仍由本产品持有。样例 captain 的程序化 team 操作存在产品归档，未出现在 captain 原始 tool/call 里，仅回放 Session 会漏掉这些业务证据。
- Watcher 的 JSONL parser 会跳过无法解析的行；本产品已有的不完整日志标记应继续保留，不能用它替换归档完整性校验。
- 0.4.4 含本地价格表与估算费用。用户采用中转站，正式接入时应配置中转站价格；不能把默认厂商估价称为中转站账单。

## 建议的接入顺序

先保留现有归档和业务关联，在其上适配 Watcher 统计与折叠展示；优先统计投影，随后工作路径。正式引入时锁定版本并验证当前 runtime、AgentTeams 和前端依赖组合。只有确有接口缺失时才评估统一升级 DSH，不因 README 版本差异直接升级全部依赖。

下一轮验收需包含：新产生的实时事件、历史回放、失败/取消/残缺日志、缺少 usage、多员工身份映射、浏览器展示及中转站费用配置。现有离线样例通过不代表这些场景均已通过。
