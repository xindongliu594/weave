# DSH 插件即插即用接入调查（2026-10-23）

## 采用的已有实现

固定版为 DSH 0.1.5-rc.1 / Cordis 4.0.2。已安装版本的 `dsh plugin --profile ...` 是 pnpm 转发器，安装后自动修改 profile bundle 列表；Loader 只装载已安装模块。上游新版 [Plugin Manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) 有完整管理界面，但其原生 Host/Client 服务并未挂入为伍，不能直接当作当前 React 页面组件使用。不能把最新上游功能记为当前版本已有。

复用现有标准包管理器负责下载、依赖解析及锁文件；复用 `build-native-tool-bundle.mjs`、原始 Cordis/DSH 注册及执行接口、现有版本快照、员工工具授权和 OpenShell worker。当前真正缺少的是网页安装及安装状态连接，不是第二套插件运行引擎。

为避免 CLI 在主 profile 自动装载第三方代码，本轮安装使用独立临时目录的标准 npm，禁用生命周期脚本，不继承生产 npm 凭据/配置；不启动 DSH profile。若本机包管理器不可用，给明确错误。这个选择保留标准 npm 分发和 DSH 原版工具执行，不模拟插件业务逻辑。安装阶段只支持公共 registry 的精确版本；私有公司的可移植安装包沿用同一目录合同。

## 兼容范围

首批面向能在既有 Tools + SystemPrompt Context 中注册工具、可打包为受限 Node worker 的插件。逐工具文件字段是接入配置，须明确声明，不能靠模型猜测权限。需要原生页面、额外 Host 服务、常驻后台进程、原生 addon 或外部网络的插件不在这一执行模式内；给出具体兼容性错误，不能放宽沙箱来冒充支持。

已有原版 [dsh-office](https://www.npmjs.com/package/@huiliyi37/dsh-office) 0.2.4 的 JJ 真实调用证据保留。第二个候选为原作者 [dsh-tool-calculator](https://github.com/omdsh-dev/dsh-tool-calculator)，需核对精确发布物、实际注册 API 与许可证后才可作为本轮实测证据。若不兼容或不可取得，应记录受阻，不能用自写 fixture 代替真实插件。

## 本轮验收方式

从管理员网页安装固定版本，显示进行中/失败/成功；安装默认停用。启用后通过既有部门及项目工具授权发现、执行；停用沿用现有撤销规则。第二个插件只增接入配置，不修改执行核心。检查安装脚本禁用、非法包/版本拒绝、失败清理、幂等、无授权安装拒绝、版本保留，以及相关类型检查、构建与浏览器流程。零付费组件验收与真实模型员工验收分别标注。
