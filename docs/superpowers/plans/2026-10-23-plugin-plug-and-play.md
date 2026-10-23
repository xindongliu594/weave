# 插件即插即用最小闭环

Spec: 本文件的验收合同，以及 `docs/research/dsh-plugin-plug-and-play-2026-10-23.md`。

## 验收合同与全局约束

- 用户已批准本轮实现；先调研，再按本计划实施。复用标准 npm 包安装、现有构建器、原版 DSH Tools/Cordis、员工授权/版本/worker，不重写插件业务或另造市场/调度器。
- 保留12个既有未提交修改，已保存 `.superpowers/sdd/2026-10-23-plugin-plug-and-play/preexisting-wip/manifest.json`。不提交这些未完改动，不覆盖数据、凭据及历史运行。不改 JJ 服务或调用付费项目模型。
- root 管文档、Git、验收证据与外部包获取；一个实现者独占产品源码和重测试槽。先失败用例再最小实现；相关检查通过后只因新问题追加检查。
- 工具型兼容插件为首批，UI/后台类明确不支持该 worker 模式。安装不等于启用/授权。新安装默认停用，不自动授予员工；版本不可变、升级不覆盖历史，现有快照/撤销机制继续生效。
- 安装输入精确 npm 包名与版本、namespace、非敏感 config、原始工具文件字段政策；拒绝命令/路径/git/URL/标签/范围等来源。固定公共 registry，生命周期脚本禁用，临时目录/缓存隔离，子进程最小环境；API 不导入插件业务代码。安装、构建有超时/输出/并发/空间限制，失败不留下可执行半成品。schema probe 沿用既有受限子进程，不能宣称已在 OpenShell 验证本地探测。
- 原生 package/工具配置属管理员接入元数据。普通员工只见获授工具；不能用宽泛 wildcard grant。私有公司 portable bundle可使用既有 manifest+hash合同导入，不能上传公共市场；不在此轮添加私有 registry 凭据管理。

## Task 1: 共用安装入口与网页闭环

实现一个完整切片，不拆成多个并行写入任务。

范围：新增 `apps/api/src/native-plugin-install.ts`（必要时独立 `.mjs` 包管理子进程）、现有 `native-capabilities.ts` / `api-route-policies.ts` / `NativeCapabilities.tsx`、`scripts/plugins/build-native-tool-bundle.mjs` 最小泛化、针对性测试。不得改动旧12文件。仅对旧签名漂移修正 `scripts/test-support/mvp-data-fixture.ts`：调用 `runManagementRouter` 传入 `createArchiveWriterManager({traceRoot})`；该项是基线构建失败前置修复，不改变运行语义。

步骤：
1. 先写安装边界和失败状态用例。检查所有调用点；基线 `npm run build` 已因 fixture 少参数失败，日志在私有工作目录，无需再重复证明。
2. 将现有构建器抽成可调用函数，CLI兼容；成功版本原子发布，重复相同字节返回既有版本且校验一致，不覆盖。保持原版工具注册和 per-tool 文件策略核对。安装从标准 npm 精确包到独立目录（不启动 profile）后调用该函数；npm 生命周期禁用、固定 registry、禁用 inherited npmrc/proxy/auth/script 环境，lock/integrity随构建凭证记录。Windows/Linux采用可验证标准 CLI，参数数组，不接受任意 shell参数。依赖缺失给行动明确错误，不偷偷装全局依赖。
3. 安装任务限单实例并发，持久状态与可解释阶段/错误；服务重启将未完成状态标为中断而不自动重放；清理只限本次受控临时目录。接收既有 manifest/compressed/metadata 的可移植包，复用 restore/read校验，不加载代码；第二原版插件是 GitHub 分发的 private 包，因此这条路径是必须项。安装记录不存原始stderr/敏感环境或凭据。
4. 新 POST 安装、GET 安装状态等端点列入精确admin清单，沿用既有CSRF/幂等。演示模式禁止真实下载安装。状态返回不暴露主机路径。安装成功刷新目录，初始未启用；启用/停用和部门/策略选项沿用既有入口。
5. 网页增加简洁安装入口、运行状态、成功后授权提示、失败原因/下一步；管理员可用一份接入JSON配置安装兼容包，勿要求手改数据库。明确这是工具插件兼容安装入口，不宣称任意上游网页插件可用。
6. 定向验证：非法源/范围/脚本、并发、安装失败与重启中断、默认停用、重复提交/版本字节完整性、普通成员/设备拒绝和CSRF、目录旧版保留。复用已有原生能力/worker/员工工具授权测试，不重写现有大矩阵。完成类型检查和构建。实现者只运行一次相关集成套件，记录确切命令/输出。

提交：实现者不做Git操作，输出 exact-file allowlist、测试结果和限制到本计划私有工作目录。root 用精确allowlist提交候选后交独立review；不得纳入旧12文件。

## Task 2: 第二个真实插件验证与交付

root 获取经过审查的第二插件固定原版包，先记录包源/版本/许可证/完整性，使用 Task1 的同一入口安装。只新增接入配置，不改worker或执行核心；实际执行工具、验证结果和授权拒绝。外网不可达/无兼容发布物应记录受阻，并继续完成无网络检查，不能自写插件冒充通过。Office旧证据不算本轮第二插件。

用可用浏览器验证安装表单/状态/启停/授权引导。浏览器验证仅短主流程，后端其余用API/代码测试。报告记录成功/失败/受阻、实际命令、文件和截图，分别标注本地受限worker和JJ OpenShell、付费模型员工验收。后两项本轮未执行时如实写明。

独立review候选范围，修复具体问题后再检查受影响项；通过后按此前授权仅推本轮源代码、说明和脱敏证据。README/使用说明给网页入口、接入配置字段及兼容边界。不宣称企业级全功能已完成。
