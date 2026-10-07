# Agent Note: Multi-turn error recovery status reset and terminal state precedence

Status: implemented

## Problem

在多轮对话中，若中间某轮发生错误（如上游 429、网络超时或模型报错），后续用户输入（如“继续”或重试）使会话成功恢复并完成，会话底部的状态指示器仍然永久显示为“执行出错”（`status-tail-error`）。

经排查根因有两处：
1. **服务端终态计算未遵循最新轮次优先（Server `sessionTerminalState`）**：在 `server.mjs` 中，计算历史 zstd 尾部状态时使用累加布尔标记（`sawError = true`）。一旦前序轮次的 `turn/end` 包含错误，`sawError` 将永久为 `true`，后续轮次成功产出的 `turn/end`（`completed`）无法清除该标记，导致 `/api/sessions`、`/api/session/attach` 和 `/api/session/stats` 一律错误下发 `state: 'error'`。
2. **客户端状态机闭环缺失（Client `sessState`）**：
   - `static/index.html` 的 `loadHistory` 中，仅在最后一条消息是 `error` 时设置状态，非 `error` 时未重置 `sessState.phase = 'done'` 与 `sessState.lastError = ''`，导致沿用旧错误态；
   - `sendPrompt` 发起新轮次时未清理 `sessState.lastError`；
   - 流式结束与挂载（attach）完成时未彻底清理错误上下文，导致尾部指示器沿用旧错误文本。

相关关联决策：
- 链入 `.agents/notes/implemented/bug-fix/2026-09-18-fix-tool-status-residue-and-align-turn-error-display.md`
- 链入 `.agents/notes/implemented/feature/2026-09-18-chat-tail-session-status-indicator.md`

## Decision

1. **服务端时序化状态推导（Latest Turn Precedence）**：
   - 在 `server.mjs` 的 `sessionTerminalState` 中，按时间线时序遍历尾部事件：当遇到新的轮次起点（`turn/start` / `user/message`）时将候选状态更新为进行中/未结算，遇到 `turn/end` 或 finish chunk 时由该轮次的终态原因（`error` / `aborted` / `completed`）决定当前最新状态。前序轮次的错误不会污染后续已完成轮次。
2. **客户端多轮状态机与指示器闭环**：
   - 在 `static/index.html` 中：
     - `loadHistory` 读取历史后，若末尾消息非错误，显式置 `sessState.phase = 'done'`、清空 `sessState.lastError`，并以最新状态驱动状态条；
     - `sendPrompt` 发送新提问时立即清空 `sessState.lastError` 与 `streamError`；
     - 流式 `done` 及 SSE `attach` 完成处理中，显式同步清理 `lastError` 并收敛至 `done` 态。

## Alternatives considered

- *方案 A：仅在客户端强制覆盖状态，服务端 `sessionTerminalState` 保持不变*。被否决，因为侧边栏会话列表绿点/红点状态由服务端 `/api/sessions` 投影，若服务端判断为 `error`，列表和挂载同步依然会回退回错误态。
- *方案 B：遇到错误轮次后禁止在原会话继续，强制新建对话*。被否决，破坏了多轮对话连续性与容错能力，且脱离 `dsh web` 标准会话流转行为。

## Consequences

- 当对话中间轮次出错而后继续成功时，底部状态栏与尾部状态胶囊及时反映最新成功终态（如 `✓ 会话已完成`），不再残留“执行出错”。
- 服务端对多轮会话的状态投影与 `dsh web` 保持一致，列表状态、挂载同步与统计口径完全以最新轮次为准。
