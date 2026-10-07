# Agent Note: 修复会话状态及时更新滞后与用户消息重复问题

Status: implemented

## Problem

升级 dsh 新版本后，系统暴露出两个交互与状态同步问题：
1. **用户消息重复**：在对话过程中，用户发送的消息在聊天窗口中被渲染了两次。根本原因在于 `lib/session-events.mjs` 中处理 durable 历史事件 `user/message` 时，无差别将其当作插队消息广播为 `steer` SSE 事件；客户端在收到该事件后通过 `appendMessage('user', data.text)` 再次向聊天流中追加了一条用户消息，而首条用户消息已在发送前置阶段本地回显，造成重复。
2. **会话与列表状态更新不够及时**：会话结束或产生状态变迁时，顶部与会话面板列表的状态变更有明显延迟（需等待下一个后台轮询周期或长达 10s 的缓存失效）。原因有三：
   - 服务端 `hostRunningCache` TTL 设定长达 10s，使得宿主完成生成后，10 秒内 `/api/sessions` 仍然判定会话为 running；
   - 服务端在通过 host rpc 监听到 `turn/end` 终态时未主动使 `hostRunningCache` 失效；
   - 客户端在接收到 `done` 终态事件后未即时触发当前工作区的 `loadSessions(cwd)` 刷新列表。

## Decision

1. **精确识别 Steering 插队消息，消除用户气泡重复**：
   在 `lib/session-events.mjs` 的 `handleSessionEvent` 中收紧判断条件：仅当 `source.kind === 'user'` 且目标明确为 `next-step` 插队认领（`source.target === 'next-step' || data.target === 'next-step'`）时才广播 `steer` 事件，普通轮次的开局消息（`next-turn`）不触发广播，彻底杜绝本地回显与服务端事件的二次重复追加。
2. **加速状态时效性与终态闭环**：
   - 将服务端 `HOST_RUNNING_CACHE_TTL_MS` 从 10s 缩减至 2.5s；
   - 在 `runChatViaHostRpc` 和 `attachHostFollowToSession` 检测到 `turnEnded` 并广播 `done` 时，立即重置 `hostRunningCache = { ids: null, at: 0 }`；
   - 在前端 `static/index.html` 的 `eventType === 'done'` 终态处理分支中，立即显式触发 `loadSessions(cwd)`，实现完成即更新。

## Alternatives considered

- **前端根据文本或时间戳去重用户气泡**：属于表现层补丁，掩盖了服务端错误将所有普通消息泛化为 steer 广播的时序语义错误；否决。
- **完全取消服务端的 hostRunningCache 缓存**：在多会话高频轮询时会导致大量并发 RPC 请求轰击宿主，影响双核环境性能；改用 2.5s 短 TTL 加终态主动失效平衡开销与时效性。

## Consequences

- 用户发送的消息仅在本地回显一次，正常轮次不再重复出现；插队消息（steer）仍按原逻辑在 step 边界正常入流。
- 会话完成或状态变迁时，列表与全局状态指示器即时同步，消除长达 10 秒的状态残留。
- 变更完全遵循 ES5 语法规范，并通过解耦契约门禁、回归套件与全部单元测试。
