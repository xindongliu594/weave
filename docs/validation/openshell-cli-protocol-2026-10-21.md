# OpenShell 固定协议核对与回收误报修复

日期：2026-10-21。基线：`076fb82`。本轮完成停止观察与历史回收误报的本地修复；企业任务级 profile 仍关闭，未部署 JJ。

## 已确认的问题

已验收停止后的观察代码将 sandbox UUID 传给 `sandbox get`，旧单元和 Product CLI 夹具同时接受名称、UUID，因而没有暴露兼容错误。固定 CLI 实际按名称查询，名称查到的对象仍需与原 journal 的 ID 精确核对。

旧回收链还将 UUID 传给 delete，并以 get 返回“sandbox not found”判断已回收。固定 CLI 的 delete 设置 `allow_missing:true`：如果这个 UUID 不是一个对象的名称，删除会成功返回但不删除原对象。get 既可能对不存在的名称返回 NotFound，也会用它隐藏没有权限的对象。因此，历史 fixture 的删除成功或 retired 缓存不能作为物理资源已经消失的证明；历史记录保留，当前容量保守保护。

依据：

- [固定 CLI：get/delete 按名称](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/run.rs)。
- [固定服务端：get 的权限隐藏、list 的独立 workspace 授权](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-server/src/grpc/sandbox.rs)。
- [固定协议：DeleteSandboxRequest 没有 expected ID/版本条件](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/proto/openshell.proto)。
- [固定 JSON 分页输出](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/crates/openshell-cli/src/output.rs)。

## JJ 实机只读核对

使用已安装 CLI，SHA256 为 `f334da80f867776dde9034e0ca3c2406d48ba77b0d0abe64b5aa610490a34fca`，与项目固定值一致。观察时间为北京时间 2026-10-21 01:24:26。

| 操作 | 实际结果 |
| --- | --- |
| 原 workspace 列表，只读取一页一条 | 成功，存在后续页；不是完整 inventory |
| 用该条目的名称 get | 成功，返回名称和 ID 均与列表一致 |
| 用同一个对象的 UUID get | exit 1，返回 sandbox not found |

只读脚本未输出沙箱名称、ID、策略内容、凭据；没有创建、停止、启动、删除、执行工具或调用模型。本次实测证明 selector 行为，未测试真实撤权和删除。

## 本轮修复范围

1. 停止观察复用原名称查询，并核对返回 ID 与原 journal 一致，保留授权、版本、超时和不重放停止的规则。
2. 固定协议不能按原 ID 条件删除，`retireStorage` 在检查、排队、CLI、intent 或文件写入之前拒绝，返回 `OPENSHELL_RETIREMENT_UNSUPPORTED` 与 `notExecuted:true`。移除旧的 NotFound 即回收成功判断。
3. 旧 intent 只允许只读核对原对象仍存在。查询后复核当前授权、配置与完整原 journal；NotFound、换 ID 或其他不明结果都保留 unknown。不会改写历史结果、重发删除或启动沙箱。
4. 历史 retired 映射投影为 unverified，原 journal 不变；不采用旧容量数字释放任务名额或磁盘预留。原两运行名额、128 个保留任务上限不变。当前容量算法仍仅覆盖 schema-2 任务映射，未解决全部 legacy 物理资源盘点。
5. 网页禁用沙箱回收预览和确认，明确显示当前未开放；历史回执显示“待物理复核”，不再声称原沙箱已不存在。工作区副本清理、日志归档和原只读核对入口保留。

## 工程验证

原始输出、退出码、耗时和源码摘要见 [证据清单](evidence/openshell-cli-protocol-2026-10-21/manifest.json)。所有重测试串行；本轮付费调用和生产修改均为 0。

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| 修复前回归 | 63 项中 18 项失败 | 保存 RED；包含名称选择、回收误报与容量保护问题 |
| 全部 desktop 测试 | 82 项中 75 通过、7 失败；其中 OpenShell 64 项全通过 | 7 项在未修改的本地执行器/磁盘测试，受 Windows rename/symlink 权限影响；未把该次命令写成成功 |
| 原样重跑上述两份测试文件 | 14/14，exit 0 | 在获准的本机执行环境重跑；覆盖原 7 项失败，无产品权限修改 |
| 实际 Product 正常工程链 | 1/1，exit 0，约 91.5 秒 | 首次因隔离环境禁止 localhost 数据库连接失败；同一命令获准重跑通过 |
| 缺失名称 delete 的协议夹具回归 | 2/2，exit 0 | 先 RED；确认成功空操作不会删除原具名对象 |
| 网页 SSR 与停止/存储关联 | 16/16，exit 0 | 先复现 3 个网页误导/按钮问题；本批未做浏览器交互验收 |
| 类型检查与生产构建 | `npm run build` exit 0，约 27.8 秒 | tsc 与 Vite；保留已有单 chunk 大于 500 kB 的提示 |

Product 运行 ID：`aa25d5f1-05a3-4ca8-acbd-0b6c38ef0d0b`。实际执行 Product、Host、交接、HTTP、SQL CAS、设备 journal、Node 子进程和文件链；模型、CLI、UID/cgroup/mTLS 隔离由工程夹具提供，不能作为真实模型或物理 OpenShell 验收。

成功的 Product 运行结束后，修改了两份 CLI 夹具及其合同断言，纠正 `allow_missing` 行为；仅对应的 2 项测试重新运行。生产 executor 和 Product 场景断言源码未改变，没有声称所有最终文件经过一次相同的完整 Product 重跑。过程 JSON 保存当时源码哈希，清单另外保存最终源码及 Git LF 形式的哈希。

独立 spec/quality 审查为 PASS，未发现可复现的 P0–P2 问题；审查实际源文件、固定协议及保留日志，未重复运行测试。六份最终源文件哈希一致；根复核证据清单 29 个文件及 6 份源码哈希通过。

## 尚未完成

完整授权 inventory、具备原 ID 条件的安全删除、失败/替代任务现场资格、恢复与备份导入，以及 JJ 任务级 profile 验收仍待完成。当前自动沙箱回收未开放；这次修复消除了错误成功路径，不能用来宣称物理回收已经实现。旧任务、文件、收据和未知费用均保留。
