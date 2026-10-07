/**
 * Token statistics fold aligned with dsh token-meter semantics.
 *
 * Authoritative rules (dsh packages/llm/token-meter + ui-chat):
 * - TokenUsage buckets are DISJOINT: `inputTokens` is uncached input only;
 *   cached input rides `cacheReadTokens`/`cacheWriteTokens` separately.
 *   Billed input = uncached + cacheRead + cacheWrite.
 * - Session totals replace (not add) repeated samples for the same
 *   turn+step (tokenUsageProjection addReplacing): streaming/follow
 *   progressive updates never double-count. An `llm/retry-started` event
 *   closes the slot (retry-started seals the old sample into the totals)
 *   so the retried attempt adds to the total instead of replacing it.
 * - Usage source = `data.usage`, falling back to the last embedded
 *   `{type:'usage'}` chunk of `data.stream` (usageOf: message first,
 *   then lastAssistantStreamChunk(stream,'usage')).
 * - pressureFrom = input + cacheRead + cacheWrite (prompt side, no output).
 * - Cache-hit share = cacheRead / billedInput, formatted so a partial hit
 *   never rounds to 100% and zero billed input yields null (row hidden).
 */

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function eventKey(turn, step) {
  return turn + ':' + step;
}

/**
 * Extract one settlement's usage sample from a durable session event.
 * Only assistant settlements carry billable usage (tokenUsageProjection
 * applies to assistant/message + assistant/attempt only).
 * Samples without turn/step coordinates are kept (turn/step undefined)
 * and folded additively so legacy transcripts never silently lose tokens.
 * @param {object} event - durable SessionEvent.
 * @returns {{turn:(number|undefined),step:(number|undefined),usage:object}|null}
 */
export function extractEventUsage(event) {
  if (!event || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')) {
    return null;
  }
  const data = event.data || {};
  const turn = typeof data.turn === 'number' ? data.turn : undefined;
  const step = typeof data.step === 'number' ? data.step : undefined;
  // 对齐 dsh usageOf：message 认 data.usage（回退 stream）；attempt 只走
  // stream（其载荷本无 usage 字段，此处超集容忍畸形 attempt 亦可，见下）。
  let usage = (event.type === 'assistant/message' && data.usage && typeof data.usage === 'object')
    ? data.usage
    : null;
  if ((!usage || typeof usage !== 'object') && Array.isArray(data.stream)) {
    for (let i = data.stream.length - 1; i >= 0; i--) {
      const rec = data.stream[i];
      if (rec && rec.type === 'chunk' && rec.chunk && rec.chunk.type === 'usage' &&
          rec.chunk.usage && typeof rec.chunk.usage === 'object') {
        usage = rec.chunk.usage;
        break;
      }
    }
  }
  if (!usage || typeof usage !== 'object') return null;
  return { turn: data.turn, step: data.step, usage };
}

function bucketsOf(usage) {
  return {
    uncached: toCount(usage.inputTokens),
    output: toCount(usage.outputTokens),
    read: toCount(usage.cacheReadTokens),
    write: toCount(usage.cacheWriteTokens),
  };
}

/**
 * Create a session-total fold with per turn+step replacement.
 * Samples without coordinates fold additively (legacy safety net).
 * @returns {{add(sample:object):void, closeRetrySlot(turn:number,step:number):void, totals():object}}
 */
export function createUsageFold() {
  const slots = new Map();
  // 已关槽样本的封存累计：closeRetrySlot 把槽内旧值搬入 sealed（总数保留），
  // 同槽重试 settlement 重新落槽，全额累加而非替换。
  const sealed = { uncached: 0, output: 0, read: 0, write: 0 };
  // 无坐标样本的加法槽（legacy transcript 兜底，永不静默丢 token）。
  const unkeyed = { uncached: 0, output: 0, read: 0, write: 0 };
  return {
    add(sample) {
      if (!sample || !sample.usage) return;
      const b = bucketsOf(sample.usage);
      if (typeof sample.turn !== 'number' || typeof sample.step !== 'number') {
        unkeyed.uncached += b.uncached;
        unkeyed.output += b.output;
        unkeyed.read += b.read;
        unkeyed.write += b.write;
        return;
      }
      slots.set(eventKey(sample.turn, sample.step), b);
    },
    // 对齐 dsh tokenUsageProjection 的 llm/retry-started 关槽：关闭后同槽的
    // 重试 settlement 做全额累加而非替换（旧值封存入总数，新值重新落槽）。
    closeRetrySlot(turn, step) {
      if (typeof turn !== 'number' || typeof step !== 'number') return;
      const key = eventKey(turn, step);
      const old = slots.get(key);
      if (old) {
        sealed.uncached += old.uncached;
        sealed.output += old.output;
        sealed.read += old.read;
        sealed.write += old.write;
        slots.delete(key);
      }
    },
    totals() {
      let uncached = sealed.uncached + unkeyed.uncached;
      let output = sealed.output + unkeyed.output;
      let read = sealed.read + unkeyed.read;
      let write = sealed.write + unkeyed.write;
      for (const b of slots.values()) {
        uncached += b.uncached;
        output += b.output;
        read += b.read;
        write += b.write;
      }
      return { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
    },
  };
}

/**
 * Sum the three disjoint prompt-side billing buckets (StatsPills billedInputTokens).
 */
export function billedInputTokens(t) {
  return (t.uncachedInputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0);
}

/**
 * Prompt-side pressure of one request: input plus cache traffic, no output.
 */
export function pressureFrom(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return toCount(usage.inputTokens) + toCount(usage.cacheReadTokens) + toCount(usage.cacheWriteTokens);
}

/** Round a cache-read ratio to exact percentage units, positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
  const scale = unitsPerPercent * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    const threshold = factor * denominatorQuotient +
      Math.ceil(factor * denominatorRemainder / doubledScale);
    if (cacheReadTokens >= threshold) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : whole + '.' + tenths;
}

/**
 * Display-ready cache-hit share that never rounds a partial hit to 100%.
 * Port of dsh ui-chat token-format.formatCacheHitPercent.
 * @param {number} cacheReadTokens - exact prompt tokens served from cache.
 * @param {number} promptTokens - exact aggregate prompt (billed input) tokens.
 * @param {0|1} decimalPlaces - ordinary-ratio precision.
 * @returns {string|null} percentage text without '%', or null when no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces) {
  if (decimalPlaces !== 1) decimalPlaces = 0;
  if (!(promptTokens > 0)) return null;
  const missedInputTokens = promptTokens - cacheReadTokens;
  if (missedInputTokens === 0) return '100';

  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1000;
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces);

  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  let nines = '';
  for (let k = 1; k < distinguishingPlaces; k++) nines += '9';
  return '99.' + nines + (10 - roundedLoss);
}
