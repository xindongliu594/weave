**Go 实际验收只读 capture helper：已准备，未运行真实捕获，2026-10-06**

NEW helper 为 `docs/test-evidence/helpers/capture-go-acceptance-2026-10-06.mjs`，冻结 SHA `350f9a3c27f121fbfa301a596a730913bf4be6450b242479b6d9de972717cd9e`。本阶段仅运行 `node --check`（exit 0）和 8/8 内存纯校验，六个源文件前后 SHA 一致，见同目录 `.txt` / `-sourceSHA.json`。没有执行 helper 的 capture main，没有任何实际 API、provider、DB、员工代码/文件、审批或服务进程动作。内存 reader 使用显式假 fetch/假持久化，不连接示例 URL。

已冻结 audit/helper/test 未改：audit `70a884709b69c5057ec6ed577fa5e6edc0dd7186337708e252ea59e45550ca54`，audit fixture `edf43be619ac8d63bb70d082be6dd2122195946737484ba778eee5ced6770686`，Go operator `cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3`，旧 audit `2f2bd665fd98e18d6aaffb09a817e682c31d56311c5cc6281c6237b71dba7dcb`，runtime recovery `aa2866bb3d472f8fe4db94881b3be1e9225b1866949370630dd4d14645271e79`。

所有 CLI 参数均为明确的 `--name=value`。来源只接受本工作树 `docs/test-evidence` JSON；budget-ledger 可为原样 JSON 证据副本，或**仅**本工作树 `.data/funded-acceptance/budget-ledger.json`。拒绝源原库/员工目录、URL、symlink/junction、路径逃逸、重复/未知参数与非正安全整数版本。没有从当前列表选择“第一个/最新 Run”，也没有按模型名推断配置。

下面仅是 root 在实际 normal 完结且确认对应服务/API 身份后使用的命令模板，本阶段未执行。端口必须改为 root 实际持有的产品 API；每次输出和 `.sources` 目录必须全新。已知 normal v7 Run 在本任务发起时仍处于 QA 同 attempt 修复阶段，不能把当时的 dev 6/6、QA 首次 9/10 exit1 当作完整验收。

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  docs/test-evidence/helpers/capture-go-acceptance-2026-10-06.mjs `
  --api=http://127.0.0.1:ACTUAL_PORT/api `
  --output=docs/test-evidence/NEW-normal-capture.json `
  --normal-project-id=4938eab8-26ed-4f60-9413-d979f05fa968 `
  --normal-run-id=95959d2c-3e0a-491a-9d98-469223fe6f59 `
  --normal-version=7 `
  --normal-confirmed-evidence=docs/test-evidence/go-after-truncation-normal-confirm-2026-10-06T02-53-22-889Z-4bfc267f.json `
  --normal-generation-evidence=docs/test-evidence/go-after-truncation-normal-generate-2026-10-06T02-52-15-848Z-95edc690.json `
  --recovery-project-id=3e101c24-87e6-43ea-80f9-a2c4b0b410f4 `
  --authorization-evidence=docs/test-evidence/funded-acceptance-approved-intent-2026-10-05.json `
  --budget-ledger=.data/funded-acceptance/budget-ledger.json
