# 固定任务：订单金额汇总

根据 inputs/orders.json 生成 report.json。金额统一使用整数分，totalCents 必须为各行 unitPriceCents × quantity 的总和，同时输出 orderCount。

员工分工：producer 提供金额计算模块；assembler 编写引用该模块的报告程序；checker 执行固定输入并核对预期结果。

测试先预先批准 library → application → inspect → repair → verify 五个任务。inspect 的交付物是诊断记录；即使发现计算错误，诊断任务本身也可以完成。repair 根据诊断修复或不修改，verify 必须真正通过。

本资料只供确定性测试：模型响应由测试适配器产生，绝不调用真实模型。自动发现依赖、自动新增修复任务、真实模型编程质量不在本测试的通过含义内。
