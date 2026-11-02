# 恢复前跨进程写入隔离接入计划

目标：让恢复读取期间的源运行保持稳定，覆盖在数据库终态后仍可能执行的异步尾部。保留 DSH 的运行、会话持久化与现有 SQL 状态机，只补它们和为伍文件档案之间的写入边界。

复用选择已在 [调研和两平台试验](../../research/task-recovery-writer-fence-2026-10-21.md) 验证：固定 `fs-native-extensions@1.5.1`，使用操作系统文件锁，不自行实现 stale/TTL 抢锁。先完成私有原语，再接全部生产者，最后对恢复开放；每步单独记录证据。

现有成果基线 `3eaac81`。累计 $3.41、七笔未知预留、权限、沙箱容量及企业 profile 都不变。全程先做零付费工程验证；生产部署另按已批准验收流程进行。

## 全局规则

- 根级 shared/exclusive gate → 按 UUID 排序的 run lifetime 锁 → 原 SQL 锁 → 短同步 journal 锁。不得持 SQL 锁等待 native 锁。
- 普通生产者持 run shared；恢复读取持 source exclusive；维护使用独立的 exclusive 权限。源读取锁不能充当写入权限。
- 锁目录持久、独立于可移动的 traceRoot，不进入备份/清理范围。锁文件不删除、改名、轮换或按年龄回收；产品工具不得写锁目录。操作结束关闭 FD，不按历史 run 永久缓存 FD。
- OS 锁是参与者协议。路径身份检查发现协议外替换时拒绝；不宣称抵挡同一 OS 用户恶意改目录、网络盘或旧版不取锁的进程。
- 同步 append 保留原返回语义，临界区禁止 await。短竞争有界重试，超时明确失败；不返回假事件、不默默丢事件，不在锁失败时重放设备动作。
- acquire 的 AbortSignal 只取消等待。已经拿到的生产者锁直到实际工作排空才释放，不能用 HTTP 超时、SQL terminal 或清空 active Map 冒充排空。
- 本批不签发恢复批准、不初始化子运行、不改变检查点摘要与原权限校验。

## Task 1：私有 native 锁适配器

**范围**：新增 `services/agent-runtime/archive-write-fence.mjs`、对应 `.d.mts`、`archive-write-fence.test.mjs` 和必要的专用测试 child；只在 runtime package.json/lock 加固定依赖。不改 trace-store、API、运行时/SQL writer、配置默认值或产品开关。

先完成这一个可独立验证的原语层，避免还没接完全部调用者就令同步 append 拒绝所有现有运行。它暂不被生产入口调用；因此不代表已提供完整 writer 静止保证。

私有 factory 接收显式的绝对 `traceRoot`、`lockRoot`。两者必须已经存在、是无链接的普通目录，互不嵌套；拒绝路径 alias、symlink/junction 与异常根。固定逻辑根的身份来自真实父目录及固定叶名称，不随 traceRoot 后续合法替换而改变 namespace。第一批只支持本次验证的平台 win32/linux x64；其他平台明确 unavailable。

建议 API（可调整命名，语义固定）：

```text
createArchiveWriteFence({traceRoot,lockRoot})
  .acquireWriter(runIds, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireSource(runId, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireMaintenance(runIds, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireRootExclusive({signal?,timeoutMs?}) -> Promise<Guard>
  .assertGuard(guard, {mode,runId?}) -> void
  .withJournalAppendSync(guard, runId, syncFn, {timeoutMs?}) -> actual result

Guard.release() // idempotent; no implicit timeout expiry
```

行为约束：

