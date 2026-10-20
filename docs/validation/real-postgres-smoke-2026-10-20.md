# Windows 独立 PostgreSQL 测试环境：实际验证

2026-10-20。按 real-postgres-validation 计划复用固定二进制包，在工作区私有临时目录运行 PostgreSQL 17.10；不是生产数据库、不是 PGlite。没有安装系统服务、修改管理员权限或访问 JJ 数据。

来源：https://github.com/leinelissen/embedded-postgres 。固定包 @embedded-postgres/windows-x64@17.10.0-beta.17，npm 完整性值见同日计划。三个可执行文件的 --version 均实测为 PostgreSQL 17.10，退出 0；安装脚本关闭，包内 pg-symlinks.json 为空。根产品依赖/锁文件未变，约 102 MB 缓存只留在忽略的开发测试目录，不进入 JJ 发布包。

首轮实例 c9087e7a-f045-4e98-9d01-2e3c408af4dc 的数据库日志已证明监听回环并 ready，但 Windows 后台服务继承了 stdout 管道，导致 spawnSync 等待超时。按同一实例状态确认并停止后才结束，没有因观测超时盲目重启。改为普通证据日志文件后，第二轮通过。

通过实例：94636e2a-04de-42c9-bea2-5eb66998075c。两个独立 PostgreSQL backend PID 为 46128 和 29820；第一事务持有行锁时，pg_blocking_pids(29820) 返回 46128，第二查询尚未完成；第一事务提交后第二查询完成。使用服务器实际锁关系，不以固定等待时长冒充并发证据。

同一个独占临时数据库运行现有 tests/identity-store.test.ts：11/11，0 failed，0 skipped，2.023 秒。包括实际重复迁移、初始化管理员并发消费、当前身份/撤权世代与审计事务约束。OIDC HTTP/TLS 会话竞争测试当前仍使用其固定 PGlite fixture，本记录没有将它算作真实 PostgreSQL 已通过。

退出时 pg_ctl 确认本次集群已停止，成功实例的数据目录与临时密码已移除；首轮失败数据也在重新验证所有权和 stopped 后清理，仅保留小型日志、版本/摘要及结果。证据位于 .superpowers/sdd/2026-10-20-real-postgres-validation/；测试脚本仍为工程探针，尚未作为通用发布 runner 完成独立审查。

限制：包不包含已验证的 pgvector，不能据此宣称完整产品迁移、成果 CAS 并发、OIDC 会话并发或 JJ Docker/沙箱已通过。后续使用同一受控环境补齐这些明确门禁，不改写 vector 类型或降低校验来让测试通过。本轮模型调用 0，生产/JJ 变更 0。

后续身份协议续验：7f00ee2d-c412-4052-a98d-907063de1b8c 在同一固定PG17.10上实际运行 guard、identity-store、identity-oidc 三套测试，29/29、0skip、退出0；独立backend44964/1264的真实行锁阻塞与释放再次成立。独立审查已只读核对结果、停止及数据/密码移除，并复核测试URL和探针清理安全。首次27/29中的一项维护时序失败已按真实Promise等待修复，原断言保留；失败实例也在复核所有权/停止后清理。详细日志与限制见enterprise-browser-identity-2026-10-20.md及其证据目录。仍不证明完整产品pgvector迁移、成果CAS或JJ沙箱；探针没有升级为通用发布runner。
