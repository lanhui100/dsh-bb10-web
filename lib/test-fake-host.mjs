/**
 * Q20 测试专用：假 DSH Web 宿主（HTTP RPC + /api/remote.mux 逻辑流）。
 *
 * 目的：在不触碰真实宿主、不发起任何 LLM 调用的前提下，把
 *   「宿主 approval/request waterfall → Q20 SSE 'approval' → POST /api/session/approval
 *    → 宿主 $events/result」
 * 整条链路跑成可断言的行为测试。协议形状严格对齐 dsh api-gateway：
 *   - RPC 信封 `{ type:'client-request', rpcId, method, payload:{ args } }`
 *     → 响应 `{ result: { ok: true, value } }`；
 *   - mux 上行 `{ type:'open', streamId, endpoint, payload }`，
 *     下行 item `{ type:'item', streamId, value }`；
 *   - `$events` 流首帧 `{ type:'ready', clientId }`；waterfall 帧
 *     `{ type:'waterfall', event, eventId, agentId, request }`。
 *
 * 该模块只读外部环境；ws 依赖从 DSH checkout 解析（缺失时返回 null，调用方跳过）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 从 DSH checkout 解析 ws 模块（与 server.mjs loadWsModule 同一候选顺序）。
 * @param {string} [dshRoot] DSH checkout 根目录（缺省 env.DSH_ROOT 或 ../deepseek-harness）
 * @returns {{WebSocketServer: Function, WebSocket: Function}|null}
 */
export function loadFakeHostWs(dshRoot) {
  const root = path.resolve(dshRoot || process.env.DSH_ROOT || path.join(process.cwd(), '..', 'deepseek-harness'));
  const candidates = [];
  try {
    const pnpmDir = path.join(root, 'node_modules', '.pnpm');
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('ws@')) candidates.push(path.join(pnpmDir, entry, 'node_modules', 'ws'));
    }
  } catch {}
  candidates.push(path.join(root, 'node_modules', 'ws'));
  candidates.push(path.join(process.cwd(), 'node_modules', 'ws'));
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  try { return require('ws'); } catch {}
  return null;
}

function writeRpc(res, ok, valueOrError) {
  const envelope = ok
    ? { result: { ok: true, value: valueOrError } }
    : { result: { ok: false, error: { code: 'FAKE_HOST', message: String(valueOrError) } } };
  const raw = JSON.stringify(envelope);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(raw);
}

/**
 * 启动一台假宿主。
 * @param {{dshRoot?: string, sessionId?: string}} [opts]
 * @returns {Promise<null|{
 *   url: string,
 *   state: object,
 *   armApproval: (frame: object) => void,
 *   finishTurn: () => void,
 *   stop: () => Promise<void>,
 * }>} ws 模块缺失时返回 null。
 */
export async function startFakeHost(opts = {}) {
  const wsLib = loadFakeHostWs(opts.dshRoot);
  if (!wsLib) return null;
  const { WebSocketServer } = wsLib;

  const state = {
    rpcLog: [],
    results: [],
    eventStreamSeq: 0,
    followStreams: [],
    arm: null,
    emittedEventIds: [],
    sessionId: opts.sessionId || 'fake-session-1',
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('fake dsh host');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch {}
      const method = String(req.url || '').replace(/^\/api\//, '').split('?')[0];
      state.rpcLog.push({ method, body });
      if (method === '$events/result') {
        state.results.push(body && body.payload ? body.payload.args : null);
        writeRpc(res, true, true);
        return;
      }
      if (method === 'session/create') {
        writeRpc(res, true, { sessionId: state.sessionId });
        return;
      }
      if (method === 'session/selectModel' || method === 'session/prompt') {
        writeRpc(res, true, true);
        return;
      }
      // 其余 RPC（session/list 冷启动播种等）一律明确失败：让 Q20 的旁路降级，绝不伪造数据。
      writeRpc(res, false, 'unsupported by fake host');
    });
  });

  const wss = new WebSocketServer({ server, path: '/api/remote.mux' });
  const sendItem = (ws, streamId, value) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'item', streamId, value }));
    } catch {}
  };

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || msg.type !== 'open') return;
      if (msg.endpoint === 'session/follow') {
        state.followStreams.push({ ws, streamId: msg.streamId });
        return;
      }
      if (msg.endpoint !== '$events') return;
      state.eventStreamSeq += 1;
      state.lastEventStreamId = msg.streamId;
      sendItem(ws, msg.streamId, { type: 'ready', clientId: `fake-client-${state.eventStreamSeq}` });
      if (!state.arm) return;
      const frame = state.arm.frame;
      state.emittedEventIds.push(frame.eventId);
      // 模拟真实网关：ready 之后投递（同一 tick 内先 item 后 waterfall 会破坏 Q20 的 ready 防御分支）
      setTimeout(() => sendItem(ws, msg.streamId, frame), 15);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** 武装下一帧授权询问：Q20 的任务级 $events 流 ready 后投递一次。 */
    armApproval(frame) { state.arm = { frame }; },
    /** 让所有 follow 流收到 turn/end，驱动 Q20 收口任务。 */
    finishTurn() {
      for (const stream of state.followStreams) {
        sendItem(stream.ws, stream.streamId, {
          type: 'event',
          event: { type: 'turn/end', seq: 9, time: Date.now(), data: { turn: 1, reason: { kind: 'done' } } },
        });
      }
    },
    async stop() {
      try { wss.close(); } catch {}
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
