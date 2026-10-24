# 周期只读维护报告

此工具可直接盘点本机为伍数据目录；不连接 API 或数据库，不读取凭据，不发起模型请求、备份、恢复或清理。它复用现有存储扫描和保留政策，不加载 DSH Schedule/Jobs。

```powershell
node scripts/maintenance/report.mjs --root=C:/approved/weiwu/data --report-dir=C:/approved/weiwu/maintenance-reports
```

`--root` 必须是显式本地绝对目录；stdout 为 JSON。`--report-dir` 可省略，提供时其父目录必须已存在，且必须与输入目录及证据文件互不包含。输出目录应由运行此工具的同一账户独占写入；不要与业务进程共享可写目录。

可选 `--retention-input=<absolute-json>` 接受已有 `GET /api/storage/retention` 返回的 `suggestion-only` JSON。它是显式提供的快照，本工具不获取身份或访问 API，也不把快照当成当前删除授权。`--backup-report=<absolute-json>` 接受既有 `scripts/verify-mvp-full-offline-backup.mjs` 输出的 `full-offline-isolated-restore-v1` 报告。所有字段均视作外部证据；这里只做格式、时间和记录结果核对，不重新验证来源真实性、备份字节或恢复能力。

报告的 `checks.storage/disk` 可独立通过；缺失、损坏、旧于 7 天、未来日期、fixture 或尚未复核的恢复证据不会成为整体通过。成功的旧演练只有 `recordedStatus: passed`，其当前可恢复性仍为 `unknown`。凭据恢复不在该演练证明范围内。原 scanStorage 对目录祖先、链接或读取权限的核验失败也保留 unknown。

退出码：`0` 所有检查通过，`1` 记录失败/输入无效/报告无法保存，`2` 信息不足。当前纯离线模式无法取得实时保留和恢复证明，正常盘点通常退出 `2`。自动化应读取具体检查项，不能把“进程已结束”解释为恢复验收通过。

默认扫描期限 30 秒，可用 `--timeout-ms=1..120000` 调整；worker 超时中止并生成 unknown。目录最多检查 10,000 个条目，单个 JSON 输入上限 1 MiB，输出上限 64 KiB，worker JS 堆上限 128 MiB。JSON 只含汇总、固定错误码与可选输入 SHA，不复制文件名、正文、源路径或密码。

输出仅轮换 `report-0.json` 和 `report-1.json` 两个本工具槽；拒绝覆盖不符合本工具格式的现有槽、链接、硬链和特殊文件。其他文件保持原样，不扫目录删除。写入通过独占 `.maintenance-lock` 和同目录临时文件 rename 完成。崩溃可能保留锁或临时文件：先确认没有维护进程，再人工检查这些本工具文件；CLI 不自动判断旧锁失效。目录应由可信用户控制，Node 路径检查不提供对抗同一账户并发恶意替换的完整文件系统隔离。

systemd 示例位于 `scripts/deployment/weiwu-maintenance.service.example` 和 `.timer.example`。先按实际批准的 release、Node 和数据目录修改，再作为用户 unit 部署。先手动运行并核对 JSON，使用本机 `systemd-analyze verify` 核对 unit 后才启用 timer；当前示例未安装或激活。`SuccessExitStatus=2` 只避免把信息不足当作进程故障，JSON 中 unknown 原样保留。示例使用 systemd journal 的宿主保留政策，持久 JSON 始终最多两份；主机 journal 容量另由现有运维策略设置。

工作台“文件与数据容量”中的“周期维护记录”通过管理员只读接口 `GET /api/storage/maintenance` 展示此汇总。API 服务显式配置 `WEIWU_MAINTENANCE_REPORT_DIR` 为与 CLI `--report-dir` 相同的本地绝对目录；报告生成账户控制写入，API 账户只需读取权限。例如本机开发启动 API 前可设置 `$env:WEIWU_MAINTENANCE_REPORT_DIR='C:/approved/weiwu/maintenance-reports'`。这只连接已有报告，不会启动 CLI、扫描、timer、备份或清理；GET 不接受路径查询参数。

读取器只核对两个固定槽，每槽最多 64 KiB，返回状态、统计和时间白名单；源路径、报告原文、错误文本与哈希不进入网页。未配置、缺失、损坏、链接、超大、未来日期或旧于 48 小时均不能成为可用当前状态。有一份有效报告而另一份损坏、未来或过期时，页面保留有效历史记录并显示降级；初次生成仅缺少另一槽不会作为损坏处理。`currentStatus` 始终是 `unknown`，历史结果位于 `report.status`；历史演练通过不证明当前恢复能力。缺少或暂时读不到维护报告不会阻塞原容量和清理功能。

机器主体就绪后可通过既有授权只读 API 取得快照；不应复用管理员浏览器 cookie 或伪造 Origin。F1 的加密周期备份、恢复演练、轮换和回滚仍是后续工作。JJ 实际 timer、当前恢复演练及浏览器交互尚未在此切片验证；当前页面验证使用接口与组件测试。
