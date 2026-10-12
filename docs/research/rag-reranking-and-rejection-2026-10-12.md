# 为伍 RAG：重排与无答案判断选型

日期：2026-10-12。用户同意在混合检索实测之后继续调研。此次只检查现有代码、DSH 社区候选及维护者文档，没有安装组件、调用模型、改变生产配置或扩大资料授权。

## 在产品中负责什么

RAG 是检索增强生成：检索已有资料，将适用片段作为员工回答和执行的上下文，并保留来源。它与公司的经验发布、Skill 加载和工具执行相接，但不自动负责这些工作，也不保证生成答案正确。

为伍已有固定版本知识快照、员工授权过滤、knowledge_search / knowledge_read、关键词检索和可选本地 E5＋pgvector＋RRF。JJ 生产当前仍是关键词；本地语义模型已在隔离试验中实际运行，未启用生产。相关代码在 apps/api/src/knowledge-store.ts、knowledge-vector.ts 和 services/embedding/local.mjs。本轮代码检查没有发现独立的交叉编码器重排或经过校准的无答案门槛。

拟补的链路：**授权与版本过滤 → 召回候选 → 重排与相关性筛选 → 按预算读取证据 → 员工使用并引用 → 独立验收**。判断资料是否完整支持结论，还需后面的证据核验；重排分数不能替代这一环。

## 候选核对

| 现成组件 | 维护者确认的能力 | 选择意见及未验证项 |
| --- | --- | --- |
| [Meilisearch rankingScoreThreshold](https://www.meilisearch.com/docs/reference/api/search/search-with-post#ranking-score-threshold) | 可排除低于指定 0～1 排名分数的文档 | 最少新增依赖的对照组，复用 JJ 已下载固定版本。排名分数不是回答正确概率，不直接写死 0.5；门槛需独立校准。是否能同时保住改写召回与无答案拒绝，尚未实测。 |
| [FlashRank](https://github.com/PrithivirajDamodaran/FlashRank) | CPU 重排库，支持 ONNX 交叉编码器；维护者列有约 150 MB 的 ms-marco-MultiBERT-L-12 多语言模型 | 优先作为轻量重排试验候选，不选默认英文 TinyBERT 来冒充中文能力。实际中文质量、JJ 延迟、Python/ONNX wheel 兼容仍未验证。 |
| [BAAI BGE reranker](https://huggingface.co/BAAI/bge-reranker-v2-m3) | 问题和片段成对评分，v2-m3 支持多语言；官方提供 FlagEmbedding/Transformers 推理 | 作为中文质量对照候选。不能套用 E5 embedding 的加载方式或声称已兼容 Node；需另核对部署依赖、CPU内存与耗时。官方 sigmoid 的 0～1 分数也不等于已校准的答案正确概率。 |
| [DSH dsh-kb-manager](https://github.com/xiaoshi7915/dsh-kb-manager) | 维护者描述 SQLite/FTS5/向量/RRF、重排状态、软删除和快照；空 rerank_model 会走规则回退 | 属于整套知识生命周期插件。README 的 eval 使用 mock embedding，不能当真实中文效果证据；未完成源码/Host 兼容与公司授权/不可变版本核验。暂不搬入第二份公司知识库。 |
| [Zilliz dsh-milvus](https://github.com/zilliztech/dsh-milvus) | Milvus 只读检索插件；“rerank”是 RRF/加权融合，维护者明确当前不支持模型交叉编码器重排 | 已有的 RRF 问题不会因为换这个插件自动解决，且要新增 Milvus。保留为向量库扩展候选，不作为本轮相关性筛选首选。 |
| [Tencent dsh-weknora](https://github.com/Tencent/WeKnora/blob/main/packages/dsh-weknora/README.md) | 现成知识列表/搜索/读取及 ask 接口 | 延续已有调研结论：需对接外部知识平台、为伍授权和版本规则。此次没有证据证明插件直接具备经过校准的无答案拒绝；不为一个筛选环节替换现有存储。 |

FlashRank 额外边界：当前 [配置源码](https://github.com/PrithivirajDamodaran/FlashRank/blob/main/flashrank/Config.py)默认下载 resolve/main 的模型压缩包；不能直接把浮动下载当固定版本。[Ranker.py](https://github.com/PrithivirajDamodaran/FlashRank/blob/main/flashrank/Ranker.py)会对问题与片段截断，长文档尾部证据须单独测。实际试验需先固定代码/模型来源和摘要、分别核对代码与模型许可、预置独立缓存；运行时不自动下载或切换模型。

## 选择与下一阶段计划

建议保留现有知识库和权限/版本实现，**先比较现有语义分数门槛、Meili 现成门槛和 FlashRank 本地重排**；轻量方案未达到质量要求时，再用 BGE 作质量对照。这里是待实测的顺序选择，没有宣称哪个候选已解决问题。

1. **准备独立评测。** 继续只用原获授权两份固定方法及合成资料。将校准集与新的留出测试集分开；原 19 个案例只作回归，不当新盲测。加入表述相近却明确不适用、答案在长片段末尾、部分支持而不足以支持完整结论的查询。查询应按意图分组划分，避免只是换几个词就泄漏到测试集。
2. **在 JJ 隔离比较。** 一份模型缓存、限量候选、串行 CPU 推理；先确认依赖兼容及固定摘要。对照原检索、原混合、门槛筛选和现成重排，记录首条/召回/相关比例、无答案误命中、冷启动、端到端 P50/P95、峰值内存和长文截断。没有新增付费 API 调用计划。
3. **固定规则后再验证。** 只在校准集确定门槛，再冻结模型、门槛和筛选策略到留出集；报告召回与误拒绝的权衡。没有答案时返回明确的“没有可靠匹配”，允许员工补充检索或按新任务流程推进，不默认塞满 TopK。相关性通过仍不宣称证据完整或答案必然正确。
4. **通过后才接入。** 保留 knowledge_search 的数组接口和固定知识读取能力，增加有界的筛选与可观察原因；日志记录模型/策略版本、候选数量、拒绝原因和耗时，避免再复制整份正文。审批快照与恢复必须固定同一策略，旧运行不能静默换门槛。QA 实际核对引用与生成结论，才可称完成 RAG 使用验收。

现成库负责检索/重排计算；为伍保留公司权限、不可变版本、费用/上下文预算、恢复与审计的薄适配。这些是当前产品契约，不能由插件目录可见性代替。

当前状态：**调研完成；上述候选重排、门槛及生成答案质量尚未实测，未写产品代码、未启用生产。** 安装与比较是下一阶段，不把维护者性能宣传当 JJ 测量结果。

后续更新：本地校准/留出试验已实跑并归档，现有候选未达到质量要求，试验缓存已清理。用户进一步澄清：大型语言模型走API，整个软件及可承受的轻量检索/嵌入/重排仍可在JJ运行；不把这次清理解释为禁止所有本地模型。后续按 [API与本地分工方案](rag-cloud-api-plan-2026-10-12.md) 推进，暂不自动重跑原安装顺序。详细结果见 [阶段报告](../validation/rag-relevance-report-2026-10-12.md)。
