/**
 * 人机交互 waterfall 帧归属判定（纯函数，零副作用，供 server.mjs 与单元测试共用）。
 *
 * 覆盖两类同构的宿主瀑布：
 *   - `user-questions/request`（ask_user_question 提问）
 *   - `approval/request`（非完全权限下越界操作的授权询问，如 sandbox 提权）
 *
 * 背景（对齐 dsh web 协议事实）：
 *   - $events 是 Gateway 全局复用的逻辑流，不是会话隔离流。任何已连接的 client
 *     都会收到「所有会话」的 waterfall 广播（`for (const client of
 *     this.remoteEventClients.values()) this.deliverRemoteEvent(...)`），
 *     且新打开的 $events 流还会立刻收到当前所有 pending 的 waterfall 重放
 *     （`for (const pending of this.pendingRemoteEvents.values()) ...`）。
 *   - 每帧 RemoteEventInvocationFrame 形如
 *     `{ type: 'waterfall', event, eventId, agentId, request }`，
 *     其中 agentId === 询问所属 Agent/Session 的 id（api-remotes 以 `agent.id` 填充，
 *     Gateway 对空 agentId 直接抛 TypeError）。
 *   - 因此每个会话任务（task.sessionId）打开自己的 $events 流后，收到帧必须按
 *     agentId 判定归属：只有与本任务会话一致的询问才能在当前 task 上接管（设置
 *     pendingQuestion / pendingApproval 并以 task.sessionId 广播到该会话）；其他会话的
 *     询问必须立刻委托回瀑布（$events/result next），否则会把别人的询问以本会话身份
 *     弹出，且本院落会错误地参与结算/被终态 cancel 击落。
 */

/**
 * 判定一帧 waterfall 是否属于本任务会话。
 * @param {string} taskSessionId 当前任务的 sessionId（可空，防御态）
 * @param {unknown} frame $events 下行的原始帧
 * @param {string} eventName 本函数认领的 waterfall 事件名
 * @returns {'own'|'foreign'|'skip'}
 *   - 'own'     本任务会话自己的询问，可安全接管；
 *   - 'foreign' 其他会话的询问，必须立即 `settleUserEvent(task, eventId, {kind:'next'})` 并忽略；
 *   - 'skip'    帧异常/无关（非 waterfall、非目标事件、缺 eventId），直接忽略。
 */
function classifyWaterfallFrame(taskSessionId, frame, eventName) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return 'skip';
  if (frame.type !== 'waterfall' || frame.event !== eventName) return 'skip';
  if (typeof frame.eventId !== 'string' || frame.eventId === '') return 'skip';
  const frameSessionId = typeof frame.agentId === 'string' ? frame.agentId : '';
  // Gateway 保证 agentId 非空；双空/单空的防御态一律按 own 处理（至少不把询问错广播到别的会话）。
  if (frameSessionId !== '' && taskSessionId !== '' && frameSessionId !== taskSessionId) {
    return 'foreign';
  }
  return 'own';
}

/**
 * ask_user_question（`user-questions/request`）帧归属判定。
 * @param {string} taskSessionId 当前任务的 sessionId
 * @param {unknown} frame $events 下行的原始帧
 * @returns {'own'|'foreign'|'skip'}
 */
export function classifyQuestionFrame(taskSessionId, frame) {
  return classifyWaterfallFrame(taskSessionId, frame, 'user-questions/request');
}

/**
 * 授权询问（`approval/request`）帧归属判定，语义与 {@link classifyQuestionFrame} 完全同构。
 * @param {string} taskSessionId 当前任务的 sessionId
 * @param {unknown} frame $events 下行的原始帧
 * @returns {'own'|'foreign'|'skip'}
 */
export function classifyApprovalFrame(taskSessionId, frame) {
  return classifyWaterfallFrame(taskSessionId, frame, 'approval/request');
}

/**
 * 归一化一条授权询问的可呈现字段（宿主 request 投影：toolName/callId/reason/displayReason）。
 * 只保留线格式允许的字段类型，缺失/畸形一律降级为空串或 null，绝不把原始对象透传给前端。
 * @param {unknown} request waterfall 帧内的 request 载荷
 * @returns {{toolName: string, callId: string, reason: string, displayReason: ({en: string, zh: string}|null)}}
 */
export function normalizeApprovalRequest(request) {
  const req = (request && typeof request === 'object' && !Array.isArray(request)) ? request : {};
  const pick = (key) => (typeof req[key] === 'string' ? req[key] : '');
  let displayReason = null;
  const raw = req.displayReason;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const en = typeof raw.en === 'string' ? raw.en : '';
    const zh = typeof raw.zh === 'string' ? raw.zh : '';
    if (en || zh) displayReason = { en: en, zh: zh };
  }
  return {
    toolName: pick('toolName'),
    callId: pick('callId'),
    reason: pick('reason'),
    displayReason,
  };
}
