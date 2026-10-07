# Agent Note: 发送流传输闪断先对账再画错误卡

Status: implemented

## Problem

R 键发"继续"后，消息流下方偶发红色"网络连接中断，请检查网络后按 R 重试"，但会话实际已在后台运行：POST 流自身断开（`xhr.onerror` / 非 200 收口）被 `doSend` 直接判为任务失败画红卡，而服务端按设计断线保活（`server.mjs` `req.on('close')` 只摘监听、任务照跑），随后轮询又看到 running——"红卡"与"运行中"并存，且红卡永不自动撤回。

链入 `.agents/notes/implemented/bug-fix/2026-09-19-align-stream-status-tail-with-header-icon.md`（状态同源同态）与 `.agents/notes/implemented/bug-fix/2026-09-18-multi-turn-error-recovery-status-reset.md`（多轮错误恢复）。

## Decision

1. 新增 `recoverOrFailSend(cwd, targetSid, sendSeq, promptText, httpStatus, offlineNow)`（`static/index.html`，ES5）：传输层失败后先 GET `/api/sessions` 查权威快照——目标会话仍 `isRunning` 则写回 `sessCache`、回 `running` 相并 `attachSession` 重挂（"连接闪断已重连"），确认为真失败才 `showStreamError` 画红卡。
2. `doSend` 的 readyState 4 非 200 分支与 `xhr.onerror` 改调该函数；`onerror` 补代次/会话归属守卫；`onreadystatechange` 顶部补 `xhr.__aborted` 守卫；四处 `activeXhr.abort()`（`stopStreaming`/`startNewChat`/`selectWorkspace`/`selectSession`）先置 `__aborted`，主动中止永不触发对账或画卡（`stopRequested` 直接收口 `stopped`）。
3. 本机离线（`navigator.onLine === false`）或新会话尚无 sid 时跳过对账、直接画卡，保持原有即时反馈。

## Alternatives considered

- *方案 A：保持立即画卡，仅在重挂成功后移除红卡*：否决。红卡 DOM 无 id/句柄，移除需遍历匹配，弱网抖动下红卡闪现仍干扰；且与"终态粘性"语义冲突。
- *方案 B：服务端为闪断连接保持 SSE 不关闭*：否决。传输层已断，保活的是任务而非连接；重连必须由客户端发起，符合现有 attach 语义。
- *方案 C：失败后固定延时（如 2s）再画卡*：否决。定时器竞态在弱网下仍穿透，且拖慢真失败的反馈；按权威快照裁定才是同源真源。

## Consequences

- 闪断场景：无红卡，状态条经"正在确认"回到运行并重挂直播；真失败场景：红卡与之前一致。
- 门禁：`test-unit.mjs` 会话 FSM 契约新增对账函数与 `__aborted` 守卫断言；ES5 静态门禁保持通过。