1. Guard 用模块私有身份存储并绑定 factory/root、模式、run 集合、活状态和实际 FD；冻结外部句柄。手写对象、别的 factory 的 guard、已释放 guard、source guard 用来 journal 写入都拒绝。所有错误有固定 code，不能返回成功标记或自动降级无锁。
2. namespace 固定为 `lockRoot/sha256(规范逻辑traceRoot)`，内部 root gate 和每 run lifetime/journal 文件。mkdir/open 必须拒绝链接、非普通文件和 nlink≠1；新文件 `wx`，已有文件非截断打开。FD 与路径 dev/ino 对应，目录祖先身份固定；捕获后的改名/替换在 guard 检查和 journal 入口拒绝。不把文件内容/PID/时间当锁。
3. root shared 在 run 锁之前；run IDs 必须是小写 UUID、非空无重复、最多 128，内部按字节排序获取。获取任意部分失败/abort/timeout，反序关闭已取 FD；不留下活锁。重复申请同 run shared 可以并存，不能共享别的调用链的生命周期。此底层不做 ALS 自动借用；Task 2 接线时实现作用域借用。
4. async acquire 使用 tryLock + 有界 timer，timeout 是 0–2000ms 的安全整数；默认 writer 2000ms，source/maintenance/root-exclusive 0。整个 root+全部 run 获取共用一个 monotonic deadline，不按每个 FD 重置。已有持有者不因等待超时被抢占。signal 已 aborted 时零获取；等待中 abort 清理本次部分锁。取得后的 signal 不提前释放。
5. guard 在取得 root gate 后绑定当前 traceRoot 物理身份，后续 assert 检查不变；root-exclusive 允许调用者在持有期间合法交换 traceRoot，因此仅固定真实父目录及锁目录。release 始终关闭自己持有的原 FD，包括路径检查已失败的情形。后续新 acquire 可以绑定交换后的新根，旧 guard 不能复活。
6. journal 只允许覆盖 run 的 writer/maintenance guard；它再取得独占 journal 文件，monotonic 最多 2000ms，每次短 tryLock；临界区回调必须是同步函数，拒绝 async/Promise/thenable，禁止重入同一 journal 临界区。回调异常仍释放 journal FD；外层 lifetime guard 仍有效。外层 guard 不能在 journal 临界区中提前 release。
7. 不导出裸 fd、不提供 `verified` 布尔、不修改目录内容来“修复”不合法锁、不删除锁文件。仅核对 traceRoot 的路径/目录身份，不读取或修改运行档案内容，不访问 SQL 或模型；测试只使用独立合成目录。

验收：

- [x] 先保存 RED，新增原语实现后验证品牌、错误模式/身份、过期 guard、非法路径、有限等待和异常清理。
- [x] 两个真实进程：writer 阻止 source；多个 writer 共存；root exclusive 阻止 writer；持有者退出后可获取；多 run 部分失败不泄漏前面已取得的锁。
- [x] journal 两进程计数/顺序操作、短争用成功、超时不调用回调；抛错不泄漏，async/thenable/重入拒绝。
- [x] 真实路径替换后旧 guard 拒绝；合法 root-exclusive 交换后新 guard 有效。链接/硬链接测试按平台权限分开报告，不能把权限 EPERM 记作安全行为通过。
- [x] 新测试、现有 trace cursor/journal 回归、类型检查/构建通过，独立审查后记录源哈希；只声明私有原语完成。

2026-10-21 Task 1 完成时：Windows 17 通过/3 明确 OS fixture 跳过，JJ Linux 同四文件哈希 20/20 通过；既有回归 17/17、项目构建和新增声明的独立类型检查通过。独立并发审查无 P0–P2。[验收记录](../../validation/archive-writer-fence-primitive-2026-10-21.md) 保留中间失败与最终哈希。当时原语尚未接生产入口；后续 2b 已接应用协调器，全部 writer 覆盖仍待 2c/3/4。

## Task 2：运行和 SQL writer 接线

接线拆成以下连续步骤，先修复当前运行的真实排空判断，再启用写入锁。Task 2a 不单独宣称 source fencing 已完成。

- **2a：真实排空。** 复用 adapter 的实际请求 `done`、Host 的原始 `close` 和 executor 的原始清理 Promise，提供稳定的 `writerDrained`。包括尚在等待批准的未发出请求、费用回填、关闭尾部；现有带时限的 `drain()` 仍用于业务等待，不能作为释放依据。协调器在记录业务终态后仍保留占用，直到真实排空。清理失败、固定 DSH 版本中无法确认已结束的启动/销毁尾部须明确保留未核对状态，不冒充成功排空，也不重复清理或模型请求。
- **2b：共享配置与作用域。** 固定一个应用根目录映射，接 ALS 同链借用和 producer 生命周期计数。入口先取锁，再进入原 SQL 锁序；后台子任务显式保留原作用域。关闭的作用域不能因迟到回调重新取锁复活。
- **2c：全部 writer 与同步 append。** 覆盖下面列出的 SQL、文件和回执入口后，将真实 append 校验与持久写入纳入短 journal 锁。独立两进程竞争验证和全入口审查完成前，恢复来源批准保持关闭。

真实排空完成后补 ALS 的同链借用与 producer 子任务计数，不重新开发调度器。`tick` 先定位候选、拿 guard、再事务重查；`launch` 的 guard 覆盖准备、Host、模型请求的实际 done、usage/finish/trace 及 heartbeat/cancel 尾部。不得把现有 drain 超时当成功排空。

覆盖 `run-state`、`LocalOperationService` 的 poll/start/result/wait catch、executor 的 checkpoint publisher/close、canonical 多事务补记、accepted-stop 外层、审批 SQL UPDATE→append、创建/重试 run 与 standalone verification。入口持锁，低层断言；不能只给 append 上锁后声明全部源已静止。closed handle 拒绝迟到回调，不重新申请新 writer 复活。

