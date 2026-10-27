# 源码副本实际安装、构建与隔离启动独立补审（2026-10-07）

真实副本依赖安装、默认 Windows Node 构建及隔离数据启动通过。本补审不改前一份冻结报告，仅读取现存日志、证明、helpers、源码和包元数据；没有启动服务或调用 API/模型/浏览器/数据库。

- 两次锁文件安装实际分别增加根219、runtime519依赖；锁 v3，安装的 Vite7.3.6、TypeScript5.9.2、DSH0.1.5-rc.1、AgentTeams0.1.20等与锁匹配。应用自身没有 postinstall；不宣称传递依赖无安装脚本。
- Node24.15.0 下 npm run build 执行类型检查及 Vite构建完成。大于500kB的分块提示是构建警告。构建后373冻结源文件/4744460字节逐个SHA及合并SHA14b09d91ea6a4b9569ef88ac0306263133493dde155eca81b9db1775bcdca75e仍严格相等。
- 唯一实际启动使用新 .data/source-startup-smoke-932481b3-ff44-4e9f-ae8b-6e50d00b308b 与端口4323，和原数据目录不同。数据库connected、runtime.ready，构建HTML200；真实usage/runs响应都是 []，没有模型请求或项目运行。
- 首次原始证明失败保留：PowerShell @ 包装空REST数组导致计数为1，属于验收helper计数错误。补充helper没有 Start-Process，对同launcher7288/API31220读取原响应后，核对CIM与保留Process身份并准确关闭；没有重复启动。关闭后的API退出4294967295对应受控终止，不能当成启动前产品崩溃。
- 隔离数据的launcher.lock及database/postmaster.pid均不存在，证明dataClosed。原环境没有打开或覆盖；既有服务健康证明属于另一条保留证据。

证据SHA和准确范围见同名JSON。此前源码包不包含完整原始验收卷宗、跨机器凭据迁移未验证与未知费用保留等限制仍然有效。
