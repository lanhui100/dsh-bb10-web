/**
 * 授权询问（approval/request）waterfall 的接管决策（纯函数，零副作用）。
 *
 * 决策只依赖三个输入：本任务 sessionId、本任务 $events 流的 clientId、下行帧本身。
 * 结算动作（$events/result）留在 server.mjs —— 本模块不碰网络、不碰计时器，
 * 供 server.mjs 与单元测试共用，保证「接管 / 委托 / fail-closed」判据只有一处。
 *
 * 语义对齐 dsh web：
 *   - foreign：其他会话的授权询问 → 必须 `next` 委托回瀑布，绝不接管；
 *   - skip：畸形/无关帧 → 不接管也不结算（协议噪声）；
 *   - unavailable：本会话询问但 toolName 缺失（无法呈现）→ 按 dsh 授权语义
 *     fail-closed 结算 'unavailable'，绝不静默吞掉；
 *   - claim：生成 task.pendingApproval（eventId/clientId/toolName/callId/reason/
 *     displayReason/delivered/askedAt），delivered 表示 $events 流已 ready、可立即广播。
 */
import { classifyApprovalFrame, normalizeApprovalRequest } from './ask-ownership.mjs';

/**
 * 规划一帧 approval/request 的处置方式。
 * @param {string} taskSessionId 当前任务会话 id（可空，防御态）
 * @param {string} eventsClientId 当前任务 $events 流的 clientId（ready 帧取得，未 ready 为空）
 * @param {unknown} frame $events 下行原始帧
 * @param {number} [now] 接管时间戳（注入以便测试确定性，缺省 Date.now()）
 * @returns {{action: 'claim', pending: object}|{action: 'delegate'}|{action: 'unavailable'}|{action: 'ignore'}}
 */
export function planApprovalWaterfall(taskSessionId, eventsClientId, frame, now) {
  const ownership = classifyApprovalFrame(taskSessionId, frame);
  if (ownership === 'foreign') return { action: 'delegate' };
  if (ownership === 'skip') return { action: 'ignore' };
  const ask = normalizeApprovalRequest(frame.request);
  if (!ask.toolName) return { action: 'unavailable' };
  const clientId = typeof eventsClientId === 'string' ? eventsClientId : '';
  return {
    action: 'claim',
    pending: {
      eventId: frame.eventId,
      clientId: clientId,
      toolName: ask.toolName,
      callId: ask.callId,
      reason: ask.reason,
      displayReason: ask.displayReason,
      delivered: clientId !== '',
      askedAt: typeof now === 'number' ? now : Date.now(),
    },
  };
}
