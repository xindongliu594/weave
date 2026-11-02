# 恢复 source/child 组合权限工程验证

日期：2026-11-01。范围只包括原 ArchiveWriterManager 的组合 scope 和定向初始化计划；没有进行数据库迁移、HTTP 恢复接线、模型请求、部署或 profile 开放。

## 实现

`withRecoverySource(sourceRunId,childRunId,fn,options)` 一次复用原 fence 的 maintenance acquisition，持 shared root gate 与排序后的两个 exclusive run lifetime。Manager 只赋予固定 source 的读认证与固定 child 的 writer 权限，不赋予 owner、maintenance 或 root。

source authority 只在原顶层回调有效；nested child writer 与 retained producer 不获得 source authority。callback/native identity 错误沿原 writer 失败策略闭锁，调用方捕获 child identity 错误也不能擦除失败状态。原 `withSource` 仍禁止所有 writer 嵌套。

## 命令与结果

1. RED：先新增测试与 process helper，未改实现。默认沙箱 `os.tmpdir()` 被映射到不存在的重复路径，首次运行 9 项均因 ENOENT 未进入被测接口。改用测试已有形式的显式工作区临时根后，9 项均因缺少 `withRecoverySource` 失败，exit 1，确认有效 RED。

```powershell
$env:ARCHIVE_SOURCE_TEMP=(Resolve-Path -LiteralPath '.private/recovery-scope-test-temp').Path
node --test services/agent-runtime/archive-recovery-source-scope.test.mjs
```

2. GREEN：最小组合 scope 实现后新 9 项通过。随后新增“捕获 child 原生身份失败仍闭锁”第 10 项，先观察该项因错误被吞而失败，再修复该组合 scope 的 latch。

3. 最终组合 scope 与 source scope 回归，exit 0：24 项通过、0 失败、0 跳过。

```powershell
$env:ARCHIVE_SOURCE_TEMP=(Resolve-Path -LiteralPath '.private/recovery-scope-test-temp').Path
node --test services/agent-runtime/archive-recovery-source-scope.test.mjs services/agent-runtime/archive-source-scope.test.mjs
```

新 10 项覆盖 source 禁写/child 事件与对象写入、原 Manager 品牌、固定角色/越界、禁止嵌套与权限升级、sync/async/AsyncResource 失效、retain child 寿命且不传 source 权限、部分排序获取清理、timeout/abort、独立进程 writer/source/root/反向竞争阻断、第三 run 可写，以及 callback/nested/source identity/child identity 失败保留原锁直到原进程退出。

4. 旧 writer/fence 回归在沙箱内（仅临时目录适配）出现原 Node IPC EPIPE：17 通过、10 失败、5 fixture 跳过，exit 1。没有修改这些旧测试或其 helper；原命令获自动审批后在沙箱外运行，exit 0：29 通过、0 失败、3 Windows fixture 跳过。

```powershell
node --test services/agent-runtime/archive-writer-scope.test.mjs services/agent-runtime/archive-write-fence.test.mjs
```

三个跳过分别是持锁 namespace rename、持锁 lockRoot rename（Windows EPERM）和 file symlink（EPERM）。不是本次新增测试的跳过。其余 hardlink、junction、原生锁/进程竞争、journal 序号与超时用例已通过。

5. 三个修改/新增 ESM 文件分别执行 `node --check`，均 exit 0。

## 源码 SHA256

| 文件 | SHA256 |
| --- | --- |
| `services/agent-runtime/archive-writer-scope.mjs` | `9063d45d2ced5ae2816bd77548918f615d9866cccde27083bc8f76dc5ad12f39` |
| `services/agent-runtime/archive-writer-scope.d.mts` | `6ef60fe570c16987fc072f6b85d5b9566c0290b619c98135281dc254f2207116` |
| `services/agent-runtime/archive-recovery-source-scope.test.mjs` | `26a6fac60ef693dd3dc254607d343e7c58792c753e97f5d00b9157def2ee16e0` |
| `services/agent-runtime/test-helpers/archive-recovery-source-child.mjs` | `afee49d866bb7ab68b155daff7f94832a9dda5d2ee7f77f816c340ff90db71cd` |

这是 Windows 原生 fence/Manager 工程证据，不证明 PostgreSQL 锁、COMMIT 丢应答、child 初始化、网页、JJ/OpenShell 或真实模型恢复已完成。SQL 与产品后续工作见 [初始化计划](../superpowers/plans/2026-11-01-task-recovery-initialization.md)。
