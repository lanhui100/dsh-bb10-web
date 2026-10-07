# Agent Note: harden authentication gate and api attack surface defenses

Status: implemented

## Problem

在 `dsh-q20-web` 的安全审计和红队渗透测试中，发现当前认证体系与端点暴露存在以下核心脆弱点：
1. **User-Agent 伪造绕过与安全边界混淆（漏洞1）**：
   - 依赖 `isQ20Client(req)` 检查 `req.headers['user-agent']` 是否包含 `BB10` 与 `AppleWebKit|Safari`。攻击者仅需简单伪造该 User-Agent 即可伪装成合法 Q20 设备。
   - UA 仅仅是一层客户端特征识别，绝对不能作为唯一的认证或安全边界。
2. **高危接口与数据暴露（漏洞4）**：
   - 在未经鉴权或未登录时，高危接口（`/api/workspace/create`, `/api/chat/stream`, `/api/session/*`, `/api/sessions`, `/api/history` 等）若因状态校验不严密，可能导致任意目录创建、跨工作区读会话转录甚至间接命令执行。
   - 前端页面在未登录前若过早发起 `/api/bootstrap` 或允许交互，可能提前暴露工作区目录、会话历史和模型配置；对于非 loopback 访问，若未认证必须只渲染纯净的设备认证登录页。
3. **Session 会话存储缺少主动失效与绝对超时清理**：
   - `validSessions` 仅在查找时做惰性过期检查，缺少定期清理或绝对上限，长时间运行可能产生死状态堆积。
4. **Token 文件安全性与读取时序**：
   - 需确保 `.q20_token` 读取机制安全健壮、去除空白字符干扰，使用恒定时间比较以防御时序侧信道攻击。

## Decision

1. **统一端点强制鉴权拦截网关**：
   - 在 `server.mjs` 中对所有 `/api/*` 请求进行硬性拦截：
     - 白名单仅放行 `/api/auth/login` 与 `/api/auth/status`。
     - 其余所有端点（包括 `/api/bootstrap`, `/api/sessions`, `/api/history`, `/api/session/*`, `/api/workspace/*`, `/api/chat/*` 等）必须通过 `isSessionValid(sessionToken)` 验证。
     - 凡未经鉴权有效 Session 签名的请求一律拒绝并返回 `HTTP 401 Unauthorized`（`{ error: "Unauthorized. Please login first." }`）。
   - 即使请求携带了合法的 Q20 User-Agent，非 loopback 访问在未登录前绝不允许访问任何业务与配置 API。
2. **前端未认证状态隔离与纯净登录渲染**：
   - 页面初始化时首先调用 `/api/auth/status` 检查认证状态。
   - 若未认证（`!authenticated`），立即激活纯净登录覆盖层（`loginOverlay`），同时隐藏所有其他面板与触发按键（隐藏 composer 触发键、快捷键拦截屏蔽所有业务快捷键除 Enter/登录提交外），不向后台发起任何 bootstrap 或 sessions 请求。
   - 登录成功后才拉取 `/api/bootstrap`，解开全套交互。
   - 保证前端所有修改严格符合 ES5 规范，并通过 Acorn 语法静态解析。
3. **安全 Token 校验与时序防范**：
   - Token 文件读取后使用 SHA-256 派生等长哈希摘要（HMAC/Hash Digest），再通过 `crypto.timingSafeEqual` 进行严格等长比较，彻底杜绝长度泄露和字符串时序差异。
4. **Session 生命周期与主动垃圾回收机制**：
   - `validSessions` 引入绝对失效时间（Max Age），并设置定时清理器（定期扫描淘汰过期 session），同时限制内存并发 Session 数量上限（防止内存泛洪）。

## Alternatives considered

- *方案 A：完全基于 Basic Auth 或 HTTP 基础认证*：老旧 BB10 WebKit 在移动端对原生 HTTP 弹窗体验极差，不支持平滑重试和自定义暗色主题样式。
- *方案 B：仅靠 User-Agent 白名单限制访问*：User-Agent 为用户态 HTTP 标头，极易被 curl 或脚本任意伪造，无法充当安全信任锚。
- *方案 C：纯粹惰性清理过期 Session*：随着时间推移，无效 Session 将永久驻留内存，引入内存泄漏隐患。故采用惰性清理与定时扫描回收相结合的策略。

## Consequences

- 所有业务 API 与敏感端点获得统一的强鉴权保护，杜绝未认证访问与敏感信息泄露。
- 伪造 UA 无法越过认证门，外部设备必须且仅能通过专属安全 Token 完成验证后方可获取工作区和交互能力。
- 前端符合黑莓 Q20 WebKit ES5 铁律，全量回归测试保持 PASS。