```

normal-only 中 recovery project ID 只用于原两项目/$10 预算归属；不创建 recovery 节、Run、版本、确认或成功状态。Root 当时所述 recovery v6 尚为 draft，因此没有填任何 parent/child/proof 占位假验收。最终采集两侧时，在以上命令另加整组真实参数：

```text
--recovery-parent-run-id=ACTUAL_PARENT_UUID
--recovery-child-run-id=ACTUAL_CHILD_UUID
--recovery-version=ACTUAL_CONFIRMED_VERSION
--recovery-confirmed-evidence=docs/test-evidence/ACTUAL-confirm.json
--recovery-generation-evidence=docs/test-evidence/ACTUAL-generate.json
--restart-evidence=docs/test-evidence/ACTUAL-controlled-restart.json
```

前五项必须一起出现、Run IDs 必须与 normal 及彼此不同。restart 若缺失仍保留实际捕获数据，同时明确列证据缺口，不制造 passed/exit/stop records。知识与拒绝证据可提供 `--normal-knowledge-evidence=PATH[,PATH]` 和 `--recovery-knowledge-evidence=PATH[,PATH]`，各最多四个既有 JSON；必须匹配 actual scenario/project/department，原字节 SHA 与副本都保存。Root 应提供既有 setup/update/拒绝 HTTP 记录；capture 不发 POST 重新制造检索或拒绝测试。

请求只放行 credential-free HTTP loopback `/api` 下的明确 GET：projects、usage、models、gateways、runs、departments、指定 project cost-readiness、指定 supported tool capability-test 列表、所给 Run 的 export/state/manifest/artifact bytes/approvals/local-operations/citations，以及真实 fixed document/space 的当前文档和版本。请求不跟随 redirect，JSON/raw archive 单份最多 50 MiB、artifact 最多 5 MiB、manifest 最多 128 个文件。下载对每个文件核对路径、重复项、原始 bytes/size/SHA；不会执行员工源码。确认与 generation 使用原 SHA 引用链；correctionEvidence 独立原样保存并核对既有 invalid HTTP200/preview/positive paid receipt，不伪装为缓存链。

`/costs` GET 在产品源码中执行 expireReservations，所以只以“预算维护”目的允许，不能宣称完全无业务副作用。前置先读取**所有** public project 的 cost-readiness，要求 model pendingCount=0 且 receipts 无 pending，并检查 public product run 无 queued/running/cancelling/unfinished。之后实际返回还要求所有 open calls 为 uncertain、保留完整 raw history、无 querying provider reconciliation。该产品没有一个维护前可读取全局 orphan pending 的纯 readiness endpoint；capture 如实记录这个预检范围，**不会声称维护前证明了 orphan pending=0**。没有 provider query/reconcile/模型/执行/审批/安装 endpoint，也没有直接 DB client。费用原 unknown amount/status/history、原记录和原两项目上限继续保留，由后续 audit 独立判断；SDK 费率不能充当 provider bill。

采集对项目、public 模型/网关配置、原 ledger、全 usage/open calls/readiness 重复前后核对；保护原 $0.48 项目的批准 version、recorded/retained view 与 cap。 supported tool test 必须是实际 ID、supported、当前 modelVersion。原始 intent 和 ledger 保留全字段和字节副本，不由捕获器调整 receipt 分配、基线或预算。原 archive 的 seq/integrity/created snapshot SHA、完整 state snapshot、实际 terminal status 全部核对；每 Run 的 export/manifest 在下载后重取比较，完整 journal 和错误/失败回执保留。

知识只读来自真实 snapshot：固定 v1、当前 v2、完整历史 content/SHA/provenance、当前 documents、public spaces/department grants、每个实际 native citation 的历史 readback。部门/空间/当前文档/版本也在结束时重查。snapshot agentDocuments/space grants 与 current employee grants 分开原样记录，没有把当前 v2 替换进固定 v1。缺 fixed/current 或版本不同、没有原拒绝 HTTP 证据、缺 restart 均在 requiredEvidenceGaps 明列；不得因为一个旧布尔值或合成 404 声称访问被拒绝。Root 最终仍须将捕获的原拒绝证据与实际 grant/员工来源逐项复核。

输出是兼容已冻结 audit 的 `normal`/可选 `recovery`/`finance` JSON；确认字段为 `{path,sha256}`，后续 audit CLI 的 hydrateCapture 按真实源链加载。完整 archive/state/downloads、public model/config、固定引用、parent/child/restart、全阶段重复 ledger 均保持原对象。每个 HTTP 响应的 endpoint/URL/method/status/content-type/byte count/SHA/rawPath 写入 sources；原始 HTTP JSON 和 artifact `.bin` 字节保存至同名的新 `.sources` 目录。原 sources 不是员工文件的覆盖位置。输出以 exclusive-create 防覆盖；失败保留已有原字节及明确 blocked 状态，不自动重试、重放或清除状态。合并主 JSON 同样受冻结 audit 的 50 MiB 输入限制，超过时阻断并保留已保存 raw sources。

`collection.status=captured-stable` 仅表示采集的重复事实稳定，绝不等于验收；`actualMvpAccepted` 恒为 false。helper 对所提供侧调用纯 auditGoProject，记录 functional/financialRetention 和真实阻断项。`auditReady` 需实际两侧和相应知识/拒绝/restart 证据齐全；normal-only 始终没有整体验收就绪。独立 auditGoTodo 将未提供 recovery、失败/未完结节点、费用未知等继续 blocked。合法失败终态也可作为真实失败证据保存，不能被采集器改为完成。

正常执行后，以新的 output 交给已冻结离线 audit CLI；必须保留原确认/生成 JSON 的相对路径与 SHA。备份按既有 `final-offline-backup-plan-2026-10-05.md` 的原样 helper 副本/第二个 worker/actual code与data manifest 方案由 root 执行，本轮没有新增备份实现、运行备份或停服。如把 capture/audit 移至新的代码审计根，保持仓库相对布局与所有已冻结依赖、原证据 JSON；metadata ledger 可原样复制进该根 docs/test-evidence 后用明确路径传入，不能读取原 `.data/local` 或改写来源正文。

八项纯校验覆盖：normal-only 无恢复对象；完整 recovery 显式身份/版本；pending/active 前置阻断；provider/settlement/search/traversal/伪造 gate 被拒绝；fake reader 只 GET 且保留精确 raw status/SHA、未获准调用 dispatch=0；manifest/file 字节严格匹配；pending/querying/不完整 archive 阻断；v1/v2 content/space/SHA/来源严格验证并如实报告其它 current version。语法检查和纯校验时间为 2026-10-06T04:01:19.0785457Z 至 04:01:19.3791794Z。真实 API 路径和 HTTP/data shapes 的整套现场采集留待 root 实际运行，工程记录不能替代它。
