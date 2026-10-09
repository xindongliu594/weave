# 可选 OpenRig 部门待办接口

为伍保留唯一的项目执行、预算、停止恢复和经理验收入口。此适配只把用户明确选择的项目元数据写入 OpenRig 0.6.6 官方队列，不启动 kernel、模型会话或第二套员工执行器。OpenRig 的 `done` 只表示队列状态。

默认关闭。没有设置 `WEIWU_OPENRIG_CONFIG` 时，不读取映射、不访问 OpenRig。配置无效或 OpenRig 不可用，只影响这些可选接口，原项目仍能在为伍执行。

## 部署配置

设置 `WEIWU_OPENRIG_CONFIG` 为私有 JSON 文件的绝对规范路径。配置在 API 启动时加载；修改后重启 API。不要把真实配置、token 或 OpenRig 数据库提交到 Git。

```json
{
  "schema": 1,
  "enabled": true,
  "bridge": {
    "version": "0.6.6",
    "endpoint": "http://127.0.0.1:57405",
    "expectedSelfHostId": "实际实例的-selfHostId",
    "tokenFile": "/绝对私有路径/openrig/token",
    "stateDirectory": "/绝对私有路径/openrig/mapping"
  },
  "departments": [
    {
      "departmentId": "00000000-0000-4000-8000-000000000001",
      "rigId": "实际-rig-ID",
      "rigName": "实际-rig-name",
      "sourceEmployeeId": "manager",
      "destinationEmployeeId": "dev",
      "seats": [
        {"employeeId": "manager", "logicalId": "dev.manager", "nodeId": "实际-manager-node-ID", "role": "manager"},
        {"employeeId": "dev", "logicalId": "dev.worker", "nodeId": "实际-developer-node-ID", "role": "developer"}
      ]
    }
  ]
}
```

示例值必须由已有部门和官方物化结果替换。支持 Windows 绝对路径（JSON 中反斜杠需转义）和 Linux 绝对路径；不能包含符号链接。token 文件和 mapping 目录必须事先存在。地址只允许带明确端口的 `http://127.0.0.1` 或 `http://[::1]`，不接受外部 URL、重定向或 URL 中的凭据。

部署程序应先以固定 OpenRig 0.6.6、`--no-kernel` 启动本机独立实例；通过官方 `OPENRIG_TERMINAL_BEARER_TOKEN` 为 daemon 配置私有 token。loopback daemon 默认不会生成该 token 文件。使用官方 `materialize-only` 建立元数据岗位并记录 rig/node 身份；不能启动岗位会话。`employeeId` 对应为伍真实员工 ID，`logicalId/nodeId/role` 对应实际 OpenRig 岗位；源员工必须是该部门经理，源与目标员工必须都属于该项目的主部门。HTTP 请求不能提供或覆盖这些配置。

首次物化结果不明时，部署程序应查询既有 rig/node，不能重复创建。部门和项目映射不可被静默覆盖。备份需一起包含 OpenRig 数据库、私有配置/token 和 mapping；恢复先在隔离目录验证。

JJ 的受控部署脚本、实际预检及回滚命令见 [JJ 常驻服务部署预检](validation/jj-openrig-deployment-preflight-2026-10-09.md)。状态统一放入 `data/pilot/openrig`，可随整目录本地备份；现有网页备份导出尚不包含这些可选集成文件。

## 网页接口

所有返回都含 `acceptanceAuthority: "weiwu"`。这些接口不调用模型。

| 接口 | 行为 |
| --- | --- |
| `GET /api/openrig/status` | 只读启动配置，返回 `enabled`、`status: disabled/ready/unavailable`；不联网 |
| `GET /api/openrig/projects?departmentId=…&projectIds=id1,id2` | 最多 100 个项目 ID，按真实部门过滤并去重；只读本地映射，返回 `items`；不联网、不创建 |
| `GET /api/projects/:id/openrig` | 只对已有项目映射执行 OpenRig GET 核对；未映射返回 `not_synced`，不创建 |
| `POST /api/projects/:id/openrig/sync`，`{"version":1}` | 用户显式同步当前版本；读取真实项目、部门和员工，首次最多产生一个官方队列创建请求；已有映射仅查询 |

单项返回：`projectId`、`enabled`、`status`、`queueItemId`、`queueState`、`acceptanceAuthority`，以及可选的脱敏 `error: {code,message}`。不会返回 token、session、内部路径、原始响应或调用堆栈。

单项 `status` 为 `disabled`、`not_bound`、`not_synced`、`synced`、`unknown` 或 `unavailable`。列表中的 `queueState` 为 `null`，表示尚未远端核对；不能把它显示为队列已完成。`not_bound` 需要部署配置绑定，`not_synced` 才允许首次同步，`unknown` 只能查询原工作项。

同步只发送项目 ID、当前版本、部门 ID/名称、最多 1000 字符需求摘要及来源/目标员工 ID；不发送系统提示、模型配置、知识库文件、预算凭据或执行命令。固定 `nudge:false`。当前只建立一次不可变映射，后续项目版本变更不会覆盖旧工作项；队列 claim/closure 与运行终态关联、多版本工作项替换尚未接入。

项目不存在或部门归档返回 404；非法同步输入返回 422 / `OPENRIG_INPUT_INVALID`；过期项目版本返回 409 / `OPENRIG_PROJECT_VERSION_CHANGED`。这两种具名错误都发生在队列写入前。全局 `Idempotency-Key` 中间件另外可能返回 409，表示原请求仍在处理，不能按任意 409 判断未写入。

网络超时不能证明未提交。模块在唯一一次外部 POST 前持久记录固定 qitem ID；即使重启后远端返回 404，仍保持 unknown 并禁止重复 POST。网页也应保留自身请求标识，刷新后先 GET 核对。OpenRig 故障通过此集成的 `unavailable/unknown` 显示，不改变为伍执行状态。

仅 POST 在明确尚未进入 `enqueueProject`、且再次读取确认没有本地 receipt 的前置检查失败时，会附带 `notSubmitted: true`。网页可以据此清除本次请求的本地待核对标记。进入 enqueue 后的任何错误、已有未知映射或映射不可读，都不会返回这个字段；不能把普通 `unavailable` 或 GET 返回的 `not_synced` 当成未提交证明。

## 验证边界

[真实独立实例报告](validation/openrig-bridge-actual-2026-10-09.md) 记录官方队列实际创建、丢失真实成功响应、daemon 重启及同 ID 核对。该报告保留当时模块的精确 SHA256。

随后 API 接入新增字符串员工 ID 兼容和纯本地 `peekProject`。`tests/openrig-router.test.ts` 使用真实内存 SQL、真实 HTTP 路由和持久映射目录，远端 OpenRig 为协议夹具；验证默认关闭、404、批量隔离、输入/版本门禁、员工来源、并发只创建一次、unknown 重启后仅查询、费用及执行表未修改、响应脱敏。这些本地回归不替代生产 API/网页与真实 daemon 的联调验收。
