# OpenRig 0.6.6 私有预安装核对（2026-10-08）

结论：可以先在全新私有 prefix 中仅安装包、禁用全部 npm lifecycle，再用官方独立 `check-abi.mjs` 检查 Node/内存 SQLite。此步骤不需要运行 `rig` 主入口、setup/up、daemon、provider hooks、人员或模型。本轮只读读取官方 metadata/tarball 和现有 Node 信息，**未安装、未执行包内代码、未创建 OpenRig 状态目录；实际 ABI smoke 尚未通过验收**。

这里的项目是 [mvschwarz/openrig](https://github.com/mvschwarz/openrig)，不是 EliasOenal/OpenRig。官方主仓 README 区分 npm 安装与启动团队：launch/setup 会涉及 provider hooks/workspace trust；通用 install.sh 还运行 setup，所以本阶段不使用它。

## 已实际读取的官方包

[npm metadata](https://registry.npmjs.org/@openrig%2fcli/0.6.6) 和 [tarball](https://registry.npmjs.org/@openrig/cli/-/cli-0.6.6.tgz) 通过 jj 只读 HTTPS 请求取得；tarball 仅在内存检查，不解包到磁盘。校验 SHA512 与 metadata 一致。

| 字段 | 实际值 |
|---|---|
| name/version/license | `@openrig/cli` / `0.6.6` / Apache-2.0 |
| engines | `node >=22` |
| repository | `https://github.com/mvschwarz/openrig` |
| bins | `rig: dist/bin-wrapper.js`；`openrig-tui: tui/dist/main.js` |
| postinstall | `node scripts/check-abi.mjs` |
| CLI 的 native dependency | `better-sqlite3: ^13.0.3` |
| tarball 大小 | 6,758,148 bytes；metadata unpackedSize 24,489,189，4077 files |
| dist.shasum | `99a5e8c889d8a188167610e490125d627f6a7a9c` |
| dist.integrity | `sha512-zG9Tt5lyxwzXIe6Qm7S4WFAhwOtD+HMC6KgbRqnp20OJLvbEe2mysFfxf0PtxFS/je7FhFkCwQ1H1tQswvQXuA==` |

其余 scripts：`test=vitest run`、`test:watch=vitest`、`build=tsc ...`、`prepublishOnly=bash ../../scripts/build-package.sh`。没有在本轮执行任何这些脚本。

已实际读取 `package/scripts/check-abi.mjs`、`package/dist/bin-wrapper.js`、`package/dist/index.js`、`package/dist/openrig-compat.js`、相关 config/trust 源码片段及 `package/package.json`。bin wrapper 会进入主入口和 front door，不能把 `rig --help/--version/doctor` 当本阶段独立 ABI 检查。

## Node 与 SQLite

jj 现有私有 Node：`/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node`；实读 `v24.19.0`、linux/x64、modules `137`、N-API `10`。对应 `lib/node_modules/npm/bin/npm-cli.js` 实际存在。

官方 ABI script：

1. 支持 Node 22/24，先拒绝低于 22 或奇数主版本；更高偶数版本仅警告未经测试。
2. 从当前 CLI 包路径解析 `better-sqlite3`。
3. 用 `process.execPath` 启动子进程，打开 `:memory:`，查询 `sqlite_version()` 后关闭；30 秒超时，信号/非零退出均失败。
4. 不 import `dist/index.js`，不打开业务 SQLite，不触发团队或 provider；成功通常没有 stdout，因此必须记录真实退出码。

已实际读取 [better-sqlite3 13.0.3 metadata](https://registry.npmjs.org/better-sqlite3/13.0.3) 和 [tarball](https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz)：

- `engines.node >=22`；本次读取 latest 同为 `13.0.3`。
- `dist.integrity=sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`，内存 SHA512 校验通过。
- tarball 11,402,131 bytes；内含 `prebuilds/linux-x64.node`（2,226,168 bytes）及其它官方平台预构建文件。
- `lib/binding.js` 按平台/架构与 glibc/musl 选择随包 prebuild；不存在才落到 node-gyp build 目录。
- package scripts **没有 install/postinstall**。因此当前这两个已审版本不需要为下载 native binary 而启用全部 lifecycle，也不应先盲目 rebuild/降级 Node。

`13.0.3` 满足 CLI 的 `^13.0.3`（>=13.0.3 且 <14.0.0），可在隔离 prefix 的 package.json 直接精确声明两者，无需修改 CLI 或加 overrides。**安装后的实际依赖树尚未读取**；必须检查 CLI 的 resolve 指向同一顶层 13.0.3，不能仅以 semver 满足就宣称无嵌套版本。

## 下一步命令（供 Root 执行；本轮未执行）

全部以 jj 用户执行、不 sudo。新 prefix 和 state 不覆盖已有安装。采用 Root 指定的独立 HOME，而非 `/home/jj` 或现有为伍服务的 `/home/jj/.local/share/weiwu/home`；显式 HOME 还能把兼容代码可能读取的 `~/.rigged`、旧 `~/.openrig/shared-docs` 限定在新隔离空间。

```bash
set -e
umask 077
task_node_root=/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64
task_prefix=/home/jj/.local/share/weiwu/runtime/openrig-v0.6.6
task_isolation=/home/jj/.local/share/weiwu/openrig
task_home="$task_isolation/home"
task_state="$task_isolation/state"
test ! -e "$task_prefix" && test ! -L "$task_prefix"
# 先核对 isolation/各父目录归属与符号链接；已有状态保留，另行审核。
test ! -e "$task_isolation" && test ! -L "$task_isolation"
mkdir -p "$task_prefix" "$task_home" "$task_state" "$task_isolation/cache" "$task_isolation/tmp"
cat > "$task_prefix/package.json" <<'JSON'
{"name":"weiwu-openrig-private","version":"0.0.0","private":true,"dependencies":{"@openrig/cli":"0.6.6","better-sqlite3":"13.0.3"}}
JSON
task_clean() {
  env -i \
    PATH="$task_node_root/bin:/usr/bin:/bin" \
    HOME="$task_home" OPENRIG_HOME="$task_state" \
    XDG_CONFIG_HOME="$task_home/.config" XDG_STATE_HOME="$task_home/.local/state" \
    XDG_CACHE_HOME="$task_isolation/cache" TMPDIR="$task_isolation/tmp" \
    npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
    npm_config_cache="$task_isolation/cache/npm" "$@"
}
cd "$task_prefix"
task_clean "$task_node_root/bin/node" "$task_node_root/lib/node_modules/npm/bin/npm-cli.js" \
  install --prefix "$task_prefix" --ignore-scripts --omit=dev --no-audit --no-fund

# 只检查解析结果与版本，不 import CLI 主入口。
task_clean "$task_node_root/bin/node" --input-type=module - "$task_prefix" <<'JS'
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const prefix = process.argv[2];
const cliPath = join(prefix, 'node_modules/@openrig/cli/package.json');
const cli = JSON.parse(readFileSync(cliPath, 'utf8'));
const require = createRequire(cliPath);
const nativePath = require.resolve('better-sqlite3/package.json');
const native = JSON.parse(readFileSync(nativePath, 'utf8'));
if (cli.version !== '0.6.6' || native.version !== '13.0.3' ||
    realpathSync(nativePath) !== realpathSync(join(prefix, 'node_modules/better-sqlite3/package.json'))) {
  throw new Error('Unexpected CLI/native version or nested native dependency; stop for review');
}
console.log(JSON.stringify({cli:cli.version, native:native.version, nativePath}));
JS

# 官方独立 Node/SQLite smoke；不用 rig doctor 代替 SQLite 实测。
task_clean "$task_node_root/bin/node" "$task_prefix/node_modules/@openrig/cli/scripts/check-abi.mjs"
printf 'Official standalone ABI smoke exit=0\n'
sha256sum "$task_prefix/package.json" "$task_prefix/package-lock.json"
```

安装产生的 lockfile 记录 resolved tarballs/integrity；保留 package.json、lockfile、Node 路径/ABI、真实退出码及原生解析路径作为验收记录。网络若需既有 GNOME 代理，仅在该受控 subprocess 明确传入已验证的 `http_proxy/https_proxy=http://127.0.0.1:7897`，不写系统/用户 npm 配置；不得无限重试同一失败路径。

## 未验证与停止条件

- 本轮没有实际安装、ABI smoke、CLI help 或团队运行，不能标安装成功。
- 其它依赖若跳过 lifecycle 后缺文件，先确定具体包和脚本行为，再审批范围内 targeted 处理；不启用全部脚本。
- ABI 失败保存输出与安装树，先查版本/resolve/随包 prebuild；不执行提示中的全局 nvm/npm 命令，也不自动更换 Node 或依赖版本。
- 只安装不提供 OS 沙箱；本阶段不 `rig setup/up`、daemon、TUI、人员、keys/providerhooks，也不迁移为伍数据库或替代 DSH。
