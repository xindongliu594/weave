# Append cursor 独立只读审查

修复后的源码复核通过，未发现尚未处理的本次变更缺陷。审查了实现、实际调用点、新测试及 Root 保存的 native 回归日志；只写本报告，没有改源码、运行 live/API/模型/数据库/服务或原员工文件操作。生产正式 build/reload 和实际运行验证仍由 Root 后续完成。

| 核对项 | 源码与已有验证依据 |
| --- | --- |
| 多 handle 序号 | 进程内以 `resolve(root)+RunID` 共享已验证 cursor。取值、redact/序列化、追加、fsync 与推进全部同步，不在这些步骤间 await。实际 120 次交替 handle 追加序号连续，每条 fsync；另一 root 的同 ID 独立。 |
| sourceKey 去重 | 支持的原始标识按相同严格值去重；外部合法追加后先重读，现有/新 sourceKey 均更新。返回 event 的调用方修改不会改变 cursor 内的 seq/Set。超出支持范围的历史使用 fullRun equality，不猜去重结果。 |
| 完整读取/导出/恢复 | `readRun` 仍完整读取 snapshot 与 journal、逐行解析连续 seq，并执行原 snapshot SHA 检查。完整 export、retry/recovery 调用 `readRun`，不拿 append cursor 或列表 summary 代替原证据。原解析规则没有因性能优化放宽。 |
| 外部变更失效 | snapshot/journal 的 BigInt stat 身份包括 inode/大小/纳秒 mtime/ctime 等，只有 atime 被排除。缓存不匹配先丢弃、完整验证，再比较读取前后身份。实际同尺寸损坏+还原 mtime、truncate、等尺寸 replace、snapshot 修改与修复回归覆盖；损坏拒绝追加。 |
| 追加后身份 | 保留 snapshot 内容身份和 journal 固定身份，核对实际大小恰增加本事件 UTF-8 字节数。不能建立下一可信 cursor 时丢缓存，下一写入重新严格读取。没有裁剪事件或猜新的 seq。 |
| 有界保留 | 最多256项、4096 sourceKeys；单项开销预算512KiB、合计8MiB，按序列化字节估算及固定开销记账。超界条目不留在 Map，临时 fullRun 回到原完整读取方式；不是保留整份大 journal。已有 eviction/4100 key 回归保持序号和去重。 |
| partial write / fsync failure | 原 `durableWrite` 写入循环、fsync、close 保留。异常立即丢 cursor 并抛原错误；部分尾部下次完整读取仍拒绝。fsync 抛错但实际整事件存在时，下次重读识别原 sourceKey，不再重复事件。该注入回归不冒充真实掉电持久化试验。 |
| 范围与性能 | 不改原预算、调用、权限、停止或恢复条件。Root 的同一封存 v12 journal 副本/40次 fsync 工程比较为旧15.526秒、新76.6ms；原完整事件内容和源 SHA 固定。该结果证明重复前缀解析的性能改善，不独自证明 live LEASE_LOST 唯一根因，也不计作正常或受控恢复验收。 |

审查最初发现一个低影响的序列化一致性缺陷：旧版 `7a1773…` 将 `Infinity/-Infinity` sourceKey 留在热 Set，但 `JSON.stringify` 实际写成 null，导致热缓存第二次跳过而完整重读不跳过。当前真实产品 sourceKey 由 `session:…` 字符串构造，该数值分支不是实际 Go 请求路径，但新旧热/冷行为应一致。

Root 已修复并经只读复核：`supportedSourceKey` 排除非有限数字，own Infinity 落盘 null 不入 Set，仍保留旧逐次追加行为；严格读取到外部合法旧字面 `1e400→Infinity` 时回退 fullRun，仍按原严格 equality 去重。新增单项同时验证 own Infinity/-Infinity 热/冷一致与 legacy exponent，不改变 canonical 字符串路径。该 finding 已解决，没有追加产品功能。

来源分开保留：

| 批次 | 源码 SHA256 | 测试源码 / 日志 |
| --- | --- | --- |
| 首次审查，44/44 | `7a1773a873830c7e0660dcab40dd1332c8d5852902d8284b0831fdcbe5856f25` | 测试 `82a609e6855a5ac3bd103fcca1290faee7e878660cc0d0e74700f0252c645967`；[旧44项日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/trace-append-cursor-2026-10-06-final.txt)，SHA `f63f9cbf5e974844dc317ead40d6cf0813e664211abb02f4a673d227e6b0fa18`。 |
| 修复后复核，45/45 | `201cbbeb241e586f1bd144ade3c663235b2f5929eba8c4f1db0c9beac40bbc01` | 测试 `d5dfea0afbcf3ef3c5697cfa6ddc7c81158719da777a9f41d72958a2d3240b74`；[45项最终日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/trace-append-cursor-2026-10-06-final-v2.txt)，SHA `41f35dc50f0bdb7500e80b2cda64221b1feafb28ae0d360f29a75de6963ddea4`。 |

最终45项日志为 tests45/pass45、fail/cancel/skip/todo均0；本审查只读核对其闭合输出与当前 source/test SHA，并执行当前源码 syntax check（exit0），没有重复扩大回归。旧44项不是修复后45项的源码依据。真实 MVP、fresh normal、受控重启恢复和最新备份均不由本报告宣布通过。
