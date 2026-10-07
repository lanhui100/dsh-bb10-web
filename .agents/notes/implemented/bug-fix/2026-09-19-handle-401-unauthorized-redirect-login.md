# Agent Note: 遇到 HTTP 401 统一重定向至安全 Token 登录页

Status: implemented

## Problem

在 BlackBerry Q20 客户端运行过程中，当服务端的安全 Token 失效、被吊销或未携带合法 Cookie 导致接口返回 `HTTP 401`（或 `netErrText` 判定为 `401` / `需要安全 Token 认证`）时：
部分接口（例如 `/api/bootstrap`）虽然弹出了登录模态框，但其他高频 API（如会话列表 `/api/sessions`、历史记录 `/api/history`、流式对话 `/api/chat/stream`、追发 `/api/session/prompt` 等）在返回 401 时仅展示了静态红卡或错误提示，并没有立即关闭其他可能遮挡的模态层并直接跳转/唤起安全 Token 登录输入页（`showLoginModal()`），导致用户无法直接重新输入 Token 完成认证恢复。

## Decision

1. 在客户端 `showLoginModal()` 与 `handleUnauthorized()` 中增加防重入与输入保护：
   - 增加 `loginOverlay.style.display === 'block'` 幂等性守卫，避免并发 401 或重复调用时冲刷清空用户已在全键盘输入的 Token 内容；
   - 唤起登录页时主动中止在途推流与长连接（`stopAttach()`、`stopHistory()`、`activeXhr.abort()`），防止残留请求继续震荡；
   - 关闭所有可能处于打开状态的覆盖层与模态框（工作区、会话、模型、权限、状态、快捷短语、帮助、问答等），隐藏输入区和触发按钮，并自动聚焦 Token 输入框。
2. 增加后台轮询认证态守卫：
   - `setInterval(..., 5000)` 轮询增加 `if (!isAuthOk) return;` 守卫，杜绝未登录态下每 5 秒持续产生 401 请求；
3. 纯函数解耦与显式错误分发：
   - 保持 `netErrText(status)` 为纯文本投影函数，不掺杂弹窗副作用；
   - 在所有网络接口失败与对账分支（`recoverOrFailSend`、`loadSessions`、`loadHistory`、`attachSession`、`sendRunningPrompt` 等）显式捕获 401 并调用 `handleUnauthorized()`。

## Alternatives considered

- 方案 A（仅在发送消息失败时弹窗）：无法覆盖会话切换、历史加载、工作区刷新等场景下的 401 状态，体验割裂。
- 方案 B（window.location.reload() 强刷）：在黑莓 Q20 WebKit 537 上整页强刷开销大且丢失前端即时状态，体验卡顿。

## Consequences

- 遇到任意 401 鉴权失效时，客户端均能立即且干净地唤出登录页供用户输入 Token，消灭死锁。
- 严格遵循 ES5 语法规范与黑莓 Q20 硬件交互要求。
