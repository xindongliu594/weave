# 本批独立审查与修复核对

日期：2026-10-11。审查范围：`ee7cf8371910ba5639c258329edb7382197fcd26..739ba8e5e5eaa8361da1b75e481d70718dbb407e` 的复用统计、候选、发布、网页和备份变更。一次独立上下文、只读审查；初始结论为 **changes requested**。审查者没有运行测试或调用生产模型。

| 发现 | 复现 | 修复 | 核对证据 |
| --- | --- | --- | --- |
| P1：单员工同时读取共享方法和员工私有资料，参与者权限检查不足以证明工作可共享 | 私有工作可错误进入共享登记，RED | 公共工作证据检查所有固定文档的实际空间；私有、缺失、外部门来源禁止共享。临时定向输入不进入自动沉淀 | `single-employee shared-method use with an employee-private source...` GREEN |
| P2：候选发布只比较数据库内哈希列，正文腐坏可能未被发现 | 只改正文、不改 SHA 列，发布错误返回 200，RED | 重新计算固定版本正文 SHA256；原候选创建/发布也执行正文校验 | `publication rehashes the source revision...` 返回 409，GREEN |
| P2：后台统计间接构造完整工作记录，遍历无界历史基线 | 窗口外基线 SQL 被重复执行，RED | 抽出公共正式工作证据；后台不计算效率基线，统计页仅在已核对的 100 个运行内找可比基线 | `reuse scans do not traverse unbounded earlier archives...` 无窗口外基线查询，GREEN |

三项均由实施者先复现，再在一次修复批次中修正。最终相关 API 22 项、UI/效率 8 项、类型检查和构建的实际输出随本报告保存。没有第二轮审查，不将实施者的 GREEN 声称为审查者对最终版本的独立确认。

未由审查认证的边界：真实模型选择质量、完整 QA/经理核对、因果提速，以及生产环境部署、凭据、供应商和在线恢复；部署与短网页核对由实施者另存证据。没有证明多进程高负载性能或原有发布并发语义。真实小任务保持“部分完成/预算受阻”，协议测试不代替真实验收。

原 RED：[red-review.txt](red-review.txt)。最终工程输出：[final-api.txt](final-api.txt)、[final-ui.txt](final-ui.txt)、[types.txt](types.txt)、[build.txt](build.txt)。
