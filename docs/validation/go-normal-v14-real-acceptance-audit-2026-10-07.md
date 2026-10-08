# 正常v14真实员工验收独立审核

结论：真实文件与任务路径通过；UI最终摘要矛盾及工作区revision口径差异待修。完整MVP未完成。

Run 88aa22a9-f887-467c-bf12-91bb57d42361，项目 4938eab8-26ed-4f60-9413-d979f05fa968，v14。

- 真实Go AI候选原样确认、新空run project审批、无恢复继承
- 7011完整连续事件、前后archive相同、4 accepted依DAG顺序
- 23 known completed本机操作、6审批命令与完整output SHA；dev首次11/12失败保留、自修后12/12，QA/review各12/12+8/8
- 5真实下载文件hash匹配员工writes/accepted outputs、producer输入固定；经理只写报告未执行命令
- 46 wire/usage各自requestId+Token匹配，费用.5079759，历史hold.096526保留、剩余1.5542203

- run/finished seq7011 summary：旧captain摘要NOT accepted/report not produced，与已完成4seal及实际经理报告矛盾，待产品UI修正，不改原记录。
- observationSeq3612/3886/5761/6411：本机executor/审批a2ef45e8…；handoff/经理正文b57de449…。本审核对相同四文件manifest重算raw顺序及localeCompare顺序得到两值，精确SHA/size相同；不是文件变化，但未来算法口径须统一，不能改原archive/report。
- 最后team/checkpoint.tasks t4 output：经理任务回复把qa_verify seq3886的op简写成16862165，实为review seq6411；报告正文第4节正确为e3bf9b37-60e8-4619-afae-698a6244e6b0。
- acceptance-report.md U1/U2/U4：经理protected context不含终端正文而标未验证；实际combined output完整，本审核验证六命令output SHA及首次GET-body异常，不将分流stdout/stderr未知误当combined缺失。

经理实际报告17620B SHA342915788d0570634a86450e650cddefa83115fe85394950f94bbb4f2269c24b。实际测试均逐次审批、完整输出哈希绑定；初次失败不隐藏。两种revision由同一完整文件清单重算，明确区分basis，不能伪装字符串相同。

全来源SHA、6回执、4seal、四处revision差异和五文件见同名JSON。

- 待验收：UI修复后真实浏览器结果核对
- 待验收：未来workspace revision算法统一工程验证
- 待验收：受控重启恢复全部节点完成
- 待验收：最终隔离备份与打包

仅读本地保存数据，未API/Cua/原DB/模型访问或员工文件写入，不改原员工报告与旧summary。
