# Windows 推荐启动入口收尾（2026-10-05）

新增项目根目录的 `start-local-production.cmd`，保留 `start-local.cmd`。新入口使用 ASCII 提示与 CRLF，检查 PATH 中的 Node/npm、符合 package.json 的 Node 版本、项目依赖及独立员工运行器依赖；缺失时提供对应的 `npm ci` 或 `npm --prefix services/agent-runtime ci` 指引。先 `call npm run build`，立即保存实际错误码，只有成功才执行 `node scripts/local.mjs --production %*`；最终保留构建或启动程序的错误码。

入口不包含私有数据目录或 Codex runtime 路径，不变更设备授权、费用上限或审批。默认数据目录、指定目录及端口参数继续由已有本机启动器处理。`docs/mvp-quickstart.md` 更新推荐入口、静态构建生效方式与上下文三种策略，保留旧验收、运行、预算和重启记录；其顶部验收状态由主代理继续更新。

## 本地实际验证

使用现成 Node v24.19.0 执行[隔离 CMD 验证器](../test-evidence/helpers/verify-production-cmd-failures-2026-10-05.mjs)，[最终输出](production-cmd-checks-final-2026-10-05.txt)退出码 0，[详细证据](../test-evidence/production-cmd-failures-2026-10-05T12-42-26.274Z.json)记录 **6/6 通过**：

| 条件 | 实际结果 |
| --- | --- |
| Node 不在 PATH | 退出 1，显示 Node/npm 安装及版本要求 |
| npm 不在 PATH | 退出 1，显示 npm 安装修复指引 |
| 项目依赖缺失 | 退出 1，显示 `npm ci` 与独立 runtime 安装命令 |
| 独立 runtime 缺失 | 退出 1，显示精确的 runtime 安装命令 |
| 隔离 npm 构建桩返回 7 | 保留退出 7，不进入启动命令 |
| 隔离构建桩成功、启动桩返回 17 | 完整传递 `--production`、端口及带空格目录参数，保留退出 17 |

测试在 `.data/production-cmd-check/isolated-UMZgOR` 的六个带空格子目录执行复制的 CMD，使用空依赖标记、隔离 npm 桩和不导入任何产品代码的 Node 启动桩。**0 实际构建、0 服务启动、0 数据库/原数据访问、0 模型调用**。没有试跑本轮入口的实际服务分支；真实完整静态 CLI、API、幂等与同目录重启已在[前一阶段](local-production-static-stage-2026-10-05.md)独立通过。桩用于验证批处理控制流，不算真实员工验收。

五项失败路径先已通过，[首次通过输出](production-cmd-failures-final-2026-10-05.txt)与[五项证据](../test-evidence/production-cmd-failures-2026-10-05T12-40-33.071Z.json)保留。更早一次验证器传入含反斜杠引号的 CMD 路径，命令未执行便失败；临时目录 `.data/production-cmd-check/isolated-PClVGe` 保留。修正为在含空格的独立目录执行复制入口后通过，未因此修改产品 CMD。

新增入口 SHA256：`cb93d44b1d98f473b55693affde606e50f60f060227f9add4d366e2b4b0949d8`。原 `scripts/local.mjs` 与静态宿主等此前冻结源码未修改，本轮没有广泛重跑已通过的构建或类型检查。此交付只补 Windows 启动体验及可读说明，不宣称此前原生退出根因已解决。
