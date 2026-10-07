# Agent Note: sess-ws-panel-poll-keepscroll

Status: implemented

## Problem

C 打开会话面板、按 V 切到全工作区聚合视图后，用户滚到底部，约每 5 秒列表被强制拽回顶部：
1. 全局 5s 轮询（`loadSessions(curCwd)` + `refreshRunningWorkspaceSessions`）回包后无条件调用 `renderSessTree()` / `renderWsTree()`，全量 `innerHTML` 重建 DOM，滚动容器（`#sess-panel` / `#ws-panel`）`scrollTop` 丢失；
2. 重绘末尾 `markKbSel()` 无条件对当前选中（或首个会话）行执行 `scrollIntoView(false)`，老旧 WebKit 下将视口拽回该行（通常顶部），与用户手动滚动位置冲突。

## Decision

会话/工作区面板重绘新增滚动保持语义（`static/index.html`，ES5）：
1. 新增 `#sess-panel` / `#ws-panel` 容器引用；`renderSessTree(keepScroll)` / `renderWsTree(keepScroll)` / `renderSessAggregated(mode, curWsName, keepScroll)` 在重建 DOM 前保存 `scrollTop`，`keepScroll` 为真时恢复；
2. `markKbSel(container, idx, allowScroll)` 默认保持原有 `scrollIntoView` 跟随（开面板、J/K 导航不受影响）；后台重绘传 `allowScroll === false` 严禁抢夺视口；
3. 后台链路统一传保持标记：5s 轮询 `loadSessions` 成功分支、`renderSessions()`、`syncSessionPhase()` 的面板同步重绘；用户主动路径（开面板、C/V/J/K/R、归档）保持原跟随行为不变。

## Alternatives considered

1. **轮询期间面板打开时跳过重绘**：实现最简单，但运行态圆点（running/waiting/done）会 stale，用户无法在面板内看到状态流转，违背面板打开即刷新状态标识的既有决策。
2. **防抖/节流轮询重绘（如仅状态变化时重绘）**：需对全工作区聚合做深度 diff，Q20 双核上 diff 开销不亚于重绘，且标题/时间戳微变仍会触发重绘，治标不治本。
3. **改用增量 DOM 更新（只更新变化行）**：改动面大，聚合视图分组/排序/增删行逻辑复杂，回归风险高；当前保存/恢复 scrollTop + 抑制 scrollIntoView 已根治跳顶，增量更新留待后续按需优化。
