# Agent Note: 状态面板会话摘要无标题时回退首条用户消息

Status: implemented

## Problem

`static/index.html` 的 `renderStatusPanel()`（O 键面板会话行）摘要链为 `latestSessionStats.title` → 列表 `sObj.title` → `sid` 前 12 位。服务端无 `title` 且本地已有消息时（如刚发首问、列表未刷新），直接掉到 ID 显示，无法帮助用户在长对话中记住会话目的。同文件横幅路径已有用户消息兜底（`pushBannerNotification` 取用户消息前 30 字），状态面板缺同款兜底。

相关旧条：`.agents/notes/implemented/feature/2026-09-18-session-status-overview-panel.md`（状态面板摘要口径）、`.agents/notes/implemented/bug-fix/2026-09-18-banner-notification-user-summary-and-overlay-guard.md`（横幅用户消息兜底先例）、`.agents/notes/implemented/bug-fix/2026-09-20-q20-directive-suffix.md`（摘要防污染）。

## Decision

在 `renderStatusPanel()` 的 `summaryTitle` 链尾加本地兜底：`title` 均为空时正序扫描 `allMessages` 取首条 `role === 'user'` 文本前 30 字，仍无才回退 `sid.substring(0, 12)`。全 ES5 写法（`var` + `try...catch`），无新增请求，无 DOM 结构变化。

## Alternatives considered

- **逆序取最新用户消息（复用横幅写法）**：横幅要的是触发轮次，状态面板要的是会话目的锚点；长对话中最新消息会漂移，否决。
- **调服务端补拉 title**：本地 `allMessages` 已有首问，多一次请求在 Q20 弱网上得不偿失；否决。
- **首条全气泡常驻（前一轮评估方案）**：破坏窗口化假设，已被 O 面板摘要替代；否决。

## Consequences

- 新会话首问发送后 O 面板即显示首问而非 ID；有 `title` 时路径不变。
- 门禁：ES5 解析 PASS，`test-decoupling.mjs` + `test-suite.mjs` 7/7 PASS。
