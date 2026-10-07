/**
 * ask_user_question waterfall 帧归属判定（纯函数，零副作用，供 server.mjs 与单元测试共用）。
 *
 * 背景（对齐 dsh web 协议事实）：
 *   - $events 是 Gateway 全局复用的逻辑流，不是会话隔离流。任何已连接的 client
 *     都会收到「所有会话」的 user-questions/request waterfall 广播（`for (const
 *     client of this.remoteEventClients.values()) this.deliverRemoteEvent(...)`），
 *     且新打开的 $events 流还会立刻收到当前所有 pending 的 waterfall 重放
 *     （`for (const pending of this.pendingRemoteEvents.values()) ...`）。
 *   - 每帧 RemoteEventInvocationFrame 形如
 *     `{ type: 'waterfall', event: 'user-questions/request', eventId, agentId, request }`，
 *     其中 agentId === 提问所属 Agent/Session 的 id（api-remotes 以 `agent.id` 填充，
 *     Gateway 对空 agentId 直接抛 TypeError）。
 *   - 因此每个会话任务（task.sessionId）打开自己的 $events 流后，收到帧必须按
 *     agentId 判定归属：只有与本任务会话一致的提问才能在当前 task 上接管（设置
 *     pendingQuestion 并以 task.sessionId 广播到该会话）；其他会话的提问必须立刻
 *     委托回瀑布（$events/result next），否则会把别人的提问以本会话身份弹出，
 *     且本院落会错误地参与结算/被终态 cancel 击落。
 *
 * @param {string} taskSessionId 当前任务的 sessionId（可空，防御态）
 * @param {unknown} frame $events 下行的原始帧
 * @returns {'own'|'foreign'|'skip'}
 *   - 'own'     本任务会话自己的提问，可安全接管；
 *   - 'foreign' 其他会话的提问，必须立即 `settleUserEvent(task, eventId, {kind:'next'})` 并忽略；
 *   - 'skip'    帧异常/无关（非 waterfall、非 user-questions/request、缺 eventId），直接忽略。
 */
export function classifyQuestionFrame(taskSessionId, frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'skip';
  if (frame.type !== 'waterfall' || frame.event !== 'user-questions/request') return 'skip';
  if (typeof frame.eventId !== 'string' || frame.eventId === '') return 'skip';
  const frameSessionId = typeof frame.agentId === 'string' ? frame.agentId : '';
  // Gateway 保证 agentId 非空；双空/单空的防御态一律按 own 处理（至少不把提问错广播到别的会话）。
  if (frameSessionId !== '' && taskSessionId !== '' && frameSessionId !== taskSessionId) {
    return 'foreign';
  }
  return 'own';
}