# Agent Note: 运行中追发消息底部停靠区隔离

Status: implemented

## Problem

此前运行中追发（`queue`/`steer`）以灰泡或深橙泡直接落入消息流 `chatContainer` 并推入客户端 `allMessages` 数组（见 [2026-09-20-running-send-queued-grey-bubble.md](2026-09-20-running-send-queued-grey-bubble.md) 与 [2026-09-21-steer-dark-orange-bubble-redteam.md](2026-09-21-steer-dark-orange-bubble-redteam.md)）。
这导致排队消息过早混入消息流中，与“实际未开始执行、仅在排队待办”的真实状态脱节；在上游 DSH Web 规范中，Queue 对应独立的 `QueueDock`，Steer 对应底部的 `pendingSteering` 表面，均不作为已提交文本进消息流，只有在真正被模型认领执行并记录到历史后才入流。

## Decision

在 `static/index.html`（严守 ES5、静态 HEX 与无 CSS 变量原则）中实施全面隔离与对抗调优：

1. **从消息流彻底剥离**：
   - 运行中 `sendRunningPrompt` 不再调用 `appendMessage`，不将排队消息放入 `allMessages`，消息流中绝不生成任何占位气泡。
2. **新增底部独立停靠区 `#queue-dock`**：
   - 采用经典绝对定位贴底（`bottom: 0`，右侧 `padding: 60px` 规避悬浮 💬 按钮）；
   - 通过 `updateChatContainerBottom()` 联动调整 `chatContainer.style.bottom` 避免内容被遮挡；
   - 纯文本单行防爆：使用 `escapeHtml` 并限制最大 50 字符预览，杜绝大段 Markdown 或代码块撑爆方屏。
3. **撤回与生命周期收口**：
   - 快捷键 `Z` 或点击停靠条内的“撤回 [Z]”触发 `/api/session/queue/remove`；
   - 增加 `isRevokingQueued` 防重锁，防御连续快速按击 `Z` 导致的假性并发冲突；
   - 增加 `currentSessionId === sid` 屏障与 `xhr.onerror` 传输兜底，防跨会话污染与网络断开导致的状态悬挂；
   - 新建会话、切换工作区、切换会话、快照同步 `sync`、历史重载 `loadHistory`、终态 `done`/`cancelled`/`error` 统一由 `clearQueueDock()` 清空，排队消息在下一轮产生或历史消息刷新时自然由真实历史接管。

## Alternatives considered

- **保留消息流内灰泡仅置于最底部**：虽在视觉末端，但仍混入了消息流与 `allMessages` 数据流，重绘或回放时易造成轮次切片混乱；否决。
- **沿用完整 `formatContent()` 渲染停靠条**：用户输入大段代码块或表格时会导致底部区域垂直撑满方屏，遮盖对话；否决，改为单行纯文本防爆。
- **全量引入上游完整复杂多条队列组件**：Q20 双核 1.5GHz CPU 与 720×720 方屏空间紧缺，引入多层展开折叠列表开销过大；否决，选用紧凑高效的单行停靠条配合 Z 键即时撤回。

## Consequences

- 排队消息在真正发出/执行前完全隔离在底部停靠区，不再污染消息流与数据数组。
- Red Team 对抗审计发现的 4 项隐患（防重锁、单行纯文本防爆、跨会话污染过滤、传输层 onerror 兜底）全数修复并达标。
- 门禁验证全通：Acorn ES5 静态解析通过，`test-decoupling.mjs` 与 `test-unit.mjs` 25 项全绿。
