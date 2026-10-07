# Agent Note: ask_user_question 跨会话串扰隔离（$events agentId 归属判定）

Status: implemented

## Problem

上报现象：会话 A 的 `ask_user_question` 提问出现在会话 B 的界面上，且当用户在正确会话（A）作答后，会话 B 里的提问面板被"自己关掉"。

相关前置决策：`.agents/notes/implemented/feature/2026-09-18-ask-user-question-bridge-and-composer.md`（Q20 侧 `$events` waterfall 桥的原始设计，含"任务期挂载 + 挂起请求由网关排队补投递"的取舍）与 `.agents/notes/implemented/bug-fix/2026-09-21-ask-multi-session-isolation.md`（前端单例面板的多会话草稿分槽/重放过滤/跨会话标黄横幅）。本次是补上两者共同假设之上的**服务端根因缺口**：前一条设计假设"每个任务挂载的 `$events` 流只携带本会话提问"，后一条的跨会话横幅分支也因此从未在服务端广播路径上真正生效（广播的 sessionId 已被错误改写成本会话）。

根因（dsh 协议事实，两处共同作用）：

1. `$events` 是 Gateway **全局复用**逻辑流，不是会话隔离流。Gateway 把每个
   `user-questions/request` waterfall 广播给**所有**已打开的 `$events` client
   （`for (const client of this.remoteEventClients.values()) this.deliverRemoteEvent(...)`），
   并且**新打开**的 `$events` 流会立刻收到当前全部 pending waterfall 的重放
   （`for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`）。
   帧格式 `RemoteEventInvocationFrame = { type: 'waterfall', event, eventId, agentId, request }`，
   其中 `agentId === agent.id === 提问所属 SessionId`，Gateway 对空 agentId 直接抛 TypeError。
2. `server.mjs` 的 `handleUserEventsItem(task, v)` 按每个会话任务（task.sessionId）各开一条
   `$events` 流，但 waterfall 分支**完全不看 `v.agentId`**：任何会话的提问都会被当前任务接管——
   设置 `task.pendingQuestion`、以 `task.sessionId` 广播 `question` SSE。于是：
   - 会话 B 的任务把会话 A 的提问以 `sessionId: B` 广播，前端误判为本会话提问而弹出全屏面板；
   - 本院落错误地留在 Gateway 该 event 的 `pending.deliveries` 里：用户在其他会话（A/DSH Web）
     作答后，Gateway 结算并以 `cancel` 帧通知剩余 deliveries，本任务匹配 `eventId` 后广播
     `cancelled`，恰好表现为"在正确会话作答后，另一个会话里的提问被关掉"；
   - 若用户在错误的会话 B 作答，还会用 B 的答案错误结算 A 的提问（跨会话篡改 upstream waterfall）。

对照 dsh web 客户端：其单个页面只开一条 `$events` 流，`ui-user-questions`
经 `ctx.remote.$on` 回调里 `resolve(frame.agentId)` 解析归属 Context，`scopeOf(owner)`
拿不到匹配会话时直接 `next()` 委托——即 dsh web 自己的消费端始终按 agentId 判归属。

## Decision

新增纯函数判定模块 `lib/ask-ownership.mjs`：`classifyQuestionFrame(taskSessionId, frame)`
对 waterfall 帧按 `agentId` 判归属，返回 `'own' | 'foreign' | 'skip'`（Gateway 保证
agentId 非空；双空/单空防御态不判 foreign）。`server.mjs` 的 `handleUserEventsItem` waterfall
分支在接管前先判定：

- `'foreign'`：其他会话的提问，立即 `settleUserEvent(task, eventId, { kind: 'next' })`
  委托回瀑布（本院落从 deliveries 退出，让真正属主会话或 DSH Web 应答），
  **绝不**设置 `pendingQuestion`、**绝不**向当前会话广播；
- `'skip'`：无关/畸形帧，直接忽略；
- `'own'`：才走原有接管路径（设 pendingQuestion + 广播）。

配套前端加固（`static/index.html`）：

- `showQuestionPanel` 的跨会话分支横幅携带 `eventId`，去重按 `id+kind+eventId`，
  终态可精确匹配移除，同会话新题不误删旧题横幅；
- `handleQuestionEvent` 终态处理改为：先按 `sessionId + eventId` 与本面板提问严格匹配
  （命中才收面板、清草稿、`syncSessionPhase` 当前会话），随后按 `eventId` 精确移除
  该会话的提问横幅、清除已结算的草稿槽，并把会话列表/树的 `waiting` 态复位——
  非当前会话的终态绝不触碰 `sessState`（`syncSessionPhase` 只可用于当前会话视图）。

## Alternatives considered

- 仅在前端把"request 是否属于当前会话"再挡一层：不充分。错误归属发生在服务端
  （task.sessionId 广播、pendingQuestion 错误挂载、错误参与结算），前端无法自证
  sessionId 真实性，也无法阻止 `$events/result` 用错误会话的 clientId 结算。
- 服务端在 `runChatViaHostRpc`/`attachToHostSessionStream` 之间共享一条 `$events` 流并按
  eventId 分发：改动面大、引入跨任务共享状态，且每条 WebSocket 独立 clientId 的
  结算语义会变得复杂；判定函数 + 每任务独立流已经是 Gateway 原生意愿（每个 client
  各答各的 `next`/`result`）。
- 对 foreign 帧不做任何回应（不调 next）：否决。本院落会一直留在 `pending.deliveries`，
  属主应答后仍会被 cancel 击落，串扰依旧；显式 `next` 是 dsh Gateway 规定的
  "该 client 不接此 waterfall" 的退出姿势。

## Consequences

- 会话 A 提问时，会话 B 的前端最多收到一条带正确 `sessionId(A)` 的 banner + 会话标黄
  （原有跨会话 UX，代码路径现在才真正可达），不再弹全屏面板；在 A 或其他客户端作答后，
  B 侧横幅/等待态按 eventId 精确清除，不再出现"被别的会话的问题接管又莫名关闭"。
- 多个 Q20 会话并发或 attach 接管期间，外来提问一律 `next` 委托，不会污染任何
  非属主会话的 pendingQuestion 与结算路径；`2026-09-21-ask-multi-session-isolation` 的
  草稿分槽/重放过滤/建桥迁移决策仍有效，未被本次替代。
- 回归：`node test-decoupling.mjs` PASS；`node test-unit.mjs` 31/31 PASS（新增
  `ask_user_question Cross-Session Isolation (classifyQuestionFrame)` 契约）；
  `node test-suite.mjs` 7/7 PASS；`static/index.html` ES5 静态解析 PASS。