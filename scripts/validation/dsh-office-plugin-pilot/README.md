# 原版 DSH 办公插件兼容性探针

这是本地组件试验，不是生产安装器或真实员工验收。固定 `@huiliyi37/dsh-office@0.2.4`，复用项目已安装的 DSH `0.1.5-rc.1`。不修改第三方源码，也不修改生产 package.json/lock。

前提：项目与 `services/agent-runtime` 依赖已按各自锁文件安装；Node 24；Python 3 用于原包核对。Windows 下首次创建两个 DSH peer 的 junction 需要相应文件系统权限。工具只使用测试文字和本地文件，不提供凭据或远程图片。

在项目根目录运行以下 PowerShell 命令准备隔离依赖。npm 的网络下载仅发生在准备阶段：

```powershell
$pilotDir = Join-Path (Get-Location).Path '.data/plugin-pilot-20261018'
New-Item -ItemType Directory -Path $pilotDir -Force | Out-Null
Copy-Item scripts/validation/dsh-office-plugin-pilot/fixtures/package*.json $pilotDir
npm.cmd pack '@huiliyi37/dsh-office@0.2.4' --pack-destination $pilotDir --ignore-scripts
Push-Location $pilotDir
npm.cmd ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --cache ./npm-cache
Pop-Location
node scripts/validation/dsh-office-plugin-pilot/run.mjs
python scripts/validation/dsh-office-plugin-pilot/audit-source.py
```

`run.mjs` 在启动插件前核对 tarball SHA512 和版本，检查 DSH peer 指向现有运行时。子进程只获得必需的脚本、包元数据、依赖和本次输出目录读权限；写权限仅限本次输出目录。清理继承环境，不授予子进程启动权限。Node 24 权限模式**不是网络隔离或恶意代码安全沙箱**；生产仍需已有 OpenShell 边界。

输出位于 `.data/plugin-pilot-20261018/runs/<UUID>/`：`result.json`、`receipt.json`、stdout/stderr 和三个样例。退出码 0 表示探针断言及全部能力要求满足；1 表示探针或边界异常；2 表示探针完成但仍有未满足能力。当前原版 0.2.4 预期返回 **2**，原因是 `xlsx_recalc` 不持久化公式缓存。不要把返回码改成 0 或手填结果来制造通过。

这个返回码包含额外的“保存缓存”要求，不能据此判断原文件在表格软件中不可用。后续 WPS 实测已通过：原公式计算、修改输入、除零错误、保存并独立读取缓存均正确。Windows 已安装可用 Excel 兼容 COM 引擎时，运行 `./scripts/validation/dsh-office-plugin-pilot/check-native-recalculation.ps1` 可重现；它只操作所附原插件样例的独立副本，结果保存到 `consumer-runs/<UUID>`。本机接口由 WPS 提供，不等于 Microsoft Excel 或 JJ 服务端验收。

公司 Skill 回归：

```powershell
node --test services/agent-runtime/approved-skills.test.mjs
```

若托管 Windows 运行环境覆写出无效临时目录，在进程内部设置测试专用目录再执行既有测试（无需修改产品）：

```powershell
New-Item -ItemType Directory -Path .data/plugin-pilot-20261018/test-tmp -Force | Out-Null
node --input-type=module -e 'import path from "node:path"; process.env.TEMP = path.resolve(".data/plugin-pilot-20261018/test-tmp"); process.env.TMP = process.env.TEMP; await import("./services/agent-runtime/approved-skills.test.mjs");'
```

该回归使用本地 fixture adapter，不是模型业务验收。探针因权限模式不支持 `fsync` 而使用 DSH 内存组合；生产 EmployeeHostFactory、持久化与恢复不在此探针覆盖范围。完整结论见 `docs/validation/dsh-office-plugin-pilot-2026-10-18.md`。
