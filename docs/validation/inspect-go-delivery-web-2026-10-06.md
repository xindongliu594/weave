# Go 真实网页交付 helper：准备与 CLI（2026-10-06）

NEW [inspect-go-delivery-web-2026-10-06.mjs](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/inspect-go-delivery-web-2026-10-06.mjs) 已准备并冻结。语法检查 exit 0，8/8 纯内存测试通过；11 个记录输入的 SHA 测试前后一致。仅执行了 `node --check`、`--help` 和纯测试；**没有执行真实入口、启动浏览器、访问实际 API/model/DB 或员工目录，也没有生成真实网页成功记录或下载包。**

本 helper 复用旧脚本的图、测试输出、预览、逐文件下载和追溯导出流程，旧脚本未修改。所有 Run/项目/版本/确认与生成证据/网页地址由六个必需 CLI 参数明确给出，目标没有固定 UUID、文件哈希、历史费用、测试数或失败状态。optional `--output-dir` 必须是 `docs/test-evidence` 下新目录；缺省生成唯一新 bundle。已存在目录、越界路径或 symlink/junction 都拒绝，不覆盖旧证据。

只有当前 Run 与项目均完成、product 非 fixture、Go 真实确认与付费生成引用链完整、四个 seed 最新节点均有 exact attempt 宿主 accepted、五个最终产物与批准 outputs/验收 seal 一致时才打开独立 headless Edge。两个 literal Node 命令的完整真实输出、退出码 0、tests=pass、fail/cancelled/skipped/todo=0、唯一 local operation 与宿主 call/attempt 回执都须成立。测试数来自实际输出；保留此前失败和旧成功历史，不把它们冒充当前已接受的版本。

实际网页阶段点“刷新审批与交付”并核对 GET 返回的全量 summary/recovery/metadata；核对四节点批准编号、完成状态、标题与依赖并截图；展开真正已接受尝试对应的命令输出并截图；五文件浏览器下载字节必须同时等于完整 manifest 和原始产品 GET 字节。README 与员工经理报告使用真实网页文本预览并截图；完整追溯通过真实网页导出，JSON snapshot/events/integrity 与原始 API export 深度相等。导出 JSON 可能经过网页缩进，下载字节 SHA 与原 HTTP export 的字节 SHA 分别记录。

所有实际 HTTP raw bytes、原 URL/方法/状态/内容类型/时间/路径/SHA，源确认/生成文档副本，PNG SHA，浏览器下载 SHA，前后稳定性及 helper 自身 SHA 保存在新 bundle。前后 Run/档案/产物/本机操作/项目未知费用预留、配置和目标项目用量必须一致。全浏览器上下文阻止所有非 GET、外部/provider、无关 Run、WebSocket 和 `/costs` 维护访问；任意越界请求被拦截后，该轮保留为 blocked，不转为成功。不点击模型测试、审批、恢复、知识保存或结算按钮，不执行下载的员工代码。

`report.json.status=passed` 的范围仅为真实网页交付证据。财务另列 `finance.status=blocked`：不查询厂商账单、不维护全局 orphan holds，不把原未知费用抹掉或推定为零。独立完整功能审计、受控恢复、知识 v2 和备份仍使用各自真实证据。

## 根任务执行示例

使用实际产品网页 origin；`4310` 是网页端口，不能填内部 API 端口。下列 normal v9 的完整 Run ID 与引用路径从已保存真实 approve/confirm 证据核实；本任务收到时仍在复审，**必须等实际 completed 后由根任务执行，本文没有宣称该 Run 已完成**。若最终版本改变，六项一并替换为最终实际值，不能只改 version。

```powershell
$goDeliveryNode = 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $goDeliveryNode docs/test-evidence/helpers/inspect-go-delivery-web-2026-10-06.mjs --run-id=1e91d7d2-d99d-45f7-90a8-bb9bb2c80ff0 --project-id=4938eab8-26ed-4f60-9413-d979f05fa968 --version=9 --confirmed-evidence=docs/test-evidence/go-headroom-normal-confirm-2026-10-06T05-22-57-266Z-df3996b3.json --generation-evidence=docs/test-evidence/go-headroom-normal-generate-2026-10-06T05-19-59-758Z-1a2b5c90.json --base-url=http://127.0.0.1:4310 --output-dir=docs/test-evidence/go-delivery-web-normal-v9-FINAL
```

