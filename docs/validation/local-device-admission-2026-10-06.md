# 本机设备准入修复与隔离回归（2026-10-06）

本轮是源码修复和隔离工程验证。真实 v10 Run `17af4ec6-379e-47bc-9b6b-0afd16d49869` 仍为 failed，没有晋升 normal 交付验收；没有调用原服务或真实模型、打开原 PGlite、读取 Key、重启服务、修改员工产物或费用记录。

## 两个已证实的失败入口

- 首个本机 filesystem `LOCAL_DEVICE_OFFLINE`：seq2379、call `call_01_bl29qz3fac5ink2h4i1frx3j`，无 local queued/row。对应 `LocalOperationService.enqueue` 写入之前的心跳准入。
- 经理 `manager_accept` attempt `361b214d-e76f-403b-ade1-78c88375433e`：model/request seq3009，model/finish seq3021 明确 `reason.kind=error`、`failure.code=LOCAL_DEVICE_OFFLINE`，session/turn/end seq3024 同码。经理 wire=0。原帧与源 SHA 见 [只读原档案模型路径](local-device-admission-2026-10-06-v10-model-path.json)。源码路径为 adapter `beforeRequest` → `RunCoordinator.reserve` → `reserveCall.authorize` → `assertRunAuthorization` → `localTarget`。
- seq3037 的 `dispatched:false / CALL_INTERRUPTED` receipt `e42313c3-2248-4af7-9abb-46c29ad8ffe8` 保留为另一个 QA 后续 request seq3016 的中断证据。宿主36次与34 wires的差额没有被估成0费用；本轮没有读取原 reservation 表或改动原账务。

## 最小行为修复

新增 `local-admission.ts` 只对 `LOCAL_DEVICE_OFFLINE` 最多等10秒，每250ms重新尝试。`enqueue` 和 `reserveCall` 每次完整事务先 ROLLBACK 并 release，再在事务外等待；没有在写事务或维护锁内 sleep。每次重新读取当前 run/project/device/授权；真实15秒 SQL心跳门槛保持原值，只有实际认证 poll/register/有效已开始 receipt 刷新心跳才可继续。没有用 API/web PID 或“缺心跳”作为在线证据。

本机门禁先检查运行状态、cancel、租约、版本、部门/知识授权、设备/目录grant、命令权限、冻结设备快照、员工工具和逐次命令批准，再判断心跳并唯一 INSERT。模型门禁也重复完整事务检查；模型能力/配置和全部预算硬门禁先于等待，固定 reservation ID，唯一 INSERT/COMMIT，无第二次外部调用。prepare、execute、adapter → product-runtime → coordinator → reserveCall 均转发原取消/截止 signal，旧单参数 Hook 保持兼容。

已开始本机操作的 soft-heartbeat 回执规则保持：设备/授权/运行/租约/operation deadline/cancel/claim token 仍严格；无效迟到回执不会刷新在线状态。离线提示改为“本机执行器状态未刷新，请确认本机服务仍在运行，然后检查恢复条件”，适用于本地启动器提供执行器的 Windows 网页 MVP。

## 验证结果

使用 bundled Node 24.19，fresh in-memory PGlite（每测试文件独立DB），loopback HTTP协议和模型double；真实本机命令只在测试临时目录运行。

| 检查 | 结果 |
| --- | --- |
| 新准入回归 `tests/local-device-admission.test.ts` | 7/7 PASS |
| 原始 started/late/claim 心跳回归 | 4/4 PASS |
| 原费用预留/未知费/回执/备份回归 | 7/7 PASS |
| 原执行权限/版本/知识/预算回归 | 7 PASS，原2个独立PostgreSQL后端/行锁用例SKIP |
| adapter + settlement + actual employee concurrency | 36/36 PASS |
| `tsc --noEmit` | exit0 |

核心计数：认证恢复后的真实 native command 文件 marker=`once\n`，相同claim重复 start拒绝，单条completed+started记录，late=null；模型恢复时 adapter.calls=1、reservation=1、settled usage=1、wire=1，等待阶段全部为0。真实离线到10秒时 local/model operations/reservations/usage/wire均0。非法device key不会恢复门禁。caller abort、原deadline、run cancel/status、租约expiry/owner、版本、撤设备/改grant/撤命令、部门/知识撤权、冻结快照不符、模型能力变化和剩余预算不足均在下一轮检查停止，零dispatch。prepare/execute的原signal也实际断言。

首integration 10/10已通过；首tsc仅新测试 `onCallError` 回调把 `Array.push` 的number返回给void类型，已修正，失败日志保留，没有覆盖。最终日志：[integration](local-device-admission-2026-10-06-final.txt)、[runtime](local-device-admission-2026-10-06-runtime.txt)、[tsc final](local-device-admission-2026-10-06-tsc-final.txt)；首跑日志：[integration first](local-device-admission-2026-10-06-first.txt)、[tsc first](local-device-admission-2026-10-06-tsc-first.txt)。

源代码于 `2026-10-06T07:31:02.898Z` 完成冻结，9个源码/声明文件和1个新测试的精确SHA见 [sourceSHA manifest](local-device-admission-2026-10-06-sourceSHA.json)。保留所有原dirty更改；不据隔离回归声称真实员工交付完成。PGlite不能验证独立PostgreSQL后端的真实行锁竞争，本轮如实保留此验证范围。