把 append 校验、去重、seq、写入、fsync 和 cursor 更新放在原语的同步临界区。正常短竞争重试同一尚未写入的事件；写入结果不明沿原完整性错误保留，不盲重放。补充真实两进程连续 seq/sourceKey 与 terminal 后延迟尾部测试。

SQL 尾部采用已有门禁，不增加另一套分布式锁：普通运行状态、accepted-stop 和单收据事务已经先取 project 行锁，来源捕获也必须在取得相同行锁后才读取。费用的批量过期、后台查询过期清扫和同中转站范围更新还可能涉及其他项目；2c 必须让实际执行 UPDATE 的事务持有既有 `918275` shared 门禁，来源捕获则在 project/run 行锁之前取该门禁的 exclusive 模式。不能在持 SQL 锁时等待 native 锁，也不能将独立 autocommit 的“取锁查询”当作覆盖后续 UPDATE。

来源事务沿用 READ COMMITTED，在所有 SQL 门禁取得后读取证据；不能先建立旧快照，再把等待锁当作刷新快照。费用仍按原预算与未知预留规则在初始化时重查，不宣称任务历史摘要覆盖了没有纳入格式的费用字段。原生 PostgreSQL 必须验证：旧事务已发出 UPDATE/COMMIT 后客户端断开，以及跨项目费用清扫排队，来源读取仍等待数据库的实际结果。本段是后续接线要求，本批尚未实现。

2026-10-21 接线边界补充：纯 SQL 的费用过期、查询过期清扫，以及原收据事务内同中转站范围的批量 SQL 更新，可复用 `918275` 保护，不再为这些批量行枚举每个 run 的 native 锁。条件是实际修改事务先持 shared 门禁，来源捕获在 native source 后、行锁之前取得 exclusive 门禁，并让两种保护持续覆盖读取、校验和来源发布。若提前释放 SQL 门禁，就不能再声称 native source 单独阻止了这些费用写入。初始化还须重新核对实时预算、待核对费用与调用次数；不能把未包含 SQL 费用的历史摘要当作费用已固定。此项精简不适用于同时写文件的工作，也不豁免账单查询 claim→外部查询→settle/save 的完整生命周期。

### Task 2a：实际运行尾部与关闭合同

本步骤修改当前生产调用链，但不启用 native 锁或恢复来源批准。使用现成 DSH 生命周期和 adapter 已有请求 `done`，不引入另一个调度器。

**范围**：`openai-compatible.mjs`/声明、`product-runtime.mjs`/声明、必要的 `host.mjs`/`employee-hosts.mjs` 生命周期记录、`run-coordinator.ts` 及相应测试。允许窄改 `sandbox.mjs` 的共享关闭 Promise 和 `index.ts` 的关闭拒绝观察；trace append、run-state SQL 合同、权限、计费策略、原生插件与生产配置不在本步修改。

合同：

1. Adapter 提供同一个只读 `writerDrained: Promise<void>`。永久停止准入后，所有已进入的请求实际 `finally` 完成才履约，包括未 dispatched、还在 `beforeRequest` 中、正在 `onResponse`/`onUsage`/`onCallError` 的请求。请求准入停止前不提前履约。原 `drain(timeoutMs,signal)` 的限时业务语义保持，不把它的返回值用作真实排空证据。
2. Runtime `start()` 返回业务 `completion` 和独立的 `writerDrained`。后者等待原执行与原 Host/executor 关闭及 adapter 真正排空；关闭只调用一次，超时只影响业务等待。所有返回的拒绝 Promise 立即有观察者，不制造未处理拒绝。请求或业务失败本身不等同于清理失败。
3. 固定 DSH 中启动被放弃、未交还 handle 的原生 setup，以及关闭失败，不能只靠 `allSettled` 判为安全。能跟踪的原 Promise 必须跟踪；无法证明结束则保留失败锁存，使用稳定的 `RUNTIME_WRITER_DRAIN_UNPROVEN`/`RUNTIME_WRITER_DRAIN_FAILED`，不泄露内部错误。执行器准备失败且未进入 Host 时，只核对实际已构造的资源，不凭空标记原生遗留。
4. 业务完成而尾部尚在处理时，保留 job/资源引用，`inspect()` 明确未就绪；拒绝新的 `start()` 必须发生在 workspace preparation 之前。成功排空后才释放引用。失败锁存保留占用，不能把失败对象删除后恢复 ready；保持既有已验收业务结果与未知费用。
5. 协调器写完业务终态后仍保留 active 项，直到实际排空。区分执行、排空、排空失败；排空项不再续写 running 租约，也不因已完成 SQL 状态被 heartbeat 当作丢租约再次取消。`close()` 等待原工作与关闭 Promise；已知失败明确拒绝，不能陷入只等 `active.size` 清空的死循环，不能重发模型或设备动作。
6. 不用测试兼容分支给缺失 `writerDrained` 的产品调用伪造已排空。已有 runtime fixture 要显式提供该合同，并标明它只能验证消费端；真实 runtime/DSH 测试必须覆盖独立的生产者行为。
7. 旧 `RunSandbox.close()` 在重置 `started` 后曾丢失原 Docker remove Promise，abort 路径还会脱离调用链启动 close。本步按实际容器代次保存并复用原 close Promise，保留原先每次 terminal 后关闭、下次工具再启动的顺序行为；新启动必须等待旧关闭成功。观察拒绝并向 runtime 提供真实失败，不重复删除、不扩大 Docker 命令权限，也不把终端状态误认为进程已退出。`index.ts` 观察 shutdown 拒绝，不能在排空失败后继续关闭数据库或宣称正常退出。

