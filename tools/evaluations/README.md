# 为伍离线工程评测

使用独立安装的 **Promptfoo 0.124.1（MIT）**，不进入生产依赖。`package-lock.json` 固定版本和 npm 完整性摘要。它需要 **Node >=22.22.0**；项目既有 CI 的 Node 22.19 不能运行此工具。请单独使用 Node 24；本次实际验证为 Node 24.15.0 / npm 11.12.1。脚本启动前明确检查运行时，不修改根项目 engine 或 CI。

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

`--require-live` 总是失败并返回 `live-evidence-required`；fixture 始终 `executionKind=fixture`、`modelExecuted=false`、`fresh=false`，合成 receipt 和零费用不能计为真实业务运行或质量验收。第一阶段没有接服务端授权、预算、新真实运行、模型质量、生产/CI/API 或网页入口。

依赖安装禁用生命周期脚本。本机安装 631 包、`node_modules` 实测 1,304,223,358 字节（约 1.21 GiB；平台可不同）。仅开发/独立评测使用，不复制到 JJ 生产。没有执行 `npm audit`，不声明无漏洞、完成审计或任意插件适配。

官方依据：

- [npm 包与版本](https://www.npmjs.com/package/promptfoo/v/0.124.1)，实施时执行 `npm view promptfoo version engines license dist.integrity dist.unpackedSize --json` 核实；顶层 npm 完整性为 `sha512-Y6fq/WGTL7lPvDsirNSmmmcPLhURwRao03iv8fCoLbFq6H1eqg5VVTmXiap5Jl+fiRaQQZXYMHb2N1gQm1tGyQ==`。
- [官方 GitHub 源码](https://github.com/promptfoo/promptfoo)、[JS provider](https://www.promptfoo.dev/docs/providers/custom-api/)、[确定性 JS 断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)。固定版本运行证据优先于最新网站说明。
- 项目调研见 `docs/research/enterprise-quality-operations-2026-10-20.md`；DSH 原有发现/执行链路继续沿用，本工具不创建另一套生产插件或执行系统。
