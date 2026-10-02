# 浏览器和 MCP：最小可用版

工作台的「工作能力」提供独立浏览器会话及外部 MCP 工具连接。员工使用时，还必须在部门员工和项目批准方案里启用对应工具，并限定站点或连接；只有在运行租约有效、项目未取消时才能调用。

## 浏览器

- 需要安装 Chrome、Edge 或 Chromium。服务器通过 `playwright-core` 启动独立无痕上下文；不读取个人浏览器配置、Cookie 或登录状态。也可通过 `BROWSER_EXECUTABLE_PATH` 指定浏览器可执行文件。
- 页面地址和允许站点分别填写。允许站点必须是完整 origin，例如 `https://example.com`；路径、账号密码和通配符不被接受。页面导航及所有资源请求都检查 origin。
- 支持打开地址、读取正文（最多 40,000 字符）、1280 × 800 截图、根据选择器点击和填写元素。操作只作用于该隔离会话。
- 最小版采用静态页面模式：HTTP 重定向、JavaScript、Service Worker、下载、新窗口和非 GET/HEAD 请求禁用。请使用最终页面地址；资源超过 4 MiB 不会交给页面。重定向被禁用是为了避免浏览器在跳转链中绕过请求拦截。依赖 JavaScript 的网站和登录/付款/发帖等写入流程不在此版本范围。仅限制 HTTP 方法不能证明远端 GET 操作没有副作用，因此只授权可信且适合读取的站点。
- 同时最多 6 个会话；空闲 10 分钟后关闭；重启不会恢复浏览器会话。
- 员工工具 `browser_read({url})` 只读取冻结在 `agent.browserOrigins` 内的站点，每次使用新的上下文，用后关闭。员工不能点击、填写或扩大站点范围。页面内容以 `untrusted_web_content` 标记，作为资料而非指令。

## MCP

1. 填写完整 MCP 服务地址，例如 `https://example.com/mcp`，以及可选 Bearer 密钥。远程必须为 HTTPS；本机 `localhost` / `127.0.0.1` / `[::1]` 可以使用 HTTP。地址不接受用户密码、查询参数或片段。
2. 保存后点「获取工具列表」。客户端完成初始化、发送 initialized 通知，再列出工具，支持最多 5 页、100 个工具。
3. 手动测试时选择工具、填写 JSON 参数，核对后勾选并点「执行工具」。该操作可能改变外部系统；未标记只读的工具仅能通过用户手动操作调用。
4. 员工自动调用需要三重一致：连接配置中授权原部门员工和具体工具；批准方案 `agent.mcpConnections` 冻结连接 ID、版本、工具列表；运行时再次校验当前配置和服务的只读提示。原部门通过 `sourceDepartmentId + sourceAgentId` 区分，同名员工不能共用授权。修改或停用连接后旧批准方案失效，需要重新核对并批准。

密钥使用现有 AES-GCM 凭证库加密，API 不返回密钥；服务在正常结果中回显的密钥也会被遮盖。MCP 错误响应正文不会透传。每次 HTTP 请求有 15 秒超时、1 MiB 响应上限，重定向被禁用；结果不明时不会自动重试写入操作。

当前协议固定为 **2025-03-26 Streamable HTTP**，支持 JSON 以及 POST 返回的 SSE，初始化后带会话 ID，完成后尝试结束服务端会话。服务必须接受此协议版本。不支持 stdio、旧 HTTP+SSE 双端点、OAuth、资源订阅、断线重放、服务端采样/elicitation 请求。客户端不执行服务器请求。只读提示由服务器提供，并非安全保证；请只连接可信 MCP 服务，并逐项授权工具。

MCP 配置持久保存于 `mcp_connections`；服务会话不持久化。员工调用返回 `untrusted_mcp_content`，不能作为扩大权限或修改任务的指令。

## 验证

`npm run test:integration -- tests/browser-mcp.test.ts`：8 项通过（2026-10-02），包括真实隔离 Chrome 的打开/读取/填写/点击/截图，以及 JavaScript 和 POST 阻断；MCP JSON/SSE 初始化、密钥不回显、加密存储、超限/异常响应、连接版本、原部门身份隔离、活动租约、取消和手动调用确认均使用本地测试服务验证。没有连接真实 MCP 账户或发送付费模型请求。

`node --test services/agent-runtime/browser-mcp-runtime.test.mjs`：真实 ProductDshRuntime 的独立员工领取任务后，经宿主调用两个外部工具，收到结果并完成任务，确认运行编号、员工身份、取消信号和审计事件贯穿调用链。模型为本地固定测试服务。

实现依据：[MCP Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)、[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)。
