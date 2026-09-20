# 06 RAG 与知识权限设计

## 知识层级

| 层级 | 示例 | 默认访问范围 |
|---|---|---|
| 公司 | 制度、品牌、产品资料 | 公司内授权 Agent |
| 部门 | 研发规范、市场资料 | 本部门授权 Agent |
| 员工 | 私有专业资料 | 指定员工 |
| Run | 本次任务输入和中间产物 | 本次团队 |

检索前先根据用户、部门、Agent 和 Run 计算允许访问的知识库 ID，向量查询必须带权限过滤，不能检索后再删结果。

## 导入流程

1. 上传原始文件并计算内容哈希。
2. 病毒扫描、类型和大小校验。
3. 提取文本、页码、标题和结构信息。
4. 按文档类型切片，保存稳定 chunk ID。
5. 生成 Embedding 并写入 pgvector。
6. 标记索引版本和状态。
7. 保留从 Chunk 到原文件位置的引用链。

## 检索流程

1. 接收 query、Agent 身份和 Run 上下文。
2. 鉴权并得到可访问知识空间。
3. 关键词与向量混合召回。
4. 可选 rerank。
5. 根据 Token 预算组装上下文。
6. 返回文本、文档 ID、页码/行号、分数和索引版本。

## Agent 工具

```text
knowledge_search(query, scopes, top_k)
knowledge_read(document_id, locator)
knowledge_sources(run_id)
```

上传、删除和授权不作为普通员工工具；它们属于用户控制面。

组织规划器只接收知识库目录的 ID、名称、用途和授权范围，不直接读取全部知识内容。它可以建议给员工绑定哪些知识库，但最终绑定集合必须是 ExecutionPolicy 允许集合的子集。

## MVP 选择

- 存储：PostgreSQL + pgvector。
- 文件：本地卷 `./data/artifacts`。
- Embedding：通过统一 Adapter 配置，可选云模型或 Ollama。
- 检索：向量 Top-K + PostgreSQL 全文检索，先做简单加权融合。
- 引用：至少返回文件名、文档版本和 chunk 定位。

社区 DSH RAG 插件适合用于技术验证，但产品知识库应独立于 DSH 生命周期，避免知识、权限和索引被 Runtime 版本绑定。
