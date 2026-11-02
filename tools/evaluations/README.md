# 为伍离线工程评测

使用独立安装的 **Promptfoo 0.124.1（MIT）**，不进入生产依赖。`package-lock.json` 固定版本和 npm 完整性摘要。它需要 **Node >=22.22.0**；项目既有 Core CI 的 Node 22.19 不能运行此工具。请单独使用 Node 24；本次实际验证为 Node 24.15.0 / npm 11.12.1。脚本启动前明确检查运行时，不修改根项目 engine。

```powershell
cd tools/evaluations
npm ci --ignore-scripts --no-audit --no-fund
cd ../..
node tools/evaluations/run.mjs --output tools/evaluations/output/unique-run-id
node tools/evaluations/release-gate.mjs tools/evaluations/output/unique-run-id/manifest.json tools/evaluations/output/unique-run-id/promptfoo.json
node --test tests/evaluation-bridge.test.mjs tests/evaluation-release-gate.test.mjs
```

输出目录必须是本工具忽略的 `output/` 下一个全新目录，不覆盖或复用旧报告。私有报告包括 Promptfoo 原始 JSON、JUnit XML、HTML、runner 日志、manifest 和 gate。报告只含合成案例，不输入用户对话。源码更改后旧报告门禁会失败，应对新源码重新评测。

`WeiwuProvider` 默认为 replay，只读取 `datasets/` 内固定 v1 案例，校验版本、案例身份、摘要及合成来源。`execute` 在网络操作之前无条件拒绝 `LIVE_AUTHORIZATION_REQUIRED`，没有环境变量绕过。runner 只接受与自身生成配置完全相同的配置，仅允许这个 provider 和本地确定性断言，拒绝云 provider、LLM judge、脚本表达式、远程提示词及额外 transform。子进程不继承模型凭据或 Node 注入配置，并关闭更新、遥测、远程生成、分享、缓存及评测数据库持久化；Promptfoo 仍会在忽略的输出目录内初始化自己的 SQLite 元数据。预加载网络阻断模块拒绝 HTTP、socket 和 fetch。此模块是受控代码的离线防护，不是运行任意插件的沙箱。

固定版本将断言 `file://` 中第一个冒号解析为函数分隔符，包括 Windows 盘符，因此配置使用相对于报告目录的本地路径。

五个案例分别为正常交付、缺 QA、旧 artifact digest、未知操作、恢复运行重复动作。后四例通过表示“成功识别应阻断的证据”，不表示坏证据获准发布。断言由 Promptfoo 执行和评分，本地 gate 只核验版本、必需案例、逐例状态/分数、回执、费用、原始报告摘要和不可混淆的合成来源，未另造评测引擎。

manifest 绑定评测身份与日期、Git commit/相关源码 dirty、源码内容摘要、runtime 摘要、工具 lock 摘要、数据集版本/摘要/案例集、规则版本/代码摘要、Promptfoo 版本及原始结果摘要。`source-inputs.json` 明确列出应用/runtime/合约/构建配置/测试/评测实现及版本数据的目录、扩展名和根配置文件；同时包含这些范围内未提交的新源码。读取前排除私有目录、历史验收文档、验证产物和依赖/输出；普通文档不会改变源码内容摘要，相关源码改动会改变摘要，相关输入删除也记录在摘要中。读取受大小限制，符号链接目标必须仍在源码白名单内。摘要提供一致性，不是数字签名或防恶意本地管理员篡改机制。

`--require-live` 总是失败并返回 `live-evidence-required`；fixture 始终 `executionKind=fixture`、`modelExecuted=false`、`fresh=false`，合成 receipt 和零费用不能计为真实业务运行或质量验收。目前没有接服务端授权、预算、新真实运行、模型质量、生产 API 或网页入口。

仓库的 `Offline engineering evaluation` workflow 使用 Node 24.15.0，在 Windows/Linux 单独安装上述依赖并执行原正向和负向 CLI 测试。它不读取模型凭据或数据库，不开启 execute；每个平台有 20 分钟超时，安装后先校验真实 CLI 存在，避免可选测试因缺依赖而跳过。只保留合成案例的 manifest、gate、JUnit 和负向 gate，保留期 7 天，不上传原始报告、HTML、日志、SQLite 或依赖。远程 workflow 的通过状态须以 GitHub 对应 commit 的实际结果为准，不能拿本地旧报告代替。

