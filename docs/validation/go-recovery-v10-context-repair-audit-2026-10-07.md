# 上下文修复独立审核

结论：未发现P0问题；源码边界与原真实请求本地预览通过。

- 生产Host proof来自封闭Map与executor已知成功回执，不依赖模型自称成功
- 同run/version/session/employee/task/attempt/scope及完整args/result hash；重复call失去资格
- native user+source tool唯一call/result配对、成功完整值；跨batch只移精确读pair，说明和其他pair保留
- 只有当前非input可写output的已知成功CAS解除旧读保护，新write完整代码/回执保持
- fixed inputs、knowledge PIN、最新批准上下文保持；失败/未知/错scope/hash/未配对write不解除保护
- 冷Host Map默认空，不凭旧模型上下文或未重建证明提权
- manifest全部source/log SHA相符，69/69及types0；强核对真实operations和全部actor字段后独立复算原真实request92403B/预留.0400281/输出10000/原cap192000/QA可用.0452769，0wire

- 本次为代码和本地预览验收，尚未证明reload后的真实员工运行成功
- single-call可入场不保证剩余任务预算足够持续多轮
- 工程manifest只有tests/types，没有独立build原日志，不补造证明
- 独立预览复用原冻结验证源码在内存执行，只增加真实operations/actor/SHA核对并写新结果；未创建新helper或改原冻结source

全部source SHA及复算指标见同名JSON。仅读本地证据与源码，未访问live API、原数据库或模型，未写员工交付物。原MVP仍partial，不能以本地预览代替真实续跑验收。
