# DSH停止续跑：只读P0审核（2026-10-06）

未发现新的、阻止未来真实controlled restart的实质P0。当前产品与已安装固定版本DSH源码已接通取消、持久终态和冷恢复。此次只读源码/既有证据，不运行产品测试、真实API/DB/provider、员工代码或服务，也不升级DSH、不改产品源码。

| 能力 | 代码证据 | 结论与剩余真实验收 |
| --- | --- | --- |
| 取消传递 | `run-coordinator.ts:122` 先事务写cancel_requested或queued→cancelled，再调用runtime.cancel；`product-runtime.mjs:55` job.controller.abort并关闭host；model边界与本机/审批工具均使用原signal | 已支持。下一次Recovery9需真实获得cancel POST/202和终态，0POST不能归为取消成功 |
| DSH停止/持久化 | pinned `dsh-agent-loop/lib/index.js:798` cancel abort当前phase；`:1656` dispose执行machine.cancel、whenIdle、持久handle.close；`host.mjs:121` memoized teardown关闭所有handle/员工/插件 | 已支持，不要求升级。产品跨Run恢复使用新宿主与验证检查点；不是强行复用旧进程内存 |
| 终态持久化与崩溃恢复 | `product-runtime.mjs:169` 关闭后存checkpoint、run/finished；`run-state.ts:27` 锁project/run，owner+lease fence后同时保存run/project与待批取消；`run-coordinator.ts:52` lease过期后重放已记录usage/terminal，否则interrupted | 已支持。受控服务重启需确认原run已停止；突然崩溃仍先等待lease与费用/未知操作核对 |
| 已完成节点skip | `run-management.ts:63` 克隆父snapshot，completedTasks+resumeHandoff审核exact attempt/seals；`checkpoint-team.mjs:8` 只在staged/pending/未发布成员阶段恢复完成状态；`product-runtime.mjs:127` restore后才approve | 已支持。完成节点与完整DAG保留；只调度剩余任务。新版approval不能继承旧版成果 |
| 预算/调用累计 | `run-management.ts:77` 净可用预算和costCarryover；`:79` 同项目同版本budgetHistory并检查原cap；`product-runtime.mjs:87` priorSpend、priorModelCalls、taskUsage传预算宿主 | 已支持。未知费需明确retain选择，pending仍拒绝；不重置调用/任务额度。durable-admissions-and-archived-wire指标与host attempts不可混为同一计数 |
| 文件SHA | `handoff-checkpoints.ts:8` 验accepted attempt、依赖、输出seal与剩余输入SHA；`work-files.ts:87` 复制父artifacts到新Run且拒绝链接/冲突；`product-runtime.mjs:82` 再验recovery.files SHA | 已支持。变化或缺失即拒绝；不把存在文件当验收通过，不重放旧审批 |
| 知识pin | `run-management.ts:63` 沿用原snapshot.knowledge，不重新抓当前目录；`knowledge-store.ts:69` 验历史revision SHA/chunkCount，`:94` 查询前验证，`:99` exact documentId/version JOIN；`product-tools.mjs:48` 查snapshot、`:51`记真实citation | 已支持。parent9批准v1后，即使catalog变v2，恢复仍search/read/cite原v1。撤权/历史版本缺失拒绝，不自动改读v2 |

既有 `tests/product-flow.test.ts:518` 包含关闭/重建API协调器与runtime、跨两次中断恢复、只运行未完成review、保留文件seal；这是已存在的隔离工程覆盖，此次未复跑或把它冒充新真实验收。根提供的v8 normal真实续跑成功与当前c929 Recovery8的3600秒deadline失败应分别记录：c929四次停止均0POST，所以它不能证明DSH取消失败，也不能记为controlled interruption成功。

当前下一步的验证边界是Recovery9：真实cancel请求确认、冻结已批准父快照、受控停服/重启、重新核对恢复条件、唯一resume子Run、完成节点无新执行、剩余节点调用与费用继续累计、目录v2下真实v1引用及私有授权隔离。此次没有执行这些动作。

## Recovery9知识pin措辞修订

NEW helper：[generate-go-recovery9-pinned-v1-web-2026-10-06.mjs](../test-evidence/helpers/generate-go-recovery9-pinned-v1-web-2026-10-06.mjs)，SHA `63dc27064071083458a565cc545a0748210e6611b95bc99e90d9ab0de29fbc90`。仅替换需求中的知识恢复段，并更新自身provenance路径；旧helper `64baaca3b6d4ceb628feecd1f782b0149d24ca27f9b8685283b55ee5cf8f1056` 与timeout guard `15c1575c894fc39ffa80fd6ea8c919bbfd5d52ef6d56824519c69ce799305446` 保持原字节。

新需求明确parent9批准snapshot的shared/QAprivate固定v1及原documentId/SHA；catalog后来更新v2时，恢复仍实际knowledge_search/read/cite原v1，不读取或引用目录v2。权限、Go、cap4.77489、两项目各5/新增10/每日20、global100/task40/deadline3600/context192000/prune、final raw binding所有SHA、root loaded/authorization markers、唯一dispatch/永久旧意图/idempotency禁止重放均保持。

离线检查使用TypeScript AST读取template，不eval或import operator；只有readonly timeout guard加载原封存文件并复核SHA。实际源展开revision为3200 UTF-16字符，≤4000。检查3/3 PASS，见 [final log](go-recovery9-pinned-knowledge-2026-10-06-final.txt)。初次检查只有测试mask表达式的括号误放导致provenance差异未归一化，已仅修测试，原helper未改；[first log](go-recovery9-pinned-knowledge-2026-10-06-first.txt)保留。manifest见 [sourceSHA](go-recovery9-pinned-knowledge-2026-10-06-sourceSHA.json)。
