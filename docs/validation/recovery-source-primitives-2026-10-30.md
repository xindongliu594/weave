# 恢复来源事实层验收（2026-10-30）

本批在共享工作区继续检查点恢复基础工作；保留另一对话的成员工作台、观测、评测和原未提交改动。没有提交、推送、部署或模型调用，没有调整预算和七笔旧未知费用。总体企业 profile 继续关闭。

## 实现范围

复用已安装原生 fence、DSH 持久化、现有档案/对象读取及恢复记录格式，只补为伍自己的来源事实连接。选择依据见 [复用核对](../research/recovery-source-facts-2026-10-30.md)，实施范围见 [计划](../superpowers/plans/2026-10-30-recovery-source-primitives.md)。

- Manager 新增只读 source 作用域。使用原生 source 排他锁，不能借用 writer/maintenance/root 权限，不能跨管理器、跨 run 或在回调结束后复用。通过原 WeakMap 核对真正 factory 管理器，伪造同名断言或借用真实方法不能更换读取根。
- 私有档案函数固定全部连续事件、唯一首个 run/created、原始 snapshot 字节 SHA，以及 SQL 快照按原归档规则脱敏后的准确对应。保留旧检查点之后的验收和尾事件；前缀不是只记录最后一条事件。
- 严格历史投影包含当前 run 22列、scope 18列、operation 24列，包括新授权/导入边界、所有 runtime effect 字段、失败/取消/迟到及 accepted_stop。指定 claim/owner/result 等列只进入摘要，SQL NULL 不填默认值，六位 UTC 微秒不退化成 Date 毫秒。输入重排按明确字节顺序规范化。

历史单元为纯函数，未连接真实 SQL 读取事务。记录 unknown 以固定事实，不代表放行 unknown。完整来源准入仍需同时使用 task/local 与 runtime effect 的未知操作门禁。

## 验证记录

| 检查 | 本批结果 | 证据边界 |
| --- | --- | --- |
| source 生命周期与跨进程隔离 | 14/14，exit0 | 实际 Windows 原生锁和独立进程，测试文件握手，无模拟锁 |
| 既有 writer / maintenance / root 选定回归 | 12/12，exit0 | 定向选择，不是全 runtime 套件 |
| 档案事实和路径别名 | 最终19/19，exit0 | 真实临时档案、硬链接与 junction；包含修复后的3项受限子进程资源回归，不代表 SQL 原操作验真 |
| 历史纯投影 + 原恢复 codec | 22/22，exit0 | 新10项、原12项，包含受限子进程内存回归 |
| 原检查点 / SHA 对象 / writer 入口 | 10/10，exit0 | 普通 Windows 环境真实硬链接；受限模式原 EPERM 保留 |
| 类型检查与构建 | 最终 npm run build，exit0 | tsc --noEmit + Vite；保留原大于500KB分块警告 |

上述五组测试合计77项通过、0失败/跳过，分别来自明确范围的命令，不能据此声称全仓套件通过。有效 RED、最终输出与源码哈希固定于 [证据清单](evidence/recovery-source-primitives-2026-10-30/manifest.json)。没有使用固定模型响应代替真实模型验收；本批没有模型验收。未改网页，本批未重复浏览器操作，也未运行JJ、OpenShell或真实PostgreSQL来源事务。

## 独立审查与已修复问题

历史审查发现拼接后才判断总大小，宽输入可能先耗尽内存。已改为累计编码字节预算；旧实现于 256MiB heap 子进程内复现 OOM，新实现受控拒绝并正常退出。另修复 UUID 数组强制转换、未配对 surrogate 的字节排序歧义。历史纯单元复审通过。

source 审查发现测试握手直接写最终文件可能读到半截 JSON，已改同目录临时文件 + rename；中间版协议计数错误及其失败也保留。读回调结束先失效权限，再释放 native guard：原生身份失效在释放前检测时保留锁；释放失败一律拒绝、不返回结果。部分 close 已成功时可能解除部分物理锁，不能声称任何 close 异常都保持完整排他直到进程退出。专门测试确认这条区别。异步回调在原生锁实际持有期间可继续只读，权限在 withSource 对外完成前失效；不承诺观察 JS Promise 内部结算瞬间，也没有增加全局 Promise hooks。

档案审查另发现解析工作量缺少节点预算。三项128MiB heap子进程先复现OOM134，再增加原文解析前的结构/深度预检、遍历节点和累计编码大小限制。修复后相同三项受控拒绝，最终完整19项通过。独立复审及跨模块品牌断言核对无剩余Critical/Important/Minor。历史补充的超宽数组同样在Reflect.ownKeys之前拒绝，并经独立复审。

支持范围有明确上限：档案snapshot 8MiB、完整journal 32MiB、250k节点/原文结构符、深度128；历史纯投影64MiB、250k节点、深度64、每类最多4096行。超限拒绝整个来源，不截断、修复或压缩源。它们不是系统整体内存配额；文件和SQL历史更大时，后续需要另外验证扩展方案。

## 尚未完成

这三项都是必要事实层，不是完整的可信来源批准或网页恢复：

1. 同一 source guard 内的费用独占、project/source-child、全部 operation/device/task 及当前授权锁；真正 SQL collector 与微秒投影。
2. 原 scope/claim/result/merge 完整链、所选历史 CP/输入重建、相同路径 A 回退及已完成 B 的固定输入与独立验收。
3. child 对象复制后重新核对、NULL-only head + marker 原子初始化、COMMIT 丢应答补证与当前 head 保护。
4. runtime/网页接线、JJ/OpenShell/真实模型小任务的正常与中断恢复验收。

本批不代表以上四项完成，不以文档或摘要代替实际来源认证。来源认证通过独立审查前不开放初始化入口。
