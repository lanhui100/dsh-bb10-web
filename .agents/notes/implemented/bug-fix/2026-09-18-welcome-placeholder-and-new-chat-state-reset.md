# Agent Note: Welcome Placeholder and New Chat State Reset

Status: implemented

## Problem

在 BlackBerry Q20 Web 界面中存在两处交互体验与状态机问题：
1. **空白对话界面体验不佳**：新建会话或打开无消息会话时，顶部仅简单显示一条左对齐的气泡消息“新对话已就绪，请输入。”（或包含历史占位 `DSH for Blackberry`），不仅侵占顶部阅读空间，而且不符合沉浸式极简设计。用户期望将其改为屏幕正居中展示的品牌探索语“探索未至之境”，并在用户发出第一条消息（或加载有历史消息的会话）后自然消失。
2. **新建对话状态异常显示“正在调用工具”且发送键变成停止键**：当用户点击“+ 新建”开启新会话时，对话框浮窗顶部的 `#status-line` 却异常显示为上一会话遗留的状态（例如“正在调用工具...”），导致输入框发送按钮被渲染为红色停止按钮（`ICON_STOP`）。用户点击该按钮时并未发送消息，而是触发了 `stopStreaming()` 并提示“已手动停止”，只有再次点击时按钮才变回发送图标并真正发出。根本原因是：
   - 之前会话如果在后台执行工具流（或页面初次进入/恢复了后台任务状态），在切换至新空白会话时，`statusLine` 的文本与颜色未被显式重置为“就绪”；
   - 此外，初始挂载或恢复阶段若未清理相关流状态/状态标识，导致状态残留影响后续新会话。

## Decision

1. **居中欢迎占位提示（“探索未至之境”）**：
   - 在 `#chat-container` 内设计专用的居中占位节点 `#welcome-placeholder`，采用绝对居中流式布局（`position: absolute; top: 38%; left: 0; right: 0; text-align: center`），主体文本“探索未至之境”为 32px 加粗（`font-weight: bold`）、暗灰柔和色调（`#666666`），其上方附一行 14px 常规字重的品牌行 `DSH For Blackberry`（`#welcome-brand`，色 `#888888`）。
   - 彻底移除 `startNewChat()` 和 `selectSession('', '')` 中硬编码插入到消息流中的 `appendMessage('assistant', '新对话已就绪，请输入。')` 助手消息气泡；
   - 新增 `updateWelcomePlaceholder()` 辅助函数：当且仅当 `currentSessionId === ''` 且 `allMessages.length === 0` 时展示居中占位；一旦用户发送第一条消息或加载历史消息时，自动移除该占位；
   - 严格遵循 ES5 与经典 CSS 规则，不使用 CSS 变量，确保 BlackBerry 10 WebKit 537 原生平滑渲染。
2. **新建会话状态与按钮彻底复位**：
   - 在 `startNewChat()` 中除了将 `sessState.running = false`、`sessState.phase = 'idle'` 之外，必须显式调用 `setStatus('就绪', 'idle')` 将 `#status-line` 的文本和颜色从先前的任何状态（如“正在调用工具...”）同步复位为“就绪”；
   - 确保 `isStreaming = false` 与 `stopAttach()`，并调用 `renderSendButton()`，保证发送按钮确认为蓝色发送箭头图标，阻断误触 `stopStreaming()`。
   - 在初始 HTML 模版中将 `#chat-container` 内的历史静态占位直接替换为居中占位结构，避免页面初载时闪烁旧气泡。

## Alternatives considered

- *方案 A：继续使用普通的 assistant 消息气泡但居中样式*：这会把“探索未至之境”当作一条真实的对话消息进入 `allMessages` 数组，导致向后端发送消息或计算消息数量时产生脏数据，且无法在用户输入首条消息后干净利落地消失。
- *方案 B：仅在 CSS 中隐藏 status-line*：未解决状态机残留的根因，无法解决发送按钮点两次才生效的问题。
- *方案 C（采纳）：独立 DOM 居中占位 + 统一状态源 reset*：状态清晰解耦，保持与 `dsh web` 语义对齐，符合宪法。

## Consequences

- 用户打开新建会话时，屏幕居中展示“探索未至之境”，呈现优雅沉浸的初态；
- 用户发送第一条消息后居中提示立即消失，消息流从顶部自然展开；
- 新建会话上方状态始终准确显示“就绪”，发送键单次点击即可立刻发送，彻底消除“正在调用工具”与二次点击假象。
