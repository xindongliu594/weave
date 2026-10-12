# 原检索、Jieba 与 Meilisearch 的实际比较

日期：2026-10-12。用户授权“先比较试试”。已完成隔离下载、同语料测量、小样本相关性检查和清理；未改生产知识库、员工权限、依赖清单或检索模式，未调用付费模型。

## 结论

在本机万片段的合成语料上，Meilisearch 对广泛命中查询明显更快：原实现中位654ms，Meili默认词匹配加固定版本检查约33ms，严格匹配约44ms，分别约19.6倍/14.9倍。小库精确查询及无命中查询，原实现可以更快，不能把这个倍数推广为所有查询的生产收益。

Jieba减少了部分中文误命中，速度变化较小。Meili严格匹配在本次小样例中进一步减少无关结果，但“退回订单金额”没有找回“订单退款”资料。不能宣称换引擎后中文语义检索已经解决。

建议：完整词法检索引擎可优先进入Meilisearch隔离集成计划；小库若只改中文分词，Jieba是较小范围的候选。为伍原资料/版本/hash仍作为事实来源，外部索引是可重建副本。当前只验证了搜索引擎试验，不代表生产接入、员工复用闭环或真实权限/恢复已经验收。

## 实验条件和来源

- Windows、Node24.19.0、Ryzen9 8940HX、约32GB内存；单并发、固定顺序的单批测量。各搜索路径先预热3次。规模每项20次，质量每项10次；质量P95即最大值。
- 基线实际调用原 `queryKnowledge`，注入新内存PGlite，使用原SQL、评分、文档/GIN索引和固定版本完整性检查。它是PGlite WASM隔离测量；代码经pg.Pool调用的真实PostgreSQL环境、JJ大库或多员工吞吐不能由此推断。
- Jieba 2.0.4与对应Windows预编译包只解包到忽略的隔离目录，npm SHA512完整性核对。原知识查询源码的隔离副本仅替换tokenize导入，数据库切片tokens也用Jieba生成；没有修改生产源码。runInputs和旧快照fallback仍使用原searchKnowledge，本轮不覆盖这些路径。
- [Meilisearch1.54.3官方发布](https://github.com/meilisearch/meilisearch/releases/tag/v1.54.3)的Windows社区版，官方SHA256匹配 `09266bd2c51747cebe908f7373cc6e2e546e3930886bb8c1427f402a0dc4c2dc`。仅127.0.0.1临时端口，临时密钥，关闭遥测，索引内存256MiB/线程2；不占用现有服务端口。
- Meili searchableAttributes=content、filterableAttributes=versionKey；禁用typo tolerance以控制试验范围。`last`为默认词匹配策略，`all`要求全部词。参见[搜索接口](https://www.meilisearch.com/docs/reference/api/search/search-with-post)。不是修改整个引擎的生产默认配置。
- 同一批约1700字符片段，1000/10000片段，50/500授权文档；另外加入私有文档、未批准新版、已删除来源哨兵。数据库版本为1，Meili过滤同一个批准文档版本ID集合。
- Meili verified计时先重跑原库同一版本完整性SQL，再发本机HTTP请求并核对已知片段内容、批准文档和v1。engine-only另记，不能与带校验基线混为一谈。
- 原计时Meili适配器提前序列化过滤条件并复用版本SQL参数，返回id/doc/version/content四字段；原SQL返回更多引用元数据。因此它是prepared adapter试验，尚非完整插件接入时延。未测索引同步竞争、空/标点查询、Meili无授权员工入口、read/skill或旧快照恢复。

## 同批中位延迟（毫秒）

| 规模 | 查询 | 原实现 | Jieba＋原SQL | Meili last＋版本检查 | Meili all＋版本检查 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1,000 | 精确needleomega | 9.23 | 8.44 | 15.62 | 15.30 |
| 1,000 | 库存调整 | 25.78 | 23.86 | 15.45 | 15.48 |
| 1,000 | 验收流程（广泛命中） | 68.14 | 59.94 | 15.67 | 15.08 |
| 1,000 | 无命中 | 5.50 | 5.04 | 15.51 | 15.73 |
| 10,000 | 精确needleomega | 45.42 | 39.92 | 32.73 | 39.83 |
| 10,000 | 库存调整 | 204.10 | 171.75 | 31.31 | 34.00 |
| 10,000 | 验收流程（广泛命中） | 653.96 | 617.47 | 33.44 | 43.83 |
| 10,000 | 无命中 | 28.28 | 23.55 | 32.24 | 32.59 |

万片段广泛查询P95：原723.19ms、Jieba657.33ms、Meili last45.09ms、all48.31ms。万片段Meili engine-only中位为16.38～30.52ms，已经包含本机HTTP及响应处理，不是服务器processingTimeMs。Jieba约几个百分点的变化不能视为稳健收益；Meili宽泛查询的大差距明显大于本批样本波动。

## 质量小样本

8份明确主题资料、6个预先指定查询及预期文档；每文档只有一个片段。这是诊断夹具，不是完整Recall/nDCG行业基准或实际员工QA验收。

| 查询 | 原结果 | Jieba | Meili last | Meili all |
| --- | --- | --- | --- | --- |
| 退款 | 退款、款式、设备退役 | 退款 | 退款 | 退款 |
| 库存调整 | 库存及3份不相关资料 | 库存＋权限调整 | 库存 | 库存 |
| 部署回滚 | 回滚＋部署配置 | 回滚＋配置 | 回滚＋配置 | 回滚 |
| zzznomatch | 无 | 无 | 无 | 无 |
| 含不存在词的长中文查询 | 3份不相关资料 | 1份 | 1份 | 无 |
| 退回订单金额（预期退款） | 退款及2份不相关资料 | 退款 | 无 | 无 |

所有路径均未返回私有、未批准v2或已删除来源哨兵；两条数据库路径也拒绝无授权员工。这里验证的是测试构造的固定manifest和索引过滤，不是损坏索引或客户端任意改filter下的生产安全保证。

## 容量和额外成本

| 规模 | 原库表＋索引 | Jieba库表＋索引 | Meili整库usedDatabaseSize | Meili异步导入 |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 1.49MiB | 0.91MiB | 8.62MiB | 2.45秒 |
| 10,000 | 12.43MiB | 7.92MiB | 83.93MiB | 18.00秒 |

资料高度重复，数据库压缩明显。Meili指标含任务/其他内部元数据，不是单纯倒排索引大小；与pg_total_relation_size不属于完全同一统计口径，也不代表常规公司资料的压缩比。二进制352,659,456字节（约336MiB），是隔离试验额外下载，不是每个项目的一份。另需考虑常驻服务、索引更新和备份；吞吐、峰值内存未测。

## 审查、补查与回收

独立只读审查确认异步建库/设置/导入/删除均等待succeeded，各规模记录isIndexing=false。指出原计时未将命中doc/version与lookup源精确绑定，以及响应契约/参数准备不完全相同。

补充验证：绑定id对应源的documentId、version、content和批准versionKey，1个正常与5个错误/越权/新版自检通过，再用真实隔离Meili重查小语料。结果另存binding-check-results.json，没有覆盖原规模耗时，也没有把补查冒称完整生产安全验收。原计时源码和补查源码分别保留。初次夹具ID冲突的停止记录保留；它不是产品故障或TDD RED证据。

两次辅助进程均已退出。只回收本轮 `.data/retrieval-compare-20261012` 中的下载、依赖、临时索引与私有日志；不会删除历史运行、凭据或原始知识。回收证明另见cleanup.json。

证据：`../validation/evidence/retrieval-comparison-2026-10-12/`，含comparison-results.json、binding-check-results.json、provenance.json、verification-summary.json与源码。先运行setup-source.py准备同版本隔离组件，再在仓库根用 `node --import tsx .../comparison-source.ts` 重现规模试验；binding-check-source.ts加`--binding-check`重查绑定。重新测量应先保留已有证据或使用新的结果目录。当前生产仍使用原检索模式。
