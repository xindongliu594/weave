# 项目重规划保留未知费用：修复后冻结结果

2026-10-06 00:56 UTC：隔离 API **16/16 通过**，失败、取消、跳过均为 0。费用模块已在项目行锁和费用策略锁内、收据过期处理之前调用 `requireProjectCostReady`；原失败用例现在拒绝过期 pending，并核对整个账本没有变化。后续最新预算复核仍保留。

本轮只重跑 `scripts/test-integration.mjs tests/project-planning.test.ts`，使用 `C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。限定文件及费用修复的 `git diff --check` 通过，限定文件无尾部空白。测试前后记录的 12 份源文件 SHA256 无漂移。UI 沿用此前 **22/22** 的本地结果，其源码和测试 SHA 与原记录相同，没有再次运行。

确认阶段继续采用保存候选的语义，核对候选与确认的费用保留选择、项目和版本；保存本身不会派发模型或外部操作。再次规划和真正执行仍分别检查费用与执行权限。本轮未增设候选保存的 pending 审批门禁，没有修改限定的四份源文件或测试正文。

原 API **15/16** 的失败证据完整保留在 `planning-carryover-2026-10-06.txt`，SHA256 为 `DB1959B35F83C22312DD3BC5E0E3C3D28A6CBC88C305C7615903924DE459E006`。修复后完整输出及 12 份依赖 SHA 在 `planning-carryover-2026-10-06-final.txt`，SHA256 为 `3B821ACDC87140EFAD15E3E44AD0F54E014BAFDABC29D629B594966AECB9C998`。

| 文件 | 最终冻结 SHA256 |
| --- | --- |
| `apps/api/src/project-planning.ts` | `D3AC7CED1C65DC49DB1E38E5F1EF7F1B66A963E89B705672DA050E99E680A277` |
| `apps/web/src/ProjectPlanning.tsx` | `863CEE67C97673224169B4BBA50176A3CBEECCE1E2C06309A2195AD8368A3975` |
| `tests/project-planning.test.ts` | `020067BA29A0FB1FCCFBE1E0366977A7415F27293D25F6505A69EFDCEC1E2C69` |
| `tests/project-planning-ui.test.ts` | `C1A22C8D3F834CBD27D6A2AD3697C3CA82D9C2AA57A2A276859607F3997F3CD4` |
| `apps/api/src/cost-control.ts`（根代理修复） | `8267BC2E3926D37E8AA1DEABEE796160744AA039E4A309B694D7116804EAB629` |

全部验证仍使用新建内存 PGlite、合成账本和运行档案、本机临时 HTTP 模型 fixture；没有访问原 `.data/local`、请求真实网关、产生真实费用或操作产品运行进程。本地价格和协议 fixture 保持原工程状态；生产模型选择按根代理的新 Go DeepSeek/GLM 指示处理。本记录覆盖隔离工程回归，独立 PostgreSQL 后端锁行为与真实 Go 网关验收仍遵循原验证范围。