验收方法：

- [x] 先记录 RED：限时 drain 返回后仍有未发出准入或费用回填尾部，`writerDrained` 仍 pending；释放原回调后一次完成，零重复请求。
- [x] 正常执行、失败/取消、Host 建立前失败，以及真实 DSH 启动中断/关闭失败的结果分别正确；被锁存的未知尾部不误报安全。
- [x] 实际 runtime 的已验收关闭超过原限时后，业务完成、排空未完成、不能启动新项目；原关闭完成才释放。关闭拒绝时业务仍保留、状态明确失败。
- [x] 实际 coordinator + 隔离 SQL：终态先落库、active 保留、heartbeat 不再误取消；排空成功后释放；失败后 shutdown 明确拒绝而不无限循环。保留历史未知费用与已完成节点。
- [x] 相关模型结算、终态、租约、类型/构建回归与独立审查通过；说明未接 native 锁，不等同于跨进程恢复验收。

2026-10-21：实现 `1ed2563`，独立审查所发现的同步预算回调漏洞修复于 `6bc0404`；限定复审 PASS。生命周期 44/44、协调器/租约/文件各 23/23、9/9、3/3、独立恢复状态 2/2；修复相关 adapter/预算回归 96/96，声明与构建通过。PGlite 不支持的原生锁用例被中断并保留原失败记录，未标通过。详见[实际排空验证](../../validation/runtime-writer-drain-2026-10-21.md)。后续 2b 见下；2c、生产部署及企业恢复仍未完成。

### Task 2b：统一目录配置与运行写入作用域

在 2a 独立审查通过后进行。复用 Node `AsyncLocalStorage` 和 Task 1 的原生锁，增加一个小型生命周期适配层；不重新实现锁、租约、计费或调度器。

**范围**：新增 runtime 内的作用域模块、声明和隔离测试；API 在应用组成入口创建共享实例，注入 coordinator；修改 coordinator 的候选获取、启动移交及原工作尾部。低层 `trace-store` 强制校验、所有 HTTP/SQL writer 和费用批量事务留给 2c，恢复入口保持关闭。

1. 逻辑 traceRoot 与 lockRoot 在启动时固定，默认锁目录为 traceRoot 父目录的 `.archive-write-locks`；如支持显式覆盖，须一次解析并验证。目录普通且互不嵌套，不进入工具工作区、备份移动或清理范围。同一进程对同一逻辑根的冲突映射必须拒绝；无法检测另一进程错误配置的事实须保留为部署限制。应用不能为每次 append 或 LocalOperationService 各建一套锁。
2. 作用域使用私有身份绑定 manager、根目录、已排序 run 集合和原 guard。相同调用链的嵌套子集可以借用；扩大集合或借用其他 manager 必须拒绝。独立调用链仍各自申请原生锁，不通过全局 runId 查找并借用别人的活 scope。
3. 在注册异步回调、启动后台子工作前显式 retain；回调恢复原 scope，原 Promise 真正结束才 finish。关闭父级准入后，既有 producer 可以完成尾部，不能新建 producer；整个 scope 结束后，迟到回调拒绝，不能自动重新取锁复活。已知失败或无法证明结束须锁存并保留原 guard，不能用超时或 catch 清空计数。
4. 普通结构化 helper 可等待自身工作排空；tick 使用显式获取的 owner，认领后将这个 owner 整体交给 launch，在 tick 返回时不关闭运行 scope 的准入。运行结束进入排空才关闭准入；已 retain 的尾部继续完成。不能让整个长任务占住 tick，也不能先关闭父准入、又让后续心跳偷偷恢复 retain。未认领的 owner 由 tick 结束。所有移交在结束原 owner 之前完成，返回的拒绝 Promise 立即被观察。
5. tick 先无锁读取候选身份、取得 native writer，再进入原 SQL 事务，重新核对全局上限、部门冲突、任务状态、版本和取消条件后认领。不得持 SQL 锁等待 native 锁。未认领释放；认领成功后沿用同一 scope 完成准备、Host、回执、终态及 2a 的实际排空。
6. 独立心跳保留所涉及运行的原 producer；不在 SQL 锁内扩大 run 集合。关闭期间已开始的 heartbeat/cancel 和运行尾部均须纳入原 scope。旧未知费用、已验收结果和故障状态不因锁获取成功而改变。
7. 当前生产调用者和测试夹具需要的配置须显式对齐。部分入口尚未接线时，不注册“所有档案 writer 已受保护”的全局保证，不启用 source/恢复；不增加绕过已注册保护的 unsafe 开关。

