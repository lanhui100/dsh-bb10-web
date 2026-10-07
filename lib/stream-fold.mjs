/**
 * Q20 SSE 时序 fold：对齐 dsh ClientAssistantStream 的 settlement 语义
 * （packages/api/session-controller/src/client/sessions/assistant-stream.ts），
 * 收敛到 Q20 单通道 SSE 所需的最小面：
 * - transient chunk（assistant-stream frame）是唯一 delta 源，按 attempt 内
 *   index 连续性校验（frame.index 必须等于 nextIndex）；
 * - durable settlement（assistant/message|assistant/attempt，surfaceOp 必须为
 *   append 且 turn/step 均为 number）按 turn+step 暂存，end/committed 才释放；
 * - usage 结算与暂存解耦：acceptDurable 返回 held 时调用方即做 usage 结算，
 *   rebaseline/冲刷永不丢 usage（上游 usage 投影独立于 presentation 暂存）；
 * - rebaseline 只发信号不清状态（与上游同构：不清现场、等基线重建）；
 *   turn/end 到达时调用方用 flushPending() 冲刷暂存走 publish 兜底，
 *   held 文本永不永久丢失；
 * - publishedSeqs 去重：已释放 seq 的重复 durable 直接 ignore；
 *   无 seq（seq<0）的 durable 走独立 legacy 通道，不进 seq 比较。
 *
 * 调用方约定（见 server.mjs createSessionEventHandler）：
 * - acceptDurable 返回 {type:'held'} = 已暂存（调用方做 usage 结算，不发 delta）；
 * - 返回 {type:'publish'} = 无匹配 attempt，调用方走全文 slice-diff 兜底；
 * - acceptFrame 返回 transient → 调用方按 chunk 类型广播 delta/thought；
 *   settlement → 调用方无动作（usage 已在 durable 到达时结算）；
 *   rebaseline → 记日志继续（状态保留，turn/end 冲刷兜底）；
 *   abandonment → 调用方按 attempt 回滚 transient 文本；
 *   duplicate → 忽略。
 */

export function createStreamFold() {
  // 进行中的 attempt：{ attemptId, startedAfterSeq, turn, step, nextIndex }
  let active = null;
  // eventSeq -> settlement entry { type, seq, turn, step, event }
  const pending = new Map();
  // 已释放的 durable seq（去重，重试/重复 settlement 直接 ignore，上限裁剪）
  const publishedSeqs = new Set();

  function isSettlementType(type) {
    return type === 'assistant/message' || type === 'assistant/attempt';
  }

  function markPublished(seq) {
    publishedSeqs.add(seq);
    if (publishedSeqs.size > 200) {
      const oldest = publishedSeqs.values().next();
      if (oldest && typeof oldest.value === 'number') publishedSeqs.delete(oldest.value);
    }
  }

  /**
   * 暂存或放行一条 durable settlement。
   * @param {object} entry - { type, seq, turn, step, surfaceOp, event }
   */
  function acceptDurable(entry) {
    if (!entry || !isSettlementType(entry.type)) return { type: 'publish', entry };
    // 非 append 修正类消息（surfaceOp replace）直接放行，不进暂存（上游同构）。
    if (entry.surfaceOp !== undefined && entry.surfaceOp !== 'append') {
      return { type: 'publish', entry };
    }
    // 无坐标或无 seq：legacy 通道直接放行，不进 seq 比较。
    if (typeof entry.turn !== 'number' || typeof entry.step !== 'number') {
      return { type: 'publish', entry };
    }
    if (typeof entry.seq !== 'number' || entry.seq < 0) {
      return { type: 'publish', entry };
    }
    if (publishedSeqs.has(entry.seq)) return { type: 'duplicate', entry };
    const a = active;
    if (
      a && entry.turn === a.turn && entry.step === a.step &&
      entry.seq > a.startedAfterSeq
    ) {
      if (pending.has(entry.seq)) {
        // 重复 seq 暂存：fail-safe 信号，不清现场（上游 rebaseline 同构）。
        return { type: 'rebaseline' };
      }
      pending.set(entry.seq, entry);
      return { type: 'held', entry };
    }
    return { type: 'publish', entry };
  }

  /**
   * 消费一帧 assistant-stream。
   * @param {object} frame - { type:'start'|'chunk'|'end', ... }
   */
  function acceptFrame(frame) {
    if (!frame || typeof frame !== 'object') return undefined;
    if (frame.type === 'start') {
      if (active || pending.size > 0) {
        // 起始冲突：只发信号不清状态（上游不清现场等 replace() 同构）。
        return { type: 'rebaseline' };
      }
      active = {
        attemptId: frame.attemptId,
        startedAfterSeq: typeof frame.startedAfterSeq === 'number' ? frame.startedAfterSeq : -1,
        turn: frame.turn,
        step: frame.step,
        nextIndex: 0,
      };
      return undefined;
    }
    if (frame.type === 'chunk') {
      const a = active;
      if (!a || a.attemptId !== frame.attemptId) return undefined;
      if (frame.index !== a.nextIndex) {
        // index 断裂：只发信号不清状态，turn/end 冲刷兜底。
        return { type: 'rebaseline' };
      }
      a.nextIndex += 1;
      return { type: 'transient', chunk: frame.chunk, time: frame.time, attemptId: a.attemptId };
    }
    if (frame.type === 'end') {
      const a = active;
      if (!a || a.attemptId !== frame.attemptId) return undefined;
      active = null;
      if (frame.index !== a.nextIndex) {
        return { type: 'rebaseline' };
      }
      const outcome = frame.outcome || {};
      if (outcome.kind === 'abandoned') {
        if (pending.size === 0) return { type: 'abandonment', attemptId: a.attemptId };
        return { type: 'rebaseline' };
      }
      if (typeof outcome.seq !== 'number' || publishedSeqs.has(outcome.seq)) {
        if (typeof outcome.seq === 'number') return { type: 'duplicate' };
        return { type: 'rebaseline' };
      }
      const entry = pending.get(outcome.seq);
      if (!entry || (outcome.eventType && entry.type !== outcome.eventType)) {
        return { type: 'rebaseline' };
      }
      pending.delete(outcome.seq);
      markPublished(outcome.seq);
      return { type: 'settlement', attemptId: a.attemptId, entry };
    }
    return undefined;
  }

  /**
   * 冲刷全部暂存（turn/end 到达时调用）：逐条走 publish 兜底，
   * held 文本永不永久丢失。返回冲刷出的 entry 数组。
   */
  function flushPending() {
    if (pending.size === 0) return [];
    const entries = Array.from(pending.values());
    pending.clear();
    return entries;
  }

  function reset() {
    active = null;
    pending.clear();
  }

  return {
    acceptDurable,
    acceptFrame,
    flushPending,
    reset,
    debugState() {
      return { hasActive: !!active, pending: pending.size, published: publishedSeqs.size };
    },
  };
}
