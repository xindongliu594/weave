# F1 只读维护健康报告切片

沿用企业总设计和 `2026-10-23-enterprise-plugin-completion.md`；本切片不安装插件、不修改业务 API、不访问生产、不执行备份/恢复/清理或模型调用。

## 复用和范围

- 复用 `storage-governance.mjs` 的 `scanStorage`、`assertStorageHeadroom` 和 `MIN_STORAGE_FREE_BYTES`；不另写递归盘点引擎。
- 复用 `storage-retention.mjs` 的建议政策。可读显式提供的原 `/api/storage/retention` JSON；快照只作建议，不能声称数据库当前空闲或授权有效。
- 读取现有 `full-offline-isolated-restore-v1` 报告的有限证明字段；仅说明记录中的演练结果，不能声称当前备份已重新验证或凭据已恢复。
- systemd oneshot/timer 提供周期触发；本地 CLI 无网络、数据库连接、鉴权绕行或凭据获取。

## 实施步骤与接口

1. 写失败测试：纯 `buildHealthReport({storage,disk,retention,backup,now})` 区分 passed/unknown/failed；缺失、过期、损坏和未复核证据不能成为整体通过。
2. 写报告核对模块；报告只含汇总数字、固定错误码和证据文件 SHA，不复制正文、文件路径、凭据或用户输入文本。
3. 写真实只读 CLI：`node scripts/maintenance/report.mjs --root=<absolute-directory> [--retention-input=<absolute-json>] [--backup-report=<absolute-json>] [--report-dir=<absolute-directory>] [--timeout-ms=30000]`。拒绝未知/重复参数、URL、非普通文件、链接路径、过大输入与输入/输出重叠。
4. 同步原生扫描放 worker thread，主线程限时终止；限制目录条目、输入字节、输出字节，timeout 返回 unknown。报告默认 stdout；显式 report-dir 中仅固定两个本工具报告槽轮换，不递归清理目录，不覆盖非本工具文件。
5. 补部署例子与使用说明；测试实际临时目录、输入/输出保持、链接/硬链/损坏证据、超时、反复写报告的边界。读取本工作区真实文档目录产出一次实盘报告，不使用生产文件。

## 文件所有权和验收

新增 `scripts/maintenance/{health.mjs,report.mjs,inspect-worker.mjs,README.md}`、`tests/maintenance-report.test.mjs`、`scripts/deployment/weiwu-maintenance.{service,timer}.example`。证据写 `.superpowers/sdd/2026-10-23-enterprise-plugin-completion/maintenance-*`；父任务负责全项目回归及最终独立审查，不修改共享 ledger。

验收以 node 测试红/绿输出、真实工作区盘点及源文件 hash 保持为准。原扫描的祖先目录核验失败保留 unknown，不放松校验。JJ timer 和生产机器身份接线列为未验证。

后续挂载点：D2 页面读此汇总；A2 完成后以机器主体取只读 API 快照。当前离线工具已可供操作者/系统 timer 使用，无须先开放新接口。

## 下一片：在现有存储页读取维护报告（2026-10-24）

沿用同一报告格式与两槽文件；复用 `readEvidence` 的普通文件、大小和稳定身份检查，不另写扫描/清理引擎。API 仅管理员读取已生成报告，不在请求中触发扫描、模型或备份。

1. 新建 `maintenance-health.ts` 有界读取器，配置由服务端 `WEIWU_MAINTENANCE_REPORT_DIR` 显式提供；未配置、缺失、损坏、链接、超大、未来时间及超过 48 小时报告均明确 unknown。只读两个固定槽，输出白名单状态/统计/时间，不返回路径或原文。有效槽旁有损坏槽须显示降级，不能隐去。
2. 现有 `storageRouter` 增加准确登记的 `GET /storage/maintenance`，继续 admin-only；不接受用户指定文件路径。增加仅此读取接口的 HTTP 测试，确保零扫描/零写入及来源文件不变。
3. `StorageCenter` 展示“周期维护记录”，区分历史报告与当前状态，缺数据不阻断原容量和清理页。使用组件渲染/前端请求封装测试，不逐项 Computer Use。
4. 增补 systemd/CLI 说明，列出同一显式报告目录配置；timer 例子不自动安装。独立审查后再集成；JJ 的实际 timer 和当前恢复演练仍未验证。
