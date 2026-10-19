/**
 * waiting 态判定纯函数（实现；协议指纹冻结，签名由 T1 固定）。
 *
 * 契约来源：.dev-team/contract-wave-2026-10-19.md §C-2（D-2 服务端产出 waiting 事实）。
 * 语义对齐 dsh：`SessionStatus.running` 与 `pendingInteraction` 正交，等待作答时
 * running 仍为 true 且 pendingInteraction.kind==='question'，故 waiting 必须由本工程自行推断。
 *
 * 判定优先级：① task.pendingQuestion（内存真源）→ waiting；② 转录尾部推断 → waiting。
 * 本模块为零副作用纯函数，供 server.mjs（/api/sessions 三处构造点、/api/sessions/status）
 * 与单元测试共用；模块内不得引入 IO、缓存或计时器。
 */

const PENDING_QUESTION_TOOL = 'ask_user_question';

/** 非对象安全取值：事件行可能是对象、JSON 字符串或脏数据。 */
function asEvent(line) {
  if (!line) return null;
  if (typeof line === 'string') {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
      return null;
    }
  }
  return (typeof line === 'object') ? line : null;
}

/** 拼接 content 分片中的文本（数组 / 字符串 / 缺失三种形态）。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!part) continue;
    if (typeof part === 'string') {
      text += (text ? '\n' : '') + part;
      continue;
    }
    if (typeof part.text === 'string' && (part.type === 'text' || !part.type)) {
      text += (text ? '\n' : '') + part.text;
    }
  }
  return text;
}

/** 事件的候选内容容器：data.content / data.message.content。 */
function eventContent(event) {
  const data = (event.data && typeof event.data === 'object') ? event.data : {};
  if (data.content !== undefined && data.content !== null) return data.content;
  if (data.message && typeof data.message === 'object') return data.message.content;
  return null;
}

/**
 * 归一化用户文本：`/\s+/g → 单个空格` 再 trim。
 * 供排队槽与已认领 prompt 的相等/前缀匹配使用（§C-1 归一化规则）。
 *
 * @param {string} text 原始文本（发送原文或来自转录气泡）
 * @returns {string} 折叠空白后的 trimmed 文本
 */
export function normalizeUserText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 取 user/message 事件的用户文本：拼接 content 中文本分片，无文本视为空串。
 *
 * @param {unknown} event 单条 durable 转录事件（形如 `{ type:'user/message', content:[...] }`）
 * @returns {string} 用户原文（未归一化）
 */
export function eventUserText(event) {
  const e = asEvent(event);
  if (!e) return '';
  const text = contentText(eventContent(e));
  if (text) return text;
  const data = (e.data && typeof e.data === 'object') ? e.data : {};
  if (typeof data.text === 'string') return data.text;
  if (typeof e.text === 'string') return e.text;
  return '';
}

/**
 * 取事件文本（契约 §C-2 原始命名，与 eventUserText 同义）：
 * 用户事件取用户原文，工具事件取可读摘要文本。
 *
 * @param {unknown} event 单条 durable 转录事件
 * @returns {string} 可读文本
 */
export function normalizeEventText(event) {
  const e = asEvent(event);
  if (!e) return '';
  if (e.type === 'user/message') return eventUserText(e);
  const data = (e.data && typeof e.data === 'object') ? e.data : {};
  const think = eventUserText(e);
  if (think) return think;
  // 工具事件：name + 参数摘要（足够可读，且不引入 IO）
  const name = (typeof data.name === 'string' && data.name)
    || (typeof data.tool === 'string' && data.tool)
    || '';
  const args = data.arguments !== undefined ? data.arguments : (data.args !== undefined ? data.args : data.input);
  if (!name && args === undefined) return '';
  let argsText = '';
  if (typeof args === 'string') argsText = args;
  else if (args !== undefined && args !== null) {
    try { argsText = JSON.stringify(args); } catch { argsText = ''; }
  }
  return normalizeUserText(name + (argsText ? ' ' + argsText : ''));
}

/** tool/call 的 callId：兼容 data.callId 与根级 callId（及 data.id 退化口径）。 */
function callIdOf(event) {
  const data = (event.data && typeof event.data === 'object') ? event.data : {};
  const candidates = [data.callId, event.callId, data.id, event.id];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return '';
}

/** tool/result 结算的所有候选 callId（生产口径 + 扁平口径 + content 口径）。 */
function resultCallIds(event) {
  const data = (event.data && typeof event.data === 'object') ? event.data : {};
  const ids = [];
  const push = (v) => { if (typeof v === 'string' && v) ids.push(v); };
  const message = (data.message && typeof data.message === 'object') ? data.message : null;
  if (message) {
    if (message.source && typeof message.source === 'object') push(message.source.callId);
    push(message.callId);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue;
        push(part.toolCallId);
        push(part.callId);
      }
    }
  }
  push(data.callId);
  push(data.toolCallId);
  push(data.id);
  if (Array.isArray(data.content)) {
    for (const part of data.content) {
      if (!part || typeof part !== 'object') continue;
      push(part.toolCallId);
      push(part.callId);
    }
  }
  return ids;
}

/**
 * 从转录事件行判定是否存在未结算的提问：
 * 存在 `type==='tool/call'`、`name==='ask_user_question'` 的调用，且其 callId
 * 没有对应的 `tool/result` 结算 → true；已结算或无提问 → false。
 *
 * @param {unknown[]} lines 转录事件对象数组，或 JSON 行字符串数组
 * @returns {boolean} 是否等待用户作答
 */
export function hasPendingQuestionFromEvents(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  const pending = new Set();
  let anonymous = 0;
  for (let i = 0; i < lines.length; i++) {
    const event = asEvent(lines[i]);
    if (!event) continue;
    if (event.type === 'tool/call') {
      const data = (event.data && typeof event.data === 'object') ? event.data : {};
      const name = (typeof data.name === 'string' && data.name) || (typeof event.name === 'string' && event.name) || '';
      if (name !== PENDING_QUESTION_TOOL) continue;
      const callId = callIdOf(event);
      // 无 callId 的提问调用不可能被结算，按未结算处理（契约 §C-2 字面口径）。
      if (callId) pending.add(callId);
      else anonymous += 1;
      continue;
    }
    if (event.type === 'tool/result') {
      for (const id of resultCallIds(event)) pending.delete(id);
    }
  }
  return pending.size > 0 || anonymous > 0;
}
