/**
 * Q20 宿主 $events 权威状态镜像（进程内内存，唯一新增模块）。
 *
 * 唯一契约来源：.dev-team/contract-wave-2026-10-16.md
 *   - §1.1  冻结签名 createHostLiveState(opts) 与事件映射表
 *   - C-4   running 真源优先级：live 事件镜像 > session/list 快照 > 本地 activeTasks
 *   - C-12  api-session/added 的 SessionSummary 无顶层 title：
 *           title = summary.title || summary.projections.values.title；
 *           projections.values.subagentCatalog / agentTeam 一并入镜像（子智能体兜底）
 *   - C-14  连接 / 断开 / 每次重连各打一行 `[HOST-LIVE]` 可 grep 日志
 *   - C-16  Q20_MOCK_HOST=1 时不建真实 WS（调用方不注入 transport，start() 安全 no-op），
 *           真源由调用方按 §1.4 接缝同步播种
 *
 * 本模块**绝不发起任何宿主 RPC / 磁盘 IO**：只消费被喂进来的事件与快照，
 * RPC 与订阅传输由调用方（server.mjs）负责注入。
 */

/** 指数退避：1s → 2s → 4s … 上限 30s（契约 §4 / C-14）。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
/**
 * 连接稳定窗口：连接存活满该时长才把退避计数归零。
 * 否则「连上即断」的抖动链路会永远停在 1s，退避永不升级（与 C-14「1s→2s→…→30s」相悖）。
 */
const BACKOFF_RESET_AFTER_MS = 30000;
/**
 * 建连双重保险（L3-P finding 1）：TCP 已连但 upgrade 无响应时，ws 不会触发
 * open/error/close，订阅会永久静默死亡。① 交给 ws 的 handshakeTimeout；
 * ② 自持 open 看门狗，超时 terminate 并走 scheduleReconnect('open-timeout')。
 */
const HANDSHAKE_TIMEOUT_MS = 10000;
const OPEN_WATCHDOG_MS = 12000;
/** 与 Gateway 冻结常量一致：$events 逻辑流 + 精确空 args 载荷。 */
const EVENTS_STREAM_ENDPOINT = '$events';
const EVENTS_STREAM_PAYLOAD = { args: {} };

/** 新建一行镜像事实（默认值即「无权威事实」时的保守值）。 */
function blankRow(sessionId) {
  return {
    sessionId: sessionId,
    running: false,
    agentAvailable: false,
    parentSessionId: '',
    origin: '',
    cwd: '',
    title: '',
    updatedAt: 0,
    subagentCatalog: [],
    agentTeam: null,
  };
}

/** C-12：SessionSummary 的标题口径（顶层 title 优先，否则 projections.values.title）。 */
function summaryTitle(summary) {
  if (!summary || typeof summary !== 'object') return '';
  if (typeof summary.title === 'string' && summary.title) return summary.title;
  const vals = summary.projections && summary.projections.values;
  if (vals && typeof vals.title === 'string' && vals.title) return vals.title;
  return '';
}

function toText(value) {
  return (value === undefined || value === null) ? '' : String(value);
}

/**
 * 创建宿主 live 状态镜像。
 *
 * @param {{
 *   log?: (msg: string) => void,
 *   WebSocketImpl?: any,
 *   url?: string,
 *   headers?: Record<string, string>,
 *   onWaterfallDecline?: (info: { clientId: string, eventId: string, event: string }) => void,
 * }} [opts] 未注入 WebSocketImpl/url 时 start() 为安全 no-op（mock 模式）。
 *   onWaterfallDecline（C-23）：每条 waterfall 帧必须回调一次，语义为「本 client 不认领，委托回瀑布」。
 * @returns {{
 *   noteEvent: (event: string, args?: any) => void,
 *   noteListItems: (items: any) => number,
 *   getSession: (sid: string) => any,
 *   getRunningIds: () => Set<string>,
 *   hasRunningTruth: (sid?: string) => boolean,
 *   listChildren: (parentId: string) => any[],
 *   start: () => boolean,
 *   stop: () => void,
 *   getSource: (sid: string) => string,
 *   listAll: () => any[],
 *   isStarted: () => boolean,
 * }}
 */
