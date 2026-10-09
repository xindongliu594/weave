# OpenShell 真实员工正常运行验收：v11

结论：**正常完成路径通过，22 项独立证据核对全部通过**。员工经已配置的 OpenCode Go / `deepseek-v4.1-flash` 完成一个摄氏转华氏 CLI 小任务：开发生成代码和说明，另一名 QA 生成并实际运行测试，经理只读复审后正式验收。此次不是受控中断恢复实验。

| 身份 | 值 |
|---|---|
| Project | `4ae5cce4-73c1-420a-987f-83db54d196f2` |
| Run | `6197cb6e-d63b-41e9-808e-3666bc376b84` |
| 方案版本 | 11 |
| 终态 | completed，档案完整性 ok，2,082 个事件 |
| 批准／完成时间 | 2026-10-09 15:27:10／15:31:59（北京时间） |
| 独立采集时间 | 2026-10-09 15:32:23（北京时间） |
| DAG | T1 开发 → T2 独立 QA → T3 经理；T3 同时依赖 T1、T2 |

机器核对：[openshell-real-normal-v11-2026-10-09.json](./openshell-real-normal-v11-2026-10-09.json)。实际 QA 完整输出：[openshell-real-normal-v11-2026-10-09.txt](./openshell-real-normal-v11-2026-10-09.txt)。输出文件是原操作返回字节，没有重新运行或手工编写测试结果。

## 员工交付与来源

| 文件 | 员工 | 字节 | SHA-256 |
|---|---|---:|---|
| `cli.mjs` | T1 / `employee-2` / `dev-1` | 2,083 | `51b1b9e7700943b74c4c3610c392ef815c36c6cc464bef4a1ec96a69f799be75` |
| `README.md` | T1 / `employee-2` / `dev-1` | 1,849 | `ab601b391833c1b899ad9d08c4defdf2e3a56dda2d54051b69b090f428009f5b` |
| `cli.test.mjs` | T2 / `employee-3` / `qa-1` | 7,232 | `33a6514402afd8a52431f12e4272daf7591d8ac0d24197a0ca9d77b8145a57df` |

三份文件各只有一次业务写入，无导入文件、无覆盖旧版本。审计将每次模型原生 `session/tool/call` 的完整写入参数，与宿主 `tool/start`、成功 `tool/result`、已实际开始并完成的本地操作、员工 session/attempt、正式交接输出及下载文件 SHA 一一对应。首次创建没有旧 SHA，按“唯一创建且无覆盖”核对，没有错误地要求更新文件时才需要的 CAS 旧版本证明。

交付可从网页该 Run 的交付物区域获取。程序运行方式由员工 README 提供：`node cli.mjs 25`；真实 QA 命令为 `node --test cli.test.mjs`。审计只下载文件用于核对，未编辑或执行业务交付物。

## 真实沙箱与测试

11 个实际文件／命令操作的回执均属于同一个 OpenShell 沙箱；所有成功回执的环境字段与已批准设备一致：

- Sandbox ID：`73ebdec2-4ffb-4235-89c6-301ddb3db409`；名称：`wwe-457e5b8a911a`。
- UID/GID：1000/1000；Node：`v24.19.0`。
- CPU：`100000 / 100000`，即 1 核；内存：536,870,912 字节，即 512 MiB。
- 执行环境指纹：`a2ec8791201283dc2aa31ba1306e6b7235bd50dcb01104b2c428c3a393dbc104`。
- 生效策略哈希：`27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5`。
- 固定镜像：`docker.io/library/node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`。

本次恰好两次命令：开发的 `node --check cli.mjs` 和 QA 的 `node --test cli.test.mjs`，都与各自逐次批准参数、员工和运行对应。QA 操作 `6ed7c1e2-f35d-4816-a64e-f0e6b20eb7c2` 首次执行即 **17 tests / 17 pass / 0 fail / 0 skipped，exit 0**。完整输出 1,366 字节，SHA-256 为 `6b5e2917b701c35f251b868549bd39e559bd5d8a3f9f8dea96cf3875418f090f`。

覆盖包含 0、100、-40 换算，小数容差，缺失、非数字、多参数，以及空字符串、纯空白和制表符拒绝。实际命令证据绑定最终工作区版本 `ec700fddaf87d7c8bf0f5ec22f7e501447ce7be83b1f2bb045a85c8e59e83992`；T1 的两份文件在 QA 和经理阶段均未变化。

## 经理验收与知识引用

T3 的独立审查 session 为 `c158e803-272d-4df5-b664-4e6ccf5b87b6`。该员工通过真实 `filesystem` 操作读到三份最终文件，并核对到相同 SHA 和工作区版本，未写文件。正式 `agent_teams_update_task` 提交 `completed / verdict=pass`，宿主在事件 **#2057** 接受 T3，**#2058** 记录 `quality/reviewed=pass`；判定依据不是员工一句“完成”。正式审查全文及三次读操作 ID 保存在机器证据中。

QA 真实调用 `knowledge_search` 和 `knowledge_read`，读取固定 v2：

- 文档：`981a73f7-419e-4ff6-9920-e394651ebc93`。
- Chunk：`fb4251400884420deb0ad16a328f4d7be65c3152e43de1ead121d7395662b972`，行 7–11。
- SHA-256：`28f402ffac2655212e91e732e03b3490bc2320675430d73de28192ca6dddf08d`。
- 运行知识授权中只有 QA 获准访问该文档；两个工具的模型调用、结果与引用事件相符。

这证明本次正常运行使用了授权的固定知识版本；目录更新后恢复仍引用 v2，需要单独的恢复实验。

## 费用与证据边界

30 次真实请求均有 HTTP 200 记录和 30 条持久化用量。当前 Run 已知费用 **$0.1869684**；采集时项目累计 **$0.8839623**，全部 JJ 试点已知累计 **$0.8953413**。历史收据 `9827dc97-cec7-4e69-bccf-7260922c9ac6` 的 **$0.0192111** 不确定占用保留，未归零；无新增待结算或未知费用。项目 $1.90、试点 $2.00 上限均未提高或超出。

完整原始 trace、API 回执和下载文件已保留：

- 远端目录：`/home/jj/.local/share/weiwu/metadata/openshell-normal-v11-20261009T073223.703581Z-786dd865`。
- 本地私有副本：`.data/research/jj-simple-task-2026-10-08/openshell-normal-v11-captured`。
- 归档 SHA-256：`997767837e5dafd14795a4e683f8787e46b84ee028011b35e3c8700ab54e6230`。
- 原始 export 20,356,281 字节，采集前后两次内容完全一致。公开文档未包含凭据。

需要保留的差异：最终协调者总结声称它自己的会话遭遇 `TASK_NOT_ACTIVE`、无法独立读取文件；这与另一个正式 T3 审查 session 的三次成功读取不属于同一执行上下文。验收采用正式 T3 结果和操作证据，协调者原文仍在 trace 中，未改写。网页展示应以正式审查结果为主。

本次命令输出是 stdout/stderr 合并流，不能宣称获得了两路独立原始流。环境元数据属于运行来源证明，不等于密码学远程证明；物理越权拒绝已有单独沙箱试验。此报告不将正常完成扩写为受控重启恢复通过。
