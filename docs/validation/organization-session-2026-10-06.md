# 组织对话稳定 Session 验证（2026-10-06）

冻结时间：2026-10-06T00:57:34.1410585+00:00。工程验证结果：**17/17 通过**，失败、取消、跳过均为 0。本次接续只修改两份测试：保留重置测试的完整对象严格比较，显式验证新增 UUID；补强 session 测试的隔离入口、旧客户端精确 fallback 哈希及 Go 请求头链路。fetch mock 参数和 call helper 的 key 参数已显式加类型；后者修复根 TypeScript 检查中的 UUID 模板字面量推断错误，业务限制没有改变。最新 10 项 API 测试在当前 cost-control/shared codec 依赖版本再次全部通过。根初次检查日志 go-initial-typecheck-2026-10-06.txt 保留原状，最终全库类型检查由根任务执行。

本报告仅证明隔离工程场景。API 使用脚本创建的全新内存 PGlite + pgvector；UI 由 Vite SSR 加载真实组件并调用其真实草稿读取和重置函数，存储为独立 MemoryStorage。数据、追溯和 Vite 缓存均设在测试临时目录。模型响应为无凭据的本地 HTTP fixture。Go 验证保留精确 Go URL 以生成请求头，再在 fetch 边界送到本地 fixture，其他目标在请求前拒绝。没有访问原数据目录 `C:/Users/JJ/Desktop/la/agent_department/.data/local`、读取真实 Key、调用真实模型、修改员工交付物或部署服务。

## 执行证据

| 执行命令 | 退出码 | 通过数 | fail / cancel / skip |
| --- | --- | --- | --- |
| `C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe --import tsx --test tests/organization-reset-ui.test.ts` | 0 | 7 | 0 / 0 / 0 |
| `C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe scripts/test-integration.mjs tests/organization-session.test.ts` | 0 | 10 | 0 / 0 / 0 |

完整输出保存在同目录的 `organization-session-2026-10-06.txt`。限定文件的 `git diff --check` 通过；Git 仅提示 organization-draft.ts 将来的 LF/CRLF 转换。此次未额外运行全库测试、真实数据库测试或浏览器交互测试。

## 验证结论

- 两个新对话即使首条需求相同，也获得不同 UUID 和请求幂等键。
- 同一对话经普通讨论、后续轮次、规划模型/设置调整、草稿 reload 和 pending reload，保留原 UUID；pending 正文中的合法 UUID 优先于草稿元数据。
- 旧草稿仅增加顶层元数据。已存 pending 正文、字段顺序和幂等键经恢复仍保持 JSON 序列化字节一致；取回请求继续使用原正文，后续新轮次才附加新 UUID。
- 已存旧请求同 key 取回没有再次网关调用，没有增加预留或用量记录。相同 key 换 UUID 返回 409。非法 UUID 在任何预留及模型调用之前返回 422。
- API 用量归属与预留 context 同为 `organization:<UUID>`。UUID 不进入模型 messages。旧客户端没有 UUID 时，归属采用 `organization:` 加 `SHA256(modelId + 换行符 + 第一条用户消息)`。
- 精确 Go endpoint 使用 `AgentDepartment/0.2.0` User-Agent；`x-opencode-session` 为 `agent-department-` 加上述 sessionId 的 SHA256。原请求取回、reload 和后续轮次保持同一哈希；新需求重置后，即使首句相同也得到新哈希。普通本地 endpoint 没有 Go session header。
- 取消重置没有任何字节或写入变化。确认重置先保存完整未知请求及原 UUID，再保存空草稿和新 UUID；未知费用记录保持原状，已存团队引用保留于旧历史。
- 归档失败、活动草稿写入失败、坏历史和同 key 不同历史内容均不能悄悄清除 pending。恢复重试不会复制历史键。重置与渲染没有网络调用，方案和项目数量不因 UUID 增加。

## 冻结源码 SHA256

前五项为本子任务自有源码；后七项为传递链路和隔离运行器的只读依赖快照。哈希针对当前工作区原始文件字节，不是 Git blob。本子任务在此快照后不再修改五项源码；后续如依赖变更，应按新 SHA 重验对应链路。

| 文件 | SHA256 |
| --- | --- |
| `apps/web/src/organization-draft.ts` | `0f9db0577e667d30eb205d0aef6d92ddaf30d03be60e2429b5a9c21c337f6019` |
| `apps/web/src/OrganizationChat.tsx` | `2192514039ba55c4cd49c036b7b63e143cc9ca1944d91eef5425d64a82b49d9d` |
| `apps/api/src/organization-chat.ts` | `9a98664eb4aaf09d24e7ce804a7294f6c92757f716db2f5770ddc04be9d8fca5` |
| `tests/organization-session.test.ts` | `59535c8abff296b43295d61ba43af41184edc5a638c8a1fc3058ca7d484e2200` |
| `tests/organization-reset-ui.test.ts` | `8cb00d37993899e5a0a55080a343fb304f4989a018b0652e11fc00c067540bf1` |
| `apps/api/src/cost-control.ts` | `8267bc2e3926d37e8aa1deabee796160744aa039e4a309b694d7116804eab629` |
| `apps/api/src/provider.ts` | `122c06d2696bd434ead8191596fefeb034b31e1edcf3bb2df30744cd032b46ea` |
| `apps/api/src/idempotency.ts` | `c6125121084924b6ae9a3a5a26497e0f8a6b7c0b24b551eaad4761e7fb587478` |
| `services/agent-runtime/completion-protocol.mjs` | `d99e21fe185f80fc8e7f4e03e8400151148b5facb77fe4e486f28568b890563d` |
| `services/agent-runtime/completion-protocol.d.mts` | `a244d653800340b1c567c0793650607d6b426ee230499b800486c09411750955` |
| `scripts/test-integration.mjs` | `c00ed62fc7cf3f2c73916ed0d7313f62293efe45e77a0787a67283e5a4be3ad6` |
| `scripts/test-support/pglite-pool.mjs` | `c6dfd78719309965b83a316dd286379c1eb0750a68f026ebe5793a8cd34eba74` |

