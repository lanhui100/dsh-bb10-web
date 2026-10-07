# Agent Note: P0 级关键安全漏洞修复（防崩溃、CORS 收敛、日志脱敏）

Status: implemented

## Problem
在对 `dsh-q20-web`（`server.mjs`）进行红队安全审计期间，发现了以下严重度为 P0 的漏洞：
1. **V2 [Critical/High] 单请求未认证进程崩溃**：
   - 请求处理顶层使用 `new URL(req.url, \`http://${req.headers.host || 'localhost'}\`)`，当外部传入畸形 `Host: [::1` 时抛出 `TypeError`，未被捕捉导致 Node 进程崩溃退出。
   - `parseCookies` 中使用 `decodeURIComponent` 处理 Cookie，当 Cookie 包含非法百分号（如 `Cookie: q20_session=%`）时抛出 `URIError`，同样未被捕捉导致崩溃。
2. **V1 [Critical] 回环免鉴权 + CORS `*` 全局放行**：
   - 所有 API 均无条件返回 `Access-Control-Allow-Origin: *`，且 OPTIONS 预检放行 `Content-Type`。
   - 当本地浏览器访问恶意第三方网站时，恶意网站可通过前端 fetch/xhr 直连 `http://127.0.0.1:3090`，窃取所有会话转录、工作区拓扑，甚至发起 POST 跨站驱动 Agent 执行任意工具。
3. **V5 [High] server.log 明文泄露会话 Cookie 凭据**：
   - `/api/chat/stream` 路由在请求日志中完整打印 `[STREAM REQ HEADERS] ${JSON.stringify(req.headers)}`，导致 64 位十六进制的 `q20_session` 明文记录到本地日志文件中，且日志文件具有全局可读权限（0664）。

## Decision
1. **防崩溃加固（针对 V2）**：
   - 在 `http.createServer` 顶层请求处理函数中，对 URL 解析做安全包装：使用固定的 `'http://127.0.0.1'` 作为 WHATWG URL base，避免未受信任的 `Host` 头注入导致 `TypeError`。
   - 对整个 `http.createServer` 的 async handler 增加外层顶层 `Promise.resolve().catch(...)` 统一错误捕获，并在进程级增加 `process.on('unhandledRejection')` 防止漏网异常击垮服务。
   - 在 `parseCookies` 中，对每个 cookie 键值的 `decodeURIComponent` 增加 `try-catch` 容错，遇非法字符回退为空或原始字符串。
2. **CORS 与跨站防护收敛（针对 V1）**：
   - 移除全局通配的 `Access-Control-Allow-Origin: *`。
   - 仅对合法的受信任 Origin（如 `http://127.0.0.1:*`、`http://localhost:*` 或环境变量指定的允许域）响应 CORS 头，对于跨域来源或未知第三方网页 Origin 拒绝响应 CORS 允许头。
   - OPTIONS 预检响应严格校验请求来源。
3. **日志脱敏与凭据保护（针对 V5）**：
   - 在打印 `[STREAM REQ HEADERS]` 时，对 `cookie`、`authorization` 等敏感头做脱敏掩码处理，仅保留前 4 位或直接过滤。
   - 服务启动时确保 `server.log` 文件权限收敛为 `0600`。

## Alternatives considered
- **完全关闭回环免鉴权**：强制所有本地请求输入 token。但因为 BlackBerry Q20 自动化测试套件（`test-suite.mjs`）和本地开发依赖回环免鉴权（`isLoopbackRequest`），若在本地请求完全关闭免鉴权，将导致所有端到端测试与本地自动化工具中断。收敛 CORS 和阻止未知 Origin 可以从根本上消除恶意网页通过浏览器发起的 CSRF/跨源数据窃取风险，同时保留本地受信开发便利。
- **引入复杂的 WAF / Helmet 中间件**：由于本项目是轻量原生 Node.js（零第三方框架依赖、保持 ES5/兼容性宪法），引入额外的大型依赖库会增加包体积和攻击面，手写安全的 URL/Cookie 解析与 CORS 校验更符合项目的轻量解耦准则。

## Consequences
- 彻底消除了通过恶意 Host / Cookie 单请求直接使服务崩溃的 DoS 风险。
- 本地浏览器打开恶意网站无法再通过 CORS 窃取本地会话或驱动本地 Agent。
- 日志文件不再泄露真实会话 Cookie，提升了多用户共享机器环境下的本地安全性。