验收方法：

- [x] 作用域子集借用、跨链独立获取、品牌/根/集合不符、关闭后复活均有正反例。
- [x] 真正延迟的 producer 在 parent 返回或业务终态后仍阻挡另一个实际进程取得 source；成功原尾部结束才释放；失败锁存保持占用。
- [x] tick 取得 native 锁前不占 SQL 锁；等待期间被取消、版本改变或部门已被占用，事务重查后不能启动。
- [x] 用实际 coordinator 和隔离数据库验证移交、心跳、关闭；锁竞争/SQL 锁序的生产数据库结论另用原生 PostgreSQL，不以 PGlite 替代。
- [x] 相关回归、声明/构建及独立审查通过；再次列出尚未覆盖的 2c/Task 3 入口，企业 profile 不开放。

2026-10-21：实现 `d9bb4a4`、嵌套有效期/借用身份修复 `a8852f4`，限定复审 PASS。初轮原生与作用域 24 通过/3 Windows OS 跳过，隔离调用方 48 通过/2 原生 PG 跳过，能力 4/4、产品 7/7（原混合命令因另一文件失败退出 1）；修复后作用域 12/12、受影响心跳 1/1，类型/构建通过。未重复无变化的测试；原生 PG 并行证据、剩余 writer、JJ 部署仍未完成。[完整范围、失败与证据](../../validation/archive-writer-scope-2026-10-21.md)。

### Task 2c.1：先补批量费用写入的 SQL 门禁

依据既有接线审查，复用 `shareCostMaintenance` 的 `918275` 事务锁。普通收据事务已先取得该锁；批量租约过期和后台账单查询过期仍有直接 UPDATE，需要先补齐，再继续 native 作用域与严格 append 接线。

**范围**：`cost-control.ts` 的 `expireReservations`、`provider-reconciliation.ts` 的过期查询清扫，必要的窄事务 helper 和隔离测试。不改计费金额、历史保留、模型调用、自动查询次数、授权或恢复入口。

1. 独立清扫在自己拥有的同一数据库事务中，先取 shared `918275`，再执行原 UPDATE，直到真实 COMMIT/ROLLBACK 结束。不得用 pool 的一条 autocommit 取锁查询“保护”随后另一条 UPDATE。
2. `reserveCall` 内的过期清扫沿用该原事务已取得的 shared 锁；内部 helper 不新开连接、不嵌套提交、不等待 native 锁。对外入口与内部事务入口须明确，不能让一个任意 `query` 对象冒充已受保护的事务。
3. 同中转站范围的账单更新沿用既有 `receiptTransaction`，维持 shared 门禁先于项目行锁的顺序。源读取将来使用 exclusive 门禁，但本步不签发来源批准。
4. 保留正常结算、待核对费用、查询认领 token、旧历史和错误语义。数据库失败不得伪造清扫成功或重新发送模型/设备动作。
5. 原生 PostgreSQL 夹具仅使用明确的独占本地测试库与最小测试 schema，不读取生产连接配置，不使用现有其他模块 runner 的 allowlist 绕过入口。轻量 PGlite 仅验证业务回归，不能作为并发锁证据。

验收：原生 PostgreSQL 验证 shared/exclusive 等待、原 UPDATE 后尚未提交的尾部、客户端断开后的实际提交或回滚，以及跨项目批量写入；保留真实 backend/阻塞关系与最终读取结果。相关费用及查询回归、类型/构建和独立审查通过后记录本步完成。原生环境暂不可用时继续完成不依赖它的工作，并明确保留该项未验证。

2026-10-21：`39a1efa` 完成本步，独立审查 PASS。原生 PostgreSQL 9/9、强化断线/内部事务断言的同组三例 3/3，费用和查询回归 29/29，类型/构建退出 0。真实断线样例最终提交，来源等待门禁后才读到已提交结果；未重放。原 timeout/夹具失败与有效 RED 全部保留。专属集群已正常停止，约 49.8MB 数据和测试凭据配置已核验清理。[验收及边界](../../validation/cost-maintenance-tail-2026-10-21.md)。

