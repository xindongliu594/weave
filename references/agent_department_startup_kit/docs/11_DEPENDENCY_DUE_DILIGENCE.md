# 11 依赖与版本尽调

## 上游项目

- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- DSH Subagent：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md>
- DSH Workflow：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/README.md>
- dsh-agent-teams：<https://github.com/NanmiCoder/dsh-agent-teams>
- 社区本地 RAG 示例：<https://github.com/AlowEnsoul/dsh-rag-kb>

## 当前判断

- DSH 采用 MIT 许可证，但处于快速迭代阶段，并明确提示可能发生兼容性破坏。
- dsh-agent-teams 采用 MIT 许可证，支持成员级 Provider/Model 配置；它与 DSH 预发布版本存在兼容组合要求。
- 社区 RAG 插件适合作为 Spike 参考，不作为产品知识和权限的唯一存储。

## 开工前必须记录

在 `compatibility-lock.md` 中记录：

```text
验证日期：
操作系统：
CPU 架构：
Node.js：
pnpm：
DSH：
dsh-agent-teams：
PostgreSQL/pgvector：
Redis：
Embedding Provider/Model：
成功测试的 LLM Provider/Model：
上游 commit/tag：
已知问题：
```

不要在技术验证前把浮动 `latest` 写进正式 Runtime 镜像。升级流程应是：建立临时环境、运行契约测试和标准 E2E、记录结果、再更新锁定版本。

## 许可证动作

- 发布产品前保留依赖许可证和版权声明。
- 建立第三方依赖清单并扫描传递依赖许可证。
- 不把上游项目名称、Logo 或商标误写成自己的品牌授权。
- 对修改过的第三方源码保留变更记录。

