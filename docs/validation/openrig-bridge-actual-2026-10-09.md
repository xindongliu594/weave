# OpenRigBridge 真实独立实例验收

2026-10-09，在 JJ 独立目录使用已固定的 OpenRig 0.6.6、真实 HTTP 接口及官方 SQLite，验证了新增 `OpenRigBridge` 模块。结果通过；这是部门岗位和待办映射模块的验收，尚不代表生产网页已接通，也不代表员工开发、QA 或经理验收。

## 实际通过内容

| 项目 | 结果与证据 |
|---|---|
| 持久岗位绑定 | 官方 `materialize-only` 创建经理、开发、QA 三个元数据岗位；模块核对并保存相同 node ID、角色和部门映射 |
| 并发去重 | 同一项目三个并发调用只产生一次真实 `POST /api/queue/create` |
| 结果不明恢复 | 第二个工作项实际提交得到 HTTP 201 后，测试观察器主动丢弃响应；模块保存 unknown，禁止重发 |
| 服务重启 | 官方停止并重启同一 OpenRig 实例；daemon PID 从 3019300 变为 3020044，另启 Node 客户端读取原映射 |
| 同 ID 接续 | 重启后仅 GET 核对两个原 qitem；新增 POST 为 0，岗位 ID、工作项正文及已有 transition 历史不变 |
| 执行权边界 | 全程 `--no-kernel`、`nudge:false`；真实会话列表为空，kernel agents 为空，未继承模型 API 凭据 |
| 验收权边界 | 官方队列关闭后模块显示真实 done 状态，仍声明 `acceptanceAuthority: weiwu`，不会生成业务 accepted 结论 |
| 收尾 | 官方 stop 成功；独立复查确认 PID 3020044 退出、回环端口 57405 关闭；数据与失败证据全部保留 |

模块 HTTP 调用统计：初始阶段 26 次，其中 POST 2 次；冷恢复阶段 14 次，其中 POST 0 次；关闭后核对阶段 14 次，其中 POST 0 次。两个 POST 分别对应两个不同工作项，均使用调用方固定 ID。

受控丢失的是一个真实成功响应，未使用固定模型响应或模拟 OpenRig 队列。观察器仍使用原生 `fetch` 访问实际 daemon，只在确认第二个真实创建已提交之后丢弃一次返回值。此测试未调用模型。

## 可追溯位置

- 模块源文件：`apps/api/src/openrig-bridge.ts`。
- 源文件 SHA256：`1c819be01ac66122593aa8635e1e26e100ea7340c153297f844d5ab047a3c2a3`。
- 远端目录：`/home/jj/.local/share/weiwu/openrig/probes/bridge-20261009T073004Z-4080bb4a-4850-4368-9a34-cf47a6575176`。
- 数据库：上述目录内 `state/probe.sqlite`；映射位于 `mapping/`。
- Rig ID：`01M4FS3HCS8KAAHE0CDM7H2BKE`。
- 部门映射 ID：`a04f6db3-bd04-4913-867f-34e68999279a`。
- 两个测试项目 ID：`515f335a-73ca-43bf-9f5a-70b94ec94369`、`8aa62631-de19-4580-86d4-92a9e5616a2c`。
- 成功报告：远端 `evidence/result-contract-v2.json`；13 个实际步骤退出码均为 0。
- [公开机器报告](openrig-bridge-actual-2026-10-09.json) 含 qitem ID、请求时间、映射哈希和证据文件哈希。
- [实际测试输出](openrig-bridge-actual-output-2026-10-09.txt) 保存三个真实模块阶段的原始 stdout。

生产服务 PID 2969369 在试验期间保持不变。生产模型账单从 184 行、$0.9332805 变为 185 行、$0.9355284；主任务当时并行执行已授权的真实员工验收，因此本报告不声称全局账单没有变化。本试验的请求轨迹、空会话、无 kernel 及无模型凭据证据确认其没有请求模型。

## 本次发现并修正的问题

1. 官方 loopback daemon 默认不生成 `terminal-token`。首次模块构造因此停止，尚无 HTTP 请求或队列记录。随后依据官方入口源码，通过支持的 `OPENRIG_TERMINAL_BEARER_TOKEN` 配置独立私有 token；凭据未导出。
2. 初版模块把详情接口当作列表元素，错误期待直接的 rig 对象。实际 `GET /api/rigs/:id` 返回 `{rig,nodes,edges}`。依据真实失败及已安装 `rig-repository.js` 修复模块和协议夹具；只读 SQLite 已确认修复前队列记录为 0。

两个失败报告分别保留在远端 `evidence/result.json`、`evidence/result-continued.json`。接续复用同一数据库和岗位，没有删除旧记录或重放未知操作。

相关本地协议测试 12/12 通过；修正后全仓 `tsc --noEmit --pretty false` 退出码为 0。本地测试不计入上述真实接口验收。

## 最小生产集成顺序

1. 由部署程序创建独立私有 OpenRig 配置、token、数据库与映射目录，以固定版本和 `--no-kernel` 启动；将全部必要数据纳入备份。通过官方 `materialize-only` 为已确认的部门建立岗位，保存并核对 rig/node ID。首次物化结果不明时先查询，不能重新创建。
2. API 在保存已确认项目之后调用 `enqueueProject`，把正式需求写入官方队列。网页展示同步状态和 qitem ID；unknown 状态仅提供 `reconcileProject` 核对入口。默认关闭的配置保持可回退。
3. 后续补充官方 claim/closure 适配，绑定现有 `RunCoordinator` 的真实运行 ID 和终态。启动、预算、工具权限、停止恢复及业务验收仍由现有运行协调器控制，OpenRig 不启动另一套员工执行器。
4. 网页从为伍读取执行/验收，从 OpenRig 读取待办归属；分别标明队列已关闭与项目已验收。修改已确认需求、变更岗位时需要版本化映射或官方撤销替换流程；当前模块会拒绝静默覆盖旧请求。

当前未验证：生产 API/网页接入、真实员工运行与 OpenRig claim/closure 的完整关联、多版本需求替换。此次独立实例已停止，不能把它当作生产常驻服务。
