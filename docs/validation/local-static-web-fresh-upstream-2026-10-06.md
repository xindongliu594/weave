静态网页代理已做最小连接修复：`scripts/local-static-web.mjs` 的上游 http.Agent 仅由 keepAlive:true 改为 false，每次本机 API 请求新建连接。没有增加 GET、POST、PUT 自动重试或重放；origin/path/header/abort/body 边界原样保留。

新增回归先在旧代理上运行：8次连续API读取实际只用了1个socket，fresh-socket断言失败；改后8次读取使用8个独立socket。另一fixture先收到完整正文并登记可能已生效的POST/PUT，再主动断开响应；GET、POST、PUT各仅派发一次，返回现有 LOCAL_API_UNAVAILABLE/502，原方法、路径/query、正文bytes与idempotency-key保持一致。测试未因为未知响应重复执行。

静态web与launcher相关回归19/19、exit0，既有origin/Host/路径/headers、流式响应、停止abort、端口释放、构建资产及原启动锁检查均通过。node --check与tsc --noEmit均exit0。完整旧失败与新通过输出见同名.txt。

已存第二次实际resume证据只读核对：`docs/test-evidence/funded-run-web-normal-resume-2026-10-06T04-57-08-143Z-30061a10.json` SHA d0f555796e0e071d624bd12b9362010915ece23b98bcafd85e50bf17aa79d275，v8 parent0947ae05…，GET `/runs/90f0e832-f423-42f3-abc0-c0749a07b90f` 返回502；mutationRequests=0、dispatchObserved=false，POST在route.continue前被守卫拦。原guard/intent/helper全部保留。直接API及其他GET健康是root本轮观测；本helper修复没有再访问原服务。

该真实502的代理错误映射覆盖多种upstream失败，无法据此证实具体ECONNRESET根因。本次已证明消除共享上游连接复用；真实reload后的GET和恢复可靠性尚需root检查，不能提前声明恢复成功。

| 冻结文件 | SHA256 |
| --- | --- |
| scripts/local-static-web.mjs | 2a75f0666efbc0f8887a267b6cb151be49fa6d2315ec392ec8b86ef186216304 |
| tests/local-static-web.test.ts | 17ddfcabd46e9b6c264d3362417efe399f8f0783e10671589bbbf03bb4aed2e0 |
| local-launcher.test.ts，未改 | 60e6a769b48c75084473010cbb59dc489ed59dc8cd9d1171ae87e8d09c812bff |

完整原/新源SHA、旧helper不变hash及边界见同名.json。验证仅使用临时本机HTTP夹具、测试构建及launcher参数/锁检查，真实API/原库/模型/Key/员工文件操作为0；未执行真实browser或service reload。源码于2026-10-06T05:04:34Z冻结，root负责精确reload。
