# Agent Note: 归档回初始页时历史加载指示顶替 Logo 且位置错位

Status: implemented

## Problem

BlackBerry Q20（720×720 方屏）上复现：会话归档（`A → Enter`）后回到初始页（`#welcome-placeholder`：Logo + "探索未至之境"，`top: 14%` 居中），随后进入任一会话时，消息流顶部贴边出现一行小字"⏳ 正在读取历史记录..."——用户感知为"初始页面在 Logo 上显示这句"，且位置与欢迎页内容基准完全脱节（顶部贴边 vs 中部居中），体验断裂。

根因在 `static/index.html` 两处：

1. `showHistoryLoading(text)` 先 `chatContainer.innerHTML = ''`（把含 Logo 的欢迎占位节点整个从 DOM 摘除），再以普通流式块（`padding: 24px 12px`，无定位）把指示追加到容器顶部。这与原决策 [2026-09-17-history-lazy-loading-and-archive-loading-state.md](../../feature/2026-09-17-history-lazy-loading-and-archive-loading-state.md) Decision 第 1 条"注入居中高对比度的加载指示卡片"的"居中"要求已漂移。
2. `startNewChat()`（归档成功回调与 `N` 键共用入口）只中止 attach 与 activeXhr，不调 `stopHistory()`——与 `selectSession()` 不对称；在途 `historyXhr` / `earlierHistoryXhr` 泄漏到归档之后，其 `setStatus` 文案可短暂冲刷欢迎页（响应虽被 `sessionSeqToken` 代次屏障丢弃，但 UI 侧已先执行）。

欢迎页展示语义以 [2026-09-18-welcome-placeholder-and-new-chat-state-reset.md](2026-09-18-welcome-placeholder-and-new-chat-state-reset.md) 为准：当且仅当 `!currentSessionId && allMessages.length === 0` 时展示。

## Decision

`static/index.html`（纯 ES5 + 经典 CSS，无服务端改动）：

1. `showHistoryLoading` 增加空白新建态守卫：`!currentSessionId && allMessages.length === 0` 时直接 `updateWelcomePlaceholder()` 并返回，绝不注入历史加载指示——初始页面永远不再出现该句（欢迎页展示条件与上案同构）。
2. 正常进入会话时，加载块改为绝对定位居中：`position: absolute; left/right: 0; top = round(chatContainer.clientHeight * 0.30)px`（像素计算而非百分比，避免相对滚动内容高度失真；约 30% 高度带与欢迎页内容同一视觉基准），还原 2026-09-17 案的"居中"要求。配色字号（`#4EC9B0` / 14px 加粗）与 ⏳ 图标不变。
3. `startNewChat()` 中 `stopAttach()` 之后补 `stopHistory()`，与 `selectSession()` 对称；归档/新建即中止在途历史加载（`selectWorkspace` 未动：代次屏障已兜底，按最小变更原则不动）。

## Alternatives considered

- **进入会话时彻底去掉 loading 指示（永远不展示）**：否决。已被 [2026-09-18-prevent-duplicate-history-loading-on-session-enter.md](2026-09-18-prevent-duplicate-history-loading-on-session-enter.md) Alternatives 方案 A 明确否决——弱网 + 双核 CPU 下首次点开长会话必须有加载反馈；本次只修位置与误现，不删反馈。
- **把加载块叠在欢迎占位之上（两者同时可见）**：否决。进入会话即 `currentSessionId` 已置位，欢迎页按既有语义本就该隐藏；叠加会造成 Logo + loading 双重视觉噪音，且违背上案的展示条件。
- **仅守卫空白态、不改顶部贴边为居中**：否决。用户投诉的第二点就是"位置也不对"；顶部贴边块与欢迎页中部居中内容无视觉连续性，方屏上跳变更生硬。

## Consequences

- 归档回初始页后，Logo 与"探索未至之境"保持干净，绝无历史文案串入。
- 进入会话的加载态落在约 30% 高度中部，与欢迎页内容同带，出消息后自然衔接。
- 通过 ES5 静态门禁（`acorn.parse(script, { ecmaVersion: 5 })` → `ES5 PASS`）；`test-decoupling.mjs && test-suite.mjs` 全量回归。
