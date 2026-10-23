# 安装与授权工具插件

本入口复用 DSH 原版工具注册、为伍现有目录、员工权限和执行设备。适用版本：DSH `0.1.5-rc.1`、Cordis `4.0.2`。

## 网页操作

1. 启动本轮代码的后端和网页，进入“浏览器与 MCP”，下拉到“原生插件工具”。需管理员身份；演示环境不能安装。
2. 选择一种来源：公共 npm 包使用**精确版本接入配置**；公司私有或 GitHub 分发的插件使用经过审核的**可移植安装包 JSON**。
3. 点击“开始安装”，查看下载、工具探测及校验状态。失败会显示原因。刷新后可继续查看本标签页最近一次任务；服务重启后的未完成安装标为中断，不自动重放。
4. 新版本安装完成后默认未启用。核对来源、版本及工具名，再点击“启用此版本”。
5. 到部门员工和项目策略分别勾选所需工具，新批准运行固定选用版本。安装、启用不会自动给员工授权。
6. 员工通过既有 `capability_search` 按授权发现并调用。停用插件阻止后续调用；历史版本及原运行绑定保留。

## 公共 npm 接入配置

示例为已核对的原版 Office 包。完整配置见 [`scripts/plugins/office-0.2.4.json`](../scripts/plugins/office-0.2.4.json)；网页输入只保留 `namespace`、`package`、`version`、`config`、`files` 五个字段。

```json
{
  "namespace": "example",
  "package": "@scope/dsh-tool",
  "version": "1.0.0",
  "config": {},
  "files": {"original_tool_name": {"read": [], "write": []}}
}
```

`files` 须逐一列出配置后实际注册的工具，读写数组填写工具参数中的文件字段名，例如 `file_path`。无文件操作的计算器使用空数组。它是管理员审核的权限元数据，不能根据工具描述自动猜测路径或授予任意文件权限。`config` 不接收密码、Token 或 API Key。

服务需要 Node.js 自带 npm。安装器调用标准 npm，在独立目录下载公共 registry 精确版本，禁用安装脚本、审计和自动 peer 安装；复用当前固定 DSH peer。npm 子进程只能读其运行代码与本次暂存目录，只能写本次暂存目录；不继承用户 npm 凭据。它不启动或修改主 DSH profile，也不在 API Host 中执行插件初始化。失败后可修正配置重新安装，不能用标签、版本范围、Git URL、命令或本机目录代替精确包名。

## 可移植包

管理员先核对原始来源、许可证、依赖、入口及权限，再使用原有通用构建器：

```powershell
node scripts/plugins/build-native-tool-bundle.mjs definition.json installed-package-directory lockfile output-root
```

构建器使用原版插件注册工具并探测 schema。输出目录中包含 `manifest.json`、`bundle.gz`、`package.json`。安装 JSON 的字段为：内容寻址编号 `id`、解析后的 `manifest`、gzip 字节的 Base64 `compressed`、元数据字节的 Base64 `metadata`。与现有备份中的单个插件记录使用同一格式，加上 `id` 即可导入。不能仅上传来源描述或伪造 manifest 来代替实际代码包。

第二个真实插件的接入元数据见 [`calculator-0.0.1.json`](../scripts/plugins/calculator-0.0.1.json)，来源固定为 [上游提交 b2007a13](https://github.com/omdsh-dev/dsh-tool-calculator/tree/b2007a13f06bcf75bf07b9d277ee8d434a316490)。它没有公开 npm 发布物，通过可移植包安装；没有为计算器修改执行核心或重写业务代码。

## 范围与限制

- 当前面向可打包进现有受限 Node worker 的工具插件。原生 DSH 网页、常驻服务、额外 Host 依赖、外部网络或原生 addon 需要对应接入评估，不能保证任意插件都兼容。
- 尚无市场搜索界面、自动审核或私有 registry 凭据管理。第三方初始化探测采用本机 Node 权限子进程；它不等同于 JJ 的 OpenShell 执行证明。
- 网页可移植 JSON 上限约 1.4 MB，API 保持原 2 MB 请求体限制；压缩包及运行时另有原有配额。公共包安装期间每 500 ms 检查暂存空间，准入上限为 256 MB / 20,000 文件，并保留 512 MB 可用磁盘，下载超时 120 秒。这是应用层采样，峰值可能超过阈值，不是操作系统硬配额。
- 重启时仅回收归属明确、子进程已退出的本次安装目录；进程仍在或退出状态无法确认时保留目录并显示管理员检查提示，不盲目杀进程或删除。最多保留 200 条安装任务、100 个插件版本；达到上限须管理员归档。
- 所有改动的状态和证据见[本轮验收报告](validation/plugin-plug-and-play-2026-10-23.md)。报告区分本地组件、JJ OpenShell 和真实模型员工验收。
