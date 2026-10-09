# JJ OpenRig 正式部署独立核对

主任务已执行通过审阅的 `--apply`。随后独立只读核对通过；此时尚未在网页同步项目，因此真实队列数为 0。本报告不把空队列服务启动视为网页全流程已验收。

| 核对项 | 实际结果 |
| --- | --- |
| 常驻服务 | `weiwu-openrig.service` active，PID `3130076` |
| 官方 runtime | OpenRig `0.6.6`、固定关键源文件 SHA256 |
| 监听/身份 | `127.0.0.1:57415`，`selfHostId=host-91ecbc4f` |
| 真实进程环境 | 与从空白构造的白名单精确一致；`OPENRIG_NO_KERNEL=1`；未继承模型 API Key 或代理 |
| rig | `01M4FVAV12PXXFXH4Q9XJY00K2`，`weiwu-pilot-3c0cb5ee` |
| 真实部门 | `3c0cb5ee-0b24-4ef5-9957-8a048c7dae0a` |
| 来源/目标 | `mgr-1` → `dev-1`，均核对真实项目主部门身份 |
| 元数据岗位 | mgr-1=`dev.manager`/manager；dev-1=`dev.dev`/developer；qa-1=`dev.qa`/qa |
| API 兼容 | rig 详情为 `{rig,nodes,edges}`；node ID、logicalId、role 与保存配置一致 |
| 运行隔离 | 三岗位 runtime 均为 `stub` 元数据占位；`sessionStatus` 和 `canonicalSessionName` 全为 null；会话为空、kernel agents 为空 |
| 初始持久状态 | SQLite `queue_items=0`；mapping 目录为空 |
| 凭据 | token 文件私有权限；仅返回路径和权限结果，未导出 token 内容 |
| 原产品服务 | `weiwu-jj.service` 仍 active，PID `3041376` |

官方 `spec validate` 和 `import --materialize-only` 都实际退出 0。此处 `stub` 只描述没有启动执行会话的官方岗位元数据，未生成固定模型响应或替代真实员工验收。

配置：`/home/jj/.local/share/weiwu/data/pilot/openrig/bridge-config.json`，SHA256 `680ec1bbd1a1d3861fa775af07c634b42702613eb2f9e372341baacf619a9abb`。

主任务部署原始证据：`/home/jj/.local/share/weiwu/data/pilot/openrig/evidence/deployment-4fbd1ccf-4364-4f44-b2c2-cd015df135f4.json`，SHA256 `63f0ea1b411d9a5e16b883d7862b2365ae8718e7bf136245e8ea90982169f0eb`。

[独立机器报告](jj-openrig-deployed-audit-2026-10-09.json) 包含实际 node ID、配置字段校验、进程状态和部署步骤退出码。本轮独立核对只读，没有创建 qitem、调用模型或更改服务。

## 网页同步后待核查

1. 主任务从网页显式点击一个真实项目的同步按钮，提供页面返回的 qitem ID、项目版本和截图。
2. 独立检查 qitem ID 等于固定部门/项目 ID 导出的请求编号；本地 receipt、部门绑定和官方队列记录均指向同一个工作项。
3. 核对实际 sourceSession/destinationSession 与 mgr-1/dev-1 保存岗位一致；正文只含项目元数据，payload 哈希与持久回执相同。
4. 通过 SQLite 只读查询确认该 qitem 仅有一行；通过为伍批量只读接口确认映射 `synced`，没有自动同步其他历史项目。
5. 页面刷新和用户点击“核对”后仍显示同 ID。列表不把 `queueState:null` 当成已完成；队列状态不变成经理验收通过。
6. 复查服务无 kernel、无员工会话、无模型凭据。为伍业务执行结果、审批与预算沿用原运行入口。
7. 若主任务安排服务重启，独立比较重启前后 qitem/node ID、receipt 哈希及队列行数；不代替用户点击同步，不执行 POST 重放。

待命的私有只读审计脚本 `.data/research/jj-deployment-2026-10-09/audit-openrig-web-sync.py` 使用无效占位 ID，收到主任务实际 qitem 后才运行。当前网页联调、常驻实例重启及回滚尚未由本报告验证。
