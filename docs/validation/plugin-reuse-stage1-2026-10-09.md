# 官方 Skill 插件首批接入与验证

日期：2026-10-09。首批复用 DSH `0.1.5-rc.1` 的 `dsh-skill` 和 `dsh-tool-skill`，已发布到 JJ。现有上下文、持久化和检查点继续保留；未安装或启动 MemOS。真实中转站调用为 0，预算和旧费用未修改。

## 网页使用

在 [JJ 网页](http://127.0.0.1:4312/) 打开项目，编辑方案，进入“本次运行的资料范围”：

1. 添加文本资料，将“使用方式”改为“工作方法（Skill）”。
2. 填写唯一的小写名称，例如 `delivery-check`，正文填写经审核的步骤、适用条件及验证方法，最多 16,000 字符。
3. 指定接收员工，并在方案中给这些员工开启“知识检索”和“知识原文”。不会自动扩权。
4. 保存方案并确认执行；任务可以明确要求“按 delivery-check 检查”。员工通过官方目录发现方法，调用官方 `skill` 工具按需读取。

批准后正文固定在运行资料中，恢复沿用其版本和哈希，不读取后来修改的方案。普通资料仍只供检索，只有显式选择的工作方法会注册为 Skill。目录只提供名称和短说明，完整正文按需加载；加载记录显示在运行时间线。

## 实现边界

- DSH 提供注册表、目录注入、加载工具和工具执行流水线；为伍只适配批准资料、员工身份与来源记录。
- 每个员工 Host 只注册自己获授权的方法；另一个员工冒用对象调用也被原生单调 guard 拒绝。加载不会增加文件、命令或预算权限。
- 正文以单个完整知识切片保存，知识读取与 Skill 加载复用同一份数据，没有另一份正文副本。哈希不符时拒绝加载。
- 已加载工作方法不被工具剪枝截成片段；原上下文字节上限仍生效。方法过大仍可能使请求被门禁拒绝，不能据此提高额度。
- 当前方法来自本次批准资料，还不是公司经验的自动发布、Skill 生成或关系图功能。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 本地合同、权限与网页渲染 | 16/16，通过；覆盖哈希、版本、正文限额、重复名称、权限门禁和 HTML 转义 |
| 原生 DSH 员工与上下文 | 41/41，通过；覆盖真实插件目录/工具、跨员工拒绝、冷恢复、检查点与完整方法保护 |
| HTTP 与数据库 | 1/1，通过；新鲜 PGlite + pgvector，实际方案批准、员工资料隔离与加密备份引用 |
| 类型检查 | `tsc --noEmit`，通过 |
| 网页构建 | Vite 通过，1699 个模块；保留现有大包体积提示，不将提示当作失败 |
| JJ 原生插件回归 | 1/1，通过；使用发布环境现有固定依赖，验证目录、读取、隔离与冷恢复 |
| 实际网页资源 | HTTP 返回新编辑入口对应 JS，资产 SHA256 已记录 |
| 业务及费用保留 | 2 个项目状态未变，用量仍为 205 条；没有新增真实模型调用 |

以上原生模型流程使用本地传输替身，验证工程机制，不代表真实模型已经在业务项目中使用 Skill。网页验证覆盖渲染、构建与实际资源，尚未做浏览器点击全流程。

本地相关命令：

```text
node --import tsx --test tests/approved-skills.test.ts tests/approved-skills-ui.test.ts tests/policy.test.ts
node --test services/agent-runtime/approved-skills.test.mjs services/agent-runtime/employee-context.test.mjs services/agent-runtime/checkpoint-context.test.mjs services/agent-runtime/employee-hosts.test.mjs services/agent-runtime/employee-checkpoint-policy.test.mjs
node scripts/test-integration.mjs tests/run-input.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
```

Codex Windows 隔离环境的虚拟临时目录不存在，本轮在 `.data/tests/plugin-reuse-temp/preload.mjs` 设置独立测试临时目录；类型检查正常执行，构建的 realpath 限制通过普通本机权限解决。测试未使用现有数据库或交付文件。

## 发布证据

新发布：`/home/jj/.local/share/weiwu/releases/weiwu-plugin1-20261009`；服务 PID `3553469`。旧发布 `weiwu-jj4-20261009` 保留，原服务配置保存在新发布目录。新发布复用旧固定依赖目录，后续回收旧发布前必须检查这项依赖关系。

- [部署核对](plugin-reuse-stage1-deployment-2026-10-09.json)：包哈希、无活动项目、健康、项目及费用记录对比。
- [实际环境核对](plugin-reuse-stage1-live-2026-10-09.json)：原生插件回归、实际服务资产及哈希。

## MemOS 准入检查

npm 官方注册表实际提供稳定版 `2.0.20`，与前次读取的 GitHub manifest 版本不同。本轮下载公开 tarball，SHA512 与注册表一致：

```text
sha512-gQxTbT2J91AW69vpu2VB3KSDOHX2Jrve2cz7LWjbnJuLY7Ls1oqIYaozznzw6q0g6fzEOKzo7CotxldKK879iw==
```

发布包的 DSH 文档仍说明强制中断可漏记后台 capture；当前依赖组合尚不满足默认 peer 检查，且缺少独立 native SQLite 等依赖。对 `@huggingface/transformers` 的精确要求为 4.2.0，为伍现用 4.3.0，不能覆盖当前版本。此处只完成发布包签名、内容及依赖准入，未运行其核心或安装脚本，不能作为运行兼容性结论。

隔离资料：`.data/plugin-trials/memos-2.0.20-22f85bca513e471695f524f80b7c042c`，包含 tarball、注册表证据、发布文档和修正后的 `admission-result-v2.json`。下一批应准备专用依赖环境与持久事件补记，验证授权、固定版本及审核发布后，再决定接入。

沙箱与临时文件自动回收、公司工作关系图、部门删除转交、自动经验提炼，以及完整 Eval 仍未完成。
