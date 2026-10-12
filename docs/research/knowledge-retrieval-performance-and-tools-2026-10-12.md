# 知识检索：实际速度与现成工具

日期：2026-10-12。只做代码检查、只读生产查询、隔离合成语料测量和官方资料调研。没有安装依赖、切换生产检索、修改员工权限或调用模型。工程结果不能替代知识复用的真实发布闭环验收。

## 结论

现有小库检索延迟低；万片段下宽泛查询耗时明显增长。本次合成语料查询计划仍走顺序扫描，不能凭已经建了 GIN 索引就宣称每次查询都使用它。相关性也需评估：中文单字匹配会给仅部分字符相同的资料分数。

优先复用成熟分词库替代自定义中文切词；若需要完整中文关键词搜索引擎，先隔离比较 Meilisearch。Qdrant 是语义/混合向量索引的候选，WeKnora 有现成 DSH 插件但属于另部署整套知识平台。后两者都不是安装后自动满足为伍权限和版本规则的组件。此处为选型建议，尚未安装或比较第三方效果。

## JJ 实际 HTTP 结果

北京时间2026-10-12 09:58。原两份测试方法 v1；QA 原授权不变。先核对当前模式 keyword，再在 JJ loopback 4310 测 `/api/knowledge/search`，每条预热2次、测量10次，并发1。包括 HTTP 与当前权限/版本快照查询，不包括 SSH往返和模型推理。

| 查询 | 返回片段 | 中位毫秒 | P95毫秒 |
| --- | ---: | ---: | ---: |
| 整数 | 2 | 5.77 | 7.71 |
| 退款 | 1 | 6.45 | 14.01 |
| 库存 | 0 | 5.25 | 5.94 |
| 检索不存在的测试词zetaomega | 2 | 6.22 | 7.07 |

最后一条仍返回两份资料，是弱相关命中的线索，不是完整相关性评测。命中不代表知识适用。10个样本的P95相当于最大值；两份资料不能证明大规模吞吐。

Windows本机4312隧道连接被拒后，改用一次SSH远程loopback测量；没有更改服务或隧道。497条用量、已登记$2.3136414、未知预留$0.0711849前后不变。证据：`../validation/evidence/retrieval-research-2026-10-12/jj-live-results.json`。

## Windows 隔离规模测量

实际调用 `queryKnowledge`，注入全新内存PGlite，并建立与产品相同的知识版本/片段表、文档索引及GIN索引。包含每次固定版本完整性检查和排名，未走HTTP或数据库socket。原生产数据库未打开。Windows、Node24.19.0、Ryzen9 8940HX、约32GB内存，单并发，重复热查询20次。

每文档20个片段，内容约1,700字符。不同主题、1%含精确英文词、全体含通用验收词，属于合成语料。100/1,000/10,000片段对应5/50/500文档及约0.50/4.96/49.61MB UTF-8文本。

| 授权片段 | 精确词中位/P95毫秒 | 中文主题中位/P95毫秒 | 宽泛词中位/P95毫秒 |
| --- | ---: | ---: | ---: |
| 100 | 4.85 / 5.61 | 7.26 / 8.27 | 11.50 / 13.18 |
| 1,000 | 7.28 / 8.13 | 25.27 / 34.07 | 71.91 / 79.42 |
| 10,000 | 47.87 / 51.97 | 219.83 / 239.26 | 626.57 / 656.63 |

50项目录逐条评分中位约1.7～2.3毫秒；目录规模与完整知识库规模不能混用。私有文档、非获批新版及无授权员工查询均未命中，获授权旧版结果保持v1；每档均有断言核对。

万片段的四份 EXPLAIN ANALYZE 都包含 knowledge_chunks 的 Seq Scan，未使用关键词GIN；排序与逐候选评分也增加开销。这个计划结论限定于本次PGlite合成语料，尚未对JJ大库执行计划或完整PostgreSQL并发作结论。没有测向量模型冷启动、百万片段或多员工吞吐，也没有完整人工标注的 Recall@6 / nDCG评测。

证据目录含 local-results.json、12份计划及可复现源码。重跑时使用新的结果目录：`node --import tsx docs/validation/evidence/retrieval-research-2026-10-12/benchmark-source.ts .data/retrieval-benchmark-new`。临时数据库只在内存，结束后关闭，未保留合成语料正文副本。

## 可复用工具及边界

