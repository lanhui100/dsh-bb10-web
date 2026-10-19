# Agent Note: 当前会话详情界面内不再发送状态横幅通知（含浮层覆盖）

Status: implemented

关联：
- [2026-09-18-global-top-banner-notifications](../feature/2026-09-18-global-top-banner-notifications.md)
- [2026-09-18-banner-notification-user-summary-and-overlay-guard](2026-09-18-banner-notification-user-summary-and-overlay-guard.md)（其"浮层覆盖时仍发通知"条款被本条取代）

## Problem

全局顶部横幅（`#top-banner-container`）用于跨会话感知后台会话的 `done` / `error` 终态。但在 720×720 方屏上横幅会下推消息流（`chatContainer.style.top` 数学联动），当用户**已经停留在该会话的详情界面**时，横幅唯一的动作（点击直达该会话）完全冗余。

原实现仅在"当前会话且未打开任何全屏浮层"时抑制：一旦用户打开工作区面板（W）、会话面板（S）、模型面板、状态面板、帮助或提问作答浮层，同一会话的终态仍会弹出横幅——用户始终处于同一会话详情视图，点击横幅不会改变任何目标，只是白白占用顶部高度。

## Decision

1. `static/index.html` 的 `notifySessionComplete`：`sid === currentSessionId` 时**无条件** `return`，删除 `isAnyOverlayOpen` 及 8 个浮层判断，不再区分浮层是否打开。
2. 作用域不变：仅抑制"会话状态横幅"（`done` / `error`）。`running` / `stopped` 过滤、用户主动停止过滤（`userStoppedSessions` + cancel 关键字）、摘要解析、去重、入列与渲染全部原样；跨会话提问横幅（`kind === 'question'`）不受影响。
3. `test-unit.mjs` 2d 契约同步为：当前会话无浮层 `done` 不发；`isSessOpen` 覆盖 `done` 不发；`isWsOpen` 覆盖 `error` 不发；离开详情（`currentSessionId = ''`）后同会话 `done` 仍发（防过度抑制泄漏）。

## Alternatives considered

1. **保留浮层例外，仅在浮层关闭后延迟补发横幅**：浮层关闭后用户回到的仍是该会话详情，横幅依旧冗余，且引入定时器与竞态（Q20 双核旧 WebKit 下徒增复杂度）。
2. **按消息流是否滚到底部（`userScrolledUp`）决定是否通知**：语义模糊——用户在详情页上滑阅读时仍属于详情界面，横幅跳转动作没有价值；且终态重渲染时滚动状态易抖动，判定不稳定。
3. **仅在进入会话时清除该会话遗留横幅（不动 emit 侧）**：只能治历史残留，无法覆盖"浮层打开时新增通知"这一用户实际痛点。

## Consequences

- 当前会话详情界面（含任何浮层覆盖）不再出现该会话的状态横幅，少占顶部 32px 与一次无效跳转；
- 其他会话、后台轮询对账（`checkSessionsStateChanges`）与跨会话提问横幅行为完全不变；
- 门禁：Acorn ES5 解析 PASS；`test-decoupling.mjs` Exit 0；`test-unit.mjs` 35/35 PASS；`test-suite.mjs` 7/7 PASS；红相 commit `477c64a` 在旧实现上真实失败（"Session detail view with overlay open must not produce done banner notification"）。
