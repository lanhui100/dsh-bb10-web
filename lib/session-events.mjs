/**
 * Durable 会话事件 → Q20 SSE 事件派生（delta/thought/tool/usage）。
 * 子进程引擎（SDK session.event 通知）与宿主 RPC 引擎（session/follow 帧）
 * 共用同一解析逻辑：两者承载的都是同一 durable SessionEvent 形状。
 *
 * 时序模型（对齐 dsh ClientAssistantStream + tokenUsageProjection）：
 * - transient chunk（assistant-stream frame）是唯一 delta 源，按 attempt 内
 *   frame.index 连续性校验；
 * - durable settlement 经 fold 按 turn+step 暂存/放行（surfaceOp 非 append、
 *   无坐标、无 seq 直接 publish；重复 seq 直接 ignore）；
 * - usage 结算与暂存解耦：durable 到达即结算，rebaseline 永不丢 usage；
 * - turn/end 到达冲刷暂存走 publish 兜底，held 文本永不丢失；
 * - abandonment 按 attemptId 回滚 transient 文本，不污染 done。
 *
 * 本模块无自由依赖：broadcast/compute/extract/fold/usage 全由 deps 注入，
 * 测试可直驱 handler 交织断言端到端行为（非字符串 grep）。
 */

export function createSessionEventHandler(task, deps) {
  const broadcast = deps.broadcastTaskEvent;
  const computeToolSummary = deps.computeToolSummary;
  const extractToolResultOutput = deps.extractToolResultOutput;
  const extractEventUsage = deps.extractEventUsage;
  const createUsageFold = deps.createUsageFold;
  const pressureFrom = deps.pressureFrom;
  const fold = deps.createStreamFold();

  const state = { accumulatedText: '', toolCallMap: new Map(), seenReasonings: new Set() };

  // durable settlement 的 usage 结算（到达即结算，与暂存/释放解耦）。
  function settleUsage(event) {
    const usageSample = extractEventUsage(event);
    if (!usageSample) return;
    if (!task.usageFold) task.usageFold = createUsageFold();
    task.usageFold.add(usageSample);
    const folded = task.usageFold.totals();
    // 注意：task.usage.inputTokens 为未缓存桶（dsh TokenUsage 原口径）；
    // stats.inputTokens 为计费和（三桶和），同名异义是史前约定，本次不改。
    task.usage = {
      inputTokens: folded.uncachedInputTokens,
      outputTokens: folded.outputTokens,
      cacheReadTokens: folded.cacheReadTokens,
      cacheWriteTokens: folded.cacheWriteTokens,
    };
    // 对齐 dsh token-meter pressureFrom：单次请求 prompt 侧（input+cache，不含输出），
    // 供上下文占用圆环做分子；累计值只供测速/状态面板使用。
    task.lastPressureTokens = pressureFrom(usageSample.usage);
    broadcast(task, 'usage', { ...task.usage, pressureTokens: task.lastPressureTokens });
  }

  // transient frame 入口（对齐 dsh acceptFrame）：chunk 唯一 delta 源。
  // transient 文本记账按 attemptId 分槽，abandonment 可精确回滚，不污染 done。
  const transientByAttempt = new Map();
  function handleAssistantFrame(frame) {
    const decision = fold.acceptFrame(frame);
    if (!decision) return;
    if (decision.type === 'transient' && decision.chunk) {
      const chunk = decision.chunk;
      if (chunk.type === 'text-delta' && chunk.text) {
        state.accumulatedText += chunk.text;
        if (decision.attemptId) {
          transientByAttempt.set(
            decision.attemptId,
            (transientByAttempt.get(decision.attemptId) || '') + chunk.text
          );
        }
        broadcast(task, 'delta', { text: chunk.text });
      } else if (
        (chunk.type === 'reasoning-delta' || chunk.type === 'thinking-delta' || chunk.type === 'thought-delta') &&
        chunk.text
      ) {
        broadcast(task, 'thought', { text: chunk.text });
      }
    } else if (decision.type === 'abandonment' && decision.attemptId) {
      // 中止 attempt 的 transient 文本回滚（对齐 dsh settleAssistant retire）。
      const ghost = transientByAttempt.get(decision.attemptId) || '';
      if (ghost && state.accumulatedText.endsWith(ghost)) {
        state.accumulatedText = state.accumulatedText.slice(0, state.accumulatedText.length - ghost.length);
      }
      transientByAttempt.delete(decision.attemptId);
    }
    // settlement：usage 已在 durable 到达时结算，此处无动作；
    // rebaseline/duplicate：状态保留，turn/end 冲刷兜底。
  }

  // turn/end 到达时冲刷暂存（held 文本永不丢失）：逐条走 publish 兜底。
  function flushHeldSettlements() {
    const flushed = fold.flushPending();
    for (const entry of flushed) {
      publishDurableText(entry.event);
    }
  }

  function handleSessionEvent(event) {
    if (!event || !event.type) return;

    // 0. Steering / User message interjection (in-turn human intervention)
    // 必须仅处理执行中认领的 next-step（插队）消息，严禁将正常轮次开头的 user/message
    // 错误广播为 steer，否则前端会把本地已回显的用户气泡重复渲染一次。
    if (event.type === 'user/message') {
      const data = event.data || {};
      const source = data.source || {};
      const isSteering = (source.kind === 'user' && source.target === 'next-step') ||
                         (data.target === 'next-step');
      if (isSteering) {
        const rawContent = data.content || (data.message && data.message.content) || [];
        let steerText = '';
        if (typeof rawContent === 'string') {
          steerText = rawContent;
        } else if (Array.isArray(rawContent)) {
          for (let ci = 0; ci < rawContent.length; ci++) {
            const part = rawContent[ci];
            if (part && (part.type === 'text' || part.text)) {
              steerText += (steerText ? '\n' : '') + (part.text || '');
            }
          }
        }
        if (steerText) {
          broadcast(task, 'steer', {
            text: steerText,
            time: event.time || data.time || Date.now(),
            seq: typeof event.seq === 'number' ? event.seq : -1,
          });
        }
      }
    }

    // 1. Tool Call
    if (
      event.type === 'tool/call' ||
      event.type === 'tool/execute' ||
      event.type === 'step/tool' ||
      event.type === 'tool/use'
    ) {
      const data = event.data || {};
      const callId = data.callId || data.id || '';
      if (callId && state.toolCallMap.has(callId)) {
        // 同一 callId 工具调用去重（例如 assistant/message content 与 tool/call 冗余派发）
        return;
      }
      const name = data.name || data.tool || '';
      const rawArgs = data.arguments || data.args || data.input || {};
      const summary = computeToolSummary(name, rawArgs);
      const callInfo = {
        name,
        summary,
        args: typeof rawArgs === 'object' ? JSON.stringify(rawArgs, null, 2) : String(rawArgs || ''),
      };
      if (callId) {
        state.toolCallMap.set(callId, callInfo);
      }
      broadcast(task, 'tool', {
        type: 'call',
        name,
        summary,
        callId,
        args: callInfo.args,
      });
    }

    // 2. Tool Result
    else if (event.type === 'tool/result') {
      const data = event.data || {};
      const callId =
        (data.message && data.message.source && data.message.source.callId) ||
        (data.message && data.message.content && data.message.content[0] && data.message.content[0].toolCallId) ||
        data.callId ||
        data.id ||
        '';
      const callInfo = callId ? state.toolCallMap.get(callId) : null;
      const name = data.name || (callInfo && callInfo.name) || '';
      const summary = (callInfo && callInfo.summary) || '';
      const isError = !!data.error ||
        !!(data.message && data.message.content && data.message.content[0] && data.message.content[0].isError) ||
        data.isError === true;
      const output = extractToolResultOutput(data);

      broadcast(task, 'tool', {
        type: 'result',
        name,
        summary,
        callId,
        ok: !isError,
        output,
      });
    }

    // 3. Direct Reasoning / Thinking
    let rawThought =
      (event.data && (event.data.thought || event.data.thinking ||
        event.data.reasoning_content || event.data.reasoning)) ||
      event.thought ||
      event.thinking ||
      event.reasoning_content;

    if (
      !rawThought &&
      (event.type === 'thought' || event.type === 'thinking' || event.type === 'reasoning')
    ) {
      rawThought = (event.data && (event.data.text || event.data.content)) || event.data;
    }

    if (typeof rawThought === 'string' && rawThought.trim()) {
      broadcast(task, 'thought', { text: rawThought });
    }

    // 4. Assistant settlement（对齐 dsh ClientAssistantStream + tokenUsageProjection：
    //    transient chunk 是唯一 delta 源；durable settlement 经 fold 暂存/放行。
    //    usage 结算与暂存解耦：到达即结算，rebaseline 永不丢 usage。
    // 4b. llm/retry-started 关槽：重试的 settlement 全额累加而非替换同槽旧样本
    if (event.type === 'llm/retry-started' && event.data &&
        typeof event.data.turn === 'number' && typeof event.data.step === 'number') {
      if (!task.usageFold) task.usageFold = createUsageFold();
      task.usageFold.closeRetrySlot(event.data.turn, event.data.step);
    }
    if (event.type === 'turn/end') {
      // turn 终结：冲刷暂存（held 文本走 publish 兜底，永不丢失）。
      flushHeldSettlements();
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      // usage 到达即结算（与暂存/释放解耦，上游 usage 投影同构）。
      settleUsage(event);
      const decision = fold.acceptDurable({
        type: event.type,
        seq: typeof event.seq === 'number' ? event.seq : -1,
        turn: event.data && typeof event.data.turn === 'number' ? event.data.turn : undefined,
        step: event.data && typeof event.data.step === 'number' ? event.data.step : undefined,
        surfaceOp: event.surfaceOp,
        event,
      });
      if (decision && decision.type === 'publish') {
        // 无进行中 attempt（SDK 本地路径 / 重连基线 / 非 append 修正）：
        // 回退全文 diff 兜底。
        publishDurableText(event);
      }
      // held：已暂存，不发 delta，等 end/committed 释放或 turn/end 冲刷；
      // duplicate：已释放过的重复 settlement，忽略；
      // rebaseline：状态保留，turn/end 冲刷兜底。
    }
  }

  // durable 全文 diff 兜底（publish 路径 / turn-end 冲刷共用）。
  function publishDurableText(event) {
    if (!event || event.type !== 'assistant/message') return;
    let msgReasoning = '';
    const content = (event.data && event.data.message && event.data.message.content) ||
      (event.data && event.data.content) || [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && (item.type === 'reasoning' || item.type === 'thought' || item.type === 'thinking') && item.text) {
          msgReasoning += (msgReasoning ? '\n' : '') + item.text;
        }
      }
    }
    if (!msgReasoning && event.data && Array.isArray(event.data.stream)) {
      for (const rec of event.data.stream) {
        if (rec && rec.type === 'reasoning-chunks' && Array.isArray(rec.texts)) {
          msgReasoning += (msgReasoning ? '\n' : '') + rec.texts.join('');
        }
      }
    }
    if (msgReasoning && !state.seenReasonings.has(msgReasoning)) {
      if (state.seenReasonings.size > 50) state.seenReasonings.clear();
      state.seenReasonings.add(msgReasoning);
      broadcast(task, 'thought', { text: msgReasoning });
    }

    let fullMsgText = '';
    for (const item of content) {
      if (item && item.type === 'text' && item.text) {
        fullMsgText += item.text;
      }
    }
    if (fullMsgText.length > state.accumulatedText.length) {
      const delta = fullMsgText.slice(state.accumulatedText.length);
      state.accumulatedText = fullMsgText;
      broadcast(task, 'delta', { text: delta });
    }
  }

  return { handleSessionEvent, handleAssistantFrame, state };
}
