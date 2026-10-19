# 交付映射修复证据

- `unit-red.txt`：修复前3项失败，分别暴露自验错误堆叠、组合重复和缺少配套映射示例。两个已有正确/拒绝行为测试通过。
- `api-red.txt`：原真实响应回放在旧反馈下失败的断言，原文与费用不修改。
- `windows-unit.txt` / `unit.txt`：Windows / JJ 各93项单元通过。
- `windows-api.txt` / `api.txt`：Windows / JJ 各19+23+3项API通过。
- `build.txt`：Windows `tsc --noEmit && vite build` 输出，保留已有包体警告。
- `results.json`：JJ退出码与六个覆盖文件哈希。`modelCalls=0` 和 `productionWrites=0` 表示本验证脚本范围，没有额外查询生产账本。
- `verify-jj.py`：实际使用的隔离准备/测试脚本，固定新目录，不重建或改写原生产目录。
- `review.md`：独立审查范围及结果。

日志只清除行尾空白以符合 Git 格式检查，不改变断言和结果。新正例为明确标记的本地夹具，只能证明程序合同接受正确映射；没有真实模型成功或员工交付证明。

复现命令：

```sh
node --import tsx --test tests/delivery-binding-feedback.test.ts tests/organization-task-planning.test.ts tests/orchestration-contracts.test.ts tests/orchestration-patterns.test.ts tests/organization-draft-diagnostics.test.ts tests/organization-routing.test.ts tests/task-contracts.test.ts tests/organization-draft.test.ts tests/planning-acceptance.test.ts
node scripts/test-integration.mjs tests/orchestration-pattern-integration.test.ts tests/organization-chat.test.ts tests/organization-routing-confirmation.test.ts
npm run build
```

固定源码基线 `0f55e13` 加 `results.json` 记录的六个本轮文件。原真实响应仍从上一轮已提交的 `orchestration-feedback-pilot-2026-10-19/real/broker-result.json` 读取，本目录不复制或改写该响应。