依赖安装禁用生命周期脚本。本机安装 631 包、`node_modules` 实测 1,304,223,358 字节（约 1.21 GiB；平台可不同）。仅开发/独立评测使用，不复制到 JJ 生产。

2026-10-20 对本隔离评测目录执行在线 `npm audit --omit=dev`，记录了 10 个受影响包，归于三项原始公告：[basic-ftp](https://github.com/advisories/GHSA-c475-qrg2-pj4r)、[braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 和 [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。固定链路 `promptfoo@0.124.1 → proxy-agent@8.0.2 → pac-proxy-agent@9.1.0 → get-uri@8.0.1 → basic-ftp@5.3.1` 中，`get-uri` 要求 `basic-ftp@^5.3.1`；已发布的修复版 6.2.3 超出该范围，不能只改锁文件，本轮也不采用未经兼容验证的主版本覆盖。另两项的已发布最高版本 `braces@3.0.3`、`node-forge@1.4.0` 仍在公告范围内。本次保留固定依赖，待上游提供兼容修复链路后复核。离线 `npm audit --offline` 返回零条并不代表无漏洞，因为它没有取得新的公告数据。

当前固定 runner 只接受生成的 replay 配置和本地合成数据；`execute` 在网络前拒绝，子进程用预加载模块阻断常用 HTTP、socket、DNS 与 fetch 入口。因此该评测流程没有预期的 FTP、watch、证书导入或不可信模板输入。此结论只限定于已检查的固定流程；未验证任意 Promptfoo 配置、第三方插件或这些依赖的全部调用路径，不能据此宣称漏洞无法利用或依赖安全。

官方依据：

- [npm 包与版本](https://www.npmjs.com/package/promptfoo/v/0.124.1)，实施时执行 `npm view promptfoo version engines license dist.integrity dist.unpackedSize --json` 核实；顶层 npm 完整性为 `sha512-Y6fq/WGTL7lPvDsirNSmmmcPLhURwRao03iv8fCoLbFq6H1eqg5VVTmXiap5Jl+fiRaQQZXYMHb2N1gQm1tGyQ==`。
- [官方 GitHub 源码](https://github.com/promptfoo/promptfoo)、[JS provider](https://www.promptfoo.dev/docs/providers/custom-api/)、[确定性 JS 断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)。固定版本运行证据优先于最新网站说明。
- 项目调研见 `docs/research/enterprise-quality-operations-2026-10-20.md`；DSH 原有发现/执行链路继续沿用，本工具不创建另一套生产插件或执行系统。

## Core v2 独立入口（2026-10-29）

旧 synthetic-v1 的五例、命令和报告契约保持不变。Core v2 声明32例七维开发回归集，其中23例实际调用产品函数检查合成输入，9例需要真实运行证据，固定记录为 pending。它不是32个真实业务任务的通过证明，不代表语义模型质量、完整权限服务、崩溃恢复或Token收益。

在仓库根目录、已有根 tsx 和本目录固定 Promptfoo 0.124.1 依赖的环境运行：

```powershell
node --import tsx --test tests/evaluation-core.test.mjs
node --import tsx tools/evaluations/core-v2-run.mjs --output tools/evaluations/output/core-v2-UNIQUE
```

每次使用新的输出目录。运行器固定本地provider/JS断言、清除凭据环境并复用网络阻断；execute拒绝。输出包含原生JSON/JUnit/HTML、manifest、gate与日志，仅保存在忽略目录。Promptfoo 对 pending 返回失败断言（退出100）；外层因为完整验收未完成返回1。不能将这个命令称为通过。`gate.counts` 区分 passed/failed/pending，`integrity` 只对完整且符合版本与证据规则的工程报告为true；`complete` 因9项pending保持false。源码在并行开发期间变化时integrity也失败，最终需要在稳定源码重跑。

manifest绑定dataset、适配/断言/门禁/运行器、全量允许范围源码、lock和Promptfoo版本。`rawDigest`绑定解析后JSON，`rawFileDigest`仅额外记录文件字节；它们是本地一致性检查，不是签名或可信执行证明。数据输入/公开oracle属于开发回归材料，不能称为盲测。未接API/数据库/浏览器/付费模型；9个pending含具体输入、oracle与最低证据字段，不能用手写“通过”补齐。