本步只解决 SQL 批量写入的数据库尾部。Task 2c 余下所有 run/HTTP/设备/收据 native 作用域、严格 trace 注册和同步 append，以及 Task 3–4，仍须逐项完成。

### Task 2c.2：取消请求的已知拒绝不能留下永久占用

接续只读审查发现当前 `cancel` 的具体问题：不存在或已结束的运行会正常回滚并返回 404/409，但拒绝穿过 `withWriter` 后也会触发未知写入失败锁存。这一步先修该已存在的接口边界，保持作用域管理器的保守失败合同。

**范围**：`run-coordinator.ts` 的 `cancel/cancelRequest` 与必要的限定取消测试。复用现有 SQL 事务和 AppError，不增加通用异常分类器、强制释放或失败复位接口。

1. 仅在原代码中“运行不存在”“运行已结束”的明确写入前分支，等待同一事务 ROLLBACK 成功后返回私有拒绝结果。作用域正常结束后，再向原 HTTP 调用方抛出原 404/409。
2. 不按任意 AppError、4xx、取消标记或错误前缀判定安全。SQL 错误、回滚/提交不明及原 runtime.cancel 的失败仍在原作用域内拒绝并锁存。
3. 保留独立 HTTP 取消作用域与运行原本显式保留的取消 producer；不借别的调用链，不重发取消或设备命令，不改经理/员工状态、权限及费用规则。
4. RED/GREEN 覆盖不存在和终态运行的原错误及后续另一个实际进程取得 source；注入 rollback/COMMIT 或原取消失败，source 仍应受阻。失败夹具由实际进程退出清理，不加测试专用强制解锁。
5. 只运行受影响取消/租约用例、类型/构建并独立复核；保留失败日志，不重复已通过原语与全部调用方套件。

2026-10-21：`020ad4e` 完成限定修复，独立审查 PASS。修复前六个普通拒绝均复现锁占用；最终取消 14/14，受影响 lease 夹具修正 1/1，类型/构建退出 0。中间环境、夹具及类型失败分别保留；四份有准确身份的临时目录已清理，无准确身份的中断残留明确未验证。[验收及边界](../../validation/cancellation-writer-scope-2026-10-21.md)。

后续普通控制接线再覆盖 recovery、run-state 原事务、协调器原始 usage/approval SQL 和审批决定 SQL→trace。它们须复用 project/run 事务边界，并传播实际档案写入失败；不能只加 ALS 包装就宣称覆盖数据库尾部。创建/重试、verification、设备、canonical、accepted-stop 继续按原矩阵分步完成；当前不开放 source 或企业 profile。

### Task 2c.3：普通恢复、状态和审批写入接线

接续既有调用点审查，复用 `run-state.ts` 的 project→run 事务、`918275` 门禁和应用唯一 writer manager。无需引入新的调度器、事务库或异常分类框架。此步在 2c.2 复审通过后实施。

**范围**：`run-coordinator.ts` 的 recover、recordUsage、approveTool、traceFinished，以及 launchOwned 的记录失败收尾；`run-state.ts` 的现有事务和三个状态入口；`run-management.ts` 的审批决定；`app.ts` 仅传入现有 manager，以及必要调用方测试。创建/重试、verification、设备协议、canonical、accepted-stop 和低层 trace 强制注册留在后续步骤。

