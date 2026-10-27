# 辅助观察脚本编码修复 · 2026-10-04

只修改 [`watch-local-processes-2026-10-04.ps1`](../test-evidence/helpers/watch-local-processes-2026-10-04.ps1) 的文件编码：在原始 UTF-8 字节前添加 `EF BB BF`，8254 → 8257 字节。移除 BOM 后 SHA256 仍为 `01edba92281089d140d158a141b3af5b9835581233b0f7868136c13071ad9487`，脚本逻辑与其余全部字节不变。

真实复现与复验均使用 `Parser.ParseFile`，未运行观察器或操作主服务：

| 实际解析器 | 修复前 | 修复后 |
| --- | --- | --- |
| 系统 Windows PowerShell 5.1.26100.7920 / Desktop | 118 个解析错误，含引号与 using 错误 | 0 |
| PowerShell 7.6.5 / Core | 0 | 0 |

最初仅检查了 PowerShell 7，遗漏系统 5.1 的无 BOM 兼容问题。本次明确调用系统 `WindowsPowerShell/v1.0/powershell.exe`，没有把工具默认 shell 冒充 5.1。[完整 JSON 证据](../test-evidence/new-api-observer-encoding-2026-10-04.json) 保留真实版本、错误样例、文件哈希和修复结果。

这只验证辅助脚本的解析兼容性，不属于主流程验收成功，也不证明原服务已稳定或静默停止问题已修复。没有启动、停止主服务，未改原数据或凭据，未调用付费模型。
