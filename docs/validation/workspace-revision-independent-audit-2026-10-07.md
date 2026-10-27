# 工作区版本标识修复独立审核

结论：本地源码与兼容性工程验证通过。

- canonicalManifest复用已有本机executor，固定path/size/sha字段和UTF16码点排序，不依赖locale、不foldcase/Unicode归一
- native、API mirror、handoff和RunSandbox调用同一basis；hash包含真实file SHA和大小
- 正常v14四文件同内容重算历史locale b57与原native/新canonical a2ef，两值均验证；没有改历史记录
- 现有resumeHandoff仍按原completed attempt及每fileSHA验证，保留旧seal/命令字节，不拿新hash替换旧值；相关兼容/tamper回归通过
- 15/15测试、types0及全部原源码/日志SHA相符；数组/object键次序变化及locale抛错回归均被覆盖

- 本地工程验收，不代表reload后新员工真实回执已统一；待Root加载和新真实流程验证
- 旧archive/报告两种basis继续保留，历史metadata不得重写
- 仅本地读保存数据/代码，无API/模型/Cua/原DB/员工写入

完整来源SHA见同名JSON。
