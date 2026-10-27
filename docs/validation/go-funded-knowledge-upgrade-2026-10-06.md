NEW Go 知识资料首次 v2 更新 helper 已准备并冻结：`docs/test-evidence/helpers/upgrade-go-funded-knowledge-web-2026-10-06.mjs`。未改旧 helper、其他 agent 源码、原库、项目、权限或员工文件。本轮没有执行任何真实 API、DB、模型、浏览器或文档更新动作。

读取旧 `drive-funded-knowledge-2026-10-05.mjs` 的 update-v2 分支后，保留两份既有测试资料的正文模板。NEW helper 只允许 UI `PUT /api/knowledge/documents/{既有ID}` 各一次，正文精确四字段 `spaceId,title,content,version`，发送 version=1 并要求 HTTP200/version=2。不创建空间、资料、员工或项目，不保存授权、不批准/恢复/重试任务，不调用 model/fee/provider API。持久 project guard 以 wx 写入，首次失败或部分成功后禁止重放。

执行前必须显式传入实际 parent UUID、实际项目版本和确认/生成/setup/stop 四组来源。复用冻结的 Go binding，读取并核对真实取消报告的完整 before/after 文件 raw-byte SHA，再复算 `stoppedCheckpointProof`。随后 fresh GET 要求 exact same-version original parent cancelled、完整导出/PIN、三名 native 员工授权一致、无 child 或同版本另一 Run、无 active Run、native unknown 明确0、各项目 pending0、恢复项目 pending/unknown0。两份历史 v1 的全文 SHA、source 和完整 chunkCount 都须保持；当前目录必须恰好 version1，历史仅一版，明确首次升级。

每次 PUT 发出前重读上述边界，更新后保留完整 before/after、两版正文/hash、Run PIN、全 usage、所有项目 ledger、模型/中转站、部门/项目/空间、审批/native operation 记录及员工 manifest。上述内容必须原样相等，仅两份目标文档 version/content/SHA 改为既定 v2。截图只取知识页面并 mask 密码框。

已存实际 Go v7 HTTP200 确认→生成链与既有 passed finish-setup 在本地验证通过；规划费用 $0.0071565、receipt `8d02d818-9599-48df-b3a2-5bb41c4a24bc`，保留选择 false。此时实际 parent Run 尚未提供，取消、真实 PIN、无 child、v2 更新及员工恢复/QA 都未验证，不能把工程夹具当作实际中断证据。

| 目标文档 | 原 v1 SHA256 | 待更新 v2 SHA256 |
| --- | --- | --- |
| 共享 `74bcc49b-db5d-4729-9e5d-c430f10d6d5d` | 4978203d4ba0eb49f45d998c3772b22fdc707fddea6cb6b21f92652ab51f7650 | cac632f60a9a1cc9ffef3e47ddb06f00efa2dd5558b85f8f2d9105a3673d130b |
| QA 私有 `9ae89b98-2eb2-4302-b79b-ea12ae9a2be7` | 77dfac48cfc2a2224906008f3f3246587765031c784a7e59c6a9cb81311eda93 | 52231e2e92ceb0600a47b16b9037f4a739c719d21ea050b517c7104363ce0220 |

mgr/dev 仅共享，QA 共享+私有，与实际 v7 方案完全一致。两个 v2 正文只替换版本标记和参考说明，不声明代码、已通过测试或员工结论。

两个 node --check 均 exit0；NEW pure tests 34/34、exit0、fetch0。夹具覆盖动态 v7/v8、实际存档链本地验证、完整取消/PIN与角色隔离、no-child/no-retry、精确首次版本边界、金额微小变化、未知 native/fee、旧v1正文和 source、其他资料/权限/模型/员工 manifest，以及 wx 防重放。完整日志见同名 .txt。

严格 CLI（仅待 root review，ACTUAL 字段仍须根实际提供，不可直接执行）：

```text
node docs/test-evidence/helpers/upgrade-go-funded-knowledge-web-2026-10-06.mjs update-v2 --run-id=ACTUAL_PARENT_UUID --version=7 --confirmed-evidence=docs/test-evidence/go-headroom-recovery-confirm-2026-10-06T03-56-22-910Z-d1533bf8.json --generation-evidence=docs/test-evidence/go-headroom-recovery-generate-2026-10-06T03-53-44-337Z-6af3adfa.json --setup-evidence=docs/test-evidence/funded-knowledge-recovery-finish-setup-2026-10-05T12-57-22-336Z-a97d6738/result.json --stop-evidence=docs/test-evidence/ACTUAL_SUCCESSFUL_GO_STOP.json
```

若根后续确认了新版本，`--version`、确认/生成/stop证据及 actual parent/current project 需全部一致；helper 不写死7。版本更新只保存知识目录，不启动 child 或员工任务。

此 helper 不请求维护型 GET /costs。未来只读完整 usage 和各项目 cost-readiness，并保留实际 stop 的完整 receipts/counters。fresh 全局未分配 reservation 未查询，旧 GLM/其他项目 unknown 不能声称为0，也不会在此结算或查询 provider。未来 public GET 会由产品应用读取其数据库；helper 无直接打开原数据库的行为。

| 冻结文件 | SHA256 |
| --- | --- |
| NEW helper | 2465ef87c93615edf709adb945895915a04591fca92358a6dc320de60b7886f7 |
| NEW pure test | 24d18c2ac45f87e39b8a4d0bef90cf955daeeb072e22831c9a467b4cb137ea63 |
| 旧 knowledge helper，未变 | 29b8a01b5e3b26eb9cf62d0bfb18bbe526ac5a25de01427c53c1a8a7551e36b8 |
| Go operator，未变 | cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3 |
| NEW Go stop，未变 | 22f928e9262c34b86971b07891e20adfa06457a7500f762ec6db0da2dfa37baf |

实际源码与来源 byteSHA、边界和未验证事项记录于同名 .json。冻结时间 2026-10-06T04:10:07Z。
