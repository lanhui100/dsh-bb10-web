# Agent Note: fix-composer-input-session-switch-hijacking

Status: implemented

## Problem

在用户打开输入框新建会话、或者准备发送消息时，若后台有先前或其它正在运行的会话刚好完成并触发完成结算（通过 attachSession 接收到 `done` / `state` 终态事件并调用 `loadHistory(..., sid, null, true)` 静默刷新历史），会导致以下严重缺陷：
1. `loadHistory` 静默刷新会执行 `allMessages = msgs; renderWindowedMessages(...)`，直接将当前视图冲刷为刚完成的旧会话内容，并把当前会话的状态与消息流覆盖；
2. 如果此时用户在输入框已输入了新建会话的文本并敲击回车发送，因为视图和状态已被旧会话污染，发送的消息将直接被当作追加轮次发到了旧会话中，造成严重的对话错乱与输入劫持；
3. 此外，当用户正在输入框编辑草稿（`inputBox.value` 非空）或者输入框正处于展开编辑焦点态（`isComposerOpen`）时，后台轮询或者完成通知如果意外触碰会话上下文，必须具备严格保护屏障，严禁在未获得用户主动切换行为的情况下自动重载历史并劫持输入上下文。

## Decision

1. **在 `loadHistory` 中增加会话归属与活跃状态校验屏障**：
   - 检查请求的历史 `id` 是否仍等于当前的 `currentSessionId`。若当前处于新建会话阶段（`!currentSessionId`）或用户已切换至其他会话（`currentSessionId !== id`），静默收口的响应一律直接丢弃，严禁冲刷全局 `allMessages`、`chatContainer` 与会话状态。
2. **在 attachSession 完成事件触发 `loadHistory` 时做新建/编辑态防护**：
   - 当收到 `done` / `cancelled` / `state` 终态时，仅在 `currentSessionId === sid` 时才允许触发静默 `loadHistory`；
   - 若当前处于新建会话准备态（`!currentSessionId` 且 `isComposerOpen`），attach 监听绝不得反向激活旧会话或重载历史。
3. **在 `doSend` 中确保新建会话的隔离性**：
   - 发送时若处于新建会话状态（`!currentSessionId`），确保请求不会意外附带任何残留的 sessionId；若检测到输入框正处于新建会话态，锁定该发送上下文为全新会话创建，杜绝串入旧会话。

## Alternatives considered

- *方案 A：全局禁用后台会话完成时的 `loadHistory` 刷新*：
  - 缺点：如果用户确实正在当前会话中阅读并等待生成结束，禁用后无法以格式化后的最终历史记录做一致性对齐，体验降级。
- *方案 B：仅通过 `currentSessionId === sid` 防护*（采纳）：
  - 核心逻辑自然且边界清晰：只要用户点了新建会话（此时 `currentSessionId = ''`），任何旧会话后台完成时的事件均无法越权冲刷主视口和消息流，输入框与消息发送绝对隔离。

## Consequences

- 用户在输入框中编辑新建会话内容时，任何后台其他会话完成都不会跳屏打断或冲刷当前界面。
- 发送新建会话消息稳定开辟新会话，彻底消除串入旧会话的风险。