Recovery v8 已有真实确认/生成证据，完成子 Run 的 UUID 尚待根任务取得。以下是未可执行的模板；占位 UUID 会在任何浏览器/API 操作之前被拒绝。选择完成的实际 child Run，继承 seal 必须属于其批准快照，不能冒用 parent 成功。

```powershell
& $goDeliveryNode docs/test-evidence/helpers/inspect-go-delivery-web-2026-10-06.mjs '--run-id=<完成后实际childUUID>' --project-id=3e101c24-87e6-43ea-80f9-a2c4b0b410f4 --version=8 --confirmed-evidence=docs/test-evidence/go-headroom-recovery-confirm-2026-10-06T05-31-56-670Z-220ef22e.json --generation-evidence=docs/test-evidence/go-headroom-recovery-generate-2026-10-06T05-27-45-597Z-13764fd5.json --base-url=http://127.0.0.1:4310 --output-dir=docs/test-evidence/go-delivery-web-recovery-v8-FINAL
```

完整 source chain 自动沿确认文件的已记录 generationEvidence 引用读取，最多 3 段并验证原始文件 SHA；不是自动挑选另一份 candidate。生成带 correctionEvidence 时保存其被引用的原始文档及 SHA。场景由真实确认文档确定。HTTP JSON 有 50 MiB、单文件有 5 MiB 上限，超限直接 blocked；README/经理完整预览须在网页现有 100,000 字符上限内。只支持源中已有的生产静态网页资源，dev Vite WebSocket 会被拒绝。

根任务调用后的文件布局：`report.json`、`sources/`、`raw/`、`screenshots/`、`downloads/`，全部在新 bundle 内；下载仅保存、读取 SHA，不执行。失败 exit 2，已收到的原始结果留存，不能把 partial report 当成成功。参数/源证据错误会在真实操作前拒绝。

## 本地验证记录

```powershell
& $goDeliveryNode --check docs/test-evidence/helpers/inspect-go-delivery-web-2026-10-06.mjs
& $goDeliveryNode --test tests/go-delivery-web-helper.test.mjs
```

[最终纯测试日志](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/inspect-go-delivery-web-2026-10-06-final.txt)：8/8、exit 0；[语法记录](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/inspect-go-delivery-web-2026-10-06-syntax.txt)：exit 0。参数、GET allowlist、无关 Run/provider/维护拒绝、mock Response 原始字节与失败保留、动态测试数/五文件、缺失与错误 seal/输出/节点、最新 repair 覆盖均用纯内存验证，没有浏览器 fixture 或实际网络。

首轮 [7/8 失败日志](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/inspect-go-delivery-web-2026-10-06.txt) 保留：fixture 的 manifest 与 seal 共用同一个对象，使损坏 manifest 的反例同时改了 seal。测试改为独立 clone 后通过，没有放宽源守卫。

冻结 SHA256（其余 9 个输入及前后核验时间见 [sourceSHA.json](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/inspect-go-delivery-web-2026-10-06-sourceSHA.json)）：

- NEW helper：`2397afde6020adb53a295fc95a2859a2b034b665fa2042a631133d1ae38c4c2f`
- NEW pure test：`d842b6ec8fb5eb84f2127c3a4b481faa8f80f383f7c4ee3a35234d0a297425a8`
- 原旧 inspect helper：`be200f4acb9cd6eb7def064c804314e8b56ee2ff12f4d60fa371d7926ea42bef`，未修改。

本轮没有修改 UI、API、policy、合同、冻结 operator/capture/audit 或员工文件。实际网页结果仍须由根任务后续生成，纯测试通过只证明这些本地守卫。
