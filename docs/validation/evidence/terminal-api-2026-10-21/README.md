# 终态 API 证据

工程测试，0 付费模型调用；物理设备与模型为明确夹具。主报告：[API 基础](../../terminal-api-2026-10-21.md)。

- [校验清单](manifest.json)：root 独立核对 8 份源码及 27 个已声明 SHA；导出 29 份原始证据，共 66,160 字节。各文件以原始字节保存。
- [暂存区复核](staged-source-check.json)：29 份证据逐字节一致。8 份源码中 6 份逐字节一致；`local-execution.ts` 与 `task-execution-scope.test.ts` 仅由 Git 将 CRLF 规范为 LF，正文一致，两种 SHA 均保留。
- [交付清单](terminal-api-final-manifest.json)：最终 104 项、类型检查、源归属与原始证据路径；其中 `.superpowers` 路径指私有工作副本，同名证据已导出在本目录。
- 最终输出：[12 项收包/绑定](terminal-api-matching-review12.txt)、[28 项终态](terminal-api-matching-terminal28.txt)、[39 项原来源](terminal-api-matching-legacy39.txt)、[25 项 scope](terminal-api-matching-scope25.txt)。每份均有同名 `.exit.txt`，scope 的退出码为 [scope25.exit.txt](terminal-api-matching-scope25.exit.txt)。
- [修复前收包 RED](terminal-api-review-red.txt)、[独立 stopped RED](terminal-api-review-stopped-red.txt)、[准入 RED](terminal-api-preflight-red.txt)、[prepare RED](terminal-api-prepare-red.txt)。早期 `terminal-api-red*.txt` 超时/清理故障保留，不冒充完整行为 RED。
- [复审问题](terminal-api-independent-review.md)、[最终独立复审](terminal-api-independent-review-final.md)、[修复与证据边界](terminal-api-review-fix-summary.md)。

不提供 API Key、数据库连接串或生产资料。公开证据中的 UUID、目录、请求与授权均来自隔离测试。这里的 SHA 固定本批源文件；后续修改应重新记录相应验证，不覆盖本目录的历史输出。
