# 已知依赖漏洞的兼容补丁计划

本计划修复企业基础核查实际发现的依赖问题，不替换运行架构。先后依赖与文件所有权如下；不得运行 `npm audit fix --force` 或降低既有证据门禁。

## 依据与范围

2026-10-20 对根生产依赖和隔离评测依赖执行只读 `npm audit --omit=dev --ignore-scripts --json`。根报告 1 项 high（sharp）；评测报告 10 个受影响包，来自 basic-ftp、braces、node-forge 三项原始 advisory 的传递影响，不等于 10 个独立漏洞。报告在当前企业基础计划的私有 scratch 中，无模型调用或生产访问。

- [sharp 维护者公告](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)：小于 0.35.5 的预构建库受 librsvg 问题影响。当前 0.35.4，由固定 Transformers 4.3.0 的 `^0.35.4` 引入；官方 0.35.5 存在，Node 要求不变。当前项目的本地使用是文本嵌入，尚无证据证明 SVG 攻击入口，但仍升级兼容安全补丁。
- [basic-ftp 公告](https://github.com/advisories/GHSA-c475-qrg2-pj4r)：当前受影响范围 `<=6.2.0`；registry 最新 6.2.3。评测 runner 禁网且只接受固定配置，仍优先消除有兼容补丁的已知缺陷。
- [braces 公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)、[node-forge 公告](https://github.com/advisories/GHSA-86w9-cpqp-85rv)：registry 最新分别 3.0.3、1.4.0，仍在受影响范围。不能把 audit 建议降级 Promptfoo 到 0.116.7 当作已验证修复。保留明确限制与复核事项，核对实际路径是否使用这些解析器；未经验证不开放不可信模板、watch、FTP 或证书导入。

## 全局约束

- 只改目标兼容传递版本及其平台二进制依赖；不升级 DSH、OpenShell、Promptfoo、Transformers 或 OIDC 协议库。
- 禁用安装生命周期脚本，不下载嵌入模型，不推理大型模型，不访问生产数据或模型 API。
- 不把静态路径分析称为漏洞无法利用，不把 audit 零报告称为全面安全审计。
- OIDC 实现者尚在修改根身份模块；根锁文件待该模块提交并交接后才修改。隔离评测锁文件可独立处理。

## Task 1：隔离评测 basic-ftp 补丁可行性

文件仅限 `tools/evaluations/package-lock.json`，必要的兼容约束应先说明；更新 `tools/evaluations/README.md` 的风险边界和验证记录。

1. 核对当前链路及父包版本范围；只更新 basic-ftp 到修复版本，不接受额外无关依赖变动。
2. 用锁文件重新安装隔离工具，生命周期脚本关闭；实际 CLI 预检和现有两个测试文件均通过。
3. 再做只读 audit，列出仍存在的原始 advisory 及传递影响；审查 runner 固定配置/禁网是否阻止有关能力入口，保留未验证边界。
4. 独立复审后提交；远端 Windows/Linux 对新提交检查。不得把上次提交的 CI 作为新锁文件证据。

实施结论：固定父包 `get-uri@8.0.1` 要求 `basic-ftp@^5.3.1`，已发布修复 6.2.3 超出兼容范围。本轮不覆盖主版本、不降级 Promptfoo，隔离锁文件保持不变；README 记录三项原始公告、10 个受影响包及固定离线流程的限制。该任务完成的是可行性核对与风险记录，漏洞仍未消除。

## Task 2：根生产 sharp 补丁

等待根锁文件所有权交接。只修改 `package-lock.json` 的 sharp 及对应预构建库条目，保持 Transformers/直接依赖不变。

1. 精确升级到 0.35.5；检查差异没有其他版本漂移，安装脚本关闭。
2. 不加载嵌入模型；检查实际 sharp 模块和版本、用本地合成像素验证编码/解码，类型检查及构建通过。
3. 对生产依赖再 audit，确认该 advisory 已消除；部署前在目标 Linux 的隔离安装验证二进制兼容性，未验证时不得标为 JJ 已发布。
4. 独立复审后提交、记录锁文件摘要与实际验证范围。

2026-10-20 本地结果：`npm update sharp --ignore-scripts --no-audit --no-fund` 将 sharp 更新到 0.35.5。程序比较 HEAD 与新锁文件，确认只有 sharp 及 26 个 `@img/sharp-*` 平台库条目改变，根 manifest 与其他依赖不变。Windows 实际模块为 sharp 0.35.5 / libvips 8.18.7；合成 2×2 RGB 数据编码为 98 字节 PNG 后解码逐字节一致。在线生产依赖 audit 返回 0 项，类型检查与构建通过（既有大 chunk 提示保留）。这不等同于全面安全审计；Linux/JJ 的隔离二进制检查仍待执行，尚未部署生产。

## 任务和依赖检查

| 关系 | 检查 / 结论 |
| --- | --- |
| Task 1 / Task 2 | 不同安装目录、锁文件与运行库，可分别验证；Task 2 等待身份实现交接 |
| Task 1 / 离线 CI | 复用已通过的固定官方 CLI 测试；依赖改变必须新版本检查 |
| Task 2 / OIDC | 不同时写根锁文件；保留新增身份依赖，禁止还原或覆盖 |
| 两任务自身 | 有补丁才更改，无补丁明确记录；依赖审计和功能检查分别报告 |
