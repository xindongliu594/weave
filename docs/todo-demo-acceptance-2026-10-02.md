# Todo API 真实模型完整演示验收（2026-10-02）

最终结论：项目 `782ecdd3-8235-4c32-95b8-d6f3fd1cabe3` 的运行 `99551bf3-94f0-464a-8cd7-6935ad679ab8` 已完成，档案完整。开发、独立审查、经理汇总三项任务均为 completed，独立审查 verdict=pass。

## 访问和交付

- 工作台运行：[打开完成记录](http://127.0.0.1:4310/#run/99551bf3-94f0-464a-8cd7-6935ad679ab8)。
- 本轮已启动本机预览：[健康检查](http://127.0.0.1:3000/health)、[Todo 列表](http://127.0.0.1:3000/todos)。预览随进程结束而停止。
- 五个交付文件位于 `.data/local/workspaces/99551bf3-94f0-464a-8cd7-6935ad679ab8/`：server.mjs、todo.test.mjs、README.md、acceptance.test.mjs、acceptance-report.md。
- 在该目录运行 `node server.mjs` 启动；`node --test todo.test.mjs` 和 `node --test acceptance.test.mjs` 分别运行开发与独立验收测试。
- 仅用 Node 内置模块，绑定 127.0.0.1。数据在内存中，重启清空。

## 本次真实证据

模型为本机已配置中转站的 gpt-6-luna，没有使用固定回复服务。方案由真实模型生成；执行前仅人工把 verify 中的说明改为精确命令。模型生成与修正全部五个交付文件；操作者核查并逐次批准测试，没有手工编辑交付文件。

宿主保存了三项真实任务的交接记录。开发测试经历两次失败后由员工修正，最终成功；独立测试包含真实 Windows CLI 子进程启动、全部接口与错误输入，并在报告写入后复测成功。

| 事件序号 | 任务 | 命令 | 退出码 |
| --- | --- | --- | --- |
| 758 | implement_todo | `node --test todo.test.mjs` | 1 |
| 1180 | implement_todo | `node --test todo.test.mjs` | 1 |
| 1566 | implement_todo | `node --test todo.test.mjs` | 0 |
| 2367 | independent_acceptance | `node --test acceptance.test.mjs` | 0 |
| 2678 | independent_acceptance | `node --test acceptance.test.mjs` | 0 |
| 2969 | independent_acceptance | `node --test acceptance.test.mjs` | 0 |

操作者另行运行 `.data/qa/verify-todo-demo.mjs`，10 项真实 HTTP 检查全部成功，检查前后文件哈希一致，并与宿主交接哈希逐个一致。详细结果为 `.data/qa/todo-demo-independent-verification.json`。

报告文字的已知误差：模型生成的 acceptance-report.md 提前把报告前第二次测试的耗时 3496.192 ms 标作报告后测试。真正的报告后测试是宿主事件 seq 2969，退出码 0；以下运行档案与独立核验是最终证据，不能以报告叙述替代命令记录。 保留模型原始产物，没有事后改写封存文件。

## 调试过程和费用

| 运行 | 状态 | 已结算调用 | 按配置单价计算的费用 |
| --- | --- | ---: | ---: |
| acfc9bb6-a4ab-4ff2-bac7-344eda4b604a | failed | 3 | $0.0030160 |
| 8dd02312-8ebf-447b-9251-1bf18d05afc9 | failed | 26 | $0.0337428 |
| 99551bf3-94f0-464a-8cd7-6935ad679ab8 | completed | 45 | $0.0654913 |

本轮两个演示项目含方案生成累计已结算 76 次调用，$0.1058068；另有 $0.0060544 保留为待核对预留，不计作确认收费或零费用。预留记录保持原样；更早原项目的 Astra 超时记录亦未清零。金额是应用按配置单价计算的数值，中转商账单可能不同。

首轮因摘要阈值过低，在写代码前失败；第二次执行在独立测试成功后丢失本机操作领取回执；修复后在同一项目、同一方案和剩余预算内完整重试成功。所有失败档案保留。

## 产品修复和回归

- 上下文摘要软阈值改用与 DSH 计量器一致的估算单位，保留独立字节上限；本演示为详细任务设置 192 KB 上下文。
- 领取响应丢失时，只重新提供服务端确认尚未开始的操作；启动依然需要原子状态转换，已开始的操作不能自动重放。本机协议请求等待改为 15 秒。
- 验证命令字段的模型 Schema 明确要求精确命令，说明文本写入任务目标或验收标准。
- 7 项上下文回归、27 项规则/合同检查、4 项 D1 本机集成测试、TypeScript 与网页构建通过。

本记录证明此 Todo 演示流程通过，不代表任意任务均可无人干预完成。
