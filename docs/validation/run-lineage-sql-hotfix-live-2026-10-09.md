# 恢复来源 SQL 热修复：实际发布验证

2026-10-09，JJ4 热修复已通过实际 API 验证：运行 `19acad23-c885-40cc-9fa7-df7d7ec127bf` 的恢复证据返回 `verified`，显示原始 QA **10/10 通过**。这次只修复查询与真实数据库列类型不一致的问题；未重新执行员工任务或测试。

首次上线查询返回 `partial`，原因是生产 `local_operations.id` 为 `text`，查询却用 `ANY(uuid[])`，原测试 fixture 也误设为 `uuid`。修复为 `ANY(text[])` 并使 fixture 与生产一致；原证据绑定规则未放宽。最初发布失败记录保留在 [JJ4 发布报告](jj4-release-2026-10-09.md)。

回执 `jj4-sql-hotfix-20261009T090744Z-4474e94c` 记录主服务 active，PID **3341617**，发布目录 `/home/jj/.local/share/weiwu/releases/weiwu-jj4-20261009`。两份改动前文件的私有备份目录为 `/home/jj/.local/share/weiwu/metadata/jj4-sql-hotfix-20261009T090744Z-4474e94c`。原 API 数据与凭据一致，**未覆盖原数据库、未重启 OpenRig、模型调用为 0**；凭据内容及哈希不公开。

| 文件 | 原 SHA256 | 新 SHA256 |
| --- | --- | --- |
| `apps/api/src/run-lineage-evidence.ts` | `bd901862895f17eb0d22d636b2f23f1c29db82f709c64217b9d98b5edf5e9858` | `6c71ac31ada1d3adf1781661419abc60a5bb3ebc53130a7974d535cc24f9b443` |
| `tests/run-lineage-evidence-api.test.ts` | `fc7ada8f0a999018d0b86465b2e3c97969eb8c25005c01d909781f356ebbf324` | `4b8125003139601a25617f16c6ccd47a2c828681f472817e71c54167e8709e79` |

实际接口确认 plan 12 的两项保留交接：T1 来自 `15c79ce8-58cc-48df-93e6-11b8f54d21f3` 的正式接收 #497，T2 来自 `7da3c44b-d8fa-4b0e-9c15-e9130ed0772a` 的 #2248。QA 引用原操作 `ac15d4f2-d455-45ae-85de-44b8c19cde0d`，命令 `node --test cli.test.mjs`，退出 0，10 项通过、0 失败、0 跳过；输出 SHA256 `f9ba46fb6bd156e379dd4a75b2725d7f34bfd48ce7c0495c18e705c2cff53eeb`，工作区版本 `4acc637e320b4b040956383ab220354710e86f106d9055d172cbf8d51d4be16b`。

Root 另报告仅一次只读浏览器检查，看到了经理验收标题、恢复的两项交接和 QA 10/10：[完成页面截图](screenshots/openshell-v12-final-recovered-qa-2026-10-09.png)。本报告作者仅整理已有回执与该检查记录，没有独立操作浏览器、再次查询线上或运行模型。

完整可公开字段与源回执哈希见 [机器可读热修复证据](run-lineage-sql-hotfix-live-2026-10-09.json)，变更清单见 [源码 SHA](run-lineage-sql-hotfix-sourceSHA-2026-10-09.json)。这份记录证明此次实际 API 修复，不扩展为持续可用性或 7×24 小时自动运行验收。