1. 每个待恢复候选先取得独立 run writer，再进入认领事务并重新核对租约、owner 和 active 状态；作用域持续覆盖原费用重放、状态收尾和档案记录。认领失败的 null 正常释放；不得持 SQL 锁等 native 锁。旧 Docker 恢复没有可核对的原停止收据，本步通过 `claimExpiredRun` 的锁内 exclusion 对 `executionTarget?.kind !== 'local'` 的旧路径明确延期：在 claim UPDATE 和 Docker 派发之前拒绝，不对该候选取消操作、重放/结算收据或修改运行及档案，沿现有日志报告。原统一费用过期清扫继续执行，可能把到期预留标为待核对；不为旧运行豁免清扫，也不声称所有费用字段恒定。重复扫描、重启仍不派发，不把旧容器当作已停止。实际停止核对留在设备协议步骤。
2. 状态 helper 接收并断言应用原 manager 的现有作用域，断言在任何 SQL 前执行；实际持久化在断言后的嵌套 `withWriter` 中完成，仅借原作用域，不自动取得另一条调用链的 owner。沿用 shared 门禁→project 行→run 行的锁序，等待原 COMMIT/ROLLBACK；错误时保留原错误，回滚失败丢弃原连接。保持租约、版本、attempt 的现有条件和 false/null 正常拒绝语义。
3. 原 fallback usage INSERT、审批申请 INSERT/取消 UPDATE、恢复的 local_operations UPDATE 放入上述短事务，不使用仅有 ALS 包装的裸 pool 写入。recordUsage 的原收据结算/重复无修改也属于记录边界；审批申请及 requested append、最终取消记账分别属于记录边界。审批轮询不持 SQL 锁，其正常 denied/abort 业务结果在这些嵌套持久化回调外处理。正常预算与授权拒绝也留在原业务调用者；不要把 reserve 的整个准入判断改成失败锁存。
4. 实际 SQL/档案持久化失败必须在原 owner 内留下失败事实，即使运行时已经处理回调错误或业务 catch 保留了验收结果，也不能把该 owner 误当作成功排空。`traceFinished` 不再吞掉档案完整性或 append 错误；它的异常穿过原状态事务。launchOwned 的记录部分失败后保留首个 `entry.drainFailure`、原验收结果并等待原 runtime drain，不再向已失败的作用域重试 finishRun、另取 owner 或绕过断言。若终态 SQL 未成功，它保持待核对；不能保证在持久化已经失败后仍能写入“已完成”注释，更不能把已验收成果改成未验收。不得增加清除失败接口。
5. HTTP 审批先校验输入、只读发现 run 身份，再独立取得 writer；同一事务重新核对身份与运行/审批状态后做原条件 UPDATE，持 owner 到原提交及 append 完成。竞争输掉或运行已停止作为明确无修改结果，事务正常结束后在作用域外返回原 409。数据库成功但 append 失败不得返回成功、解锁或重复审批。
6. 显式更新直接调用状态 helper / runManagementRouter 的测试配置，使用同一应用根的 manager；不增加测试专用无锁模式。失败锁存夹具仍由实际持有进程退出后清理。

验收集中覆盖：native 在 SQL 前取得并在等待后重查；null/false 和审批竞争无修改结果释放；原 replay/append 未结束时其他进程不能取得 source；外层已验收或运行时已处理的记录失败仍保持占用且不重试终态写入；正常拒绝审批在成功收尾后可排空；旧 Docker 路径重复扫描零派发、零恢复修改；原状态原子性和租约行为不变。保留有效 RED、受影响控制/状态回归、类型构建与独立审查。PGlite 只证明业务行为，现有原生 PG 并行用例若未执行须明确标记，不用 SQL 字符串断言代替实际数据库尾部结论。本步不宣称全部 writer 或来源批准完成。

### Task 2c.4：批准与重试的目标运行写入接线

2026-10-24：2c.3 本地接线已验证并补 pending-completion 失败锁存修复；2c.4 目标写入接线已实现，16/16 定向测试通过。原生完整迁移竞争测试已准备，本机 PostgreSQL 缓存无 pgvector 配套，该项待带 pgvector 的隔离 PostgreSQL 验证。未开放父/祖先 source 捕获，Task 3/4 仍待做。阶段证据见 `../../validation/enterprise-plugin-foundations-2026-10-24.md`。

复用现有两个 HTTP handler、原事务和应用 manager，不另建准入服务。接续只读审查核对了导入文件、知识、能力快照、检查点、资源规划预览和 readiness 调用：这些路径没有复制工作区、追加档案、调用模型或启动员工。默认 Docker readiness 是等待结束的只读 image inspect；批准/重试的修改是原事务末尾的 run INSERT 与 project UPDATE。

**范围**：`app.ts` 项目 approve handler、`run-management.ts` retry handler，以及必要的限定测试。在 2c.3 复审通过后实施；不改方案、预算、权限、父运行恢复格式或各业务 validator。

