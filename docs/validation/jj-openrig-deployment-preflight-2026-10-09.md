# JJ OpenRig 常驻元数据服务部署预检

2026-10-09，完成部署脚本审阅、私有目录暂存、Linux 回归和只读预检。此报告仅证明部署准备通过，尚未启用新服务、物化正式岗位或同步项目。

## 已实际核对

- 安装包为官方 OpenRig 0.6.6，位于 `/home/jj/.local/share/weiwu/runtime/openrig-v0.6.6`。
- 官方 `daemon/dist/index.js` 第 370–374 行支持直接前台执行；同文件负责 SIGTERM 排空并保存 `daemon-shutdown.json`。使用 `systemd Type=exec` 管理实际 Node PID，不另造 daemon。
- 官方 `kernel-boot.js` 明确在 `OPENRIG_NO_KERNEL=1` 时跳过 kernel 启动。官方 CLI `dist/client.js` 支持 `OPENRIG_TERMINAL_BEARER_TOKEN`；loopback 默认不自动生成 token，因此由本部署单独生成私有 token。
- 待绑定真实部门：`3c0cb5ee-0b24-4ef5-9957-8a048c7dae0a`；指定项目 `4ae5cce4-73c1-420a-987f-83db54d196f2` 当时为版本 12。真实岗位为 `mgr-1`、`dev-1`、`qa-1`，经理/成员身份已核对。
- 拟用回环端口 57415 未被占用；`weiwu-openrig.service` 未安装；`data/pilot/openrig` 尚不存在；JJ 用户 `Linger=yes`。
- 现行 `weiwu-jj.service` 正常运行，预检记录 PID 3041376。本轮没有修改或重启它。

## 脚本与行为

源文件：`scripts/deployment/prepare-jj-openrig.py`、`scripts/deployment/openrig-metadata-runner.py`、`scripts/deployment/test_prepare_jj_openrig.py`。

`--check` 是默认只读模式。`--apply` 仅管理新 `weiwu-openrig.service`，复用固定 runtime，使用全新私有 HOME 和从空白构造的环境；不继承模型 Key、代理或 SSH 变量。所有状态、SQLite、token、映射、bridge-config.json，以及 unit/runner 副本均位于 `/home/jj/.local/share/weiwu/data/pilot/openrig`。

首次 `--apply` 通过官方 `import --materialize-only` 建立三岗位元数据，且在导入前持久记录尝试。超时或结果不明后，再次执行只查询同一 rig 名；找不到不能当成未提交，脚本会停止而不会重新导入。确认真实岗位和空会话后才发布私有配置，不创建任何项目 queue item。网页同步由为伍的独立显式接口完成。

重复执行核对同一 unit、配置、rig/node 身份，拒绝静默覆盖。`--rollback` 仅停用并禁用已证明属于本部署的新服务，核对 PID 和官方关闭回执，保留全部数据及 unit 文件。即使 HTTP 健康检查失败，仍可依据实际进程/数据身份关闭已知进程。未实现或测试自动删除数据。

## 真实预检结果

| 检查 | 结果 |
| --- | --- |
| Linux 隔离回归 | 7/7 通过，无跳过 |
| `prepare-jj-openrig.py --check` | 退出码 0；仅 GET 真实产品身份、读取源文件和 systemd 状态 |
| `systemd-analyze --user verify` | 退出码 0；新 unit 无错误 |
| 状态目录 | 预检后仍不存在，未启动 daemon、未调用模型 |

Linux 回归覆盖：未知物化不可重放；已有 rig 同 ID 核对；外来/重复拓扑拒绝；已有配置不可覆盖；私有权限和模型凭据剥离；岗位会话/运行时校验；修改后的 unit 无权被回滚停止。

systemd 输出包含系统现有 `/usr/lib/systemd/user/spice-vdagent.service` 在 `[Install]` 中声明 `StandardError` 的无关警告，未修改该系统文件。

详细[机器报告](jj-openrig-deployment-preflight-2026-10-09.json)和[实际输出](jj-openrig-deployment-preflight-output-2026-10-09.txt)已保存。

## 交给主任务执行

已暂存目录：

`/home/jj/.local/share/weiwu/admin/openrig-metadata-v1-3c6f63846563`

审阅后由主任务以 JJ 普通用户执行，不使用 sudo：

```sh
python3 /home/jj/.local/share/weiwu/admin/openrig-metadata-v1-3c6f63846563/prepare-jj-openrig.py --check
python3 /home/jj/.local/share/weiwu/admin/openrig-metadata-v1-3c6f63846563/prepare-jj-openrig.py --apply
```

停用可选服务、保留数据：

```sh
python3 /home/jj/.local/share/weiwu/admin/openrig-metadata-v1-3c6f63846563/prepare-jj-openrig.py --rollback
```

成功后由主任务在为伍服务中设置 `WEIWU_OPENRIG_CONFIG=/home/jj/.local/share/weiwu/data/pilot/openrig/bridge-config.json`。准备脚本不会修改为伍服务，也不会自动给为伍设置该变量。

冻结哈希：

| 文件 | SHA256 |
| --- | --- |
| `prepare-jj-openrig.py` | `3c6f63846563d85fe7e818630075732badf07c71518e89513102f3e433594745` |
| `openrig-metadata-runner.py` | `e018ab811b1ae5ac5385cdae2623d99bbf2b2ed39e4e922d00c8ebf3485f8f4b` |
| `test_prepare_jj_openrig.py` | `1b722bcf8143c14cac8eef7e839ee1eee03b080c33676bb8e95027773413feb0` |

## 尚需验证和备份限制

正式 `--apply`、前台常驻服务实测、真实岗位物化、网页同步及服务重启由下一阶段完成；上述源码和预检不能替代这些验收。为伍员工执行、费用控制和经理验收仍只有原 RunCoordinator。

该目录纳入**整目录本地备份**的范围；备份 SQLite 前应先停止新 OpenRig 服务并核对关闭回执。现有网页 `/backup/export` 不包含可选 OpenRig SQLite/config/token，不能把“放在 data/pilot 下”当作网页导出已覆盖。恢复需先在隔离目录核对，避免同时启动两个使用相同配置的实例。
