# 组织草案反馈修复证据

源码基线 `dac13e8` 加本轮六个文件，实际 SHA256 见 `results.json`。本目录使用保存的真实响应做本地回放；没有新增真实模型调用，不能视为模型成功率证据。

两个 RED 日志仅移除了空行上的尾随空格，断言和结果保持原样。

| 文件 | 内容 |
| --- | --- |
| `windows-unit.txt` | Windows 85 项单元检查，0 失败 |
| `windows-api.txt` | Windows 三组 API 检查，18+23+3，0 失败 |
| `unit.txt` / `api.txt` | JJ 同样的 85+44 项隔离检查，0 失败 |
| `results.json` | JJ 命令退出码、源码基线、六个文件哈希、零模型调用/生产写入 |
| `build.txt` | Windows `tsc --noEmit && vite build`，含现有包体警告 |
| `api-red.txt` | 修复前原真实草案未同时报告独立错误的失败断言 |
| `dedup-red.txt` | 两个文件合同问题造成重复报告的失败断言（2 !== 1）；最终单元日志包含修复后的通过结果 |
| `review.md` | 独立审查与复审结论及范围 |

复现命令（仓库根目录）：

```sh
node --import tsx --test tests/organization-draft-diagnostics.test.ts tests/organization-task-planning.test.ts tests/organization.test.ts tests/organization-draft.test.ts tests/task-contracts.test.ts tests/orchestration-patterns.test.ts tests/planning-output.test.ts
node scripts/test-integration.mjs tests/orchestration-pattern-integration.test.ts tests/organization-chat.test.ts tests/organization-routing-confirmation.test.ts
npm run build
```

JJ 使用 Node 24.19.0，隔离目录 `/home/jj/.local/share/weiwu/validation/orchestration-feedback-20261019-dac13e8`，独立测试数据及本地响应夹具；仅复用已安装依赖。`results.json` 的零调用/零生产写入是验证脚本执行范围的记录，不是另一次生产账本查询。