1. 输入解析后，每请求只分配一个拟建目标 UUID，再取得该目标的 writer，最后才 connect/BEGIN/取得 SQL 锁。snapshot 的输入 ID 与最终 INSERT 使用同一个 UUID。已有运行/子运行分支仍按原条件返回它，不去扩大锁集合或取得正在运行的旧子运行 owner。
2. 在原事务重新核对 version、状态、已有 attempt、资源预览与所有原批准/恢复条件；保留 shared 费用门禁→project→parent 的锁序、日/部门/项目预算、历史调用、未知费用保留和未知操作确认。
3. 明确区分尚未派发 COMMIT 与已经派发 COMMIT。经审查的准入路径无文件/外部修改或游离 producer；因此在前一阶段发生错误、且原 ROLLBACK 成功时，可以返回携带原错误的内部结果，作用域排空后再按原 HTTP 形状抛出。依据是实际事务已回滚，不是错误类别；不得建立任意 AppError/4xx 白名单。
4. 每处 COMMIT（含已有运行分支）调用前即标记已派发。COMMIT 不明或 ROLLBACK 失败在原作用域内拒绝、保留首个错误并按需丢弃原连接；后续回滚成功也不能证明先前 COMMIT 未成功。不得重试 INSERT/COMMIT、另取 owner 或在 catch 中抹去回滚失败。
5. writer 持有到实际提交/回滚及原 client 清理结束。批准后的 activity log 和独立 tick 保留原后置顺序；activity log 失败不等于 run 未提交，也不能导致重复创建。未来 readiness 若变成修改或游离任务，须重新审查，不能继续套用本步的已回滚证明。
6. 这是目标运行写入保护。父/祖先的 checkpoint、档案与 budgetHistory 读取尚未被 source exclusive 固定；仅给父运行加 shared 也不能证明稳定。完整来源读取仍由后续 source/maintenance 接线完成，本步不开放企业来源批准。

验收：阻塞目标 writer 时未进入 SQL，等待后重新检查版本/状态；代表性原拒绝和意外 validator 错误在确认回滚后释放；末尾 INSERT/UPDATE 失败全部回滚；提交结果不明或回滚失败持续阻塞；并发批准只创建一次；重试按原条件返回已有且可能活跃的子运行；未知费用/操作/资源预览拒绝不变；准入不写档案/工作区、不执行模型或设备任务。运行受影响批准/重试/导入/预算用例及类型构建，独立审查后记录边界，不重跑无关套件。

## Task 3：对象、维护与备份接线

对象存储/检查点写入绑定同一作用域；维护在原多事务外持 run exclusive；backup 在 SQL 锁之前持 root exclusive，跨目录交换和回滚，不导入/移动锁目录。未接入的 CLI 全目录恢复/迁移仅可在停服窗口使用。

验证两进程下对象复制、归档、备份目录交换与 writer 的冲突；旧 handle 不复活、新 guard 绑定新物理根。保留原 enterprise destination/未知操作门禁。

### 2026-10-29 补齐同步档案写入入口

复核当前代码后，运行、控制、目标 admission、维护和备份外层已有持锁入口，不重复实现旧 ledger 中仍显示待派发的部分。沿用此前选定并固定的 `fs-native-extensions@1.5.1`、`archive-write-fence` 和 `archive-writer-scope`，补齐尚缺的底层强制检查。

1. 在应用启动时登记唯一档案根。登记后不可解除，原始句柄不能借新作用域继续写；独立、未登记的离线夹具保留旧接口。
2. create/open/append 共用已有同步 journal 锁，临界区覆盖快照初始化、验证、去重、序号、fsync 和游标更新。句柄绑定原始存活作用域。
3. SHA 对象写入检查同一运行 writer；日志压缩要求 maintenance。物理写入异常保留原失败占用，不自动解除或重放。
4. 两个真实进程核对连续序号、sourceKey 去重、写入排空和 source 排他；再跑产品/API/维护/备份相关回归与构建。

本批只补上述入口，不能据此宣称所有磁盘/SQL writer 已覆盖。Task 4 的完整来源审查、恢复来源证明、子运行初始化及实际 JJ 验收仍是后续门禁；企业 profile 保持关闭。

## Task 4：覆盖审查及交付给恢复来源核对

2026-10-30：限定覆盖审查形成26行矩阵，已修两个确定缺口（运行账单query全生命周期writer、root内规划诊断写入）；同步检查点的首个mkdir交还受保护对象入口。6项物理失败跨进程回归、14项账单writer/HTTP、17项账单、12项费用、8项规划API、10项对象/Checkpoint及2项目录隔离通过，产品19场景分组有通过证据，8项runner/所有权通过，类型构建0。独立限定/整合审查无待处理Critical/Important。相关原失败、产品聚合124及schema修正后的轻量边界保留，见 [收口报告](../../validation/checkpoint-parallel-2026-10-30.md)。不将本次矩阵当作source认证；后续仍须按来源计划的完整SQL/日志/对象/当前权限条件实现真实捕获与子初始化，企业profile保持关闭。

逐入口核对所有源表 UPDATE/INSERT、档案 create/append、对象/mirror/rename，保留双进程和原生 PostgreSQL 证据。所有 writer 接完且独立审查通过后，才把真实独占 guard 交给恢复来源 Task 2；随后仍须核对完整 SQL/档案/权限/已验收节点，才能初始化子运行。

首次部署需停止旧 writer、统一升级、再启动，不能混用新旧进程。Windows/JJ 原生原语试验不能代替这条完整产品链验收；本计划完成也不自动开放企业 profile。