| 选项 | 已核对官方能力 | 为伍接入判断 |
| --- | --- | --- |
| [pgvector](https://github.com/pgvector/pgvector#filtering) + [@node-rs/jieba](https://github.com/napi-rs/node-rs/tree/main/packages/jieba) | 现有向量存储/距离和索引，成熟中文分词库。[Jieba平台包清单](https://raw.githubusercontent.com/napi-rs/node-rs/main/packages/jieba/package.json)列有Windows/Linux目标。 | 最小范围，无新增索引服务。分词变化须固定版本并重建派生tokens，旧任务不能静默改检索模式。ANN的后过滤及召回行为必须隔离验证，不能直接把加HNSW当作权限过滤已完成。 |
| [Meilisearch](https://www.meilisearch.com/docs/resources/help/language) | 自带Jieba中文词典分词、关键词排名；可用[自供向量](https://www.meilisearch.com/docs/capabilities/hybrid_search/how_to/search_with_user_provided_embeddings)，[安全与查询过滤](https://www.meilisearch.com/docs/capabilities/security/overview)。 | 适合评估完整词法引擎。新增服务及索引同步；原文/版本留在为伍。官方[安装支持](https://www.meilisearch.com/docs/resources/self_hosting/getting_started/install_locally)对Windows桌面不作与Server相同保证，JJ上Docker是候选路线，尚未安装测试。 |
| [Qdrant](https://qdrant.tech/documentation/search/hybrid-queries/) | dense/sparse混合、RRF、payload过滤、官方TS客户端及[多租户模式](https://qdrant.tech/documentation/manage-data/multitenancy/)。 | 更偏语义与规模索引。新增服务和派生数据同步；中文效果依赖embedding。每路搜索绑定权限、不可变版本ID；[本地Docker部署](https://qdrant.tech/documentation/quickstart/)不替代业务权限验证。 |
| [WeKnora + dsh-weknora](https://github.com/Tencent/WeKnora/blob/main/packages/dsh-weknora/README.md) | Tencent项目附带DSH插件，提供知识库列表、混合搜索、整份文档读取和可选ask。有契约测试及模拟后端E2E，说明验证DSH0.1.0-rc.8/WeKnora0.8.0，仍需核对我们锁定版本。 | 能减少解析/检索系统自研，但部署和数据对接最大。标准[Compose](https://raw.githubusercontent.com/Tencent/WeKnora/main/docker-compose.yml)含应用、前端、docreader、ParadeDB/Postgres及Redis；Lite不是成员共享权限的等价替代。 |

### WeKnora 不能忽略的接入边界

- [请求类型](https://raw.githubusercontent.com/Tencent/WeKnora/main/internal/handler/session/types.go)有知识库/文档/tag ID过滤，未见version/hash/as_of；[客户端](https://raw.githubusercontent.com/Tencent/WeKnora/main/packages/dsh-weknora/src/client.ts)读取当前文档块。同一个文档ID不证明正文不可变，需隔离试验每个不可变版本独立ID及原文哈希核验。
- [后端](https://raw.githubusercontent.com/Tencent/WeKnora/main/internal/handler/session/qa.go)先做API key范围授权；但[插件](https://raw.githubusercontent.com/Tencent/WeKnora/main/packages/dsh-weknora/src/tools.ts)的 knowledgeBaseIds 是默认范围，工具参数可覆盖，空配置会使用凭证可见全部库。不能把这个配置当员工白名单；需要受限凭证和宿主强制注入批准范围。
- 首轮只测search/read并关闭ask。ask创建会话且调用另一个模型，不能绕开为伍预算；目录/搜索/读取没有入库、编辑、删除操作。部分片段会截断并标识，完整引用核验须按原始来源及完整读取证据处理。

[LlamaIndex.TS](https://github.com/run-llama/LlamaIndexTS)官方仓库明确已弃用/停止维护，不作为新依赖首选。[Haystack](https://docs.haystack.deepset.ai/docs/qdranthybridretriever)有现成混合检索组件，但它是Python框架，Node项目需额外服务，因此本轮不作为最小接入路线。

选型下一步是隔离比较，而非现在切换生产：用同一批中文公司资料与人工预期结果，对比精确/同义词/无关/越权/旧版/已删除资料，记录相关性、P50/P95、索引大小和恢复一致性。选择完成后再列集成计划；当前知识发布闭环的未验收状态保持。