export function createHostLiveState(opts = {}) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const log = (typeof options.log === 'function') ? options.log : () => {};
  const WebSocketImpl = options.WebSocketImpl || null;
  const url = (typeof options.url === 'string') ? options.url : '';
  const headers = (options.headers && typeof options.headers === 'object') ? options.headers : {};
  const onWaterfallDecline = (typeof options.onWaterfallDecline === 'function') ? options.onWaterfallDecline : null;

  /** sid -> 事实行 */
  const sessions = new Map();
  /** sid -> { source: 'live'|'list', at: number }：是否持有权威 running 事实 */
  const truth = new Map();

  let started = false;
  let socket = null;
  let reconnectTimer = null;
  let reconnectCount = 0;
  let backoffAttempts = 0;
  let stabilityTimer = null;
  let openWatchdog = null;
  let streamId = '';
  let connectedOnce = false;
  /** $events 事件代际 clientId（来自 ready 帧；C-23 回 $events/result 必需）。 */
  let clientId = '';

  function ensureRow(sessionId) {
    let row = sessions.get(sessionId);
    if (!row) {
      row = blankRow(sessionId);
      sessions.set(sessionId, row);
    }
    return row;
  }

  function markTruth(sessionId, source) {
    truth.set(sessionId, { source: source, at: Date.now() });
  }

  /** C-12：把一条 SessionSummary 的全字段 upsert 进行内。 */
  function applySummary(row, summary) {
    if (!summary || typeof summary !== 'object') return;
    if (summary.running !== undefined) row.running = !!summary.running;
    if (summary.agentAvailable !== undefined) row.agentAvailable = !!summary.agentAvailable;
    if (summary.parentSessionId !== undefined) row.parentSessionId = toText(summary.parentSessionId);
    if (summary.origin !== undefined) row.origin = toText(summary.origin);
    if (summary.cwd !== undefined) row.cwd = toText(summary.cwd);
    const title = summaryTitle(summary);
    if (title) row.title = title;
    if (typeof summary.updatedAt === 'number' && summary.updatedAt > 0) row.updatedAt = summary.updatedAt;
    const vals = summary.projections && summary.projections.values;
    if (vals && typeof vals === 'object') {
      if (Array.isArray(vals.subagentCatalog)) row.subagentCatalog = vals.subagentCatalog;
      if (vals.agentTeam && typeof vals.agentTeam === 'object') row.agentTeam = vals.agentTeam;
    }
  }

  /** live 事件已定稿的行：只补空缺的描述性字段，绝不覆盖更新过的 live 事实（C-4）。 */
  function fillMissing(row, summary) {
    if (!summary || typeof summary !== 'object') return;
    if (!row.title) {
      const title = summaryTitle(summary);
      if (title) row.title = title;
    }
    if (!row.cwd && summary.cwd) row.cwd = toText(summary.cwd);
    if (!row.parentSessionId && summary.parentSessionId) row.parentSessionId = toText(summary.parentSessionId);
    if (!row.origin && summary.origin) row.origin = toText(summary.origin);
    if (!row.updatedAt && typeof summary.updatedAt === 'number' && summary.updatedAt > 0) {
      row.updatedAt = summary.updatedAt;
    }
    const vals = summary.projections && summary.projections.values;
    if (vals && typeof vals === 'object') {
      if ((!Array.isArray(row.subagentCatalog) || row.subagentCatalog.length === 0) && Array.isArray(vals.subagentCatalog)) {
        row.subagentCatalog = vals.subagentCatalog;
      }
      if (!row.agentTeam && vals.agentTeam && typeof vals.agentTeam === 'object') row.agentTeam = vals.agentTeam;
    }
  }

  function extractArgs(args) {
    if (Array.isArray(args)) return args;
    if (args && typeof args === 'object' && Array.isArray(args.args)) return args.args;
    return [];
  }

  /** §1.1 事件映射（未知事件幂等 no-op）。 */
  function noteEvent(event, args) {
    try {
      const name = (event === undefined || event === null) ? '' : String(event);
      const list = extractArgs(args);
      if (name === 'api-session/status') {
        const sessionId = toText(list[0]);
        if (!sessionId) return;
        const row = ensureRow(sessionId);
        row.running = !!list[1];
        markTruth(sessionId, 'live');
        return;
      }
      if (name === 'api-session/added') {
        const summary = list[0];
        if (!summary || typeof summary !== 'object') return;
        const sessionId = toText(summary.sessionId);
        if (!sessionId) return;
        const row = ensureRow(sessionId);
        applySummary(row, summary);
        markTruth(sessionId, 'live');
        return;
      }
      if (name === 'api-session/removed') {
        const sessionId = toText(list[0]);
        if (!sessionId) return;
        const row = ensureRow(sessionId);
        // §1.1：保留行以便列表继续显示，仅收敛运行态
        row.running = false;
        row.agentAvailable = false;
        markTruth(sessionId, 'live');
        return;
      }
      if (name === 'api-session/activity') {
        const sessionId = toText(list[0]);
        if (!sessionId) return;
        const row = ensureRow(sessionId);
        const updatedAt = Number(list[1]);
        // 只更新 updatedAt，不改变 running，也不建立 running 权威事实
        if (Number.isFinite(updatedAt) && updatedAt > 0) row.updatedAt = updatedAt;
        return;
      }
      // 其余事件（含 api-session/error）：幂等 no-op
    } catch (err) {
      log('[HOST-LIVE] noteEvent failed conn=' + streamId + ' ' + ((err && err.message) || String(err)));
    }
  }

  /**
   * C-11 冷启动播种：用一次 session/list 快照批量播种。
   * 不覆盖已有更新的 live 事实（只补空缺字段），返回新播种行数。
   */
  function noteListItems(items) {
    if (!Array.isArray(items)) return 0;
    let seeded = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const sessionId = toText(item.sessionId);
      if (!sessionId) continue;
      const row = ensureRow(sessionId);
      const held = truth.get(sessionId);
      if (held && held.source === 'live') {
        fillMissing(row, item);
        continue;
      }
      applySummary(row, item);
      markTruth(sessionId, 'list');
      seeded++;
    }
    return seeded;
  }

  /** 返回镜像行的浅拷贝（调用方不得就地改写内部事实）。 */
  function copyRow(row) {
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      running: row.running,
      agentAvailable: row.agentAvailable,
      parentSessionId: row.parentSessionId,
      origin: row.origin,
      cwd: row.cwd,
      title: row.title,
      updatedAt: row.updatedAt,
      subagentCatalog: Array.isArray(row.subagentCatalog) ? row.subagentCatalog.slice() : [],
      agentTeam: row.agentTeam,
    };
  }

  function getSession(sessionId) {
    const key = toText(sessionId);
    if (!key) return null;
    return copyRow(sessions.get(key));
  }

  /** 永不为 null（未知即空集，调用方自行决定兜底）。 */
  function getRunningIds() {
    const out = new Set();
    for (const row of sessions.values()) {
      if (row.running) out.add(row.sessionId);
    }
    return out;
  }

  /**
   * 是否持有权威 running 事实：
   *   - 传 sid：该 sid 是否有权威事实（区分「未知」与「确认不在跑」）——C-20 桥接前置条件；
   *   - 不传：进程内是否收到过任何权威事实——C-11 全局口径。
   */
  function hasRunningTruth(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return truth.size > 0;
    return truth.has(toText(sessionId));
  }

  /** 权威事实来源：'live' | 'list' | ''（无权威事实）。 */
  function getSource(sessionId) {
    const held = truth.get(toText(sessionId));
    return held ? held.source : '';
  }

  /** 子会话（parentSessionId === parentId），running 降序、updatedAt 降序。 */
  function listChildren(parentId) {
    const key = toText(parentId);
    if (!key) return [];
    const out = [];
    for (const row of sessions.values()) {
      if (row.parentSessionId === key) out.push(copyRow(row));
    }
    out.sort((a, b) => {
      const ar = a.running ? 1 : 0;
      const br = b.running ? 1 : 0;
      if (br !== ar) return br - ar;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return out;
  }

  /** 全量镜像行（子智能体看板兜底用；不含任何 RPC / 磁盘 IO）。 */
  function listAll() {
    const out = [];
    for (const row of sessions.values()) out.push(copyRow(row));
    return out;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearStabilityTimer() {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  }

  function clearOpenWatchdog() {
    if (openWatchdog) {
      clearTimeout(openWatchdog);
      openWatchdog = null;
    }
  }

  /** 断开 → 指数退避重连（stop() 后不再重连，C-14 每次各打一行可 grep 日志）。 */
  function scheduleReconnect(reason) {
    if (!started) {
      log('[HOST-LIVE] disconnected conn=' + streamId + ' (' + reason + '); stopped, no reconnect');
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, backoffAttempts));
    backoffAttempts++;
    reconnectCount++;
    log('[HOST-LIVE] disconnected conn=' + streamId + ': ' + reason);
    log('[HOST-LIVE] reconnect #' + reconnectCount + ' in ' + delay + 'ms (backoff attempt ' + backoffAttempts + ') conn=' + streamId);
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function handleFrame(raw) {
    let frame = null;
    try {
      const text = (typeof raw === 'string') ? raw : Buffer.from(raw).toString('utf8');
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'error') {
      log('[HOST-LIVE] stream error conn=' + streamId + ' ' + JSON.stringify(frame.error || {}).slice(0, 200));
      return;
    }
    if (frame.type !== 'item') return;
    const value = frame.value;
    if (!value || typeof value !== 'object') return;

    // ready：记录本代际 clientId（C-23 回 $events/result 的唯一凭据）
    if (value.type === 'ready') {
      clientId = (typeof value.clientId === 'string') ? value.clientId : '';
      log('[HOST-LIVE] events ready conn=' + streamId + ' clientId=' + (clientId || '-'));
      return;
    }

    // C-23（致命项）：waterfall 必须立即委托回瀑布，否则宿主侧提问/审批永久挂起。
    // C-23 末句 / F3：waterfall 帧**绝不**喂状态镜像（RemoteEventInvocationFrame 无 args 字段）。
    if (value.type === 'waterfall') {
      const eventId = (typeof value.eventId === 'string') ? value.eventId : '';
      const eventName = (typeof value.event === 'string') ? value.event : '';
      if (onWaterfallDecline && eventId) {
        try {
          onWaterfallDecline({ clientId: clientId, eventId: eventId, event: eventName, conn: streamId });
        } catch (err) {
          log('[HOST-LIVE] onWaterfallDecline threw conn=' + streamId + ' eventId=' + eventId
            + ' ' + ((err && err.message) || String(err)));
        }
      } else {
        log('[HOST-LIVE] waterfall unhandled conn=' + streamId + ' event=' + eventName
          + ' eventId=' + (eventId || '-') + ' clientId=' + (clientId || '-'));
      }
      return;
    }

    // cancel：仅清理本地挂起（本模块无挂起状态，幂等 no-op，无需回应）
    if (value.type === 'cancel') return;

    // 仅 emit 帧允许进入状态镜像
    if (value.type === 'emit' && typeof value.event === 'string' && value.event) {
      noteEvent(value.event, value.args);
    }
    // 其余类型：与状态镜像无关，no-op
  }

  function connect() {
    if (!started) return;
    let next;
    try {
      // ① ws 自身握手超时（未注入该选项的实现会忽略，由 ② 看门狗兜底）
      next = new WebSocketImpl(url, { headers: headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    } catch (err) {
      log('[HOST-LIVE] connect failed conn=' + streamId + ' ' + ((err && err.message) || String(err)));
      scheduleReconnect('ctor-error');
      return;
    }
    socket = next;
    const myStreamId = streamId;
    let opened = false;
    let watchdogFired = false;

    // ② open 看门狗：TCP 已连但 upgrade 无响应时不会触发 open/error/close，必须自持超时
    clearOpenWatchdog();
    openWatchdog = setTimeout(() => {
      openWatchdog = null;
      if (!started || socket !== next || opened) return;
      watchdogFired = true;
      log('[HOST-LIVE] open-timeout after ' + OPEN_WATCHDOG_MS + 'ms; terminating socket conn=' + myStreamId);
      try { if (typeof next.terminate === 'function') next.terminate(); } catch { /* 尽力而为 */ }
      scheduleReconnect('open-timeout');
    }, OPEN_WATCHDOG_MS);

    next.on('open', () => {
      if (!started || socket !== next) return;
      opened = true;
      clearOpenWatchdog();
      log('[HOST-LIVE] connected url=' + url + ' conn=' + myStreamId + (connectedOnce ? ' (reconnected)' : '')
        + ' (backoff attempt ' + backoffAttempts + ')');
      connectedOnce = true;
      // 连接稳定窗口后归零退避（抖动链路保持指数升级，见 BACKOFF_RESET_AFTER_MS）
      clearStabilityTimer();
      stabilityTimer = setTimeout(() => {
        stabilityTimer = null;
        if (started && socket === next) {
          if (backoffAttempts > 0) log('[HOST-LIVE] connection stable ' + BACKOFF_RESET_AFTER_MS + 'ms; backoff reset conn=' + myStreamId);
          backoffAttempts = 0;
        }
      }, BACKOFF_RESET_AFTER_MS);
      if (typeof stabilityTimer.unref === 'function') stabilityTimer.unref();
      try {
        next.send(JSON.stringify({
          type: 'open',
          streamId: myStreamId,
          endpoint: EVENTS_STREAM_ENDPOINT,
          payload: EVENTS_STREAM_PAYLOAD,
        }));
      } catch (err) {
        log('[HOST-LIVE] subscribe send failed conn=' + myStreamId + ' ' + ((err && err.message) || String(err)));
      }
    });
    next.on('message', (raw) => {
      if (!started || socket !== next) return;
      handleFrame(raw);
    });
    next.on('error', (err) => {
      log('[HOST-LIVE] socket error conn=' + myStreamId + ' ' + ((err && err.message) || String(err)));
    });
    next.on('close', (code, reason) => {
      if (socket === next) socket = null;
      clearStabilityTimer();
      clearOpenWatchdog();
      const why = 'close code=' + code + (reason ? ' reason=' + String(reason).slice(0, 120) : '');
      if (!started) {
        log('[HOST-LIVE] disconnected conn=' + myStreamId + ' ' + why + '; stopped, no reconnect');
        return;
      }
      if (watchdogFired) {
        // 看门狗已 terminate 并排好重连：避免重复调度
        log('[HOST-LIVE] disconnected conn=' + myStreamId + ' ' + why + ' (after open-timeout; reconnect already scheduled)');
        return;
      }
      scheduleReconnect(why);
    });
  }

  /**
   * 启动 $events 长连订阅（幂等）。
   * 未注入 WebSocketImpl/url 时安全 no-op 并返回 false（Q20_MOCK_HOST=1 走此路径，C-16）。
   */
  function start() {
    if (started) return false;
    started = true;
    // 先生成关联 token：所有日志行（含 no-op 分支）都带 conn=<streamId>（C-14 / L3-B findings 3/4）
    streamId = 'q20-live-' + Math.random().toString(36).slice(2, 10);
    if (!WebSocketImpl || !url) {
      log('[HOST-LIVE] start skipped conn=' + streamId + ': no transport injected (WebSocketImpl/url missing) — 安全 no-op');
      return false;
    }
    reconnectCount = 0;
    backoffAttempts = 0;
    connect();
    return true;
  }

  /** 停止订阅：关闭 WebSocket、清理重连/稳定/看门狗定时器，之后不再重连（契约 §4 资源释放）。 */
  function stop() {
    const wasStarted = started;
    started = false;
    clearReconnectTimer();
    clearStabilityTimer();
    clearOpenWatchdog();
    const current = socket;
    socket = null;
    if (current) {
      try { if (typeof current.removeAllListeners === 'function') current.removeAllListeners(); } catch { /* 尽力而为 */ }
      try { if (typeof current.close === 'function') current.close(); } catch { /* 尽力而为 */ }
      try { if (typeof current.terminate === 'function') current.terminate(); } catch { /* 尽力而为 */ }
    }
    if (wasStarted) log('[HOST-LIVE] stopped conn=' + streamId + ': socket closed, timers cleared');
  }

  function isStarted() {
    return started;
  }

  /** 当前关联 token（C-14 / logging correlation_token）：供调用方日志携带同一 conn= 标识。 */
  function getStreamId() {
    return streamId;
  }

  return {
    // 冻结签名（§1.1）
    noteEvent: noteEvent,
    noteListItems: noteListItems,
    getSession: getSession,
    getRunningIds: getRunningIds,
    hasRunningTruth: hasRunningTruth,
    listChildren: listChildren,
    start: start,
    stop: stop,
    // 附加只读查询（实现细节自由，供 server.mjs 兜底/诊断）
    getSource: getSource,
    listAll: listAll,
    isStarted: isStarted,
    getStreamId: getStreamId,
  };
}
