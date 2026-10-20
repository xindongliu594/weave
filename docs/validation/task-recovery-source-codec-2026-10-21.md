# 检查点恢复来源记录与文件锁隔离验证

日期：2026-10-21；源码基线 `35d2b1f`。本批完成严格记录格式及现成锁库的隔离验证。**尚未完成产品恢复来源签发、子运行初始化和网页恢复。**

## 实际修改

新增 `apps/api/src/task-recovery-state.ts` 与对应测试，复用现有 Zod、路径与 manifest 算法、SHA256 和脱敏函数。检查源运行/检查点/合并回执身份、文件范围及大小、子运行变化和记录摘要；拒绝未知字段、越权路径、删除、格式变形及伪造认证标记。

函数只校验格式和摘要，不读取数据库、文件或模型，不把传入 JSON 当作真实来源证明。没有迁移数据库、改变权限、开启企业 profile 或修改原检查点算法。

## 工程结果

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 首次缺模块及最小实现 RED | 失败符合预期 | 保存原输出 |
| Unicode 控制字符 / Proxy 负例 RED | 12 项中 2 失败 | 修复后纳入最终新测试 |
| 四文件相关回归 | 45 项，44 通过，0 失败，1 跳过，exit 0 | 首次受限环境有 3 个旧 hardlink 测试 EPERM；同命令普通本机环境重跑通过。跳过项是原有迁移门禁，不声称已验迁移 |
| 初次类型检查 | TS2345，exit 2 | 保留输出；显式 `return invalid()` 修正收窄，不删除校验 |
| 修正后新 codec | 12/12，exit 0 | 最终源文件版本 |
| 修正后 `npm run build` | 类型检查 + Vite，exit 0 | 仍有现有 >500 kB chunk 提示 |
| 独立 spec/质量审查 | PASS，无 P0–P2 | 静态审查与日志核对，未冒充再次实测 |

四文件命令：

```text
node --import tsx --test tests/task-recovery-state.test.ts services/agent-runtime/step-checkpoints.test.mjs services/agent-runtime/task-checkpoint-v2.test.mjs tests/task-accepted-stop-state.test.ts
```

原输出、实现者报告、独立审查及 SHA256 见 [证据清单](evidence/task-recovery-source-codec-2026-10-21/manifest.json)。单次完整回归在类型收窄修正之前；修正后运行新 codec 与构建，没有把两次运行拼成一次完整回归。

## 现成文件锁的 Windows/JJ 实测

按 [复用调研](../research/task-recovery-writer-fence-2026-10-21.md) 在独立目录安装 `fs-native-extensions@1.5.1`，固定六包 lockfile、禁用安装脚本。未更改产品 package.json / package-lock.json。

两边最终同一脚本 SHA256 为 `ee0714e7287bc53b9bd72898ca3faf1566b739fa91e62644633c22237d6809d9`，依赖 lockfile SHA256 为 `512ce43748bb2c5f56e04c00be31f30e8e90cc9283e1516bb9c47f90c386e54c`。Windows Node 24.15.0、JJ Linux Node 24.19.0，均 exit 0：七项锁行为检查通过；另外记录了一项路径替换局限和一项小型开销观测。

- 两个进程共享/独占互斥、关闭句柄、正常退出、结束本脚本自己的子进程后释放均符合预期。
- 两个实际子进程在锁内完成 60 次文件读改写，最终计数 60；有限重试没有抢走仍被持有的锁。
- **锁文件可以被重命名并替换；新文件可再次取得锁。** 锁住描述符不能代替固定文件身份；这项输出是局限证据。
- 最终 1000 次无争用 open/lock/unlock/close：Windows 约 229 微秒/次，JJ 约 8 微秒/次。没有比较产品速度、网络盘或高并发负载。

独立审查指出首轮 close 用例等进程退出后才重新加锁，不能单独证明关闭描述符释放。已改为关闭后回传确认、进程继续存活，另一进程取得锁后才通知退出；两平台最终输出均包含 `reacquiredWhileOwnerAlive: true`。初轮脚本、记录及审查意见均保留。

JJ 实验目录：`/home/jj/.local/share/weiwu/validation/native-lock-2026-10-21`。部署的为伍服务、运行档案、生产数据库和 API 配置未读写。库已下载到该隔离目录，尚未成为产品依赖。

复现：将证据目录内两个 dependency 清单改名为 `package.json` 和 `package-lock.json` 放到新隔离目录，执行 `npm ci --prefix <隔离目录> --ignore-scripts --no-audit --no-fund`，再运行：

```text
node scripts/validation/native-file-lock-pilot.cjs --dependency-root <隔离目录> --output <新的结果JSON路径>
```

脚本只读写自己的合成文件，并只终止自己创建的子进程；输出路径须不存在。结果没有使用固定模型响应，不涉及模型调用。

## 剩余工作

跨进程锁原语可复用，但当前运行尾部、事务外工具结果、审批追加和维护路径尚未共同遵守它。下一批先接写入所有权和读取期间的独占保护，再完成原 SQL/完整档案来源核对、子运行原子初始化与恢复竞争验证。已完成节点保留、未知外部动作不重放等原边界不变。

本批真实模型调用为 0，生产部署变更为 0；累计 $3.41 和七笔旧未知费用保持。企业 profile 继续关闭。
