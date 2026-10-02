# 真实 Todo API 项目验证记录（2026-10-02）

结论：**真实模型已完成编码并通过开发烟测与独立 HTTP API 验收测试，但项目尚未通过完整交付**。最新运行在测试后写入报告，使工作区版本变化，交接检查拒绝旧测试证据；Windows 命令行启动也仍有缺陷。不能把两个测试通过写成整个项目验收成功。

## 运行记录

项目：`92f22bdb-daa2-4d00-a5c7-cf3bbae1dc05`。批准上限为 $0.50、60 次模型调用、每任务 30 次调用、900 秒。使用原批准模型，未提高预算或改换模型。

| 运行 | 结果 | 已结算调用 | 按配置单价结算费用 |
| --- | --- | ---: | ---: |
| `44a21f8e-cbbd-4ae6-b154-bfa8d3b16bd1` | `failed`：`Run deadline exceeded` | 19 | $0.0160124 |
| `2676320d-1d89-49e2-9834-ab5f3bee02cd` | `failed`：`REPEATED_ERROR: 同类工具错误连续出现 3 次` | 3 | $0.0026592 |
| `16b58bf2-6fa7-4dd7-9806-17f5bfc7fafe` | `failed`：审查交接 `UNVERIFIED_COMMAND` 后报告 `needs_revision`，未授权自动返工，转为 `REPLAN_REQUIRED` | 22 | $0.0203095 |
| 合计 | 未通过完整交付 | 44 | $0.0389811 |

这些金额来自运行档案的 `billing/usage`，是项目按配置单价计算的费用，不是中转商实际账单。三个运行均没有 `billing/unconfirmed`，恢复检查的 `unknownOperations` 均为空。

首轮质量任务不允许跳过原任务身份恢复，故执行 `resume:false` 完整重试。该次完整重试沿用了原产物，开发模型尝试写入 `todo.mjs`、`smoke.test.mjs` 和 `README.md` 时均没有 `expectedSha256`，分别触发 `FILE_VERSION_CONFLICT`；第三个错误触发保护停止。这是三个不同文件的写入错误，不能据此声称模型曾在读到错误反馈后重新尝试了三轮。

修复完整重试的旧产物复制问题后，在相同累计预算和调用上限内仅追加最后一次验证。运行 `16b58bf2-...` 的工作区在创建时已实测存在且文件列表为空。它新生成了全部产物，未再出现旧文件覆盖冲突。

## 最新运行的真实测试与交接

工作区：`.data/local/workspaces/16b58bf2-6fa7-4dd7-9806-17f5bfc7fafe`。

两次终端审批前均完整阅读实际生成代码，确认只使用 Node 内置模块，测试服务绑定 `127.0.0.1` 随机端口，不包含外网访问或文件破坏操作，随后逐次批准：

| 命令 | 审批 ID | 实际证据 |
| --- | --- | --- |
| `node --test smoke.test.mjs` | `92af9c34-fe00-4224-aca1-fdfa5d19d62f` | `handoff/command-observed` seq 785，退出码 0；build 在 seq 866 被接受 |
| `node --test acceptance.test.mjs` | `db887c8c-f129-41b0-86ad-702c4288375a` | `handoff/command-observed` seq 1641，退出码 0；1 passed、0 failed |

QA 在验收测试通过后写入 `review.json`（seq 1705），随后尝试 `completed/pass`，seq 1762 被拒绝为 `UNVERIFIED_COMMAND: node --test acceptance.test.mjs`。原因是测试之后工作区改变，原命令证据不再对应当前版本。模型随后尝试未授权的 `terminal` 而被拒绝，最终报告 `needs_revision`；该方案未授权自动返工，所以宿主停止并要求重新制定方案。报告中的 `result: pass` 不等于宿主交付已完成。

最新版 `todo.mjs` SHA256：`df60815f7f86e58a96e3a10a4a69c85d9ef10ee98fa6f548a171240dbe8c1c1b`。所有生成代码保持原样，没有手工修复、调整测试或代替模型完成交接。

## 前一失败运行的独立产物核对

核对目录：`.data/local/workspaces/2676320d-1d89-49e2-9834-ab5f3bee02cd`。检查生成代码只使用 Node 内置模块，测试服务绑定 `127.0.0.1` 随机端口后，独立执行：

```text
node --test smoke.test.mjs acceptance.test.mjs
```

- `smoke.test.mjs`：通过。
- `acceptance.test.mjs`：未运行验收断言；第 65 行存在 `SyntaxError: missing ) after argument list`。
- 合计 1 通过、1 失败，进程退出码 1。

这次独立检查没有修改生成代码，也没有把人工检查写成模型通过验收。继承的 `review.json` 不能替代实际测试结果。

`todo.mjs` SHA256：`0abade487d5dddc321211f3109f2f75b70cc4b35951197e2c1891e4d9e46d091`。

## Windows 启动缺陷（最新版仍存在）

最新版独立 CLI 探测使用 Node.js v24.15.0、随机端口 58176，并用独立预加载守卫把任何监听限制在 loopback。以生成文件为入口的子进程退出码 0，无标准输出或错误输出，`GET /health` 仍返回连接拒绝。

最新版入口判断为 ``import.meta.url === `file://${process.argv[1]}` ``。Windows 路径拼接结果是 `file://C:\...\todo.mjs`，不等于真实模块 URL `file:///C:/.../todo.mjs`，所以入口没有启动服务器。需要后续模型修复采用正确的文件 URL 转换，并增加独立 CLI 启动验收。此探测不改变生成文件，也没有在测试外持续运行 Todo 服务。

### 前一产物的同类缺陷

在 Node.js v24.15.0 中使用生成文件作为子进程入口，指定随机端口 63562，并通过独立预加载守卫把任何监听限制在 loopback。探测结果：子进程退出码 0，无标准输出或错误输出，`GET /health` 返回连接拒绝。

入口判断使用：

```js
import.meta.url === new URL(process.argv[1] ?? '', 'file:').href
```

Windows 绝对路径 `C:\...\todo.mjs` 在这种构造方式下成为 `c:` URL，不等于模块的 `file:///C:/.../todo.mjs`，所以服务没有启动。需要在后续模型修复任务中使用正确的文件 URL 转换，并添加独立 CLI 启动验收。生成代码的监听地址还是 `0.0.0.0`，也应根据本机原型要求明确调整默认监听范围。本次没有手工修复这些产物。

探测结束后仅回收了本次创建的子进程，工作台服务保持运行。
