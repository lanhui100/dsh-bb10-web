import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createStreamFold } from './lib/stream-fold.mjs';
import { createHostLiveState } from './lib/host-live-state.mjs';
import { createSessionEventHandler as createSessionEventHandlerImpl } from './lib/session-events.mjs';
import { classifyQuestionFrame } from './lib/ask-ownership.mjs';
import { applySubagentLite } from './lib/subagent-lite.mjs';
import {
  extractEventUsage,
  createUsageFold,
  billedInputTokens,
  pressureFrom,
  formatCacheHitPercent,
} from './lib/token-stats.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, 'static');

// Resolve DSH root directory from environment or default sibling checkout
const DSH_ROOT = path.resolve(process.env.DSH_ROOT || path.join(__dirname, '../deepseek-harness'));
const DSH_SDK_PATH = path.join(DSH_ROOT, 'packages/sdk/client/lib/index.js');

let DeepSeekHarness = null;
let tryLockExclusive = null;
let realpathNormalize = null;

// Resolve DSH workspace library
const DSH_WORKSPACE_PATH = path.join(DSH_ROOT, 'packages/workspace/workspace/lib/index.js');
let defaultWorkspaceTitle = (p) => path.basename(p) || path.parse(p).root;
try {
  const wsModule = await import(pathToFileURL(DSH_WORKSPACE_PATH).href);
  if (typeof wsModule.realpathNormalize === 'function') {
    realpathNormalize = wsModule.realpathNormalize;
  }
  if (typeof wsModule.defaultWorkspaceTitle === 'function') {
    defaultWorkspaceTitle = wsModule.defaultWorkspaceTitle;
  }
} catch (err) {
  console.warn(`[WARN] Failed to load from ${DSH_WORKSPACE_PATH}: ${err.message}`);
}
if (!realpathNormalize) {
  realpathNormalize = async (p) => fs.promises.realpath(path.resolve(p));
}

// Memory Task Pool for running/detached sessions
// sessionId -> {
//   sessionId,
//   cwd,
//   harness,
//   status: 'running' | 'done' | 'error' | 'cancelled',
//   startedAt: number,
//   updatedAt: number,
//   events: Array<{ event: string, data: any }>,
//   listeners: Set<(event: string, data: any) => void>,
//   finalResponse: string | null,
//   error: string | null,
// }
const activeTasks = new Map();

function broadcastTaskEvent(task, event, data) {
  // 终态事件去重：done/error/cancelled 只广播一次（RPC 引擎的 close 回调与
  // 取消端点可能竞争同一次终态）
  if (event === 'done' || event === 'error' || event === 'cancelled') {
    if (task.terminalSent) return;
    task.terminalSent = true;
  }
  // 时序真理（对齐 dsh assembler seq 保序）：task 内单调 seq 是 Q20 SSE
  // 通道唯一全序；replay burst 按 seq 排序重放，客户端 arrival-order
  // 渲染即等价于上游 seq 排序渲染。
  task.updatedAt = Date.now();
  task.eventSeq = (typeof task.eventSeq === 'number' ? task.eventSeq : 0) + 1;
  task.events.push({ event, data, seq: task.eventSeq });
  // Limit event buffer to 1000 items to protect memory
  if (task.events.length > 1000) {
    task.events.splice(0, task.events.length - 1000);
  }
  for (const listener of task.listeners) {
    try {
      listener(event, data, task.eventSeq);
    } catch {
      // ignore
    }
  }
}
try {
  const sdkModule = await import(pathToFileURL(DSH_SDK_PATH).href);
  DeepSeekHarness = sdkModule.DeepSeekHarness;
} catch (err) {
  console.error(`[CRITICAL] Failed to load DSH SDK from ${DSH_SDK_PATH}: ${err.message}`);
  console.error('Please ensure DSH_ROOT environment variable points to a valid deepseek-harness directory.');
}

try {
  const flockPath = path.join(DSH_ROOT, 'native/system/packages/entry/lib/flock.js');
  const flockModule = await import(pathToFileURL(flockPath).href);
  tryLockExclusive = flockModule.tryLockExclusive;
} catch (err) {
  console.warn(`[WARN] Failed to load flock module: ${err.message}`);
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml');
const SETTINGS_FILE = path.join(DSH_HOME, 'settings.yaml');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const WORKSPACE_DOMAIN_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');
const DSH_WEB_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
const lastQueuedPromptsBySession = new Map();

// Q20 文件上传上限：5MB。前端同值硬拦截；服务端按实际字节流再卡一次
// （Content-Length 声明超限直接 413；分块传输按累计字节熔断）。
const Q20_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
// 图片内联 base64 上限（5MB 文件 → 约 7MB base64；parseJsonBody 10MB 上限内）。
const Q20_IMAGE_B64_MAX = 7 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Q20_MOCK_HOST：测试用 mock 宿主（绝不再做真实链路）。
//   Q20_MOCK_HOST=1      → callDshWebRpc / callDshWebArchiveSession 全部短路到
//                          进程内内存注册表，不触碰真实 DSH Web (3080)，不发起
//                          任何真实 LLM 调用（合成回复 + 本地 zstd 转录）。
//   Q20_MOCK_HOME=<dir>  → 工作区目录创建根（默认 ~/；测试改到临时目录，杜绝
//                          在真实家目录残留 ~/q20* 探针目录）。
// 生产默认两个开关均为关闭；由 test-unit.mjs / test-suite.mjs 以独立端口 +
// 临时 DSH_HOME 拉起，测试完全隔离。
// ─────────────────────────────────────────────────────────────────────────────
const Q20_MOCK_HOST = process.env.Q20_MOCK_HOST === '1';
const Q20_MOCK_HOME = process.env.Q20_MOCK_HOME ? path.resolve(process.env.Q20_MOCK_HOME) : '';
const MOCK_WORKSPACE_ROOT = Q20_MOCK_HOME || os.homedir();
const mockHostState = {
  workspaces: new Map(),   // wid -> { id, path, title, sessionIds }
  sessions: new Map(),     // sid -> { id, title, running, workspaceId }
  transcripts: new Map(),  // sid -> string[]（JSONL 行，续接追加）
  seqBySession: new Map(), // sid -> 转录 seq 计数器
  turnBySession: new Map(),// sid -> 回合数
};
let mockWsSeq = 0;
let mockSidSeq = 0;

// mock 模式下启动即确保工作区创建根存在（真实 ~/ 天然存在，测试临时根需要预建）。
if (Q20_MOCK_HOST && Q20_MOCK_HOME) {
  try { fs.mkdirSync(MOCK_WORKSPACE_ROOT, { recursive: true }); } catch {}
}

function mockEnsureWorkspaceDomainFile() {
  if (fs.existsSync(WORKSPACE_DOMAIN_FILE)) return;
  fs.mkdirSync(path.dirname(WORKSPACE_DOMAIN_FILE), { recursive: true });
  const doc = {
    unit: 'dsh-workspace-domain',
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
  fs.writeFileSync(WORKSPACE_DOMAIN_FILE, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

function mockReadWorkspaceDomainFile() {
  try { return JSON.parse(fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8')); } catch { return null; }
}

function mockWriteWorkspaceDomainFile(doc) {
  const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
}

function mockRegisterWorkspace(rawPath, title) {
  const wid = 'mock-ws-' + (++mockWsSeq);
  const resolved = path.resolve(String(rawPath || ''));
  mockHostState.workspaces.set(wid, { id: wid, path: resolved, title: title || path.basename(resolved) || 'mock-ws', sessionIds: [] });
  mockEnsureWorkspaceDomainFile();
  const doc = mockReadWorkspaceDomainFile() || { global: { workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } };
  doc.global = doc.global || {};
  if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = [];
  doc.tables = doc.tables || {};
  doc.tables.workspaces = doc.tables.workspaces || {};
  doc.global.workspaceIds.push(wid);
  doc.tables.workspaces[wid] = {
    path: resolved,
    title: mockHostState.workspaces.get(wid).title,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockWriteWorkspaceDomainFile(doc);
  return wid;
}

function mockUnregisterWorkspace(wid) {
  const ws = mockHostState.workspaces.get(wid);
  if (!ws) return false;
  for (const sid of ws.sessionIds) {
    const s = mockHostState.sessions.get(sid);
    if (s) s.workspaceId = null; // 会话落袋未分组
  }
  mockHostState.workspaces.delete(wid);
  try {
    const doc = mockReadWorkspaceDomainFile();
    if (doc && doc.tables && doc.tables.workspaces) {
      delete doc.tables.workspaces[wid];
      if (Array.isArray(doc.global.workspaceIds)) {
        doc.global.workspaceIds = doc.global.workspaceIds.filter((x) => x !== wid);
      }
      mockWriteWorkspaceDomainFile(doc);
    }
  } catch {}
  return true;
}

function mockCreateSession(sid, workspaceId) {
  mockHostState.sessions.set(sid, { id: sid, title: 'mock-session', running: false, workspaceId: workspaceId || null });
  mockHostState.seqBySession.set(sid, 0);
  mockHostState.turnBySession.set(sid, 0);
  if (workspaceId && mockHostState.workspaces.has(workspaceId)) {
    const ws = mockHostState.workspaces.get(workspaceId);
    if (!ws.sessionIds.includes(sid)) ws.sessionIds.push(sid);
    try {
      const doc = mockReadWorkspaceDomainFile();
      if (doc && doc.tables && doc.tables.workspaces && doc.tables.workspaces[workspaceId]) {
        const rec = doc.tables.workspaces[workspaceId];
        rec.sessionIds = Array.isArray(rec.sessionIds) ? rec.sessionIds : [];
        if (!rec.sessionIds.includes(sid)) rec.sessionIds.push(sid);
        rec.updatedAt = new Date().toISOString();
        mockWriteWorkspaceDomainFile(doc);
      }
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.4 mock 宿主测试接缝（仅 Q20_MOCK_HOST=1 分支读取；生产路径绝不读取）
//   Q20_MOCK_HOST_RUNNING_SESSIONS / LIST_DELAY_MS / LIST_FAIL / SUBAGENTS / RPC_LOG
// ─────────────────────────────────────────────────────────────────────────────

/** 物理收据：每次 mock RPC 追加一行 JSON {"method","at"}（测试可数请求次数）。 */
function mockNoteRpc(method) {
  const file = process.env.Q20_MOCK_HOST_RPC_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ method: method, at: Date.now() }) + '\n');
  } catch { /* 收据写入失败不影响被测行为 */ }
}

/** §1.4 接缝：逗号分隔的「mock 侧 running 会话」（session/list 与 live 真源共用）。 */
function mockSeamRunningIds() {
  const raw = process.env.Q20_MOCK_HOST_RUNNING_SESSIONS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** §1.4 接缝：并入 session/list items 的子会话行（JSON 数组）。 */
function mockSeamSubagents() {
  const raw = process.env.Q20_MOCK_HOST_SUBAGENTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x === 'object' && x.sessionId);
  } catch {
    return [];
  }
}

/** mock session/list items：内存注册表 + §1.4 接缝（running / SUBAGENTS）。 */
function mockSessionListItems() {
  const runningIds = new Set(mockSeamRunningIds());
  const items = [];
  const seen = new Set();
  for (const s of mockHostState.sessions.values()) {
    const running = runningIds.has(s.id);
    items.push({
      sessionId: s.id,
      title: s.title,
      running: running,
      state: running ? 'running' : 'done',
      projections: { values: { title: s.title } },
    });
    seen.add(s.id);
  }
  for (const sub of mockSeamSubagents()) {
    if (seen.has(sub.sessionId)) continue;
    seen.add(sub.sessionId);
    const running = sub.running !== undefined ? !!sub.running : runningIds.has(sub.sessionId);
    items.push({
      sessionId: sub.sessionId,
      title: sub.title || '',
      running: running,
      state: running ? 'running' : 'done',
      parentSessionId: sub.parentSessionId || '',
      origin: sub.origin || 'subagent',
      cwd: sub.cwd || '',
      projections: { values: { title: sub.title || '', subagent: sub } },
    });
  }
  return items;
}

/**
 * mock RPC 入口（仅 Q20_MOCK_HOST=1）：写 RPC 收据 + 施加 §1.4 的 session/list 注入。
 * 生产路径绝不经过本函数。
 */
function mockHandleRpcAsync(method, request) {
  mockNoteRpc(method);
  if (method !== 'session/list') return Promise.resolve(mockHandleRpc(method, request));
  const fail = process.env.Q20_MOCK_HOST_LIST_FAIL === '1';
  const delay = Number(process.env.Q20_MOCK_HOST_LIST_DELAY_MS || 0);
  const respond = () => (fail ? { ok: false, error: 'mock: session/list injected failure' } : mockHandleRpc(method, request));
  if (Number.isFinite(delay) && delay > 0) {
    return new Promise((resolve) => { setTimeout(() => resolve(respond()), delay); });
  }
  return Promise.resolve(respond());
}

function mockHandleRpc(method, request) {
  const req = (request && typeof request === 'object') ? request : {};
  switch (method) {
    case 'workspace/create': {
      const wid = mockRegisterWorkspace(req.path, req.title);
      const ws = mockHostState.workspaces.get(wid);
      return { ok: true, value: { workspace: { workspaceId: wid, path: ws.path, title: ws.title, sessionIds: [] } } };
    }
    case 'workspace/delete': {
      const wid = req.workspaceId;
      if (!wid || !mockHostState.workspaces.has(wid)) {
        return { ok: false, code: 'workspace/not-found', error: 'workspace not found' };
      }
      mockUnregisterWorkspace(wid);
      return { ok: true, value: {} };
    }
    case 'session/create': {
      const sid = req.sessionId || 'mock-session-' + (++mockSidSeq);
      mockCreateSession(sid, req.workspaceId || null);
      return { ok: true, value: { sessionId: sid } };
    }
    case 'session/list': {
      return { ok: true, value: { items: mockSessionListItems() } };
    }
    case 'session/modelCatalog': {
      return {
        ok: true,
        value: {
          groups: [
            {
              id: 'ponyllm',
              models: [
                { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
                { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
                { id: 'kimi-k3', name: 'Kimi-K3' },
              ],
            },
            { id: 'local', models: [{ id: 'mock-local-1', name: 'Mock Local 1' }] },
          ],
          default: { provider: 'ponyllm', model: 'glm-5.3-flash' },
        },
      };
    }
    case 'session/selectModel':
      return { ok: true, value: {} };
    case 'session/prompt':
      return { ok: true, value: { accepted: true } };
    case 'workspace/insertSessionBefore': {
      const wid = req.workspaceId;
      const sid = req.sessionId;
      if (!wid || !sid || !mockHostState.workspaces.has(wid) || !mockHostState.sessions.has(sid)) {
        return { ok: false, error: 'mock: insertSessionBefore target missing' };
      }
      const ws = mockHostState.workspaces.get(wid);
      if (!ws.sessionIds.includes(sid)) ws.sessionIds.push(sid);
      mockHostState.sessions.get(sid).workspaceId = wid;
      return { ok: true, value: {} };
    }
    default:
      return { ok: true, value: {} };
  }
}

/** mock 宿主合成回复：绝不代表真实模型输出。 */
function mockReplyForPrompt(promptText) {
  const p = String(promptText || '').trim().replace(/\s+/g, ' ');
  return `[MOCK] 收到：${p.slice(0, 48) || '（空）'}。本回复由 Q20 测试 mock 宿主合成，不代表任何真实模型输出。`;
}

/** mock 宿主本地落转录（对齐官方 zstd JSONL 口径，供 /api/history、/api/sessions 直读）。 */
function mockPersistTranscript(targetCwd, sessionId, promptText, reply) {
  try {
    const dir = path.join(SESSIONS_ROOT, projectKey(path.resolve(targetCwd)), sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const seq = mockHostState.seqBySession.get(sessionId) || 0;
    const turn = (mockHostState.turnBySession.get(sessionId) || 0) + 1;
    mockHostState.turnBySession.set(sessionId, turn);
    const now = Date.now();
    const lines = mockHostState.transcripts.get(sessionId) || [];
    if (lines.length === 0) {
      lines.push(JSON.stringify({ type: 'header', id: sessionId, cwd: path.resolve(targetCwd), createdAt: now, version: 'mock' }));
      lines.push(JSON.stringify({ type: 'session/title', time: now, data: { title: 'mock-session' } }));
    }
    lines.push(JSON.stringify({ type: 'user/message', seq: seq + 0, time: now, data: { content: [{ type: 'text', text: String(promptText || '') }], source: { kind: 'user' } } }));
    lines.push(JSON.stringify({ type: 'assistant/message', seq: seq + 1, time: now, surfaceOp: 'append', data: { turn, step: 1, message: { content: [{ type: 'text', text: reply }] }, stream: [] } }));
    lines.push(JSON.stringify({ type: 'turn/end', seq: seq + 2, time: now, data: { turn, reason: { kind: 'done' } } }));
    mockHostState.seqBySession.set(sessionId, seq + 3);
    mockHostState.transcripts.set(sessionId, lines);
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  } catch (err) {
    console.warn(`[MOCK] transcript persist failed for ${sessionId}: ${err.message}`);
  }
}

/** mock 宿主合成一次完整对话回合（delta → turn/end → done），与真实路径同构。 */
function runMockChatTurn(task, sessionId, targetCwd, promptText) {
  const handler = createSessionEventHandler(task);
  const reply = mockReplyForPrompt(promptText);
  const seq = mockHostState.seqBySession.get(sessionId) || 0;
  const now = Date.now();
  handler.handleSessionEvent({
    type: 'assistant/message',
    seq: seq + 1,
    time: now,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: reply }] }, stream: [] },
  });
  handler.handleSessionEvent({ type: 'turn/end', seq: seq + 2, time: now, data: { turn: 1, reason: { kind: 'done' } } });
  mockPersistTranscript(targetCwd, sessionId, promptText, reply);
  task.status = 'done';
  task.finalResponse = reply;
  broadcastTaskEvent(task, 'done', { sessionId, finalResponse: reply });
  console.log(`[TASK COMPLETED via MOCK host] sessionId: ${sessionId}, final len: ${reply.length}`);
  return 'done';
}

/**
 * 校验前端图片内联载荷，还原 DSH PromptContentPart image 形状。
 * 对齐上游 imageMediaType 白名单（png/jpeg/webp/gif）与 admitPromptContent 规范 base64。
 * 返回 { ok:true, part } / { ok:false, error }，调用方一律 400 回传。
 */
function toPromptImagePart(image) {
  if (image === undefined) return { ok: true, part: null };
  if (!image || typeof image !== 'object') {
    return { ok: false, error: 'Invalid "image": expected {mediaType,data}' };
  }
  const mt = image.mediaType;
  if (mt !== 'image/png' && mt !== 'image/jpeg' && mt !== 'image/webp' && mt !== 'image/gif') {
    return { ok: false, error: 'Invalid "image": unsupported mediaType (png/jpeg/webp/gif only)' };
  }
  const data = image.data;
  if (typeof data !== 'string' || !data || data.length > Q20_IMAGE_B64_MAX || !/^[A-Za-z0-9+/=]+$/.test(data)) {
    return { ok: false, error: 'Invalid "image": bad base64 data or too large (max 5MB)' };
  }
  const part = { type: 'image', mediaType: mt, data };
  if (typeof image.name === 'string' && image.name) part.name = image.name.slice(0, 128);
  return { ok: true, part };
}

/**
 * Q20 文件上传 → 宿主 uploadFileBinary 原生字节透传（管道①，解耦合规）。
 * 宿主路由是原生字节路由（application/octet-stream + ?sessionId&name），
 * 非 JSON-RPC：严禁 callDshWebRpc / parseJsonBody 碰二进制，否则必坏。
 * 宿主不可达（ECONNREFUSED/超时/502/503）一律 fail-fast，严禁回退本地 SDK
 * （receipt 由宿主签发只对宿主引擎有效，回退必撞锁/无效收据）。
 * 成功透传宿主信封 {ok:true,value:{receiptId,file}}；失败透传状态与错误。
 */
function proxyUploadToHost(req, res, sessionId, fileName) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const url = new URL('/api/session/uploadFileBinary', DSH_WEB_URL);
      url.searchParams.set('sessionId', sessionId);
      if (fileName) url.searchParams.set('name', fileName);
      const authority = url.host;
      const cookie = getDshWebAuthCookie(authority);
      const headers = {
        'Host': authority,
        'Origin': url.origin,
        'Content-Type': 'application/octet-stream',
      };
      if (cookie) headers['Cookie'] = cookie;
      const declaredLen = parseInt(req.headers['content-length'] || '', 10);
      if (!isNaN(declaredLen) && declaredLen > Q20_UPLOAD_MAX_BYTES) {
        sendJson(res, 413, { ok: false, error: 'file too large (max 5MB)' });
        // 声明超限：只管回 413，不 destroy socket——客户端声明与实发不一致时
        // destroy 必发 RST 污染连接池；resume 排空让双方自然 FIN。
        try { req.resume(); } catch {}
        finish(false);
        return;
      }
      if (!isNaN(declaredLen) && declaredLen >= 0) headers['Content-Length'] = String(declaredLen);
      let received = 0;
      let aborted = false;
      req.on('aborted', () => { aborted = true; });
      const clientReq = http.request(url, { method: 'POST', headers, timeout: 60000 }, (hostRes) => {
        const chunks = [];
        hostRes.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); });
        hostRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          res.writeHead(hostRes.statusCode || 200, {
            'Content-Type': 'application/json; charset=utf-8',
            ...SECURITY_HEADERS,
            ...getCorsHeaders(req),
          });
          res.end(raw);
          finish(true);
        });
      });
      clientReq.on('error', (err) => {
        if (aborted) { finish(false); return; }
        const unreachable = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT';
        sendJson(res, unreachable ? 502 : 500, { ok: false, error: unreachable ? 'host unreachable' : ('upload proxy failed: ' + err.message) }, req);
        finish(false);
      });
      clientReq.on('timeout', () => {
        try { clientReq.destroy(new Error('timeout')); } catch {}
        sendJson(res, 502, { ok: false, error: 'host unreachable' }, req);
        finish(false);
      });
      req.on('data', (chunk) => {
        if (settled) return; // 413/错误已终结：只排空，不再写宿主、不再二次响应
        received += chunk.length;
        if (received > Q20_UPLOAD_MAX_BYTES) {
          try { clientReq.destroy(); } catch {}
          sendJson(res, 413, { ok: false, error: 'file too large (max 5MB)' });
          // 实发超限：不 destroy 请求 socket，resume 排空剩余字节让双方自然 FIN，
          // 避免 RST 污染客户端连接池。
          try { req.resume(); } catch {}
          finish(false);
          return;
        }
        if (!clientReq.write(chunk)) req.pause();
      });
      clientReq.on('drain', () => { try { req.resume(); } catch {} });
      req.on('end', () => { if (settled) return; try { clientReq.end(); } catch { finish(false); } });
      req.on('error', () => { try { clientReq.destroy(); } catch {} finish(false); });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'upload proxy failed: ' + err.message }, req);
      finish(false);
    }
  });
}

/**
 * DSH 官方工作区与归档逻辑：
 * 官方数据源保存在 ~/.dsh/storages/workspace.json 中。
 * 每个工作区有一个 sessionIds 列表（即属于该工作区的会话，按最新排布）。
 * 全局有一个 global.archivedSessionIds（即已归档的会话列表）。
 * 只有在 sessionIds 中且不在 archivedSessionIds 中的会话才是有效显示的活跃未归档会话。
 */
let workspaceDomainCache = { data: null, mtimeMs: 0 };
// 归档即时遮罩：远端 RPC 成功后官方落盘可能有延迟，本地文件读到的
// archivedSessionIds 会短暂缺失该 id，导致 /api/sessions 把已归档会话
// 吐回列表（数秒后才消失）。凡归档成功的 id 先记入内存遮罩，读路径
// 一律叠加过滤，保证归档立即可见；常驻小集合，上限裁剪防膨胀。
const archivedOverlay = new Set();
function markArchivedOverlay(id) {
  if (!id) return;
  archivedOverlay.add(String(id));
  workspacesCache = null;
  try { invalidateUngroupedCache(); } catch {}
  if (archivedOverlay.size > 500) {
    const oldest = archivedOverlay.values().next();
    if (oldest && oldest.value) archivedOverlay.delete(oldest.value);
  }
}
function archivedWithOverlay() {
  const s = readArchivedSessionIds();
  for (const id of archivedOverlay) s.add(String(id));
  return s;
}
function readWorkspaceDomain() {
  try {
    const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
    if (workspaceDomainCache.data && st.mtimeMs === workspaceDomainCache.mtimeMs) {
      return workspaceDomainCache.data;
    }
    const doc = JSON.parse(fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8'));
    workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
    return doc;
  } catch {
    return workspaceDomainCache.data || { global: { archivedSessionIds: [] }, tables: { workspaces: {} } };
  }
}

function readArchivedSessionIds() {
  const doc = readWorkspaceDomain();
  const ids = (doc && doc.global && doc.global.archivedSessionIds) || [];
  return new Set(ids.map(String));
}

function removeArchivedSessionId(sessionId) {
  const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc.global || !Array.isArray(doc.global.archivedSessionIds)) {
    return false;
  }
  const idx = doc.global.archivedSessionIds.indexOf(sessionId);
  if (idx === -1) return false;
  doc.global.archivedSessionIds.splice(idx, 1);
  const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
  workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
  try { invalidateUngroupedCache(); } catch {}
  return true;
}

function unmarkArchivedOverlay(id) {
  if (!id) return;
  archivedOverlay.delete(String(id));
  workspacesCache = null;
  try { invalidateUngroupedCache(); } catch {}
}

/**
 * 追加一个 id 到官方归档名单（原子写：tmp + rename，与 dsh storage-json writeAtomic 同协议）。
 */
function appendArchivedSessionId(sessionId) {
  const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc.global || !Array.isArray(doc.global.archivedSessionIds)) {
    throw new Error('workspace.json global.archivedSessionIds 缺失，拒绝写入');
  }
  if (doc.global.archivedSessionIds.includes(sessionId)) return false;
  doc.global.archivedSessionIds.push(sessionId);
  const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
  workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
  try { invalidateUngroupedCache(); } catch {}
  return true;
}

/**
 * 获取 DSH 官方 Web 服务的签名认证 Cookie（用于调用 3080 端口上的官方 RPC）
 */
function getDshWebAuthCookie(authority) {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const parsed = parseYaml(content);
    const rec = parsed && parsed.records && parsed.records['client-connection/browser-session'];
    const secretStr = rec && rec.payload && rec.payload.secret;
    if (!secretStr) return null;

    // decodeBase64Url
    const padding = '='.repeat((4 - (secretStr.length % 4)) % 4);
    const secretBuf = Buffer.from(secretStr.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64');
    if (secretBuf.length !== 32) return null;

    const cookieName = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
    const now = Date.now();
    const payload = {
      version: 1,
      authority,
      issuedAt: now,
      expiresAt: now + 30 * 24 * 3600 * 1000,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', secretBuf).update(body).digest('base64url');
    return `${cookieName}=v1.${body}.${sig}`;
  } catch (err) {
    console.warn(`[WARN] Failed to get DSH Web auth cookie: ${err.message}`);
    return null;
  }
}

async function callDshWebUnarchiveSession(sessionId) {
  if (Q20_MOCK_HOST) {
    return Promise.resolve({ ok: true, value: {} });
  }
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/workspace/unarchiveSession', DSH_WEB_URL);
      const authority = url.host; // e.g. 127.0.0.1:3080
      const cookie = getDshWebAuthCookie(authority);
      const headers = {
        'Host': authority,
        'Origin': url.origin,
        'Content-Type': 'application/json',
      };
      if (cookie) {
        headers['Cookie'] = cookie;
      }

      const reqBody = JSON.stringify({
        type: 'client-request',
        rpcId: `q20-unarchive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        method: 'workspace/unarchiveSession',
        payload: {
          args: {
            request: {
              sessionId,
            },
          },
        },
      });

      const clientReq = http.request(
        url,
        {
          method: 'POST',
          headers,
          timeout: 2500,
        },
        (res) => {
          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(rawData);
                if (parsed && parsed.result && parsed.result.ok) {
                  console.log(`[DSH RPC] Successfully unarchived session ${sessionId} via DSH Web at ${DSH_WEB_URL}`);
                  resolve({ ok: true, remote: true, value: parsed.result.value });
                  return;
                } else {
                  const errDesc = (parsed && parsed.result && parsed.result.error && parsed.result.error.message) || rawData;
                  console.warn(`[DSH RPC WARN] DSH Web responded with unarchive RPC error: ${errDesc}`);
                  resolve({ ok: false, error: errDesc });
                  return;
                }
              } catch (e) {
                console.warn(`[DSH RPC WARN] Failed to parse DSH Web response: ${e.message}`);
                resolve({ ok: false, error: e.message });
                return;
              }
            }
            console.warn(`[DSH RPC WARN] DSH Web HTTP ${res.statusCode}: ${rawData.slice(0, 100)}`);
            resolve({ ok: false, status: res.statusCode, error: rawData });
          });
        }
      );

      clientReq.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });

      clientReq.on('timeout', () => {
        clientReq.destroy();
        resolve({ ok: false, error: 'Request to DSH Web timed out' });
      });

      clientReq.write(reqBody);
      clientReq.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * 尝试通过 DSH Web 官方 RPC 调用归档会话。
 * 若 DSH Web 服务在线（默认 127.0.0.1:3080），调用其 workspace/archiveSession，
 * 这样官方 Web 前端能在实时 feed 和内存中立刻感知归档，并更新 UI；
 * 若 DSH Web 不在线或调用失败，由上层退回本地写 workspace.json。
 */
async function callDshWebArchiveSession(sessionId) {
  if (Q20_MOCK_HOST) {
    return Promise.resolve({ ok: true, value: {} });
  }
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/workspace/archiveSession', DSH_WEB_URL);
      const authority = url.host; // e.g. 127.0.0.1:3080
      const cookie = getDshWebAuthCookie(authority);
      const headers = {
        'Host': authority,
        'Origin': url.origin,
        'Content-Type': 'application/json',
      };
      if (cookie) {
        headers['Cookie'] = cookie;
      }

      const reqBody = JSON.stringify({
        type: 'client-request',
        rpcId: `q20-archive-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        method: 'workspace/archiveSession',
        payload: {
          args: {
            request: {
              sessionId,
            },
          },
        },
      });

      const clientReq = http.request(
        url,
        {
          method: 'POST',
          headers,
          timeout: 2500,
        },
        (res) => {
          let rawData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rawData += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(rawData);
                if (parsed && parsed.result && parsed.result.ok) {
                  console.log(`[DSH RPC] Successfully archived session ${sessionId} via DSH Web at ${DSH_WEB_URL}`);
                  resolve({ ok: true, remote: true, value: parsed.result.value });
                  return;
                } else {
                  const errDesc = (parsed && parsed.result && parsed.result.error && parsed.result.error.message) || rawData;
                  console.warn(`[DSH RPC WARN] DSH Web responded with RPC error: ${errDesc}`);
                  resolve({ ok: false, error: errDesc });
                  return;
                }
              } catch (e) {
                console.warn(`[DSH RPC WARN] Failed to parse DSH Web response: ${e.message}`);
                resolve({ ok: false, error: e.message });
                return;
              }
            }
            console.warn(`[DSH RPC WARN] DSH Web HTTP ${res.statusCode}: ${rawData.slice(0, 100)}`);
            resolve({ ok: false, status: res.statusCode, error: rawData });
          });
        },
      );

      clientReq.on('error', (err) => {
        // DSH Web not running or connection refused
        console.log(`[DSH RPC INFO] DSH Web not reachable at ${DSH_WEB_URL} (${err.code || err.message}), falling back to direct persistence`);
        resolve({ ok: false, error: err.message, unreachable: true });
      });

      clientReq.on('timeout', () => {
        clientReq.destroy();
        console.warn(`[DSH RPC WARN] DSH Web request timed out, falling back to direct persistence`);
        resolve({ ok: false, error: 'timeout', unreachable: true });
      });

      clientReq.write(reqBody);
      clientReq.end();
    } catch (err) {
      console.warn(`[DSH RPC WARN] Unexpected error in callDshWebArchiveSession: ${err.message}`);
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * 通用 DSH Web 官方 RPC 调用（与 callDshWebArchiveSession 同一签名认证与信封）。
 * 返回 { ok:true, value } / { ok:false, unreachable:true, error } / { ok:false, error }。
 */
function callDshWebRpc(method, request, timeoutMs = 8000, opts = {}) {
  // mock 宿主：短路到进程内注册表，绝无真实网络/LLM 链路。
  if (Q20_MOCK_HOST) {
    return mockHandleRpcAsync(method, request);
  }
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/' + method, DSH_WEB_URL);
      const authority = url.host;
      const cookie = getDshWebAuthCookie(authority);
      const headers = {
        'Host': authority,
        'Origin': url.origin,
        'Content-Type': 'application/json',
      };
      if (cookie) headers['Cookie'] = cookie;
      const reqBody = JSON.stringify({
        type: 'client-request',
        rpcId: `q20-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        method,
        // opts.rawArgs: pass args verbatim. Endpoints disagree on envelope
        // shape — session/list's descriptor wants { _request } directly,
        // while e.g. workspace/archiveSession wants { request: {...} }.
        payload: { args: opts.rawArgs ? request : { request } },
      });
      const clientReq = http.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        let rawData = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.warn(`[DSH RPC WARN] ${method} HTTP ${res.statusCode}: ${rawData.slice(0, 160)}`);
            resolve({ ok: false, status: res.statusCode, error: rawData.slice(0, 300), unreachable: res.statusCode === 502 || res.statusCode === 503 });
            return;
          }
          try {
            const parsed = JSON.parse(rawData);
            if (parsed && parsed.result && parsed.result.ok) {
              resolve({ ok: true, value: parsed.result.value });
            } else {
              const errObj = (parsed && parsed.result && parsed.result.error) || {};
              console.warn(`[DSH RPC WARN] ${method} rpc-error ${errObj.code || ''}: ${errObj.message || rawData.slice(0, 160)}`);
              resolve({ ok: false, code: errObj.code, error: errObj.message || rawData.slice(0, 300) });
            }
          } catch (e) {
            console.warn(`[DSH RPC WARN] ${method} bad envelope: ${e.message}`);
            resolve({ ok: false, error: `bad rpc envelope: ${e.message}` });
          }
        });
      });
      clientReq.on('error', (err) => resolve({ ok: false, error: err.message, unreachable: err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' }));
      clientReq.on('timeout', () => { clientReq.destroy(); resolve({ ok: false, error: 'timeout', unreachable: true }); });
      clientReq.write(reqBody);
      clientReq.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

let wsModuleCache = null;
/** 加载 DSH checkout 内置的 ws 模块（/api/remote.mux 流载体客户端所需）。 */
function loadWsModule() {
  if (wsModuleCache !== null) return wsModuleCache;
  const candidates = [];
  try {
    const pnpmDir = path.join(DSH_ROOT, 'node_modules', '.pnpm');
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('ws@')) candidates.push(path.join(pnpmDir, entry, 'node_modules', 'ws'));
    }
  } catch {}
  candidates.push(path.join(DSH_ROOT, 'node_modules', 'ws'));
  for (const candidate of candidates) {
    try {
      wsModuleCache = createRequire(pathToFileURL(path.join(candidate, 'package.json')))(candidate);
      return wsModuleCache;
    } catch {}
  }
  wsModuleCache = false;
  return wsModuleCache;
}

let hostRunningCache = { ids: null, at: 0 };
let hostTitleCache = { map: null, at: 0 };
let hostSessionListInflight = null;
const HOST_RUNNING_CACHE_TTL_MS = 8000;
const HOST_TITLE_CACHE_TTL_MS = 15000;

// ─────────────────────────────────────────────────────────────────────────────
// 宿主 $events 权威状态镜像（单例，进程启动时在 listen 回调内建立并 start()）
//   lib/host-live-state.mjs（契约 §1.1 冻结签名）；生产路径注入真实 mux 连接参数，
//   Q20_MOCK_HOST=1 时不注入 transport（start() 安全 no-op）并由 §1.4 接缝同步播种。
// ─────────────────────────────────────────────────────────────────────────────
let hostLiveState = null;
/** C-20 冷启动桥接：durable mtime 新鲜窗口（毫秒）。 */
const HOST_LIVE_BRIDGE_MTIME_MS = 300000;

let dshHostAliveCache = { alive: null, at: 0 };
let dshHostAliveInflight = null;
const DSH_HOST_ALIVE_TTL_MS = 5000;

/**
 * 权威检测 DSH 官方 Web 底座进程（3080）是否存活在线。
 * 在 Q20_MOCK_HOST 模式下直接判定存活；在线模式下采用 2.5s 超时探活（带 1 次快速重试以滤除瞬态毛刺），
 * 并带 5s 缓存与 In-flight 单飞。
 */
async function checkDshHostAlive(force = false) {
  if (Q20_MOCK_HOST) return true;
  const now = Date.now();
  if (!force && dshHostAliveCache.alive !== null && (now - dshHostAliveCache.at < DSH_HOST_ALIVE_TTL_MS)) {
    return dshHostAliveCache.alive;
  }
  if (dshHostAliveInflight) {
    return dshHostAliveInflight;
  }

  function probeOnce() {
    return new Promise((resolve) => {
      try {
        const url = new URL(DSH_WEB_URL);
        const authority = url.host;
        const cookie = getDshWebAuthCookie(authority);
        const headers = {
          'Host': authority,
          'Origin': url.origin,
        };
        if (cookie) headers['Cookie'] = cookie;
        const clientReq = http.request(
          url,
          {
            method: 'GET',
            headers,
            timeout: 2500,
          },
          (res) => {
            res.resume();
            const alive = res.statusCode !== 502 && res.statusCode !== 503;
            resolve(alive);
          }
        );
        clientReq.on('error', () => {
          resolve(false);
        });
        clientReq.on('timeout', () => {
          clientReq.destroy();
          resolve(false);
        });
        clientReq.end();
      } catch {
        resolve(false);
      }
    });
  }

  dshHostAliveInflight = (async () => {
    let alive = await probeOnce();
    if (!alive) {
      // 快速延迟 100ms 二次确认，滤除因 GC 或瞬态网络抖动引起的误报
      await new Promise((r) => setTimeout(r, 100));
      alive = await probeOnce();
    }
    dshHostAliveCache = { alive, at: Date.now() };
    return alive;
  })().finally(() => {
    dshHostAliveInflight = null;
  });

  return dshHostAliveInflight;
}

/**
 * 宿主 session/list 全量 items 的短缓存 + In-Flight 单飞复用。
 *
 * 背景（对齐 dsh web 协议事实 + BB10 慢链路实测）：宿主 session/list RPC 体积大
 * （2.4MB 级），慢链路下耗时可到 6~16s。/api/session/subagents（按 U 打开多智能体
 * 看板）与 /api/sessions 等消费方共享同一次 RPC，避免每次开看板都重新向宿主拉全量，
 * 这是看板“先显标题再显详情”懒加载的带宽与延迟前提。
 */
// 契约 C-17（Lead 实测修正 C-2）：宿主 session/list 真实全量返回实测 474435ms / 3891 items，
// 故主通道超时 ≥600000ms、成功 TTL ≥1800000ms、失败退避 ≥300000ms。
// 主通道永远后台化 + 单一在飞：绝不进入任何请求的热路径，失败绝不清空已知 running（C-1/C-4）。
const HOST_LIST_FULL_TTL_MS = 1800000;
const HOST_LIST_FULL_TIMEOUT_MS = 600000;
const HOST_LIST_FULL_FAIL_BACKOFF_MS = 300000;
// mock 模式保持短 TTL：mock RPC 是进程内同步调用，测试需要即时可见性（生产语义不变）。
const HOST_LIST_FULL_TTL_MS_MOCK = 8000;
let hostSessionListFullCache = { items: null, at: 0 };
let hostSessionListFullInflight = null;
let hostSessionListFullNextAttemptAt = 0;
let hostSessionListFullFailStreak = 0;

function hostListFullTtlMs() {
  return Q20_MOCK_HOST ? HOST_LIST_FULL_TTL_MS_MOCK : HOST_LIST_FULL_TTL_MS;
}

/**
 * 获取宿主 session/list 完整 items；宿主不可达或 RPC 失败返回 null（调用方降级为空列表）。
 * - 单一在飞（C-1）：任意时刻全进程最多 1 个 session/list 在飞，并发调用挂靠同一 Promise。
 * - 失败退避（C-2/C-17）：失败后 ≥300s 内不再发起，且**绝不清空**已知 running 快照（C-4）。
 * - force=true 仅穿透成功缓存，不穿透失败退避（避免重试风暴）。
 */
async function fetchHostSessionListFull(force = false) {
  const now = Date.now();
  if (!force && hostSessionListFullCache.items !== null
    && (now - hostSessionListFullCache.at < hostListFullTtlMs())) {
    return hostSessionListFullCache.items;
  }
  if (hostSessionListFullInflight) {
    return hostSessionListFullInflight;
  }
  if (now < hostSessionListFullNextAttemptAt) {
    return hostSessionListFullCache.items;
  }
  hostSessionListFullInflight = (async () => {
    try {
      const result = await callDshWebRpc('session/list', { _request: {} }, HOST_LIST_FULL_TIMEOUT_MS, { rawArgs: true });
      let items = null;
      if (result.ok && result.value && Array.isArray(result.value.items)) {
        items = result.value.items;
        hostSessionListFullCache = { items, at: Date.now() };
        hostSessionListFullNextAttemptAt = 0;
        hostSessionListFullFailStreak = 0;
      } else {
        // 失败：保留既有快照（可能为 null），进入退避窗口；绝不把已知 running 清空
        hostSessionListFullFailStreak++;
        hostSessionListFullNextAttemptAt = Date.now() + HOST_LIST_FULL_FAIL_BACKOFF_MS;
        console.warn(`[HOST-LIST] session/list failed attempt=${hostSessionListFullFailStreak} `
          + `backoff=${HOST_LIST_FULL_FAIL_BACKOFF_MS}ms kept=${hostSessionListFullCache.items === null ? 'none' : hostSessionListFullCache.items.length}`);
      }
      return items;
    } catch (err) {
      hostSessionListFullFailStreak++;
      hostSessionListFullNextAttemptAt = Date.now() + HOST_LIST_FULL_FAIL_BACKOFF_MS;
      console.warn(`[HOST-LIST] session/list threw attempt=${hostSessionListFullFailStreak} backoff=${HOST_LIST_FULL_FAIL_BACKOFF_MS}ms error=${err && err.message}`);
      return hostSessionListFullCache.items;
    } finally {
      hostSessionListFullInflight = null;
    }
  })();
  return hostSessionListFullInflight;
}

/**
 * 同步窥视主通道缓存中的 session/list items（绝不发起/等待 RPC）。
 * C-3：热路径只允许读取已知快照，缺失/过期时由 scheduleHostSessionListRefresh 后台刷新。
 */
function peekHostSessionListFull() {
  return Array.isArray(hostSessionListFullCache.items) ? hostSessionListFullCache.items : null;
}

/**
 * C-3/C-11：后台（fire-and-forget）刷新共享主通道；失败退避与单一在飞由主通道自身保证。
 * 走 fetchHostSessionListData：成功快照会同时刷新 running/title 缓存并批量播种 live 镜像（C-11）。
 */
function scheduleHostSessionListRefresh(force = false) {
  try {
    const p = fetchHostSessionListData(force);
    if (p && typeof p.then === 'function') p.catch(() => { /* 后台刷新失败静默：绝不进入任何请求的响应路径 */ });
  } catch { /* 同步异常同样不得冒泡到请求路径 */ }
}

/**
 * 统一获取宿主 session/list 的全量数据（合并 running 与 title 提取，带 In-Flight 单飞复用）。
 * 避免 getHostTitleMap 与 getHostRunningSessionIds 分别发起庞大的 2.4MB RPC。
 * 原始 items 复用 fetchHostSessionListFull 的共享缓存与单飞，两路消费只触发一次 RPC。
 */
async function fetchHostSessionListData(force = false) {
  const now = Date.now();
  const runningValid = !force && hostRunningCache.ids !== null && (now - hostRunningCache.at < HOST_RUNNING_CACHE_TTL_MS);
  const titleValid = !force && hostTitleCache.map !== null && (now - hostTitleCache.at < HOST_TITLE_CACHE_TTL_MS);
  if (runningValid && titleValid) {
    return { ids: hostRunningCache.ids, map: hostTitleCache.map };
  }
  if (hostSessionListInflight) {
    return hostSessionListInflight;
  }
  hostSessionListInflight = (async () => {
    try {
      const items = await fetchHostSessionListFull(force);
      const reqNow = Date.now();
      let ids = null;
      let map = null;
      if (Array.isArray(items)) {
        ids = new Set(items.filter((i) => i && i.running).map((i) => String(i.sessionId)));
        map = new Map();
        for (const i of items) {
          if (!i || !i.sessionId) continue;
          const t = i.title || (i.projections && i.projections.values && i.projections.values.title);
          if (typeof t === 'string' && t) map.set(String(i.sessionId), t);
          // C-20：由快照 cwd 登记 durable 目录（零磁盘 IO），供 /api/sessions/status 按需求值桥接
          indexSessionDirByCwd(i.sessionId, i.cwd);
        }
        // C-11：成功快照批量播种 live 镜像（不覆盖更新的 live 事件事实），失败时绝不触碰镜像
        if (hostLiveState) {
          try { hostLiveState.noteListItems(items); } catch (err) {
            console.warn(`[HOST-LIVE] noteListItems failed conn=${hostLiveState.getStreamId() || '-'} ${err && err.message}`);
          }
        }
      }
      // 失败（items === null）时保留既有 ids/map，绝不清空已知 running（C-4）
      if (ids !== null) hostRunningCache = { ids, at: reqNow };
      if (map !== null) hostTitleCache = { map, at: reqNow };
      return { ids: hostRunningCache.ids, map: hostTitleCache.map };
    } finally {
      hostSessionListInflight = null;
    }
  })();
  return hostSessionListInflight;
}

/** 宿主权威会话标题（projections.values.title，含 rename 后即时值），15s 缓存；宿主不可达返回 null（调用方保持本地标题）。 */
async function getHostTitleMap(force = false) {
  const now = Date.now();
  if (!force && hostTitleCache.map !== null && now - hostTitleCache.at < HOST_TITLE_CACHE_TTL_MS) {
    return hostTitleCache.map;
  }
  const data = await fetchHostSessionListData(force);
  return data.map;
}
/** DSH Web 宿主 view 中正在运行(running)的会话 id 集合，短缓存（可显式 force 绕过）；宿主不可达返回 null。 */
async function getHostRunningSessionIds(force = false) {
  const now = Date.now();
  if (!force && hostRunningCache.ids !== null && now - hostRunningCache.at < HOST_RUNNING_CACHE_TTL_MS) {
    return hostRunningCache.ids;
  }
  const data = await fetchHostSessionListData(force);
  return data.ids;
}

/**
 * C-3 同步窥视：已知 running 集合（无缓存即 null），绝不发起/等待宿主 RPC。
 * 热路径一律用本函数，缺失/过期时调用 scheduleHostSessionListRefresh 后台刷新。
 */
/** C-3 同步窥视：已知宿主标题 Map（无缓存即 null）。 */
function peekHostTitleMap() {
  return (hostTitleCache.map !== null) ? hostTitleCache.map : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话运行事实缓存（进程内，零宿主 RPC / 零磁盘 IO）
//   生产者：isSessionUiRunning（/api/sessions 等热路径的实际判定结果）
//   消费者：/api/sessions/status（C-18）——保证与 /api/sessions 口径一致（A8）
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_RUNNING_FACT_TTL_MS = 60000;
const SESSION_RUNNING_FACT_MAX = 5000;
const sessionRunningFacts = new Map(); // sid -> { running, source, at }

function noteSessionRunningFact(sessionId, running, source) {
  const key = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!key) return;
  sessionRunningFacts.set(key, { running: !!running, source: source, at: Date.now() });
  if (sessionRunningFacts.size > SESSION_RUNNING_FACT_MAX) {
    const now = Date.now();
    for (const [k, v] of sessionRunningFacts) {
      if (now - v.at > SESSION_RUNNING_FACT_TTL_MS) sessionRunningFacts.delete(k);
      if (sessionRunningFacts.size <= SESSION_RUNNING_FACT_MAX) break;
    }
  }
}

function peekSessionRunningFact(sessionId) {
  const key = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!key) return null;
  const hit = sessionRunningFacts.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SESSION_RUNNING_FACT_TTL_MS) {
    sessionRunningFacts.delete(key);
    return null;
  }
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话 durable 目录索引（进程内）：由既有磁盘扫描 / 宿主快照填充；
// 仅在 C-20 桥接的按需定位中做一次有界查找（见 locateSessionDirForStatus），其余路径零磁盘 IO。
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_DIR_INDEX_MAX = 20000;
const sessionDirIndex = new Map(); // sid -> sessionDir

function indexSessionDir(sessionId, sessionDir) {
  const key = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!key || !sessionDir) return;
  if (sessionDirIndex.size >= SESSION_DIR_INDEX_MAX && !sessionDirIndex.has(key)) return;
  sessionDirIndex.set(key, sessionDir);
}

/** 由宿主快照的 cwd 推导 durable 目录（零磁盘 IO；仅登记，不做存在性校验）。 */
function indexSessionDirByCwd(sessionId, cwd) {
  const key = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!key || !cwd) return;
  try {
    indexSessionDir(key, path.join(SESSIONS_ROOT, projectKey(path.resolve(cwd)), key));
  } catch { /* 非法 cwd：跳过索引 */ }
}

// C-25 尾部精确判定的短缓存（与 sessionTerminalState 同款 mtime+size 键）
const TURN_TAIL_CACHE_TTL_MS = 2000;
const turnTailCache = new Map();

/**
 * C-25：C-20 自带更精确的「回合未终结」判定。
 * `sessionTerminalState()` 把 cancelled/aborted/interrupted/blocked 的 turn/end 也映射为 'stopped'，
 * 与「未终结」不可区分，会把已取消会话在 300s 窗口内误报 running。此处独立判定：
 * 仅当尾部最后一条终结性事件是进行中类事件（user/message、turn/start、step/start、tool/call、
 * assistant/message）且其后无任何 turn/end 或 assistant/chunk(finish) 时才视为未终结。
 * 不改动 sessionTerminalState 的既有语义。
 */
function transcriptTurnUnterminated(zstdPath) {
  if (!zstdPath) return false;
  try {
    const st = fs.statSync(zstdPath);
    const cacheKey = `${zstdPath}:${st.mtimeMs}:${st.size}`;
    const now = Date.now();
    const cached = turnTailCache.get(cacheKey);
    if (cached && now - cached.at < TURN_TAIL_CACHE_TTL_MS) return cached.value;
    const buf = fs.readFileSync(zstdPath);
    const frames = scanZstdFrames(buf);
    let value = false;
    if (frames.length > 0) {
      let tailText = '';
      const maxFrames = Math.min(frames.length, 30);
      for (let i = frames.length - maxFrames; i < frames.length; i++) {
        try { tailText += zlib.zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8'); } catch { /* skip corrupted frame */ }
      }
      let unterminated = false;
      for (const line of tailText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let o;
        try { o = JSON.parse(trimmed); } catch { continue; }
        if (o.type === 'turn/end') { unterminated = false; continue; }
        if (o.type === 'assistant/chunk' && o.data && o.data.chunk && o.data.chunk.type === 'finish') { unterminated = false; continue; }
        if (o.type === 'user/message' || o.type === 'turn/start' || o.type === 'step/start'
          || o.type === 'tool/call' || o.type === 'assistant/message') {
          unterminated = true;
        }
      }
      value = unterminated;
    }
    if (turnTailCache.size > 500) turnTailCache.clear();
    turnTailCache.set(cacheKey, { value, at: now });
    return value;
  } catch {
    return false;
  }
}

/** C-20 桥接的同步 IO 部分：durable 尾部未终结（C-25 精确判定）+ mtime 新鲜。 */
function coldStartBridgeByZstd(zstdPath) {
  if (!zstdPath) return false;
  if (sessionTerminalState(zstdPath, null) !== 'stopped') return false;
  if (!transcriptTurnUnterminated(zstdPath)) return false;
  try {
    const st = fs.statSync(zstdPath);
    return Date.now() - st.mtimeMs <= HOST_LIVE_BRIDGE_MTIME_MS;
  } catch {
    return false;
  }
}

/** C-20 桥接（含 flock 前置）：与 isSessionUiRunning 完全同口径。 */
async function coldStartBridgeRunning(sessionDir) {
  if (!sessionDir) return false;
  if (!(await isSessionLocked(sessionDir))) return false;
  return coldStartBridgeByZstd(findSessionZstdPath(sessionDir));
}

// 未命中缓存（短 TTL）：重复查询未知 sid 不再产生磁盘 IO（C-18 P95 ≤300ms）
const sessionDirMissIndex = new Map();
const SESSION_DIR_MISS_TTL_MS = 30000;

/**
 * C-20 桥接所需的 durable 目录定位（有界 + 可缓存）：
 *   1) 进程内索引命中 → 零磁盘 IO；
 *   2) 已注册工作区（内存镜像 workspace.json）推导 projectKey 目录 → 逐目录 statSync（≤ 工作区数）；
 *   3) 兜底：SESSIONS_ROOT 一级目录（≤ 项目目录数）逐个 statSync。
 * 命中/未命中均入缓存，重复查询不再产生磁盘 IO。
 * F4（安全）：入口先过 isValidSessionId，非法 id 直接返回 null，绝不参与任何 fs 路径拼接。
 * 注意：C-18 的「零磁盘 IO」在「无任何权威事实」的 C-20 桥接路径上由 C-20 显式覆盖；
 * 其余路径（有 live/list 权威事实或已有事实缓存）严格零磁盘 IO。
 */
function locateSessionDirForStatus(sessionId) {
  const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!sid || !isValidSessionId(sid)) return null;
  const hit = sessionDirIndex.get(sid);
  if (hit) return hit;
  const missAt = sessionDirMissIndex.get(sid);
  if (missAt && Date.now() - missAt < SESSION_DIR_MISS_TTL_MS) return null;

  const candidates = [];
  try {
    const doc = readWorkspaceDomain();
    const tables = doc && doc.tables && doc.tables.workspaces;
    if (tables) {
      for (const ws of Object.values(tables)) {
        if (!ws || typeof ws.path !== 'string') continue;
        try { candidates.push(path.join(SESSIONS_ROOT, projectKey(path.resolve(ws.path)), sid)); } catch { /* 非法路径跳过 */ }
      }
    }
  } catch { /* workspace 镜像不可读：继续兜底 */ }
  try {
    for (const p of fs.readdirSync(SESSIONS_ROOT)) candidates.push(path.join(SESSIONS_ROOT, p, sid));
  } catch { /* SESSIONS_ROOT 不可读：无候选 */ }

  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) {
        indexSessionDir(sid, dir);
        sessionDirMissIndex.delete(sid);
        return dir;
      }
    } catch { /* 继续下一个候选 */ }
  }
  if (sessionDirMissIndex.size >= SESSION_DIR_INDEX_MAX) sessionDirMissIndex.clear();
  sessionDirMissIndex.set(sid, Date.now());
  return null;
}

/**
 * G1：已知 session/list 快照的「新鲜度上限」（与主通道 TTL 一致）。
 * 过期快照的缺席按未知处理；快照命中的 positive 事实仍可用于提升（绝不下压）。
 */
const HOST_SNAPSHOT_MAX_AGE_MS = HOST_LIST_FULL_TTL_MS;
let hostSnapshotIndex = { items: null, map: null };

/**
 * G1：已知 list 快照的 sid→running 全量索引（含 false），过期或缺失返回 null。
 * 只读主通道缓存，绝不发起/等待 RPC。
 */
function peekHostSnapshotRunningMap() {
  const items = peekHostSessionListFull();
  if (!Array.isArray(items)) return null;
  const age = Date.now() - hostSessionListFullCache.at;
  if (!(age >= 0) || age > HOST_SNAPSHOT_MAX_AGE_MS) return null;
  if (hostSnapshotIndex.items === items && hostSnapshotIndex.map) return hostSnapshotIndex.map;
  const map = new Map();
  for (const i of items) {
    if (!i || !i.sessionId) continue;
    map.set(String(i.sessionId), !!i.running);
  }
  hostSnapshotIndex = { items: items, map: map };
  return map;
}

/**
 * G1/G2：会话运行判定的**唯一函数**（C-4 单点口径）。
 * `/api/sessions` 行、`/api/session/prompt` 插队闸门、`/api/sessions/status` 三处全部调用本函数，
 * 保证三者结论一致（避免「列表报 running 而 status 报非 running」的自激对账循环）。
 *
 * 顺序（严格 C-4 + G1）：
 *   1) 本地 activeTask running → true（source 'task'，C-24）；
 *   2) live 事件镜像持有该 sid 的权威事实（含 false）→ 直接采用（source 'live'）；
 *   3) 已知 list 快照**命中该 sid**（含 false，且快照在新鲜度上限内）→ 采用（source 'list'）；
 *      快照**未命中/过期** ⇒ 未知，**不得当作 false**，继续走桥接（G1）；
 *   4) 进程内正向事实缓存（只提升，保证短窗口内三处同口径）；
 *   5) C-20 冷启动桥接（只提升不降级）：flock 被占 && C-25 精确尾部未终结 && mtime ≤300s（source 'heuristic'）。
 *
 * @returns {Promise<{ isRunning: boolean, source: 'task'|'live'|'list'|'heuristic' }>}
 */
async function resolveSessionRunning(input) {
  const opts = (input && typeof input === 'object') ? input : {};
  const task = opts.task || null;
  const sid = (opts.sid === undefined || opts.sid === null) ? '' : String(opts.sid);
  if (opts.sessionDir && sid) indexSessionDir(sid, opts.sessionDir);

  // 1) 本地 task（G2）
  if (task && task.status === 'running') {
    noteSessionRunningFact(sid, true, 'task');
    return { isRunning: true, source: 'task' };
  }
  if (!sid) return { isRunning: false, source: 'heuristic' };

  // 2) live 事件镜像（权威真源，含 false）
  if (hostLiveState && hostLiveState.hasRunningTruth(sid)) {
    const live = hostLiveState.getSession(sid);
    const running = !!(live && live.running);
    const source = hostLiveState.getSource(sid) || 'live';
    noteSessionRunningFact(sid, running, source);
    return { isRunning: running, source: source };
  }

  // 3) 已知 list 快照：仅「命中该 sid」才算权威（缺席/过期一律按未知）
  const snapshot = peekHostSnapshotRunningMap();
  if (snapshot && snapshot.has(sid)) {
    const running = !!snapshot.get(sid);
    noteSessionRunningFact(sid, running, 'list');
    return { isRunning: running, source: 'list' };
  }

  // 4) 正向事实缓存（只提升）：短窗口内保证 /api/sessions 与 /api/sessions/status 同口径
  const fact = peekSessionRunningFact(sid);
  if (fact && fact.running) {
    return { isRunning: true, source: fact.source || 'heuristic' };
  }

  // 5) C-20 冷启动桥接（只提升不降级）
  const dir = opts.sessionDir || sessionDirIndex.get(sid) || locateSessionDirForStatus(sid);
  const bridged = await coldStartBridgeRunning(dir);
  // 负结论也入缓存（供诊断/防抖），但读取侧只采信正向事实
  noteSessionRunningFact(sid, bridged, 'heuristic');
  return { isRunning: bridged, source: 'heuristic' };
}

/**
 * 会话"运行中"判定（UI 用）：resolveSessionRunning 的薄包装（保持既有调用签名）。
 * forceFresh 只触发后台刷新，绝不在热路径等待宿主 RPC（C-3）。
 */
async function isSessionUiRunning(task, sessionDir, sessionId, forceFresh = false) {
  if (forceFresh) scheduleHostSessionListRefresh(true);
  const resolved = await resolveSessionRunning({ task: task, sessionDir: sessionDir, sid: sessionId });
  return resolved.isRunning;
}

/**
 * C-18/C-20/C-24/C-25：/api/sessions/status 的单 sid 事实（与 resolveSessionRunning 同口径）。
 * known:true 表示持有权威事实（live/list/task）或桥接提升；known:false 表示无权威事实（前端严禁据此降级）。
 */
async function sessionStatusFact(sessionId) {
  const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  // F4：非法 id（含路径穿越）一律不参与任何 fs 访问
  if (!sid || !isValidSessionId(sid)) return { isRunning: false, state: 'idle', known: false, source: '' };

  // U1（C-24/G2）：必须把本地 activeTask 一并传入唯一判定函数。
  // 否则宿主失联走 SDK 回退时，同一会话 /api/sessions 报 running 而 status 报非 running，
  // 前端见 known:true&&!isRunning 即判 down 并置对账 cwd → 5s 自激 loadSessions 循环。
  const resolved = await resolveSessionRunning({ task: activeTasks.get(sid), sid: sid });
  if (resolved.isRunning) {
    return { isRunning: true, state: 'running', known: true, source: resolved.source || 'heuristic' };
  }
  const authoritative = (resolved.source === 'live' || resolved.source === 'list' || resolved.source === 'task');
  return {
    isRunning: false,
    state: 'idle',
    known: authoritative,
    source: authoritative ? resolved.source : '',
  };
}

/**
 * 按 DSH 官方归属规则解析工作区 id：会话头 cwd 的规范路径等于工作区 path。
 * 数据源是宿主持久镜像 workspace.json（只读，写路径永远走宿主 RPC）。
 */
async function resolveWorkspaceIdByCwd(targetCwd) {
  try {
    const canonical = await realpathNormalize(targetCwd);
    const doc = readWorkspaceDomain();
    const tables = doc && doc.tables && doc.tables.workspaces;
    if (!tables) return null;
    for (const [wid, ws] of Object.entries(tables)) {
      if (!ws || typeof ws.path !== 'string') continue;
      if (ws.path === canonical) return wid;
    }
  } catch (err) {
    console.warn(`[WARN] resolveWorkspaceIdByCwd failed: ${err.message}`);
  }
  return null;
}

/**
 * 从 durable 会话事件流派生 Q20 SSE 事件（delta/thought/tool）。
 * 子进程引擎（SDK session.event 通知）与宿主 RPC 引擎（session/follow 帧）
 * 共用同一解析逻辑：两者承载的都是同一 durable SessionEvent 形状。
 */
/**
 * Durable 会话事件 → Q20 SSE 派生（薄包装：实现要lib/session-events.mjs，
 * 供测试直驱）。
 */
function createSessionEventHandler(task) {
  return createSessionEventHandlerImpl(task, {
    broadcastTaskEvent,
    computeToolSummary,
    extractToolResultOutput,
    extractEventUsage,
    createUsageFold,
    pressureFrom,
    createStreamFold,
  });
}

/**
 * 用户提问（ask_user_question）应答桥 —— 与 dsh web ui-user-questions 同构：
 *   宿主 waterfall 'user-questions/request' → Q20 SSE 'question' 事件 → 浏览器
 *   极简作答组件 → POST /api/session/question → 宿主 $events/result RPC 回填。
 * clientId 来自 $events 流首帧 ready，eventId 逐帧对应，二者缺一不可。
 */

/** 校验浏览器提交的答案批次（与 dsh answerEntries 同口径，custom 收敛为 trim 非空）。 */
function validateAskAnswers(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const answers = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.id !== 'string' || !entry.id) return null;
    if (!Array.isArray(entry.selected)) return null;
    for (const sel of entry.selected) {
      if (typeof sel !== 'string') return null;
    }
    if (entry.custom !== undefined && typeof entry.custom !== 'string') return null;
    const answer = { id: entry.id, selected: entry.selected.slice() };
    const trimmedCustom = typeof entry.custom === 'string' ? entry.custom.replace(/^\s+|\s+$/g, '') : '';
    if (trimmedCustom !== '') {
      answer.custom = trimmedCustom;
    }
    answers.push(answer);
  }
  return answers;
}

/** 通过 $events/result RPC 结算一条 Remote waterfall（result / next / rejected）。 */
function settleUserEvent(task, eventId, outcome) {
  const clientId = (task.pendingQuestion && task.pendingQuestion.clientId) || task.eventsClientId || '';
  if (!clientId || !eventId) {
    return Promise.resolve({ ok: false, error: 'missing $events clientId/eventId' });
  }
  return callDshWebRpc('$events/result', { clientId, eventId, outcome }, 10000, { rawArgs: true });
}

/** 清除并广播提问终态（answered/cancelled）；无挂起提问时为幂等 no-op。 */
function clearTaskPendingQuestion(task, type) {
  const pending = task.pendingQuestion;
  if (!pending) return;
  task.pendingQuestion = null;
  broadcastTaskEvent(task, 'question', { type: type || 'cancelled', eventId: pending.eventId });
}

/** 处理 $events 逻辑流 item 帧：ready / waterfall / cancel（emit 类转发事件与 Q20 无关）。 */
function handleUserEventsItem(task, v) {
  if (!v || typeof v !== 'object') return;
  if (v.type === 'ready') {
    task.eventsClientId = typeof v.clientId === 'string' ? v.clientId : '';
    // 防御：waterfall 先于 ready 到达（非网关协议顺序）时补投递一次
    if (task.pendingQuestion && !task.pendingQuestion.delivered) {
      task.pendingQuestion.clientId = task.eventsClientId;
      task.pendingQuestion.delivered = true;
      broadcastTaskEvent(task, 'question', {
        type: 'request',
        sessionId: task.sessionId,
        eventId: task.pendingQuestion.eventId,
        questions: task.pendingQuestion.questions,
      });
    }
    return;
  }
  if (v.type === 'waterfall' && v.event === 'user-questions/request') {
    // 跨会话隔离（关键防线）：$events 是 Gateway 全局复用流，所有连接的 client
    // 都会收到所有会话的 user-questions/request 广播（含新开流的 pending 重放）。
    // 帧内 agentId 即提问所属 SessionId。非本任务会话的提问必须立刻委托回瀑布
    // （next），绝不能在本 task 上设置 pendingQuestion 或以 task.sessionId 广播——
    // 否则其他会话的提问会以本会话身份弹出面板，且本院落错误留在 Gateway 的
    // deliveries 里，别人在正确会话作答后终态 cancel 会反过来击落本会话面板。
    const frameOwnership = classifyQuestionFrame(task.sessionId, v);
    if (frameOwnership === 'foreign') {
      if (task.eventsClientId && v.eventId) {
        settleUserEvent(task, v.eventId, { kind: 'next' });
      }
      return;
    }
    if (frameOwnership === 'skip') return;
    const questions = v.request && Array.isArray(v.request.questions) ? v.request.questions : null;
    if (!questions || questions.length === 0) {
      // 无法呈现的问题批次：按 dsh web 语义委托回瀑布（next），绝不吞掉请求
      settleUserEvent(task, v.eventId, { kind: 'next' });
      return;
    }
    task.pendingQuestion = {
      eventId: typeof v.eventId === 'string' ? v.eventId : '',
      clientId: task.eventsClientId || '',
      questions,
      delivered: !!task.eventsClientId,
      askedAt: Date.now(),
    };
    if (task.pendingQuestion.delivered && task.pendingQuestion.eventId) {
      broadcastTaskEvent(task, 'question', { type: 'request', sessionId: task.sessionId, eventId: task.pendingQuestion.eventId, questions });
    }
    console.log(`[USER QUESTION] session ${task.sessionId} pending (${questions.length} questions)`);
    return;
  }
  if (v.type === 'cancel') {
    if (task.pendingQuestion && task.pendingQuestion.eventId === v.eventId) {
      console.log(`[USER QUESTION] session ${task.sessionId} cancelled by host`);
      clearTaskPendingQuestion(task, 'cancelled');
    }
    return;
  }
}

/**
 * 在已连接的 remote.mux WebSocket 上打开 $events 逻辑流（user-questions waterfall 载体）。
 * payload 必须为精确空 args（网关强制校验）。
 */
function openUserEventsStream(ws, streamId) {
  ws.send(JSON.stringify({
    type: 'open',
    streamId,
    endpoint: '$events',
    payload: { args: {} },
  }));
}

/**
 * DSH Web 在线时的官方对话引擎（与 dsh web 自身完全同一路径）：
 *   session/create（宿主在此写入工作区归属）→ session/selectModel
 *   → /api/remote.mux 上打开 session/follow 流 → session/prompt
 *   → 按 durable 事件流推送 delta/thought/tool，turn/end 收尾。
 * 会话从此由宿主持有写租约——这正是 dsh web 的归属逻辑；离线时才回退
 * 子进程引擎（SDK），并保留 workspace.json 直写兜底。
 * 返回值协议（绝不盲目回退——宿主一旦持有会话，子进程必然撞锁）：
 *   'fallback-sdk'：宿主从未接管该会话（create 前不可达）或宿主已确认宕机
 *                   （租约随进程消亡），可安全回退子进程引擎；
 *   'done'        ：任务终结事件（done/error/cancelled）已发出；
 *   'failed'      ：宿主已接管会话后的失败，任务错误已发出，不可回退。
 */
async function runChatViaHostRpc(task, { targetCwd, provider, model, promptText, promptMode, receiptIds, imagePart }) {
  const sessionId = task.sessionId;
  const failTask = (message) => {
    task.status = 'error';
    task.error = message;
    broadcastTaskEvent(task, 'error', { message, code: classifyDshError(message), source: 'dsh' });
    return 'failed';
  };

  // 1) create：宿主创建或收养会话，并写入工作区归属（官方归属入口）
  const workspaceId = await resolveWorkspaceIdByCwd(targetCwd);
  const createRequest = workspaceId ? { sessionId, workspaceId } : { sessionId, cwd: targetCwd };
  let created = await callDshWebRpc('session/create', createRequest);
  if (!created.ok && workspaceId && !created.unreachable) {
    // 归属失败不应阻断对话：降级为 cwd-only 创建（按 DSH 规则落在 Ungrouped）
    created = await callDshWebRpc('session/create', { sessionId, cwd: targetCwd });
  }
  if (!created.ok) {
    if (created.unreachable) {
      // create 前不可达：纯文本可安全回退；附件消息无本地通道，诚实失败
      if (!!imagePart || (Array.isArray(receiptIds) && receiptIds.length > 0)) {
        return failTask('附件消息需宿主在线，当前宿主不可达，附件未发送，请稍后重试');
      }
      return 'fallback-sdk';
    }
    // 会话已被宿主（或正在运行的子进程回合）持有写租约：此时回退子进程必然
    // 再次撞锁，直接把冲突作为任务错误呈现。
    if (/already.?owned/i.test(String(created.code || '') + String(created.error || ''))) {
      return failTask('会话正被另一个进程运行（写租约冲突），请稍后再试');
    }
    return failTask(created.error || 'session/create failed');
  }

  if (sessionId && !createdSidsSeen.has(sessionId)) {
    createdSidsSeen.add(sessionId);
    workspacesCache = null;
    try { invalidateSessionsCache(targetCwd); } catch {}
  }

  // 2) 模型选择（与子进程模式 per-run provider/model 语义一致）
  if (provider && model) {
    const selected = await callDshWebRpc('session/selectModel', { sessionId, provider, model }, 10000);
    if (!selected.ok) return failTask(selected.error || 'session/selectModel failed');
  }

  // 2.5) mock 宿主：跳过真实 mux/WS/follow，合成完整回合（delta → done + 本地转录）。
  if (Q20_MOCK_HOST) {
    return runMockChatTurn(task, sessionId, targetCwd, promptText);
  }

  // 3) 打开 follow 流（ /api/remote.mux WebSocket 载体 ）
  const WebSocketImpl = loadWsModule();
  if (!WebSocketImpl) return failTask('ws module unavailable for /api/remote.mux stream');
  const authority = new URL(DSH_WEB_URL).host;
  const ws = new WebSocketImpl(DSH_WEB_URL.replace(/^http/, 'ws') + '/api/remote.mux', {
    headers: { Host: authority, Origin: DSH_WEB_URL, Cookie: getDshWebAuthCookie(authority) || '' },
  });
  task.rpc = { ws, sessionId, finished: false };

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      const t = setTimeout(() => reject(new Error('remote.mux open timeout')), 8000);
      ws.once('open', () => clearTimeout(t));
      ws.once('error', () => clearTimeout(t));
    });
  } catch (err) {
    return failTask(`remote.mux open failed: ${err.message}`);
  }

  // 在 mux 连接上打开 session/follow 逻辑流（durable 事件 + turn/end 终点）
  ws.send(JSON.stringify({
    type: 'open',
    streamId: 'q20-follow',
    endpoint: 'session/follow',
    // assistantStream:true：与 dsh web 同构，transient chunk 为唯一打字机
    // 源（chunk 按 frame.index 保序，durable settlement 只做终态结算）。
    payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
  }));

  // 同连接打开 $events 逻辑流：ask_user_question 的 user-questions/request
  // waterfall 由此到达（dsh web 客户端等价挂载）
  const eventsStreamId = `q20-events-${Math.random().toString(36).slice(2, 8)}`;
  openUserEventsStream(ws, eventsStreamId);

  const handler = createSessionEventHandler(task);
  let turnEnded = false;
  let streamError = null;
  const finishOnce = (fn) => {
    if (task.rpc.finished) return;
    task.rpc.finished = true;
    try { ws.close(); } catch {}
    // 流/回合终结时若仍有挂起提问，向浏览器广播取消以收起作答组件
    clearTaskPendingQuestion(task, 'cancelled');
    if (fn) fn();
  };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'item') {
      if (m.type === 'error') {
        if (m.streamId === eventsStreamId) {
          // $events 流故障不影响会话事件流：仅降级为无提问应答能力
          console.warn(`[WARN] $events stream error (non-fatal): ${m.error && m.error.message ? m.error.message : 'unknown'}`);
          return;
        }
        streamError = m.error && m.error.message ? m.error.message : 'remote stream error';
        finishOnce(() => {
          if (task.status !== 'cancelled' && !turnEnded) {
            task.status = 'error';
            task.error = streamError;
            broadcastTaskEvent(task, 'error', { message: streamError, code: classifyDshError(streamError), source: 'dsh' });
          }
        });
      }
      return;
    }
    const v = m.value;
    if (!v) return;
    if (m.streamId === eventsStreamId) {
      handleUserEventsItem(task, v);
      return;
    }
    if (v.type === 'event' && v.event) {
      if (v.event.type === 'agent/inbox/spliced' && v.event.data && Array.isArray(v.event.data.inserted)) {
        for (const item of v.event.data.inserted) {
          if (item && item.id) {
            const rpcId = item.source?.rpcId;
            if (!task.inboxQueue) task.inboxQueue = [];
            task.inboxQueue.push({ itemId: item.id, rpcId, text: item.content?.[0]?.text || '' });
            if (task.lastQueuedPrompt && (!task.lastQueuedPrompt.itemId || task.lastQueuedPrompt.requestId === rpcId)) {
              task.lastQueuedPrompt.itemId = item.id;
            }
          }
        }
      }
      if (v.event.type === 'turn/end') {
        turnEnded = true;
        const endReason = v.event.data?.reason;
        if (endReason && endReason.kind === 'error') {
          const errObj = endReason.error || {};
          const msg = errObj.message || '模型生成失败';
          finishOnce(() => {
            task.status = 'error';
            task.error = msg;
            task.errorCode = errObj.code;
            broadcastTaskEvent(task, 'error', {
              message: msg,
              code: classifyDshError(msg),
              source: 'dsh',
              details: errObj.code || '',
            });
          });
          return;
        }
      }
      handler.handleSessionEvent(v.event);
      if (turnEnded) {
        finishOnce(() => {
          task.status = 'done';
          hostRunningCache = { ids: null, at: 0 };
          const finalResponse = handler.state.accumulatedText || '未能获取到有效模型响应 (上游服务异常或鉴权失败)';
          task.finalResponse = finalResponse;
          broadcastTaskEvent(task, 'done', { sessionId, finalResponse });
          console.log(`[TASK COMPLETED via DSH host rpc] sessionId: ${sessionId}, final len: ${finalResponse.length}`);
        });
      }
    }
    // 实时消费 assistant-stream 帧：唯一 delta 源，按 frame.index 保序
    // （对齐 dsh ClientAssistantStream；durable settlement 只做 usage 结算）。
    if (v.type === 'assistant-stream' && v.frame) {
      handler.handleAssistantFrame(v.frame);
    }
  });
  ws.on('close', () => {
    finishOnce(() => {
      if (task.status === 'cancelled') {
        broadcastTaskEvent(task, 'cancelled', { sessionId, message: '用户已手动停止任务' });
        return;
      }
      if (streamError && !turnEnded) {
        task.status = 'error';
        task.error = streamError;
        broadcastTaskEvent(task, 'error', { message: streamError, code: classifyDshError(streamError), source: 'dsh' });
      } else if (!turnEnded) {
        // 流意外断开且无 turn/end：按当前累计文本收尾，避免任务悬挂
        task.status = 'done';
        const finalResponse = handler.state.accumulatedText || '会话流意外中断，请重试';
        task.finalResponse = finalResponse;
        broadcastTaskEvent(task, 'done', { sessionId, finalResponse });
      }
    });
  });
  ws.on('error', (err) => {
    streamError = streamError || err.message;
    finishOnce(() => {
      if (task.status !== 'cancelled' && !turnEnded) {
        task.status = 'error';
        task.error = err.message;
        broadcastTaskEvent(task, 'error', { message: err.message, code: classifyDshError(err.message), source: 'dsh' });
      }
    });
  });

  // 4) prompt（收据式 RPC；真正结束以 durable turn/end 为准）
  // imagePart/receiptIds 遇回退一律诚实失败：本地 SDK 子进程引擎无附件通道，
  // 静默丢弃附件发纯文本即撒谎（与“绝不静默丢弃”宪法冲突）。
  const hasAttachments = !!imagePart || (Array.isArray(receiptIds) && receiptIds.length > 0);
  const failAttachmentFallback = () => failTask('附件消息需宿主在线，当前宿主不可达，附件未发送，请稍后重试');
  // promptMode 仅接受上游 session/prompt 契约值 queue|steer，非法值由调用方前置 400。
  // receiptIds：Q20 上传收据（新会话首问挂文件用；去重、上限 5 个）。
  // imagePart：Q20 图片内联（png/jpeg/webp/gif），无需 sid，首条即可带图。
  var promptFileParts = [];
  if (Array.isArray(receiptIds)) {
    var seenRid = {};
    for (var rii = 0; rii < receiptIds.length; rii++) {
      var ridv = receiptIds[rii];
      if (typeof ridv !== 'string' || !ridv || seenRid[ridv]) continue;
      seenRid[ridv] = true;
      promptFileParts.push({ type: 'file', receiptId: ridv });
      if (promptFileParts.length >= 5) break;
    }
  }
  if (imagePart) promptFileParts.push(imagePart);
  const prompted = await callDshWebRpc('session/prompt', {
    requestId: `q20-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    mode: (promptMode === 'steer' || promptMode === 'queue') ? promptMode : 'queue',
    content: promptFileParts.concat([{ type: 'text', text: promptText }]),
  }, 10000);
  if (!prompted.ok) {
    if (prompted.unreachable && !turnEnded) {
      // 宿主在接管后宕机：写租约随进程消亡，子进程引擎可安全接管——
      // 但附件消息无本地通道，诚实失败不回退
      if (hasAttachments) return failAttachmentFallback();
      finishOnce(() => {});
      return 'fallback-sdk';
    }
    return failTask(prompted.error || 'session/prompt failed');
  }
  return 'done';
}

/**
 * 为后台正在运行的会话建立宿主 follow 流桥接（如果 activeTask 不存在或已非 running）。
 * 当客户端点击/切换到外部进程或之前未被内存监控的正在运行的会话时调用。
 */
async function attachHostFollowToSession(sessionId, targetCwd) {
  let task = activeTasks.get(sessionId);
  if (task && task.status === 'running') {
    return task;
  }

  const WebSocketImpl = loadWsModule();
  if (!WebSocketImpl) return null;

  task = {
    sessionId,
    cwd: targetCwd ? path.resolve(targetCwd) : process.cwd(),
    harness: null,
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    listeners: new Set(),
    finalResponse: null,
    error: null,
  };
  // 建桥保留挂起：旧 task 若有未结算的提问挂起（pendingQuestion），迁移到新 task，
  // 避免 attach 建桥瞬间整体替换导致浏览器提交时撞上 no pending。
  try {
    const prevTask = activeTasks.get(sessionId);
    if (prevTask && prevTask !== task && prevTask.pendingQuestion && prevTask.pendingQuestion.eventId) {
      task.pendingQuestion = prevTask.pendingQuestion;
    }
  } catch {}
  activeTasks.set(sessionId, task);

  const authority = new URL(DSH_WEB_URL).host;
  let ws;
  try {
    ws = new WebSocketImpl(DSH_WEB_URL.replace(/^http/, 'ws') + '/api/remote.mux', {
      headers: { Host: authority, Origin: DSH_WEB_URL, Cookie: getDshWebAuthCookie(authority) || '' },
    });
  } catch (err) {
    console.warn(`[ATTACH HOST] Failed to instantiate WebSocket: ${err.message}`);
    activeTasks.delete(sessionId);
    return null;
  }

  task.rpc = { ws, sessionId, finished: false };

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      const t = setTimeout(() => reject(new Error('remote.mux open timeout')), 6000);
      ws.once('open', () => clearTimeout(t));
      ws.once('error', () => clearTimeout(t));
    });
  } catch (err) {
    console.warn(`[ATTACH HOST] remote.mux connection failed: ${err.message}`);
    try { ws.close(); } catch {}
    activeTasks.delete(sessionId);
    return null;
  }

  // 开启 session/follow 逻辑流
  ws.send(JSON.stringify({
    type: 'open',
    streamId: `q20-follow-attach-${sessionId.slice(-6)}`,
    endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
  }));

  // 桥接路径同样挂载 $events 流：外部运行会话的提问也能在 Q20 上应答
  const eventsStreamId = `q20-events-${Math.random().toString(36).slice(2, 8)}`;
  openUserEventsStream(ws, eventsStreamId);

  const handler = createSessionEventHandler(task);
  let turnEnded = false;
  let streamError = null;

  const finishOnce = (fn) => {
    if (task.rpc.finished) return;
    task.rpc.finished = true;
    try { ws.close(); } catch {}
    clearTaskPendingQuestion(task, 'cancelled');
    if (fn) fn();
  };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'item') {
      if (m.type === 'error') {
        if (m.streamId === eventsStreamId) {
          console.warn(`[WARN] $events stream error (non-fatal): ${m.error && m.error.message ? m.error.message : 'unknown'}`);
          return;
        }
        streamError = m.error && m.error.message ? m.error.message : 'remote stream error';
        finishOnce(() => {
          if (task.status !== 'cancelled' && !turnEnded) {
            task.status = 'error';
            task.error = streamError;
            broadcastTaskEvent(task, 'error', { message: streamError, code: classifyDshError(streamError), source: 'dsh' });
          }
        });
      }
      return;
    }
    const v = m.value;
    if (!v) return;
    if (m.streamId === eventsStreamId) {
      handleUserEventsItem(task, v);
      return;
    }
    if (v.type === 'event' && v.event) {
      if (v.event.type === 'agent/inbox/spliced' && v.event.data && Array.isArray(v.event.data.inserted)) {
        for (const item of v.event.data.inserted) {
          if (item && item.id) {
            const rpcId = item.source?.rpcId;
            if (!task.inboxQueue) task.inboxQueue = [];
            task.inboxQueue.push({ itemId: item.id, rpcId, text: item.content?.[0]?.text || '' });
            if (task.lastQueuedPrompt && (!task.lastQueuedPrompt.itemId || task.lastQueuedPrompt.requestId === rpcId)) {
              task.lastQueuedPrompt.itemId = item.id;
            }
          }
        }
      }
      if (v.event.type === 'turn/end') {
        turnEnded = true;
        const endReason = v.event.data?.reason;
        if (endReason && endReason.kind === 'error') {
          const errObj = endReason.error || {};
          const msg = errObj.message || '模型生成失败';
          finishOnce(() => {
            task.status = 'error';
            task.error = msg;
            task.errorCode = errObj.code;
            broadcastTaskEvent(task, 'error', {
              message: msg,
              code: classifyDshError(msg),
              source: 'dsh',
              details: errObj.code || '',
            });
            setTimeout(() => {
              if (activeTasks.get(sessionId) === task) activeTasks.delete(sessionId);
            }, 5 * 60 * 1000);
          });
          return;
        }
      }
      handler.handleSessionEvent(v.event);
      if (turnEnded) {
        finishOnce(() => {
          task.status = 'done';
          hostRunningCache = { ids: null, at: 0 };
          const finalResponse = handler.state.accumulatedText || '';
          task.finalResponse = finalResponse;
          broadcastTaskEvent(task, 'done', { sessionId, finalResponse });
          console.log(`[ATTACH HOST] Follow ended for session: ${sessionId}`);
          setTimeout(() => {
            if (activeTasks.get(sessionId) === task) activeTasks.delete(sessionId);
          }, 5 * 60 * 1000);
        });
      }
    }
    // attach 路径已带 assistantStream:true：transient chunk 唯一 delta 源。
    if (v.type === 'assistant-stream' && v.frame) {
      handler.handleAssistantFrame(v.frame);
    }
  });

  ws.on('close', () => {
    finishOnce(() => {
      if (task.status === 'cancelled') {
        broadcastTaskEvent(task, 'cancelled', { sessionId, message: '用户已手动停止任务' });
      } else if (!turnEnded) {
        task.status = 'done';
        broadcastTaskEvent(task, 'done', { sessionId, finalResponse: handler.state.accumulatedText || '' });
      }
      setTimeout(() => {
        if (activeTasks.get(sessionId) === task) activeTasks.delete(sessionId);
      }, 5 * 60 * 1000);
    });
  });

  ws.on('error', (err) => {
    streamError = streamError || err.message;
    finishOnce(() => {
      if (task.status !== 'cancelled' && !turnEnded) {
        task.status = 'error';
        task.error = err.message;
        broadcastTaskEvent(task, 'error', { message: err.message, code: classifyDshError(err.message), source: 'dsh' });
      }
      setTimeout(() => {
        if (activeTasks.get(sessionId) === task) activeTasks.delete(sessionId);
      }, 5 * 60 * 1000);
    });
  });

  return task;
}

/**
 * 严格按照 DSH 官方 Workspace.attachSession 规范挂载会话到工作区：
 * 1. 查找匹配 targetCwd 的工作区记录。
 * 2. 验证 session header 的 cwd 与工作区 path 的规范化路径一致。
 * 3. 将 sessionId prepend 到工作区的 sessionIds 列表中，并更新 updatedAt。
 * 4. 采用 writeAtomic 协议安全回写 workspace.json 并刷新缓存。
 */
async function attachSessionToWorkspace(targetCwd, sessionId) {
  if (!sessionId || !targetCwd) return false;
  try {
    const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc.tables || !doc.tables.workspaces) return false;

    let canonicalTargetCwd = targetCwd;
    try {
      canonicalTargetCwd = await realpathNormalize(targetCwd);
    } catch {
      canonicalTargetCwd = path.resolve(targetCwd);
    }

    let targetWid = null;
    let targetWs = null;
    for (const [wid, ws] of Object.entries(doc.tables.workspaces)) {
      if (!ws || !ws.path) continue;
      let wsCanon = ws.path;
      try {
        wsCanon = await realpathNormalize(ws.path);
      } catch {
        wsCanon = path.resolve(ws.path);
      }
      if (wsCanon === canonicalTargetCwd) {
        targetWid = wid;
        targetWs = ws;
        break;
      }
    }

    if (!targetWid || !targetWs) {
      // 当前目录未在官方工作区登记，属于非官方工作区
      return false;
    }

    if (!Array.isArray(targetWs.sessionIds)) {
      targetWs.sessionIds = [];
    }

    if (targetWs.sessionIds.includes(sessionId)) {
      return true; // 已经挂载
    }

    // 将 sessionId 插入到头部（最新排列）
    targetWs.sessionIds = [sessionId, ...targetWs.sessionIds];
    targetWs.updatedAt = new Date().toISOString();

    const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw err;
    }

    const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
    workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
    workspacesCache = null;
    try { invalidateUngroupedCache(); } catch {}
    console.log(`[WORKSPACE ATTACH] Attached session ${sessionId} to workspace "${targetWs.title || targetWid}" (${canonicalTargetCwd})`);
    return true;
  } catch (err) {
    console.warn(`[WARN] Failed to attach session ${sessionId} to workspace: ${err.message}`);
    return false;
  }
}

/**
 * 工作区单名校验（Linux/macOS/Windows 三系统合法性交集；与前端 wsAddValidateName 同语义，服务端权威）。
 * 禁止：空、超长(>64字符)、`.`/`..`、`/ \ : * ? " < > |` 与控制字符、尾点、Windows 保留名（首尾空白 trim 后判定）。
 */
const WS_NAME_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
function validateWorkspaceName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '请输入工作区名称' };
  // 首尾空白属输入填充，先 trim；Windows 尾点禁令判 trim 后名（尾空格经 trim 已不可能残留）
  const name = raw.trim();
  if (!name) return { ok: false, error: '请输入工作区名称' };
  if (/\.$/.test(name)) return { ok: false, error: '名称不能以点结尾（Windows）' };
  if (name.length > 64) return { ok: false, error: '名称过长（≤64字符）' };
  if (name === '.' || name === '..') return { ok: false, error: '名称不能是 . 或 ..' };
  if (/[\/\\:\*\?"<>\|\x00-\x1F]/.test(name)) return { ok: false, error: '名称含非法字符（禁 / \\ : * ? " < > |）' };
  const base = name.toUpperCase().split('.')[0];
  if (WS_NAME_RESERVED.has(base)) return { ok: false, error: `名称是系统保留名（${base}）` };
  return { ok: true, name };
}

/**
 * 在家目录下按单名新建工作区（严格 create-only：默认就是 ~/ 下，不接受其它路径，
 * 遇已存在目录/文件/注册记录一律报冲突，绝不静默复用或绑定既有目录）。
 * 优先调用 DSH Web (3080) 的 RPC 'workspace/create'；
 * 若 DSH Web 离线，则以官方存储格式原子写入 ~/.dsh/storages/workspace.json。
 */
async function createHomeWorkspace(rawName) {
  const v = validateWorkspaceName(rawName);
  if (!v.ok) {
    throw new Error(v.error);
  }
  const target = path.join(MOCK_WORKSPACE_ROOT, v.name);
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      throw new Error(`~/ 下已存在同名文件: ${v.name}`);
    }
    throw new Error(`工作区已存在: ~/${v.name}，请换个名称`);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  let madeDir = false;
  try {
    fs.mkdirSync(target, { mode: 0o755 });
    madeDir = true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw new Error(`工作区已存在: ~/${v.name}，请换个名称`);
    }
    throw e;
  }
  const dropFreshDir = () => {
    try { if (madeDir) fs.rmdirSync(target); } catch {}
  };
  let canonicalPath;
  try {
    canonicalPath = await realpathNormalize(target);
  } catch (e) {
    dropFreshDir();
    throw e;
  }

  // 残留注册检查：同 canonical 已登记（删目录未注销的僵尸记录）同样视为重复，拒绝复用。
  try {
    const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
    const doc = JSON.parse(raw);
    const table = (doc && doc.tables && doc.tables.workspaces) || {};
    for (const ws of Object.values(table)) {
      if (!ws || !ws.path) continue;
      let wsCanon = ws.path;
      try {
        wsCanon = await realpathNormalize(ws.path);
      } catch {
        wsCanon = path.resolve(ws.path);
      }
      if (wsCanon === canonicalPath) {
        dropFreshDir();
        throw new Error(`工作区已存在: ~/${v.name}，请换个名称`);
      }
    }
  } catch (e) {
    if (e && e.message && e.message.indexOf('工作区已存在') === 0) throw e;
    // 注册表不可读则继续走创建主链路，由后继写入失败兜底报错
  }

  // 1. 优先尝试 DSH Web 官方 RPC (workspace/create)。宿主侧创建失败时删空目录回滚，避免 ~/ 下残留空文件夹。
  // 宿主不可达（ECONNREFUSED/超时/502/503 → unreachable）才走离线兜底；宿主已接管但拒收（duplicate/校验失败）直接报错，严禁回退撞锁。
  const rpcRes = await callDshWebRpc('workspace/create', { path: canonicalPath });
  if (rpcRes && rpcRes.ok && rpcRes.value && rpcRes.value.workspace) {
    workspacesCache = null; // 使工作区缓存失效
    const wsVal = rpcRes.value.workspace;
    return {
      created: true,
      workspace: {
        id: wsVal.workspaceId,
        cwd: wsVal.path,
        name: wsVal.title || defaultWorkspaceTitle(wsVal.path),
        sessionCount: Array.isArray(wsVal.sessionIds) ? wsVal.sessionIds.length : 0,
      },
    };
  }
  if (rpcRes && !rpcRes.unreachable) {
    dropFreshDir();
    throw new Error((rpcRes && (rpcRes.error || rpcRes.code)) || '宿主拒绝创建工作区');
  }

  // 2. 离线兜底：以 DSH 官方规格原子读写 workspace.json（此处必为新建，遇残留即报冲突回滚空目录）
  let raw;
  let doc;
  try {
    raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
    doc = JSON.parse(raw);
  } catch (e) {
    dropFreshDir();
    throw e;
  }
  if (!doc.tables || !doc.tables.workspaces) {
    doc.tables = doc.tables || {};
    doc.tables.workspaces = doc.tables.workspaces || {};
  }
  if (!doc.global || !Array.isArray(doc.global.workspaceIds)) {
    doc.global = doc.global || {};
    doc.global.workspaceIds = doc.global.workspaceIds || [];
  }

  // 检查是否已存在相同规范化路径的工作区（残留僵尸记录同样视为重复，绝不复用）
  for (const ws of Object.values(doc.tables.workspaces)) {
    if (!ws || !ws.path) continue;
    let wsCanon = ws.path;
    try {
      wsCanon = await realpathNormalize(ws.path);
    } catch {
      wsCanon = path.resolve(ws.path);
    }
    if (wsCanon === canonicalPath) {
      dropFreshDir();
      throw new Error(`工作区已存在: ~/${v.name}，请换个名称`);
    }
  }

  // 创建新工作区记录
  const id = crypto.randomUUID();
  const title = defaultWorkspaceTitle(canonicalPath);
  const now = new Date().toISOString();
  const record = {
    path: canonicalPath,
    title,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };

  doc.tables.workspaces[id] = record;
  doc.global.workspaceIds = [id, ...doc.global.workspaceIds];

  const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    dropFreshDir();
    throw err;
  }

  const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
  workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
  workspacesCache = null; // 失效本地工作区缓存

  console.log(`[WORKSPACE CREATE] Registered workspace "${title}" (${canonicalPath}) with id ${id}`);
  return {
    created: true,
    workspace: {
      id,
      cwd: canonicalPath,
      name: title,
      sessionCount: 0,
    },
  };
}

/**
 * 按 cwd 注销工作区注册（仅从列表移除，对齐官方 delete 语义：文件夹与会话日志保留，
 * 其会话落入 Ungrouped）。优先调宿主 workspace/delete（需 workspaceId，先按 canonical 查注册表）；
 * 宿主不可达才本地原子删注册表。成功后清 workspacesCache/workspaceDomainCache。
 * 宿主已接管但拒收 → 直接抛错，严禁回退。
 */
async function removeWorkspaceByCwd(rawCwd) {
  if (!rawCwd || typeof rawCwd !== 'string') {
    throw new Error('Missing required field "cwd"');
  }
  const canonical = path.resolve(rawCwd.trim());
  let targetId = null;
  let targetTitle = '';
  try {
    const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
    const doc = JSON.parse(raw);
    const table = (doc && doc.tables && doc.tables.workspaces) || {};
    for (const [wid, ws] of Object.entries(table)) {
      if (!ws || !ws.path) continue;
      let wsCanon = ws.path;
      try {
        wsCanon = await realpathNormalize(ws.path);
      } catch {
        wsCanon = path.resolve(ws.path);
      }
      if (wsCanon === canonical) {
        targetId = wid;
        targetTitle = ws.title || '';
        break;
      }
    }
  } catch (e) {
    throw new Error('工作区注册表不可读');
  }
  if (!targetId) {
    throw new Error('工作区未注册（可能已移除）');
  }
  // 1. 宿主优先
  const rpcRes = await callDshWebRpc('workspace/delete', { workspaceId: targetId });
  if (rpcRes && rpcRes.ok) {
    workspacesCache = null;
    invalidateUngroupedCache(); // 移除后其会话落袋未分组
    try {
      const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
      workspaceDomainCache = { data: JSON.parse(fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8')), mtimeMs: st.mtimeMs };
    } catch {}
    console.log(`[WORKSPACE REMOVE] Removed "${targetTitle || canonical}" via host RPC`);
    return { id: targetId, cwd: canonical, name: targetTitle || path.basename(canonical) };
  }
  if (rpcRes && !rpcRes.unreachable) {
    throw new Error((rpcRes && (rpcRes.error || rpcRes.code)) || '宿主拒绝移除工作区');
  }
  // 2. 离线兜底：本地原子删注册（tables.workspaces + global.workspaceIds），绝不碰目录
  const raw2 = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
  const doc2 = JSON.parse(raw2);
  if (!doc2.tables || !doc2.tables.workspaces || !doc2.tables.workspaces[targetId]) {
    throw new Error('工作区未注册（可能已移除）');
  }
  delete doc2.tables.workspaces[targetId];
  if (doc2.global && Array.isArray(doc2.global.workspaceIds)) {
    doc2.global.workspaceIds = doc2.global.workspaceIds.filter((x) => x !== targetId);
  }
  const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc2, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
  const st2 = fs.statSync(WORKSPACE_DOMAIN_FILE);
  workspaceDomainCache = { data: doc2, mtimeMs: st2.mtimeMs };
  workspacesCache = null;
  invalidateUngroupedCache(); // 移除后其会话落袋未分组
  console.log(`[WORKSPACE REMOVE] Removed "${targetTitle || canonical}" via local write`);
  return { id: targetId, cwd: canonical, name: targetTitle || path.basename(canonical) };
}

const ZSTD_MAGIC = 0xFD2FB528;

/**
 * Scan structurally complete frames in a concatenated Zstandard buffer without decompressing.
 * Node.js node:zlib exposes zstdDecompressSync for single frames.
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      break; // reserved frame-header bit
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;

    let corrupt = false;
    while (true) {
      if (buffer.length - offset < 3) {
        corrupt = true;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        corrupt = true;
        break;
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        corrupt = true;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (corrupt) break;

    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

/**
 * Decompress all complete frames in a concatenated Zstandard file,
 * with support for reverse tail frame decoding for fast cursor pagination.
 */
function decompressAllZstdFrames(buffer, maxTailFrames) {
  const frames = scanZstdFrames(buffer);
  let framesToDecode = frames;
  if (typeof maxTailFrames === 'number' && maxTailFrames > 0 && frames.length > maxTailFrames) {
    framesToDecode = frames.slice(frames.length - maxTailFrames);
  }
  let decompressed = '';
  for (const { start, end } of framesToDecode) {
    try {
      const chunk = zlib.zstdDecompressSync(buffer.subarray(start, end));
      decompressed += chunk.toString('utf8');
    } catch {
      // Ignore corrupted / partial trailing frames
    }
  }
  return decompressed;
}

/* @Q20-MODEL-SOURCE-START */
/**
 * Minimal YAML parser with zero dependencies for dsh 用户层配置文档
 * （~/.dsh/settings.yaml 旧格式，以及 ~/.dsh/profiles/<p>/cordis.patch.yml 新格式）。
 * 顶层既可能是映射（旧格式），也可能是序列（dsh ≥ 0.1.7-alpha.1 的 profile patch）。
 */
function parseYaml(str) {
  if (!str || typeof str !== 'string') return {};
  const lines = str.split('\n');
  let root = {};
  for (let i = 0; i < lines.length; i++) {
    const probe = lines[i].split(/(?<!["\x27])#/)[0].trim();
    if (!probe) continue;
    if (probe.startsWith('- ')) root = [];
    break;
  }
  const stack = [{ indent: -1, value: root }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const withoutComment = raw.split(/(?<!["\x27])#/)[0];
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.search(/\S/);
    const content = withoutComment.trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;

    if (content.startsWith('- ')) {
      const rest = content.slice(2).trim();
      let item;
      if (rest.includes(':') && !rest.startsWith('{') && !rest.startsWith('[')) {
        const colon = rest.indexOf(':');
        const k = rest.slice(0, colon).trim();
        const v = parseScalar(rest.slice(colon + 1).trim());
        item = { [k]: v };
        if (Array.isArray(parent)) {
          parent.push(item);
        }
        stack.push({ indent, value: item });
      } else {
        item = parseScalar(rest);
        if (Array.isArray(parent)) {
          parent.push(item);
        }
      }
    } else if (content.includes(':')) {
      const colon = content.indexOf(':');
      const key = content.slice(0, colon).trim();
      const rawVal = content.slice(colon + 1).trim();

      if (rawVal === '') {
        let isArray = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nextRaw = lines[j].split(/(?<!["\x27])#/)[0];
          if (!nextRaw.trim()) continue;
          isArray = nextRaw.trim().startsWith('- ');
          break;
        }
        const newVal = isArray ? [] : {};
        if (Array.isArray(parent)) {
          const last = parent[parent.length - 1];
          if (last && typeof last === 'object') {
            last[key] = newVal;
          }
        } else {
          parent[key] = newVal;
        }
        stack.push({ indent, value: newVal, key });
      } else {
        const val = parseScalar(rawVal);
        if (Array.isArray(parent)) {
          const last = parent[parent.length - 1];
          if (last && typeof last === 'object') {
            last[key] = val;
          }
        } else {
          parent[key] = val;
        }
      }
    }
  }
  return root;
}

function parseScalar(v) {
  if (v === '' || v === undefined) return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (!isNaN(v) && v !== '') return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 把「用户层模型配置文档」归一化为 { models, contextWindows }。
 *
 * dsh 0.1.7-alpha.1（feat(settings): project volatile Config through profile-backed
 * forms，#4587）把单一 ~/.dsh/settings.yaml 拆成 profile-backed Config 表单，
 * 用户层文档改为 profile 的 cordis.patch.yml：**顶层 YAML 数组**，每项
 * `{ id, config }`，llm-deepseek 的模型在 config.models、llm-pi-ai 的 provider
 * 在 config.providers。旧格式（≤ 0.1.6）仍按顶层映射读取，两种形状都要认。
 *
 * 纯函数：无 IO、无全局依赖，便于 test-unit 用标记块抽取后直接执行。
 */
function normalizeModelSections(doc) {
  const models = [];
  const contextWindows = {};
  const seen = new Set();

  function add(provider, m) {
    const key = provider + ':' + m.id;
    if (seen.has(key)) return;
    seen.add(key);
    models.push({
      provider: provider,
      model: m.id,
      name: m.name || m.id,
      contextWindow: Number(m.contextWindow) || 0,
    });
    if (Number(m.contextWindow) > 0) contextWindows[key] = Number(m.contextWindow);
  }

  function addDeepseekSection(section) {
    if (!section || !Array.isArray(section.models)) return;
    for (const m of section.models) {
      if (m && m.id) add('deepseek-official', m);
    }
  }

  function addPiAiSection(section) {
    if (!section || !section.providers || typeof section.providers !== 'object') return;
    for (const providerKey of Object.keys(section.providers)) {
      const pConfig = section.providers[providerKey];
      if (!pConfig || !Array.isArray(pConfig.models)) continue;
      for (const m of pConfig.models) {
        if (m && m.id) add(providerKey, m);
      }
    }
  }

  if (Array.isArray(doc)) {
    // 新格式：profile patch 的 loader 补丁条目数组
    for (const entry of doc) {
      if (!entry || typeof entry.id !== 'string') continue;
      const config = (entry.config && typeof entry.config === 'object') ? entry.config : {};
      if (entry.id === 'llm-deepseek') addDeepseekSection(config);
      else if (entry.id === 'llm-pi-ai') addPiAiSection(config);
    }
  } else if (doc && typeof doc === 'object') {
    // 旧格式：settings.yaml 顶层映射
    addDeepseekSection(doc['llm-deepseek']);
    addPiAiSection(doc['llm-pi-ai']);
  }

  return { models: models, contextWindows: contextWindows };
}

/**
 * 读取用户层配置文档里声明的默认 provider/model（agent-default-model 条目）。
 * 新旧两种文档形状共用，缺省返回 null。
 */
function normalizeDefaultSelection(doc) {
  let section = null;
  if (Array.isArray(doc)) {
    for (const entry of doc) {
      if (entry && entry.id === 'agent-default-model'
        && entry.config && typeof entry.config === 'object') {
        section = entry.config;
        break;
      }
    }
  } else if (doc && typeof doc === 'object') {
    section = doc['agent-default-model'] || null;
  }
  if (!section) return null;
  if (!section.provider && !section.model) return null;
  return { provider: section.provider || '', model: section.model || '' };
}
/* @Q20-MODEL-SOURCE-END */

/**
 * dsh ≥ 0.1.7-alpha.1（#4587）把单一 ~/.dsh/settings.yaml 换成 profile-backed Config：
 * 用户层文档迁到 profiles/<name>/cordis.patch.yml（顶层 YAML 数组），旧文件被
 * 改名成 settings.yaml.imported 后不再更新。因此磁盘读取必须认这个新家。
 * `dsh web` 固定落在 web profile，故优先读它；其余 profile 仅作补充。
 */
const PROFILES_ROOT = path.join(DSH_HOME, 'profiles');
const PREFERRED_PROFILE = 'web';

/** 按优先级收集磁盘用户层配置文档：新格式 profile patch 在前，旧格式 settings.yaml 兜底。 */
function readSettingsDocuments() {
  const docs = [];
  try {
    if (fs.existsSync(PROFILES_ROOT)) {
      const names = fs.readdirSync(PROFILES_ROOT).filter((name) => {
        try {
          return fs.statSync(path.join(PROFILES_ROOT, name, 'cordis.patch.yml')).isFile();
        } catch (err) {
          return false;
        }
      });
      names.sort((a, b) => {
        if (a === PREFERRED_PROFILE) return -1;
        if (b === PREFERRED_PROFILE) return 1;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
      for (const name of names) {
        const file = path.join(PROFILES_ROOT, name, 'cordis.patch.yml');
        const parsed = parseYaml(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) docs.push(parsed);
      }
    }
  } catch (err) {
    console.warn('[MODEL SOURCE] failed to read profile patches:', err.message);
  }
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      docs.push(parseYaml(fs.readFileSync(SETTINGS_FILE, 'utf8')));
    }
  } catch (err) {
    console.warn('[MODEL SOURCE] failed to read settings.yaml:', err.message);
  }
  return docs;
}

/**
 * 离线兜底：从磁盘用户层文档提取模型目录与默认 provider/model。
 * 在线路径见 readModelCatalog()——优先用宿主 RPC 的权威目录。
 */
function readDshSettings() {
  const docs = readSettingsDocuments();
  const models = [];
  const contextWindows = {};
  const seenModelKey = new Set();
  let defaultSelection = null;

  for (const doc of docs) {
    const normalized = normalizeModelSections(doc);
    for (const m of normalized.models) {
      const key = `${m.provider}:${m.model}`;
      if (seenModelKey.has(key)) continue;
      seenModelKey.add(key);
      models.push(m);
    }
    for (const key of Object.keys(normalized.contextWindows)) {
      if (contextWindows[key] === undefined) contextWindows[key] = normalized.contextWindows[key];
    }
    if (!defaultSelection) defaultSelection = normalizeDefaultSelection(doc);
  }

  const current = {
    provider: (defaultSelection && defaultSelection.provider) || 'deepseek-official',
    model: (defaultSelection && defaultSelection.model) || 'deepseek-v4-flash',
    // 默认权限：新会话一律「工作区内修改」（对齐 dsh permission-presets 默认
    // workspace-write；危险等级「完全权限」必须由用户在界面显式选择并确认）
    permission: 'workspace-write',
  };

  // 权限预设（对齐 dsh web 官方目录与中文翻译：permission-presets 中文文案）
  //   1. workspace-write     工作区内修改（默认：沙箱限定工作区写入 + 越界需确认）
  //   2. danger-full-access  完全权限（无沙箱 + 不再确认，选择时前端需风险确认组件）
  //   3. read-only           仅可查看
  // requiresConfirm: 由服务端元数据驱动前端风险确认门禁（数据驱动而非前端 id
  // 白名单）——未来宿主新增需确认的档位（如 auto）仅需在此同步加标志。
  const permissions = [
    { id: 'workspace-write', name: '工作区内修改', requiresConfirm: false },
    { id: 'danger-full-access', name: '完全权限', requiresConfirm: true },
    { id: 'read-only', name: '仅可查看', requiresConfirm: false },
  ];

  // Ensure default model is included
  const currentKey = `${current.provider}:${current.model}`;
  if (!seenModelKey.has(currentKey)) {
    models.unshift({
      provider: current.provider,
      model: current.model,
      name: `${current.model} (${current.provider})`,
      contextWindow: Number(contextWindows[currentKey]) || 0,
    });
  }

  return { models, contextWindows, current, permissions };
}

/**
 * 在线权威路径：宿主 RPC `session/modelCatalog`（与 dsh web 官方模型选择器同一数据源）。
 * 返回 null 表示宿主不可达或目录为空，调用方退回磁盘镜像。
 *
 * 注意信封：modelCatalog 无入参，descriptor 只接受 `args: {}`（非 rawArgs 的
 * `{ request: {} }` 会被 gateway 判为 arguments-invalid）。
 */
async function readModelCatalogFromHost(disk) {
  const res = await callDshWebRpc('session/modelCatalog', {}, 6000, { rawArgs: true });
  if (!res || !res.ok || !res.value || !Array.isArray(res.value.groups)) {
    return null;
  }

  const models = [];
  const seen = new Set();
  for (const group of res.value.groups) {
    if (!group || typeof group.id !== 'string' || !Array.isArray(group.models)) continue;
    for (const m of group.models) {
      if (!m || !m.id) continue;
      const key = `${group.id}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        provider: group.id,
        model: m.id,
        name: m.name || m.id,
        // 目录本身不带 contextWindow（容量由适配器配置声明），用磁盘镜像补齐ctx环
        contextWindow: Number(disk.contextWindows[key]) || 0,
      });
    }
  }
  if (models.length === 0) return null;

  const hostDefault = res.value.default || {};
  const current = {
    provider: hostDefault.provider || disk.current.provider,
    model: hostDefault.model || disk.current.model,
    permission: disk.current.permission,
  };
  if (hostDefault.reasoningEffort) current.reasoningEffort = hostDefault.reasoningEffort;

  const currentKey = `${current.provider}:${current.model}`;
  if (!seen.has(currentKey)) {
    models.unshift({
      provider: current.provider,
      model: current.model,
      name: `${current.model} (${current.provider})`,
      contextWindow: Number(disk.contextWindows[currentKey]) || 0,
    });
  }

  return { models, contextWindows: disk.contextWindows, current, permissions: disk.permissions };
}

/**
 * 模型目录唯一入口：宿主 RPC 优先（管道①），宿主不可达时退回磁盘镜像（管道②兜底）。
 */
let modelCatalogCache = null;
let modelCatalogCacheAt = 0;
const MODEL_CATALOG_TTL_MS = 30000;

async function readModelCatalog() {
  const now = Date.now();
  if (modelCatalogCache && now - modelCatalogCacheAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache;
  }
  const disk = readDshSettings();
  try {
    const host = await readModelCatalogFromHost(disk);
    if (host) {
      modelCatalogCache = host;
      modelCatalogCacheAt = now;
      return host;
    }
  } catch (err) {
    console.warn('[MODEL SOURCE] host modelCatalog failed:', err.message);
  }
  // 磁盘镜像不进 TTL 缓存（读取磁盘 settings 文件耗时可忽略，宿主恢复后下一次请求可立即重新连接宿主）
  return disk;
}

/**
 * Read session metadata and attempt to extract session title or first user question.
 * Only a small file prefix is read: the session header lives in the first
 * zstd frame, and transcripts reach tens of MB — readFileSync of the whole
 * file per directory scan froze the event loop and ballooned RSS.
 */
const SESSION_HEADER_PREFIX_BYTES = 64 * 1024;
const BLANK_SESSION_MAX_BYTES = 4096;

/**
 * 转录头解析缓存（键：zstd 路径；指纹：mtimeMs + size）。
 *
 * 动机：工作区树与会话列表每次刷新都要逐条解析转录头部（64KB 前缀 + zstd 解压），
 * 才能拿到 id / cwd / 标题 / hasTurns。本机 sessions 树已达 4000+ 转录、1.4GB，
 * 一次全树解析是 7~8 秒同步 CPU，把事件循环整个占死：/api/bootstrap 冷启动
 * 10~15s、/healthz 最大阻塞 7.5s，手机端首屏即表现为"服务打不开"。
 * 转录只会在尾部追加，mtime/size 变化即代表需要重解析；未变化直接命中，
 * 全树扫描因此退化为 stat-only。
 */
const SESSION_HEADER_CACHE_MAX = 12000;
const sessionHeaderCache = new Map();

function readSessionHeader(filePath) {
  try {
    const fileStat = fs.statSync(filePath);
    const cached = sessionHeaderCache.get(filePath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      // 浅拷贝：调用方可能就地修改 header 字段，缓存对象不得被污染
      return cached.header ? Object.assign({}, cached.header) : null;
    }
    const header = parseSessionHeaderUncached(filePath);
    if (sessionHeaderCache.size >= SESSION_HEADER_CACHE_MAX) {
      // FIFO 淘汰（Map 保持插入序）：一次砍掉 1/4，避免无界增长与逐条删除开销
      let drop = Math.ceil(SESSION_HEADER_CACHE_MAX / 4);
      for (const key of sessionHeaderCache.keys()) {
        sessionHeaderCache.delete(key);
        if (--drop <= 0) break;
      }
    }
    sessionHeaderCache.set(filePath, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      header: header ? Object.assign({}, header) : null,
    });
    return header;
  } catch {
    return null;
  }
}

function parseSessionHeaderUncached(filePath) {
  try {
    const fileStat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      const head = Buffer.alloc(SESSION_HEADER_PREFIX_BYTES);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      buf = head.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
    // Scan up to 5 frames to extract title or first user message
    let frames = scanZstdFrames(buf, 5);
    if (!frames || frames.length === 0) {
      // Prefix did not contain a complete frame boundary: fall back to the
      // whole file (rare; e.g. an oversized first frame).
      buf = fs.readFileSync(filePath);
      frames = scanZstdFrames(buf, 5);
    }
    if (!frames || frames.length === 0) return null;

    let header = null;
    let title = '';
    let hasTurns = false;

    for (const f of frames) {
      try {
        const decomp = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
        const lines = decomp.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (!header && obj.id) {
              header = obj;
            }
            if (obj.type === 'session/title' && obj.data && obj.data.title) {
              title = obj.data.title;
            }
            if (obj.type === 'user/message') {
              hasTurns = true;
              const text = extractTextFromContent(obj.data?.message?.content || obj.data?.content);
              const genuine = cleanUserPrompt(text);
              if (genuine && !title) {
                title = genuine.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
              }
            } else if (obj.type === 'turn/start' || obj.type === 'assistant/message') {
              hasTurns = true;
            }
          } catch {
            // ignore
          }
        }
        if (title && hasTurns) break;
      } catch {
        // ignore
      }
    }

    if (header) {
      header.title = title || header.title || '';
      // If turn events were not observed in the prefix frames, check physical file size.
      // A genuine blank session (new session with only header and baseline configs) is ~400-600 bytes.
      // If the file exceeds BLANK_SESSION_MAX_BYTES (4KB), its turn/message frames exist
      // but exceeded the 64KB scan window — it cannot be blank.
      if (!hasTurns && fileStat && fileStat.size > BLANK_SESSION_MAX_BYTES) {
        hasTurns = true;
      }
      header.hasTurns = hasTurns;
    }
    return header;
  } catch {
    return null;
  }
}

/**
 * Count how many registered (non-archived) session ids actually resolve to an
 * on-disk session directory with a transcript (zstd). Mirrors the resolution
 * logic in getSessionsForCwd (dir named by sid, or header.id match) so the
 * workspace-tree count is always consistent with the session list.
 * Single-pass: builds one disk-side sid index (O(dir count)) instead of the
 * former O(registered × dirs) rescan, which froze the event loop on large
 * workspaces (e.g. 173 registered ids × 700+ dirs).
 */
function countResolvableRegistered(wsDir, sessionIds, archived) {
  if (!wsDir || !fs.existsSync(wsDir) || !Array.isArray(sessionIds)) return 0;
  const diskSids = new Set();
  let subdirs = null;
  try {
    subdirs = fs.readdirSync(wsDir);
  } catch {
    return 0;
  }
  for (const sub of subdirs) {
    if (sub.startsWith('.')) continue;
    const sPath = path.join(wsDir, sub);
    try {
      const st = fs.statSync(sPath);
      if (!st.isDirectory()) continue;
      const zstdPath = findSessionZstdPath(sPath);
      if (!zstdPath) continue;
      const header = readSessionHeader(zstdPath);
      const sidCandidate = String(header && header.id || sub);
      const task = activeTasks.get(sidCandidate) || (header && header.id ? activeTasks.get(String(header.id)) : null);
      const isRunning = task && task.status === 'running';
      if (!isRunning && header && header.hasTurns === false) {
        continue; // 过滤无实质消息的 blank 会话
      }
      diskSids.add(sidCandidate);
      if (header && header.id) {
        // also index by header.id so sid-named or header-matched ids hit
        diskSids.add(String(header.id));
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  let count = 0;
  for (const sid of sessionIds) {
    if (archived.has(String(sid))) continue;
    if (diskSids.has(String(sid)) || diskSids.has(sid)) count += 1;
  }
  return count;
}

/**
 * Scan ~/.dsh/sessions/ to discover all workspaces and their session counts.
 * 严格遵循 DSH 官方逻辑：如果 workspace.json 中有定义该工作区，其有效会话由注册的 sessionIds
 * 且磁盘上真实存在（可解析到 zstd 转录）者构成，并排除 archivedSessionIds。
 * Results are cached briefly: this scan reads a transcript header per session
 * dir, which is far too heavy to re-run on every /api/sessions call.
 */
const WORKSPACES_CACHE_TTL_MS = 10000;
let workspacesCache = null;
let workspacesCacheAt = 0;
const createdSidsSeen = new Set();

function getWorkspaces() {
  const now = Date.now();
  if (workspacesCache && now - workspacesCacheAt < WORKSPACES_CACHE_TTL_MS) {
    return workspacesCache;
  }
  const domain = readWorkspaceDomain();
  const officialWsMap = new Map();
  const archived = archivedWithOverlay();

  if (domain && domain.tables && domain.tables.workspaces) {
    // 严格遵循 DSH 官方：按 global.workspaceIds 权威顺序排列
    const order = (domain.global && Array.isArray(domain.global.workspaceIds)) ? domain.global.workspaceIds : Object.keys(domain.tables.workspaces);
    for (const wid of order) {
      const ws = domain.tables.workspaces[wid];
      if (!ws || !ws.path) continue;
      const sids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      const canonPath = path.resolve(ws.path);
      // 占位 0；真实计数在下方磁盘扫描循环中按实际目录收敛（与 /api/sessions 列表一致）
      officialWsMap.set(canonPath, {
        cwd: canonPath,
        name: ws.title || path.basename(canonPath) || canonPath,
        dirName: null,
        sessionCount: 0,
        sessionIds: sids,
        official: true,
      });
    }
  }

  if (!fs.existsSync(SESSIONS_ROOT)) {
    return Array.from(officialWsMap.values()).sort((a, b) => b.sessionCount - a.sessionCount);
  }

  const entries = fs.readdirSync(SESSIONS_ROOT);
  const workspacesMap = new Map(officialWsMap);

  for (const entry of entries) {
    const fullDir = path.join(SESSIONS_ROOT, entry);
    try {
      const st = fs.statSync(fullDir);
      if (!st.isDirectory()) continue;
      const subdirs = fs.readdirSync(fullDir);
      let resolvedCwd = null;
      let activeCount = 0;

      for (const s of subdirs) {
        if (s.startsWith('.')) continue;
        const sPath = path.join(fullDir, s);
        try {
          if (!fs.statSync(sPath).isDirectory()) continue;
          const files = fs.readdirSync(sPath);
          const zstdFile = files.find((f) => f.endsWith('.jsonl.zstd'));
          if (!zstdFile) continue;
          const header = readSessionHeader(path.join(sPath, zstdFile));
          if (!resolvedCwd && header && header.cwd) {
            resolvedCwd = header.cwd;
          }
          const sid = (header && header.id) || s;
          if (archived.has(String(sid)) || archived.has(s)) continue;
          const task = activeTasks.get(String(sid || '')) || (header && header.id ? activeTasks.get(String(header.id)) : null);
          const isRunning = !!(task && task.status === 'running');
          if (!isRunning && header && header.hasTurns === false) continue;
          activeCount += 1;
        } catch {
          // ignore
        }
      }

      if (!resolvedCwd && entry.startsWith('--') && entry.endsWith('--')) {
        const unslug = entry.slice(2, -2).replace(/-/g, '/');
        resolvedCwd = unslug.startsWith('/') ? unslug : `/${unslug}`;
      }

      if (resolvedCwd) {
        const canon = path.resolve(resolvedCwd);
        const existing = workspacesMap.get(canon);
        if (existing) {
          existing.dirName = entry;
          if (existing.official && Array.isArray(existing.sessionIds)) {
            // 官方工作区：只统计注册且未归档、且在磁盘上有真实转录文件的会话
            existing.sessionCount = countResolvableRegistered(fullDir, existing.sessionIds, archived);
          }
        } else {
          // 非官方工作区（未在 workspace.json 注册）：
          // 仅当为当前进程工作目录且物理存在时，作为唯一未注册工作区临时兜底；已注销/历史孤儿工作区一律过滤不显示，对齐 DSH Web 官方标准
          const isCurrentCwd = canon === path.resolve(process.cwd());
          const isTmp = canon.startsWith('/tmp/') || canon === '/tmp';
          const dirExists = fs.existsSync(canon);
          if (isCurrentCwd && !isTmp && dirExists) {
            workspacesMap.set(canon, {
              cwd: canon,
              name: path.basename(canon) || canon,
              dirName: entry,
              sessionCount: activeCount,
              sessionIds: null,
              official: false,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  workspacesCache = Array.from(workspacesMap.values()).sort((a, b) => b.sessionCount - a.sessionCount);
  workspacesCacheAt = Date.now();
  return workspacesCache;
}

/**
 * 启动预热：把全树转录头解析摊到多个事件循环轮次里做完。
 *
 * 冷启动后首次 /api/bootstrap 若撞上空白缓存，仍要一次性解压全树（7~8s）——
 * 恰是最糟的首屏时刻。listen 成功后以 setImmediate 分批（每批 24 条）预热，
 * 单批耗时约 40~60ms，既让 /healthz 等请求保持可响应，又让首屏请求撞到热缓存。
 * 预读只做只读解析，不产生任何写副作用；Q20_DISABLE_HEADER_WARM=1 可关闭（测试用）。
 */
const SESSION_HEADER_WARM_BATCH = 24;
let sessionHeaderWarmStarted = false;

function warmSessionHeaderCacheAsync() {
  if (sessionHeaderWarmStarted || process.env.Q20_DISABLE_HEADER_WARM === '1') return;
  sessionHeaderWarmStarted = true;

  const queue = [];
  try {
    for (const wsEntry of fs.readdirSync(SESSIONS_ROOT)) {
      const wsDir = path.join(SESSIONS_ROOT, wsEntry);
      let subdirs;
      try {
        if (!fs.statSync(wsDir).isDirectory()) continue;
        subdirs = fs.readdirSync(wsDir);
      } catch {
        continue;
      }
      for (const sub of subdirs) {
        if (sub.startsWith('.')) continue;
        const sPath = path.join(wsDir, sub);
        try {
          if (!fs.statSync(sPath).isDirectory()) continue;
          const zstdPath = findSessionZstdPath(sPath);
          if (zstdPath) queue.push(zstdPath);
        } catch {
          // ignore unreadable dirs
        }
      }
    }
  } catch {
    return;
  }
  if (queue.length === 0) return;

  let idx = 0;
  const startedAt = Date.now();
  function step() {
    const end = Math.min(idx + SESSION_HEADER_WARM_BATCH, queue.length);
    for (; idx < end; idx++) {
      try {
        readSessionHeader(queue[idx]);
      } catch {
        // ignore
      }
    }
    if (idx < queue.length) {
      setImmediate(step);
      return;
    }
    console.log(`[WARM] session header cache ready: ${queue.length} transcripts in ${Date.now() - startedAt}ms`);
  }
  setImmediate(step);
}

/**
 * 官方标准 projectKey 与 encodeSegment 算法（严格对齐 @deepseek-ai/dsh-session-persistence-jsonl）
 */
function encodeSegment(raw) {
  if (!raw || raw.length === 0) return '';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

function projectKey(cwd) {
  if (!cwd || cwd.length === 0) return '--root--';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/**
 * Find the session directory name in ~/.dsh/sessions/ matching a given cwd.
 */
function findWorkspaceDir(targetCwd) {
  if (!targetCwd) return null;
  const normalized = path.resolve(targetCwd);
  
  // 1. 优先使用官方确定的 projectKey(cwd) 寻址
  const pKey = projectKey(normalized);
  const exactPath = path.join(SESSIONS_ROOT, pKey);
  if (fs.existsSync(exactPath)) return exactPath;

  const workspaces = getWorkspaces();
  const match = workspaces.find((w) => path.resolve(w.cwd) === normalized);
  if (match) return path.join(SESSIONS_ROOT, match.dirName);

  // Fallback slug match
  const slug = normalized.replace(/[/\\:]/g, '-').replace(/^-+/, '');
  const candidate = path.join(SESSIONS_ROOT, `--${slug}--`);
  if (fs.existsSync(candidate)) return candidate;

  return null;
}

/**
 * Check whether a session directory is currently locked by a running process.
 */
async function isSessionLocked(sessionDir) {
  const lockFile = path.join(sessionDir, 'session.lock');
  if (!fs.existsSync(lockFile)) return false;
  if (!tryLockExclusive) {
    // If flock binding is not available, check if modified very recently (< 10s)
    try {
      const st = fs.statSync(lockFile);
      return Date.now() - st.mtimeMs < 10000;
    } catch {
      return false;
    }
  }

  let handle;
  try {
    handle = await fs.promises.open(lockFile, 'w');
    try {
      await tryLockExclusive(handle.fd);
      await handle.close();
      return false; // Acquired lock, so nobody else is holding it
    } catch (err) {
      await handle.close();
      if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
        return true; // Locked by another process!
      }
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 工作区会话列表短缓存与 In-Flight 去重：
 * 5秒 TTL 缓存每个 cwd 的解析结果；并发请求挂靠同一个 Promise，杜绝重复遍历与 RPC。
 * 发生写操作（创建会话、归档、分支）时可调用 invalidateSessionsCache(cwd) 失效。
 */
const SESSIONS_CACHE_TTL_MS = 5000;
const sessionsCache = new Map(); // cwd -> { list, at }
const sessionsInflight = new Map(); // cwd -> Promise<list>

function invalidateSessionsCache(targetCwd = null) {
  if (targetCwd) {
    const norm = path.resolve(targetCwd);
    for (const k of sessionsCache.keys()) {
      if (k === norm || k.startsWith(norm + '::')) sessionsCache.delete(k);
    }
  } else {
    sessionsCache.clear();
  }
}

async function getSessionsForCwdCached(targetCwd, filter = 'hide-archived') {
  const normalizedCwd = path.resolve(targetCwd);
  const normFilter = (filter === 'all' || filter === 'only-archived') ? filter : 'hide-archived';
  const cacheKey = normalizedCwd + '::' + normFilter;
  const now = Date.now();
  const cached = sessionsCache.get(cacheKey);
  if (cached && now - cached.at < SESSIONS_CACHE_TTL_MS) {
    return cached.list;
  }
  if (sessionsInflight.has(cacheKey)) {
    return sessionsInflight.get(cacheKey);
  }
  const promise = (async () => {
    try {
      const list = await getSessionsForCwd(targetCwd, normFilter);
      sessionsCache.set(cacheKey, { list, at: Date.now() });
      return list;
    } finally {
      sessionsInflight.delete(cacheKey);
    }
  })();
  sessionsInflight.set(cacheKey, promise);
  return promise;
}

/**
 * List all sessions in a workspace cwd.
 * 严格按照 DSH 官方规则：
 * 1. 如果工作区在 workspace.json 中登记，其有效会话由 ws.sessionIds 定义，并排除 global.archivedSessionIds。
 * 2. 如果工作区未在 workspace.json 中，则退回扫描目录并排除 archivedSessionIds。
 */
async function getSessionsForCwd(targetCwd, filter = 'hide-archived') {
  const wsDir = findWorkspaceDir(targetCwd);
  if (!wsDir || !fs.existsSync(wsDir)) return [];

  const normalizedCwd = path.resolve(targetCwd);
  const domain = readWorkspaceDomain();
  const archived = archivedWithOverlay();
  const normFilter = (filter === 'all' || filter === 'only-archived') ? filter : 'hide-archived';

  let registeredSessionIds = null;
  if (domain && domain.tables && domain.tables.workspaces) {
    for (const ws of Object.values(domain.tables.workspaces)) {
      if (ws && ws.path && path.resolve(ws.path) === normalizedCwd) {
        if (Array.isArray(ws.sessionIds)) {
          registeredSessionIds = ws.sessionIds;
        }
        break;
      }
    }
  }

  const list = [];

  // C-3：批量前置只读已知 running 快照（同步窥视，绝不等待宿主 RPC）；缺失/过期后台刷新。
  // live 事件镜像的权威事实由 isSessionUiRunning 逐行优先消费（C-4）。
  scheduleHostSessionListRefresh();
  // （G1）快照口径已收敛到 resolveSessionRunning 单点：此处只负责后台刷新

  if (registeredSessionIds !== null) {
    // 官方工作区：单遍扫描建立 header.id → 目录索引（O(目录数)），
    // 再按注册表 O(1) 查找。原实现对每个磁盘未命中的注册 sid 全目录
    // 暴力重扫（O(注册数×目录数)，173×726 时阻塞事件循环 ~9s）。
    const diskIndex = new Map();
    try {
      const allSubdirs = fs.readdirSync(wsDir);
      for (const sub of allSubdirs) {
        if (sub.startsWith('.')) continue;
        const sPath = path.join(wsDir, sub);
        try {
          const st0 = fs.statSync(sPath);
          if (!st0.isDirectory()) continue;
          const zstdPath0 = findSessionZstdPath(sPath);
          if (!zstdPath0) continue;
          const h = readSessionHeader(zstdPath0);
          if (h && h.id) diskIndex.set(String(h.id), { zstdPath: zstdPath0, dirStat: st0 });
        } catch {}
      }
    } catch {}

    for (const sid of registeredSessionIds) {
      const isArchived = archived.has(String(sid));
      if (normFilter === 'hide-archived' && isArchived) continue;
      if (normFilter === 'only-archived' && !isArchived) continue;
      let zstdPath = null;
      let st = null;

      // 1) 以 sid 命名的目录
      try {
        const sPath = path.join(wsDir, sid);
        const stDirect = fs.statSync(sPath);
        if (stDirect.isDirectory()) {
          const direct = findSessionZstdPath(sPath);
          if (direct) {
            zstdPath = direct;
            st = stDirect;
          }
        }
      } catch {
        // ignore
      }

      // 2) header.id 索引命中
      if (!zstdPath) {
        const hit = diskIndex.get(String(sid));
        if (hit) {
          zstdPath = hit.zstdPath;
          st = hit.dirStat;
        }
      }

      if (zstdPath && st) {
        try {
          const zst = fs.statSync(zstdPath);
          const header = readSessionHeader(zstdPath);
          const task = activeTasks.get(sid);
          const isRunning = await isSessionUiRunning(task, path.dirname(zstdPath), sid);
          if (!isRunning && header && header.hasTurns === false) {
            continue; // 过滤无实质消息的 blank 会话
          }
          list.push({
            id: sid,
            title: header?.title || '',
            createdAt: header?.createdAt || st.birthtimeMs,
            updatedAt: zst.mtimeMs,
            origin: header?.origin || 'user',
            agentPreset: header?.agentPreset,
            version: header?.version,
            cwd: header?.cwd || targetCwd,
            isRunning,
            isArchived,
            state: isRunning ? 'running' : sessionTerminalState(zstdPath, task),
          });
        } catch {}
      }
    }
    return applyHostTitles(list);
  }

  // 非官方登记的工作区：按目录扫描
  const subdirs = fs.readdirSync(wsDir);
  for (const s of subdirs) {
    if (s[0] === '.') continue;
    const sPath = path.join(wsDir, s);
    try {
      const st = fs.statSync(sPath);
      if (!st.isDirectory()) continue;
      const files = fs.readdirSync(sPath);
      const zstdFile = files.find((f) => f.endsWith('.jsonl.zstd'));
      if (!zstdFile) continue;

      const zstdPath = path.join(sPath, zstdFile);
      const zst = fs.statSync(zstdPath);
      const header = readSessionHeader(zstdPath);
      const sid = header?.id || s;
      const isArchived = archived.has(String(sid)) || archived.has(s);
      if (normFilter === 'hide-archived' && isArchived) continue;
      if (normFilter === 'only-archived' && !isArchived) continue;
      const task = activeTasks.get(sid);
      const isRunning = await isSessionUiRunning(task, sPath, sid);
      if (!isRunning && header && header.hasTurns === false) {
        continue; // 过滤无实质消息的 blank 会话
      }

      list.push({
        id: sid,
        title: header?.title || '',
        createdAt: header?.createdAt || st.birthtimeMs,
        updatedAt: zst.mtimeMs,
        origin: header?.origin || 'user',
        agentPreset: header?.agentPreset,
        version: header?.version,
        cwd: header?.cwd || targetCwd,
        isRunning,
        isArchived,
        state: isRunning ? 'running' : sessionTerminalState(zstdPath, task),
      });
    } catch {
      // ignore
    }
  }

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return applyHostTitles(list);
}

/**
 * 未分组会话（对齐 dsh web Ungrouped/sessionVisible）：磁盘上有真实转录、未归档、
 * 不在任何已注册工作区 sessionIds 中、且 origin 不是 subagent 的普通会话。
 * 注销工作区后其会话落入此处。仅本函数过滤 subagent（现有 C 面板口径不动，防回归）。
 * 10s 短缓存（写操作方 remove/archive 后由前端 loadUngrouped 主动刷新；Q20 双核防全量扫描阻塞）。
 */
let ungroupedCache = null;
let ungroupedCacheAt = 0;
const UNGROUPED_CACHE_TTL_MS = 10000;
function invalidateUngroupedCache() {
  ungroupedCache = null;
  ungroupedCacheAt = 0;
}
async function getUngroupedSessions() {
  const now = Date.now();
  if (ungroupedCache && now - ungroupedCacheAt < UNGROUPED_CACHE_TTL_MS) return ungroupedCache;
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const domain = readWorkspaceDomain();
  const archived = archivedWithOverlay();
  const registered = new Set();
  if (domain && domain.tables && domain.tables.workspaces) {
    for (const ws of Object.values(domain.tables.workspaces)) {
      if (ws && Array.isArray(ws.sessionIds)) {
        for (const sid of ws.sessionIds) registered.add(String(sid));
      }
    }
  }
  const list = [];
  const entries = fs.readdirSync(SESSIONS_ROOT);
  // C-3：只读已知快照（同步窥视），缺失/过期后台刷新
  scheduleHostSessionListRefresh();
  // （G1）快照口径已收敛到 resolveSessionRunning 单点：此处只负责后台刷新
  for (const entry of entries) {
    const fullDir = path.join(SESSIONS_ROOT, entry);
    let subdirs = null;
    try {
      if (!fs.statSync(fullDir).isDirectory()) continue;
      subdirs = fs.readdirSync(fullDir);
    } catch {
      continue;
    }
    for (const s of subdirs) {
      if (s.startsWith('.')) continue;
      const sPath = path.join(fullDir, s);
      try {
        if (!fs.statSync(sPath).isDirectory()) continue;
        const zstdPath = findSessionZstdPath(sPath);
        if (!zstdPath) continue;
        const header = readSessionHeader(zstdPath);
        const sid = (header && header.id) || s;
        if (archived.has(String(sid)) || archived.has(s)) continue;
        if (registered.has(String(sid))) continue;
        if (header && header.origin === 'subagent') continue; // 对齐官方 sessionVisible
        const task = activeTasks.get(sid);
        const isRunning = await isSessionUiRunning(task, sPath, sid);
        if (!isRunning && header && header.hasTurns === false) continue;
        const zst = fs.statSync(zstdPath);
        const st = fs.statSync(sPath);
        list.push({
          id: sid,
          title: (header && header.title) || '',
          createdAt: (header && header.createdAt) || st.birthtimeMs,
          updatedAt: zst.mtimeMs,
          origin: (header && header.origin) || 'user',
          agentPreset: header && header.agentPreset,
          version: header && header.version,
          cwd: (header && header.cwd) || '',
          isRunning,
          state: isRunning ? 'running' : sessionTerminalState(zstdPath, task),
        });
      } catch {
        // ignore
      }
    }
  }
  // 同 updatedAt 用 id 稳定 tie-break（对齐官方 orderByRecency）
  list.sort((a, b) => ((b.updatedAt || 0) - (a.updatedAt || 0)) || (String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0)));
  const out = await applyHostTitles(list);
  ungroupedCache = out;
  ungroupedCacheAt = Date.now();
  return out;
}

/**
 * 把宿主权威标题叠加到会话列表项上（本地 zstd 头部扫描只读前 5 帧，
 * 读不到 fork 后追加的 rename 事件；宿主 projections.values.title 即时可见）。
 * 宿主不可达时静默保持本地标题。
 */
async function applyHostTitles(list) {
  try {
    // C-3：只读已知快照 + 后台刷新，绝不在热路径等待宿主 RPC
    scheduleHostSessionListRefresh();
    const map = peekHostTitleMap();
    const liveTitles = hostLiveState ? hostLiveState.listAll() : [];
    if (!map && liveTitles.length === 0) return list;
    const liveById = new Map();
    for (const row of liveTitles) {
      if (row && row.sessionId && row.title) liveById.set(String(row.sessionId), row.title);
    }
    for (const item of list) {
      if (!item || !item.id) continue;
      const key = String(item.id);
      if (map && map.has(key)) {
        item.title = map.get(key);
      } else if (liveById.has(key)) {
        item.title = liveById.get(key);
      }
    }
  } catch {}
  return list;
}

/**
 * Fork 子会话标题递增（对齐 dsh web increasedForkTitle）：
 * 尾部半角 (N)/全角（N）数字递增，否则追加 ` (1)`。
 */
function increasedForkTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/.exec(title);
  if (ascii && ascii[1] !== undefined && ascii[2] !== undefined) {
    return ascii[1] + '(' + (BigInt(ascii[2]) + 1n).toString() + ')';
  }
  const fullWidth = /^(.*?)（(\d+)）$/.exec(title);
  if (fullWidth && fullWidth[1] !== undefined && fullWidth[2] !== undefined) {
    return fullWidth[1] + '（' + (BigInt(fullWidth[2]) + 1n).toString() + '）';
  }
  return title + ' (1)';
}

/**
 * Clean system prompts/directives and extract genuine user question.
 */
function cleanUserPrompt(rawText) {
  if (!rawText) return '';
  let cleaned = rawText.trim();
  // Strip [重要交互规范：...] prefix (legacy) and suffix (current)
  cleaned = cleaned.replace(/^\[重要交互规范：[^\]]*\]\s*/g, '');
  cleaned = cleaned.replace(/\s*\[重要交互规范：[^\]]*\]$/g, '');
  // Strip any leading system tags or directives
  cleaned = cleaned.replace(/^\[system:[^\]]*\]\s*/gi, '');
  cleaned = cleaned.replace(/^system:\s*/gi, '');
  return cleaned.trim();
}
/**
 * Extract text from user or assistant content structure
 */
function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === 'text' || c.text))
      .map((c) => c.text || '')
      .join('\n');
  }
  return '';
}

/* ==== Q20 消息内文件预览（图片 / txt / md）服务端事实源 ====
 * 数据来源只有两条只读通道：
 *   ① 官方附件对象存储镜像 ~/.dsh/attachments/v1（内容寻址，格式对齐
 *      dsh packages/attachment/attachment-local: objects/<sha2>/<sha> 与
 *      files/<sha2>/<sha>/<name>、file-objects/<sha2>/<sha>）；
 *   ② 注册工作区内的普通文件（markdown 图片/本地文件链接）。
 * 两条通道都只用白名单扩展名 + 只读 + 体积上限回应，绝不回显任意字节。 */
const ATTACHMENTS_ROOT = path.join(DSH_HOME, 'attachments', 'v1');
const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/;
const PREVIEW_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const PREVIEW_TEXT_EXTS = ['txt', 'md', 'markdown', 'log', 'json', 'csv', 'yml', 'yaml'];
const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;   // 文本预览硬上限（2GB 设备内存红线）
const PREVIEW_IMAGE_MAX_BYTES = 6 * 1024 * 1024;  // 图片预览硬上限（720p 归一化图 ~200KB，6MB 已很宽）

/** 预览闸门用的注册工作区 realpath 集合缓存。
 *  getWorkspaces() 冷启动要全量扫 ~1700 个会话目录（实测 3s，同步阻塞 SSE），
 *  预览是点击链路，绝不能每个请求付一次；60s TTL 内新增工作区最多延迟一分钟生效。 */
const REGISTERED_WS_CACHE_TTL_MS = 60000;
let registeredWsCache = { at: 0, roots: [] };

function registeredWorkspaceRoots() {
  const now = Date.now();
  if (registeredWsCache.roots.length > 0 && now - registeredWsCache.at < REGISTERED_WS_CACHE_TTL_MS) {
    return registeredWsCache.roots;
  }
  const roots = [];
  try {
    for (const ws of getWorkspaces()) {
      if (!ws || !ws.cwd) continue;
      try {
        roots.push(fs.realpathSync(path.resolve(ws.cwd)));
      } catch {
        // 目录已消失：跳过
      }
    }
  } catch {
    // 保持空集合（拒绝），下次请求重试
  }
  if (roots.length > 0) registeredWsCache = { at: now, roots };
  return roots;
}

/**
 * 预览闸门的工作区归属判定：先查官方注册表（mtime 缓存的一次小 JSON 读，
 * 毫秒级，覆盖 UI 工作区列表的权威来源），未命中再落到磁盘派生集合的
 * 60s 缓存——正常点击路径永不触发全量会话扫描。
 * @param rootReal - already realpath-resolved candidate root.
 */
function isRegisteredWorkspaceRoot(rootReal) {
  try {
    const domain = readWorkspaceDomain();
    const table = domain && domain.tables && domain.tables.workspaces;
    if (table) {
      for (const wid of Object.keys(table)) {
        const p = table[wid] && table[wid].path;
        if (!p) continue;
        try {
          if (fs.realpathSync(path.resolve(p)) === rootReal) return true;
        } catch {
          // 目录已消失：跳过
        }
      }
    }
  } catch {
    // 注册表不可读：退回磁盘派生集合
  }
  return registeredWorkspaceRoots().indexOf(rootReal) !== -1;
}

/** Lowercase extension of a display name ('' when none). */
function fileExtLower(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Preview class for one file: 'image' | 'text' | '' (not previewable).
 * Extension only — the extension must come from a server-derived name (stored
 * leaf or realpath basename); a caller-supplied media type is never consulted.
 */
function previewKindOf(name) {
  const ext = fileExtLower(name);
  if (PREVIEW_IMAGE_EXTS.indexOf(ext) !== -1) return 'image';
  if (PREVIEW_TEXT_EXTS.indexOf(ext) !== -1) return 'text';
  return '';
}

/**
 * Image signature sniffing. Used as the authoritative content gate for
 * extension-less attachment objects (and as a cross-check for extension-claimed
 * images), so a caller can never turn arbitrary bytes into a served file by
 * dressing up a query alias.
 * @returns 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | ''
 */
function detectImageMediaType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return '';
}

/** Strip every path component (POSIX and Windows) and control characters. */
function sanitizeLeafName(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw;
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) name = name.slice(slash + 1);
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\s+|\s+$/g, '');
  if (!name || name === '.' || name === '..') return '';
  return name.slice(0, 255);
}

/**
 * Resolve the immutable object path of one stored attachment. The digest is
 * content addressing and therefore the only thing that selects a file; the
 * display name is a sanitized alias leaf inside the digest directory.
 *
 * P0 安全（别信别名）：候选命中必须落在真实存在的存储叶名上，
 * 返回的 `gateName` 只能是**存储侧**的叶名或空串（空串走内容签名），
 * 绝不用调用方传来的 name 决定白名单与 Content-Type。
 * @returns {{ path: string, gateName: string } | null}
 */
function resolveAttachmentObjectPath(id, name) {
  const raw = String(id || '');
  if (!ATTACHMENT_ID_RE.test(raw)) return null;
  const sha = raw.slice(7);
  let rootReal;
  try {
    rootReal = fs.realpathSync(ATTACHMENTS_ROOT);
  } catch {
    rootReal = path.resolve(ATTACHMENTS_ROOT);
  }
  const leaf = sanitizeLeafName(name);
  const candidates = [];
  if (leaf) {
    candidates.push({
      path: path.join(ATTACHMENTS_ROOT, 'files', sha.slice(0, 2), sha, leaf),
      gateName: leaf,
    });
  }
  candidates.push({ path: path.join(ATTACHMENTS_ROOT, 'file-objects', sha.slice(0, 2), sha), gateName: '' });
  candidates.push({ path: path.join(ATTACHMENTS_ROOT, 'objects', sha.slice(0, 2), sha), gateName: '' });
  for (const candidate of candidates) {
    try {
      const st = fs.lstatSync(candidate.path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const real = fs.realpathSync(candidate.path);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
      return { path: real, gateName: candidate.gateName };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * SSR payload for the browser stream: the durable attachment references of one
 * user/message content array (dsh image/file parts), with only presentation
 * facts — the browser resolves bytes on demand through /api/attachment.
 */
function extractAttachmentsFromContent(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c) continue;
    const isImage = c.type === 'image';
    const isFile = c.type === 'file' || c.type === 'attachment';
    if (!isImage && !isFile) continue;
    const a = c.attachment;
    if (!a || typeof a.attachmentId !== 'string') continue;
    const name = sanitizeLeafName(a.name);
    const item = {
      kind: isImage ? 'image' : 'file',
      id: a.attachmentId,
      name,
      bytes: Number.isFinite(a.bytes) ? a.bytes : 0,
    };
    if (isImage) {
      item.mediaType = typeof a.mediaType === 'string' ? a.mediaType : '';
      item.width = Number.isFinite(a.width) ? a.width : 0;
      item.height = Number.isFinite(a.height) ? a.height : 0;
    }
    out.push(item);
  }
  return out;
}

/**
 * Shared read-only responder for both preview channels.
 *
 * P0 安全契约（别信别名）：`gateName` 必须由服务端从磁盘事实推导
 * （工作区文件的 basename、附件存储的叶名），调用方传来的 name 只作展示，
 * 永不参与白名单判定与 Content-Type 推导。无扩展名的附件对象只认内容签名；
 * 扩展名自称图片但内容签名不符同样拒绝。读取后再校一次长度（stat→read TOCTOU）。
 */
function servePreviewFile(req, res, absolutePath, gateName, cacheControl) {
  const kind = previewKindOf(gateName);
  const maxBytes = kind === 'text' ? PREVIEW_TEXT_MAX_BYTES : PREVIEW_IMAGE_MAX_BYTES;
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    sendJson(res, 404, { ok: false, error: 'preview file not found' }, req);
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    sendJson(res, 404, { ok: false, error: 'preview target is not a file' }, req);
    return;
  }
  if (stat.size > maxBytes) {
    sendJson(res, 413, { ok: false, error: 'file too large for preview', bytes: stat.size, maxBytes }, req);
    return;
  }
  let data;
  try {
    data = fs.readFileSync(absolutePath);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: sanitizeErrorMessage(err) }, req);
    return;
  }
  if (data.length > maxBytes) {
    sendJson(res, 413, { ok: false, error: 'file too large for preview', bytes: data.length, maxBytes }, req);
    return;
  }
  let contentType = '';
  if (kind === 'text') {
    contentType = fileExtLower(gateName) === 'json'
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8';
  } else {
    const sniffed = detectImageMediaType(data);
    if (!sniffed) {
      sendJson(res, 415, { ok: false, error: 'unsupported preview type' }, req);
      return;
    }
    contentType = sniffed;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(data.length),
    'Cache-Control': cacheControl || 'private, no-cache',
    ...SECURITY_HEADERS,
    ...getCorsHeaders(req),
  });
  res.end(data);
}

/**
 * Resolve a markdown-referenced workspace file inside the sandbox of one
 * registered workspace: realpath both sides and require containment, so `..`
 * segments and symlinks can never escape the workspace root.
 * @returns {{ ok: true, path: string } | { ok: false, status: number, error: string }}
 */
function resolveWorkspacePreviewPath(cwdRaw, filePathRaw) {
  if (!cwdRaw || !filePathRaw) return { ok: false, status: 400, error: 'Missing "cwd" or "path"' };
  let rootReal;
  try {
    rootReal = fs.realpathSync(path.resolve(String(cwdRaw)));
  } catch {
    return { ok: false, status: 400, error: 'Invalid "cwd"' };
  }
  let registered = false;
  try {
    registered = isRegisteredWorkspaceRoot(rootReal);
  } catch {
    registered = false;
  }
  if (!registered) return { ok: false, status: 403, error: 'workspace is not registered' };
  const requested = String(filePathRaw);
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(rootReal, requested);
  let targetReal;
  try {
    targetReal = fs.realpathSync(target);
  } catch {
    return { ok: false, status: 404, error: 'preview file not found' };
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    return { ok: false, status: 403, error: 'path escapes the workspace root' };
  }
  return { ok: true, path: targetReal };
}

/**
 * Compute a concise summary for a tool call.
 */
function computeToolSummary(name, rawArgs) {
  let args = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return rawArgs.replace(/[\r\n\t]+/g, ' ').slice(0, 60);
    }
  }
  if (!args || typeof args !== 'object') {
    return typeof rawArgs === 'string' ? rawArgs.replace(/[\r\n\t]+/g, ' ').slice(0, 60) : '';
  }

  if (args.command) return String(args.command).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
  if (name === 'ask_user_question' && args.questions && Array.isArray(args.questions)) {
    return args.questions.length + ' 个问题';
  }
  if (name === 'present' && args.files && Array.isArray(args.files)) {
    return args.files.length + ' 个交付文件';
  }
  if (args.cmd) return String(args.cmd).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
  if (args.file_path) return String(args.file_path).slice(0, 60);
  if (args.path) return String(args.path).slice(0, 60);
  if (args.file) return String(args.file).slice(0, 60);
  if (args.pattern) return String(args.pattern).slice(0, 60);
  if (args.url) return String(args.url).slice(0, 60);
  if (args.query) return String(args.query).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
  if (args.queries && Array.isArray(args.queries)) return args.queries.join(', ').slice(0, 60);
  if (args.description) return String(args.description).replace(/[\r\n\t]+/g, ' ').slice(0, 60);
  if (args.prompt) return String(args.prompt).replace(/[\r\n\t]+/g, ' ').slice(0, 60);

  const keys = Object.keys(args);
  if (keys.length > 0) {
    const val = args[keys[0]];
    if (typeof val === 'string' || typeof val === 'number') {
      return `${keys[0]}: ${String(val).replace(/[\r\n\t]+/g, ' ').slice(0, 60)}`;
    }
  }
  try {
    return JSON.stringify(args).slice(0, 60);
  } catch {
    return '';
  }
}

/**
 * Extract output text from tool result message data.
 */
function extractToolResultOutput(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  let text = '';
  const content = data.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && item.content) {
        if (Array.isArray(item.content)) {
          for (const sub of item.content) {
            if (sub && sub.text) text += (text ? '\n' : '') + sub.text;
          }
        } else if (typeof item.content === 'string') {
          text += (text ? '\n' : '') + item.content;
        }
      }
    }
  }
  if (!text && data.error) {
    text = typeof data.error === 'object' ? JSON.stringify(data.error) : String(data.error);
  }
  if (!text && data.output) {
    text = typeof data.output === 'object' ? JSON.stringify(data.output) : String(data.output);
  }
  if (!text && data.result) {
    text = typeof data.result === 'object' ? JSON.stringify(data.result) : String(data.result);
  }
  if (text.length > 8000) {
    text = text.slice(0, 8000) + '\n... (输出过长，已截断)';
  }
  return text;
}

/**
 * Classify a DSH execution error message into a coarse client-facing code.
 * Only affects the short label; the full message is always passed through.
 * Codes: 'auth' | 'ratelimit' | 'timeout' | 'upstream' | 'dsh-error'
 */
function classifyDshError(msg) {
  const s = String(msg || '').toLowerCase();
  if (/401|unauthor|forbidden|invalid (api )?key|token|鉴权|认证|登录/.test(s)) return 'auth';
  if (/429|rate.?limit|quota|too many|限流|配额/.test(s)) return 'ratelimit';
  if (/timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|超时|连接被拒绝/.test(s)) return 'timeout';
  if (/upstream|provider|model|502|503|504|overloaded|上游|模型/.test(s)) return 'upstream';
  return 'dsh-error';
}

/**
 * P0 安全：sessionId 白名单（拒绝 .. / 分隔符 / 编码遍历 / 超长）。
 * 真实目录形态：裸 UUID 与 `session-` 前缀；测试 ghost id 全小写连字符，均在白名单内。
 */
function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length >= 1 && sessionId.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(sessionId) && sessionId !== '.' && sessionId !== '..' &&
    sessionId.indexOf('..') === -1;
}

// P0 安全：服务端错误脱敏（路径/系统细节不出网）
function sanitizeErrorMessage(err) {
  const msg = (err && err.message) ? String(err.message) : 'Internal error';
  if (process.env.NODE_ENV === 'production') return 'Internal Server Error';
  return msg
    .replace(/[A-Za-z]:[\\/][^\s"'`;,]*/g, '[path]')
    .replace(/(^|[\s"'`(\[])\/(?:[^/\s"'`()[\]{}]+(?:\/[^/\s"'`()[\]{}]+)*)/g, '$1[path]')
    .replace(/\/home\/[^\s"'`;,]*/g, '[path]');
}

/**
 * Read session directory and path for a given targetCwd and sessionId.
 */
function findSessionDirUnindexed(targetCwd, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const wsDir = findWorkspaceDir(targetCwd);
  if (!wsDir || !fs.existsSync(wsDir)) return null;

  // 1. 优先使用官方确定的 encodeSegment(sessionId) 寻址
  const encSeg = encodeSegment(sessionId);
  if (encSeg) {
    const exactDir = path.join(wsDir, encSeg);
    if (fs.existsSync(exactDir)) return exactDir;
  }

  // 2. 直连 sessionId 匹配
  const directDir = path.join(wsDir, sessionId);
  if (fs.existsSync(directDir)) return directDir;

  const entries = fs.readdirSync(wsDir);
  for (const e of entries) {
    if (e === sessionId) {
      return path.join(wsDir, e);
    }
  }

  for (const e of entries) {
    const sPath = path.join(wsDir, e);
    try {
      if (!fs.statSync(sPath).isDirectory()) continue;
      const files = fs.readdirSync(sPath);
      const zstdFile = files.find((f) => f.endsWith('.jsonl.zstd'));
      if (zstdFile) {
        const header = readSessionHeader(path.join(sPath, zstdFile));
        if (header && header.id === sessionId) {
          return sPath;
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. 全局会话目录兜底：处理子智能体可能跨工作区或存放在独立目录的情况
  // P0 安全：归属校验——兜底命中必须位于当前工作区的注册目录或 projectKey 目录内，否则拒绝
  const allowedRoots = [];
  try {
    allowedRoots.push(fs.realpathSync(wsDir));
  } catch {
    allowedRoots.push(path.resolve(wsDir));
  }
  try {
    const pKeyDir = path.join(SESSIONS_ROOT, projectKey(path.resolve(targetCwd)));
    try {
      allowedRoots.push(fs.realpathSync(pKeyDir));
    } catch {
      allowedRoots.push(path.resolve(pKeyDir));
    }
  } catch {}
  try {
    const allWsDirs = fs.readdirSync(SESSIONS_ROOT);
    for (const d of allWsDirs) {
      if (d === '.' || d === '..') continue;
      const candidatePath = path.join(SESSIONS_ROOT, d, sessionId);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
        let realCandidate;
        try {
          realCandidate = fs.realpathSync(candidatePath);
        } catch {
          continue;
        }
        const owned = allowedRoots.some((root) => realCandidate === root || realCandidate.startsWith(root + path.sep));
        if (owned) return candidatePath;
      }
    }
  } catch {}

  return null;
}

/**
 * 会话目录定位 + 进程内索引登记（供 C-20 桥接在 /api/sessions/status 上按需求值）。
 */
function findSessionDir(targetCwd, sessionId) {
  const dir = findSessionDirUnindexed(targetCwd, sessionId);
  if (dir) indexSessionDir(sessionId, dir);
  return dir;
}

/**
 * Session terminal state, aligned with dsh web status semantics:
 *   running | stopped | error | done | idle
 * Priority: in-memory task status wins (running/cancelled/error/done);
 * otherwise infer from the transcript tail — a finish chunk with
 * reason.kind 'error' => error; a finished turn (turn/end or finish chunk)
 * => done; any activity but no finish => stopped (interrupted); nothing => idle.
 * Results are cached per file (mtime+size) for a short TTL so list refresh
 * and attach polls do not re-decode the tail on every call.
 */
const SESSION_STATE_CACHE_TTL_MS = 2000;
const sessionStateCache = new Map();

function sessionTerminalState(zstdPath, task) {
  if (task) {
    if (task.status === 'running') return 'running';
    if (task.status === 'cancelled') return 'stopped';
    if (task.status === 'error') return 'error';
    if (task.status === 'done') return 'done';
  }
  if (!zstdPath) return 'idle';
  try {
    const st = fs.statSync(zstdPath);
    const cacheKey = `${zstdPath}:${st.mtimeMs}:${st.size}`;
    const cached = sessionStateCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < SESSION_STATE_CACHE_TTL_MS) {
      return cached.state;
    }
    const buf = fs.readFileSync(zstdPath);
    const frames = scanZstdFrames(buf);
    if (frames.length === 0) return 'idle';
    let tailText = '';
    const maxFrames = Math.min(frames.length, 30);
    for (let i = frames.length - maxFrames; i < frames.length; i++) {
      try {
        tailText += zlib.zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8');
      } catch {
        // skip corrupted frame
      }
    }
    let latestState = 'idle';
    for (const line of tailText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed);
        if (o.type === 'user/message' || o.type === 'turn/start') {
          latestState = 'stopped';
        } else if (o.type === 'step/start' || o.type === 'tool/call' || o.type === 'assistant/message') {
          if (latestState === 'idle') latestState = 'stopped';
        } else if (o.type === 'assistant/chunk' && o.data && o.data.chunk && o.data.chunk.type === 'finish') {
          const rk = o.data.chunk.reason?.kind;
          if (rk === 'error') latestState = 'error';
          else if (rk === 'cancelled' || rk === 'aborted' || rk === 'interrupted' || rk === 'blocked') latestState = 'stopped';
          else latestState = 'done';
        } else if (o.type === 'turn/end') {
          const rk = o.data?.reason?.kind;
          if (rk === 'error') latestState = 'error';
          else if (rk === 'cancelled' || rk === 'aborted' || rk === 'interrupted' || rk === 'blocked') latestState = 'stopped';
          else latestState = 'done';
        }
      } catch {
        // ignore non-JSON lines
      }
    }
    const state = latestState;
    if (sessionStateCache.size > 500) sessionStateCache.clear();
    sessionStateCache.set(cacheKey, { state, at: now });
    return state;
  } catch {
    return 'idle';
  }
}

/**
 * Locate the session zstd transcript file path (v4 > v3 > v2 > legacy).
 * Shared by getSessionHistory and the attach poller's change detector.
 */
function findSessionZstdPath(sessionDir) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return null;
  const files = fs.readdirSync(sessionDir);
  const zstdFile =
    files.find((f) => f === 'session.v4.jsonl.zstd') ||
    files.find((f) => f === 'session.v3.jsonl.zstd') ||
    files.find((f) => f === 'session.v2.jsonl.zstd') ||
    files.find((f) => f.endsWith('.jsonl.zstd'));
  return zstdFile ? path.join(sessionDir, zstdFile) : null;
}

/**
 * Read and parse history messages from a session's zstd file.
 */
function getSessionHistory(targetCwd, sessionId) {
  const sessionDir = findSessionDir(targetCwd, sessionId);
  if (!sessionDir || !fs.existsSync(sessionDir)) return [];

  const zstdPath = findSessionZstdPath(sessionDir);
  if (!zstdPath) return [];

  const buf = fs.readFileSync(zstdPath);
  const fullText = decompressAllZstdFrames(buf);
  const lines = fullText.split('\n');
  const history = [];

  // 对齐 dsh web deliverablesDefinition: 提取 present 显式交付与 write/edit 产生的文件
  const turnDeliverables = new Map(); // turn -> Map(path -> { path, name, description, kind })
  const turnMutatedFiles = new Map(); // turn -> Map(path -> { path, name, description, kind })

  // Timeline assembly (dsh web order): user messages are flat nodes in seq
  // order; assistant content is grouped per (turn, step) with blocks kept in
  // content order (thought/text/tool), tool results backfilled by callId.
  const stepNodes = new Map();
  let curStep = null;

  const stepKeyOf = (turn, step) => `${turn ?? '?'}:${step ?? '?'}`;

  const newStepNode = (turn, step, time) => ({
    role: 'assistant',
    turn,
    step,
    time: time || 0,
    seq: -1,
    blocks: [],
    text: '',
    thought: '',
    tools: [],
    _thoughtSeen: [],
    _toolIndex: new Map(),
  });

  const finalizeStepNode = (node) => {
    const textParts = [];
    const thoughtParts = [];
    const tools = [];
    for (const b of node.blocks) {
      if (b.kind === 'text' && b.text) textParts.push(b.text);
      else if (b.kind === 'thought' && b.text) thoughtParts.push(b.text);
      else if (b.kind === 'tool') {
        tools.push({
          callId: b.callId,
          name: b.name,
          summary: b.summary,
          arguments: b.arguments,
          status: b.status,
          output: b.output,
          ok: b.ok,
        });
      }
    }
    node.text = textParts.join('\n');
    node.thought = thoughtParts.join('\n\n');
    node.tools = tools;
    delete node._thoughtSeen;
    delete node._toolIndex;
  };

  const flushStep = () => {
    if (!curStep) return;
    finalizeStepNode(curStep);
    if (curStep.blocks.length > 0) history.push(curStep);
    curStep = null;
  };

  const ensureStep = (turn, step, time, seq) => {
    const key = stepKeyOf(turn, step);
    let node = stepNodes.get(key);
    if (!node) {
      node = newStepNode(turn, step, time);
      stepNodes.set(key, node);
    }
    if (typeof seq === 'number' && seq >= 0) node.seq = seq;
    if (curStep !== node) {
      flushStep();
      curStep = node;
    }
    return node;
  };

  const pushThought = (node, text) => {
    if (!text || node._thoughtSeen.includes(text)) return;
    node._thoughtSeen.push(text);
    node.blocks.push({ kind: 'thought', text });
  };

  const pushText = (node, text) => {
    if (!text) return;
    const last = node.blocks[node.blocks.length - 1];
    if (last && last.kind === 'text') {
      last.text += text;
    } else {
      node.blocks.push({ kind: 'text', text });
    }
  };

  const pushToolHead = (node, callId, name, rawArgs) => {
    if (callId && node._toolIndex.has(callId)) return node._toolIndex.get(callId);
    const summary = computeToolSummary(name, rawArgs);
    const block = {
      kind: 'tool',
      callId: callId || '',
      name: name || '',
      summary,
      arguments: typeof rawArgs === 'object' ? JSON.stringify(rawArgs, null, 2) : String(rawArgs || ''),
      status: 'running',
    };
    node.blocks.push(block);
    if (callId) node._toolIndex.set(callId, block);
    return block;
  };

  const fillToolResult = (turn, step, callId, data) => {
    const node = stepNodes.get(stepKeyOf(turn, step));
    let block = null;
    if (node) {
      block =
        (callId ? node._toolIndex.get(callId) : null) ||
        (callId ? node.blocks.filter((b) => b.kind === 'tool' && b.callId === callId).pop() : null) ||
        node.blocks.filter((b) => b.kind === 'tool').pop() ||
        null;
    }
    if (!block) return;
    const isError = !!data.error || !!data.message?.content?.[0]?.isError || data.isError === true;
    block.status = isError ? 'error' : 'done';
    block.ok = !isError;
    block.output = extractToolResultOutput(data);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user/message') {
        // Exclude system prompt snapshot and skill catalog injections
        const sourceKind = obj.data?.source?.kind;
        if (sourceKind && sourceKind !== 'user') {
          continue;
        }
        flushStep();
        const rawContent = obj.data?.content || obj.data?.message?.content;
        const text = extractTextFromContent(rawContent);
        const genuine = cleanUserPrompt(text);
        // Q20 文件预览：附件（图片/文件）与正文同源进消息流；纯附件（无正文）
        // 的轮次也必须落库，否则用户发的图在客户端不可见、更无从点击预览。
        const attachments = extractAttachmentsFromContent(rawContent);
        if (genuine || attachments.length > 0) {
          const userMsg = {
            role: 'user',
            text: genuine,
            time: obj.time || obj.data?.time || 0,
            seq: (typeof obj.seq === 'number' && obj.seq >= 0) ? obj.seq : -1,
          };
          if (attachments.length > 0) userMsg.attachments = attachments;
          history.push(userMsg);
        }
      } else if (obj.type === 'assistant/message') {
        const turn = obj.data?.turn;
        const step = obj.data?.step;
        const node = ensureStep(turn, step, obj.time, obj.seq);
        const content = obj.data?.message?.content || obj.data?.content || [];
        if (Array.isArray(content)) {
          for (const c of content) {
            if (!c) continue;
            if (c.type === 'text' && c.text) {
              pushText(node, c.text);
            } else if ((c.type === 'reasoning' || c.type === 'thought' || c.type === 'thinking') && c.text) {
              pushThought(node, c.text);
            } else if (c.type === 'tool-call') {
              const cid = String(c.id || c.callId || '');
              pushToolHead(node, cid, c.name || '', c.arguments || {});
            }
          }
        }
        const stream = obj.data?.stream || [];
        for (const s of stream) {
          if (s && s.type === 'reasoning-chunks' && Array.isArray(s.texts)) {
            const reasoningJoined = s.texts.join('');
            if (reasoningJoined) {
              pushThought(node, reasoningJoined);
            }
          }
        }
      } else if (obj.type === 'deliverables/presented') {
        const turn = obj.data?.turn;
        if (turn !== undefined && obj.data?.files && Array.isArray(obj.data.files)) {
          if (!turnDeliverables.has(turn)) turnDeliverables.set(turn, new Map());
          const map = turnDeliverables.get(turn);
          for (const f of obj.data.files) {
            if (f && f.path) {
              const base = sanitizeLeafName(f.path) || path.basename(f.path);
              const kind = previewKindOf(base) || 'file';
              map.set(f.path, {
                path: f.path,
                name: base,
                description: f.description || '',
                kind: kind,
              });
            }
          }
        }
      } else if (
        obj.type === 'tool/call' ||
        obj.type === 'tool/execute' ||
        obj.type === 'step/tool' ||
        obj.type === 'tool/use'
      ) {
        const data = obj.data || {};
        const node = ensureStep(data.turn, data.step, obj.time, obj.seq);
        const callId = data.callId || data.id || '';
        const name = data.name || data.tool || '';
        const rawArgs = data.arguments || data.args || data.input || {};
        pushToolHead(node, callId, name, rawArgs);

        // 对齐 dsh web: 提取 present 声明交付物与 write/edit 产生的文件
        const turn = data.turn;
        if (turn !== undefined) {
          let parsedArgs = rawArgs;
          if (typeof parsedArgs === 'string') {
            try { parsedArgs = JSON.parse(parsedArgs); } catch {}
          }
          if (name === 'present' && parsedArgs && Array.isArray(parsedArgs.files)) {
            if (!turnDeliverables.has(turn)) turnDeliverables.set(turn, new Map());
            const map = turnDeliverables.get(turn);
            for (const f of parsedArgs.files) {
              if (f && f.path) {
                const base = sanitizeLeafName(f.path) || path.basename(f.path);
                const kind = previewKindOf(base) || 'file';
                map.set(f.path, {
                  path: f.path,
                  name: base,
                  description: f.description || '',
                  kind: kind,
                });
              }
            }
          } else if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
            const filePath = parsedArgs?.file_path || parsedArgs?.path;
            if (filePath && typeof filePath === 'string') {
              if (!turnMutatedFiles.has(turn)) turnMutatedFiles.set(turn, new Map());
              const map = turnMutatedFiles.get(turn);
              const base = sanitizeLeafName(filePath) || path.basename(filePath);
              const kind = previewKindOf(base) || 'file';
              map.set(filePath, {
                path: filePath,
                name: base,
                description: '',
                kind: kind,
              });
            }
          }
        }
      } else if (obj.type === 'tool/result') {
        const data = obj.data || {};
        const callId =
          data.message?.source?.callId ||
          data.message?.content?.[0]?.toolCallId ||
          data.callId ||
          data.id;
        fillToolResult(data.turn, data.step, callId, data);
      } else if (obj.type === 'turn/end') {
        const reason = obj.data?.reason;
        if (reason && reason.kind === 'error') {
          flushStep();
          const errObj = reason.error || {};
          const errMsg = errObj.message || '模型生成失败';
          history.push({
            role: 'error',
            text: errMsg,
            code: errObj.code || '',
            time: obj.time || obj.data?.time || 0,
            seq: (typeof obj.seq === 'number' && obj.seq >= 0) ? obj.seq : -1,
          });
        }
      }
    } catch {
      // ignore non-json lines
    }
  }

  flushStep();

  // 对齐 dsh web 交付物规则 (deliverablesDefinition / selectDeliverables)：
  // 为每轮最后一条 assistant 消息绑定该轮生成交付物 (deliverables)。
  // present 显式声明优先；若无 present 但有 write/edit，则呈现本轮产生文件。
  const lastStepByTurn = new Map();
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.role === 'assistant' && item.turn !== undefined && item.turn !== null) {
      lastStepByTurn.set(item.turn, item);
    }
  }
  for (const [turn, targetItem] of lastStepByTurn.entries()) {
    const presentedMap = turnDeliverables.get(turn);
    const mutatedMap = turnMutatedFiles.get(turn);
    if (presentedMap && presentedMap.size > 0) {
      targetItem.deliverables = Array.from(presentedMap.values());
    } else if (mutatedMap && mutatedMap.size > 0) {
      targetItem.deliverables = Array.from(mutatedMap.values());
    }
  }

  return history;
}

/**
 * 把 live 镜像行投影成 session/list item 形状（C-6/C-12 兜底：字段名/类型与宿主 items 一致）。
 */
function liveRowToSummaryItem(row) {
  if (!row || !row.sessionId) return null;
  const values = { title: row.title || '' };
  if (Array.isArray(row.subagentCatalog)) values.subagentCatalog = row.subagentCatalog;
  if (row.agentTeam && typeof row.agentTeam === 'object') values.agentTeam = row.agentTeam;
  return {
    sessionId: row.sessionId,
    title: row.title || '',
    running: !!row.running,
    state: row.running ? 'running' : 'done',
    agentAvailable: !!row.agentAvailable,
    parentSessionId: row.parentSessionId || '',
    origin: row.origin || '',
    cwd: row.cwd || '',
    updatedAt: row.updatedAt || 0,
    projections: { values: values },
  };
}

/**
 * C-6/C-12：用 live 事件镜像覆盖/补全 session/list items。
 * - 覆盖：running / title / updatedAt / parentSessionId / origin / cwd / 投影（live 事件为更高权威，C-4）；
 * - 追加：session/list 缺失但 live 已知的行（如 LIST_FAIL 时的子会话）。
 * 不改变既有字段名与类型（C-10）。
 */
function mergeLiveSessionItems(items) {
  const base = Array.isArray(items) ? items : [];
  if (!hostLiveState) return base;
  let liveRows = [];
  try { liveRows = hostLiveState.listAll(); } catch { liveRows = []; }
  if (liveRows.length === 0) return base;
  const liveById = new Map();
  for (const row of liveRows) liveById.set(String(row.sessionId), row);

  const merged = [];
  const seen = new Set();
  for (const item of base) {
    if (!item || !item.sessionId) { merged.push(item); continue; }
    const key = String(item.sessionId);
    seen.add(key);
    const row = liveById.get(key);
    if (!row) { merged.push(item); continue; }
    const values = Object.assign({}, (item.projections && item.projections.values) || {});
    if (row.title) values.title = row.title;
    if (Array.isArray(row.subagentCatalog) && row.subagentCatalog.length) values.subagentCatalog = row.subagentCatalog;
    if (row.agentTeam && typeof row.agentTeam === 'object') values.agentTeam = row.agentTeam;
    merged.push(Object.assign({}, item, {
      running: !!row.running,
      state: row.running ? 'running' : (item.state || 'done'),
      title: row.title || item.title || '',
      parentSessionId: row.parentSessionId || item.parentSessionId || '',
      origin: row.origin || item.origin || '',
      cwd: row.cwd || item.cwd || '',
      updatedAt: row.updatedAt || item.updatedAt || 0,
      projections: Object.assign({}, item.projections || {}, { values: values }),
    }));
  }
  for (const row of liveRows) {
    if (seen.has(String(row.sessionId))) continue;
    const projected = liveRowToSummaryItem(row);
    if (projected) merged.push(projected);
  }
  return merged;
}

/**
 * C-21：单 sid 定向 `session/projections`（信封 `payload.args = { request: { sessionId } }`，
 * 与 session/list 的 `{_request:{}}` 不同）。单飞 + 每 sid 15s 缓存，失败/超时/异常一律返回 null，
 * 绝不抛错、绝不让上层端点失败。mock 模式经 callDshWebRpc 短路到 mock（返回空 value），不发真实 RPC。
 */
const PROJECTIONS_TTL_MS = 15000;
// C-21 允许 ≤5000ms；此处取 2500ms：宿主对已终结/无投影会话可能长期不响应，
// 收紧后单次响应最坏耗时仍落在 C-22 的 P95 ≤2500ms 口径内（失败再负缓存 15s，不重试风暴）。
const PROJECTIONS_TIMEOUT_MS = 2500;
const sessionProjectionsCache = new Map(); // sid -> { values, at }
const sessionProjectionsInflight = new Map(); // sid -> Promise

/** 返回 undefined=未缓存；null=负缓存命中（该 sid 当前取不到 projections）；对象=正缓存命中。 */
function peekSessionProjections(sessionId) {
  const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!sid) return undefined;
  const hit = sessionProjectionsCache.get(sid);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PROJECTIONS_TTL_MS) {
    sessionProjectionsCache.delete(sid);
    return undefined;
  }
  return (hit.values === undefined || hit.values === null) ? null : hit.values;
}

function fetchSessionProjections(sessionId) {
  const sid = (sessionId === undefined || sessionId === null) ? '' : String(sessionId);
  if (!sid || !isValidSessionId(sid)) return Promise.resolve(null);
  const cached = peekSessionProjections(sid);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = sessionProjectionsInflight.get(sid);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const res = await callDshWebRpc('session/projections', { sessionId: sid }, PROJECTIONS_TIMEOUT_MS);
      if (res && res.ok && res.value && res.value.values && typeof res.value.values === 'object') {
        sessionProjectionsCache.set(sid, { values: res.value.values, at: Date.now() });
        if (sessionProjectionsCache.size > 2000) sessionProjectionsCache.clear();
        return res.value.values;
      }
      // 负缓存（同 TTL）：宿主对已终结/无投影会话可能长期不响应，绝不能让面板每次重拉都等满超时
      sessionProjectionsCache.set(sid, { values: null, at: Date.now() });
      console.warn(`[HOST-PROJ] session/projections unavailable sid=${sid} attempt=1 error=${(res && (res.error || res.code)) || 'no-values'}`);
      return null;
    } catch (err) {
      sessionProjectionsCache.set(sid, { values: null, at: Date.now() });
      console.warn(`[HOST-PROJ] session/projections threw sid=${sid} attempt=1 ${err && err.message}`);
      return null;
    } finally {
      sessionProjectionsInflight.delete(sid);
    }
  })();
  sessionProjectionsInflight.set(sid, p);
  return p;
}

/**
 * C-21：把定向 projections 的 `subagentCatalog` + `agentTeam` 注入 items（保持既有字段名/类型），
 * 让下方既有映射逻辑原样产出子会话/团队任务行。子会话 running 优先取 live 事实，缺失按 false。
 * @returns {boolean} 是否注入了任何内容
 */
function applyProjectionsToItems(items, parentId, values) {
  if (!Array.isArray(items) || !values || typeof values !== 'object') return false;
  const catalog = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
  const team = (values.agentTeam && typeof values.agentTeam === 'object') ? values.agentTeam : null;
  const members = (team && Array.isArray(team.members)) ? team.members : [];
  if (catalog.length === 0 && members.length === 0) return false;

  let parent = items.find(s => s && s.sessionId === parentId);
  const parentValues = Object.assign({}, (parent && parent.projections && parent.projections.values) || {});
  if (catalog.length > 0) parentValues.subagentCatalog = catalog;
  if (team) parentValues.agentTeam = team;
  if (parent) {
    // 不改写共享缓存对象：就地替换为浅拷贝（items 本身已是副本）
    const idx = items.indexOf(parent);
    parent = Object.assign({}, parent, {
      projections: Object.assign({}, parent.projections || {}, { values: parentValues }),
    });
    items[idx] = parent;
  } else {
    parent = {
      sessionId: parentId, title: '', running: false, state: 'done', origin: '', parentSessionId: '',
      cwd: '', updatedAt: 0, projections: { values: parentValues },
    };
    items.push(parent);
  }

  const seen = new Set();
  for (const it of items) {
    if (it && it.sessionId) seen.add(String(it.sessionId));
  }
  const upsertChild = (id, title, running, extra) => {
    if (!id || seen.has(String(id))) return;
    seen.add(String(id));
    const live = hostLiveState ? hostLiveState.getSession(id) : null;
    const isRunning = live ? !!live.running : !!running;
    items.push({
      sessionId: String(id),
      title: title || '',
      running: isRunning,
      state: isRunning ? 'running' : 'done',
      origin: 'subagent',
      parentSessionId: parentId,
      cwd: (live && live.cwd) || '',
      updatedAt: (extra && extra.updatedAt) || 0,
      projections: { values: Object.assign({ title: title || '' }, (extra && extra.values) || {}) },
    });
  };
  for (const c of catalog) {
    if (!c || !c.id) continue;
    upsertChild(c.id, c.label || '', false, { updatedAt: c.createdAt || 0, values: { subagent: { mode: c.mode, label: c.label } } });
  }
  for (const m of members) {
    if (!m || !m.id) continue;
    upsertChild(m.id, m.name || '', (m.phase === 'active' || m.status === 'running'), { values: {} });
  }
  return true;
}

/**
 * 获取指定父会话或工作区下的所有子智能体/Agent Team/后台任务列表。
 * 与官方 DSH 规范对齐：
 * 1. 优先调用官方 DSH Web session/list RPC 读取权威投影（subagentCatalog 与 parentSessionId 树状链）；
 * 2. 结合 projections.values.subagent 及 subagentCatalog 信息提炼模式（one-shot 后台任务、continuable 子Agent、team 等）；
 * 3. 结果按更新时间排序，带 isRunning / state 状态。
 * C-3/C-6/C-21：只读已知快照（绝不等待主通道 RPC），session/list 不可用时用 live 镜像兜底；
 * 会话级查询在既有真源全空时用单 sid 定向 session/projections 补全（≤1 次，单飞 + 15s 缓存）。
 */
async function getSessionSubagents(targetCwd, parentSessionId) {
  if (!parentSessionId) return { parentId: parentSessionId || '', subagents: [], tasks: [] };

  // 1. 读取官方 session/list 权威列表：命中共享主通道缓存即零等待；缺失/过期由后台刷新补齐（C-3），
  //    live 事件镜像（C-6/C-12）兜底 parentSessionId 子会话与 agentTeam.tasks。
  scheduleHostSessionListRefresh();
  // .slice()：C-21 注入需要可变副本，绝不改写共享主通道缓存数组/对象
  const items = mergeLiveSessionItems(peekHostSessionListFull()).slice();
  // 智能解析有效父会话：若传入的 parentSessionId 本身是 teammate/子智能体（带有 parentSessionId 或被其他 session 登记为 teammate），
  // 则自动追溯到它的根/主会话，确保在子智能体会话中按 U 也能完整看到整个团队与任务板！
  let effectiveParentId = parentSessionId;
  const initialSession = items.find(s => s && s.sessionId === parentSessionId);
  if (initialSession && initialSession.parentSessionId) {
    effectiveParentId = initialSession.parentSessionId;
  } else {
    // 检查是否有其他会话将当前 session 纳入其 agentTeam.members (role === 'teammate') 或 subagentCatalog
    const owningParent = items.find(s => {
      if (!s || s.sessionId === parentSessionId) return false;
      const proj = (s.projections && s.projections.values) || {};
      const team = proj.agentTeam;
      if (team && Array.isArray(team.members) && team.members.some(m => m && m.id === parentSessionId && m.role === 'teammate')) {
        return true;
      }
      const cat = proj.subagentCatalog;
      if (Array.isArray(cat) && cat.some(c => c && c.id === parentSessionId)) {
        return true;
      }
      return false;
    });
    if (owningParent && owningParent.sessionId) {
      effectiveParentId = owningParent.sessionId;
    }
  }

  let parent = items.find(s => s && s.sessionId === effectiveParentId);
  let catalog = (parent && parent.projections && parent.projections.values && Array.isArray(parent.projections.values.subagentCatalog))
    ? parent.projections.values.subagentCatalog
    : [];

  let teamData = (parent && parent.projections && parent.projections.values && parent.projections.values.agentTeam) || null;
  let teamMembers = (teamData && Array.isArray(teamData.members)) ? teamData.members : [];
  let teamTasks = (teamData && Array.isArray(teamData.tasks)) ? teamData.tasks : [];

  let teammateMap = new Map();
  for (const m of teamMembers) {
    if (m && m.id) teammateMap.set(m.id, m);
  }

  let children = items.filter(s => {
    if (!s || s.sessionId === effectiveParentId) return false;
    if (s.parentSessionId === effectiveParentId) return true;
    if (teammateMap.has(s.sessionId)) return true;
    return catalog.some(c => c && c.id === s.sessionId);
  });

  // C-21 触发条件（Lead 终验修正，缺陷 #3 残留缺口）：只要「已知权威信息不足以覆盖父会话的 catalog」
  // 就对该单一 sid 做一次定向 session/projections 补全（单飞 + 15s 缓存；失败一律回落既有真源，绝不抛错）：
  //   ① 无全量快照（冷启动窗口）或快照已过期 —— 权威信息缺失；
  //   ② 既有真源未产出任何子会话/团队行（原条件）；
  //   ③ children.length < catalog.length —— 快照/catalog 已知但行缺失（重启后仅 1 条 live 子会话即此情形）。
  // 合并是**加性**的：applyProjectionsToItems 对已存在的 id 直接跳过，多执行一次不会产生重复行。
  const snapshotItems = peekHostSessionListFull();
  const snapshotUnusable = !Array.isArray(snapshotItems) || snapshotItems.length === 0
    || (Date.now() - hostSessionListFullCache.at > HOST_SNAPSHOT_MAX_AGE_MS);
  const coverageInsufficient = snapshotUnusable
    || (children.length === 0 && teamMembers.length === 0 && teamTasks.length === 0)
    || (children.length < catalog.length);
  if (coverageInsufficient) {
    const values = await fetchSessionProjections(effectiveParentId);
    if (values && applyProjectionsToItems(items, effectiveParentId, values)) {
      parent = items.find(s => s && s.sessionId === effectiveParentId);
      catalog = (parent && parent.projections && parent.projections.values && Array.isArray(parent.projections.values.subagentCatalog))
        ? parent.projections.values.subagentCatalog
        : [];
      teamData = (parent && parent.projections && parent.projections.values && parent.projections.values.agentTeam) || null;
      teamMembers = (teamData && Array.isArray(teamData.members)) ? teamData.members : [];
      teamTasks = (teamData && Array.isArray(teamData.tasks)) ? teamData.tasks : [];
      teammateMap = new Map();
      for (const m of teamMembers) {
        if (m && m.id) teammateMap.set(m.id, m);
      }
      children = items.filter(s => {
        if (!s || s.sessionId === effectiveParentId) return false;
        if (s.parentSessionId === effectiveParentId) return true;
        if (teammateMap.has(s.sessionId)) return true;
        return catalog.some(c => c && c.id === s.sessionId);
      });
    }
  }

  const subagents = children.map(ch => {
    const catEntry = catalog.find(c => c && c.id === ch.sessionId) || {};
    const proj = (ch.projections && ch.projections.values) || {};
    const subMeta = proj.subagent || {};
    const teamMember = teammateMap.get(ch.sessionId);

    const isTeam = !!teamMember || (teamMember && teamMember.role === 'teammate') || proj.agentPreset === 'agent-team';
    let mode = catEntry.mode || subMeta.mode || (ch.origin === 'subagent' ? 'subagent' : 'task');
    if (isTeam) {
      mode = 'team';
    }

    let kind = '子Agent';
    if (mode === 'one-shot') kind = '后台任务';
    else if (mode === 'team') kind = 'Agent Team';

    const label = (teamMember && teamMember.name) || catEntry.label || subMeta.label || '';
    const title = (teamMember && (teamMember.name + (teamMember.description ? ' (' + teamMember.description + ')' : ''))) || label || proj.title || ch.title || ('子任务 ' + ch.sessionId.substring(0, 8));
    const running = (teamMember && (teamMember.status === 'running' || teamMember.phase === 'active')) || !!ch.running;
    const state = (teamMember && ((teamMember.status === 'running' || teamMember.phase === 'active') ? 'running' : (teamMember.status === 'failed' ? 'failed' : 'done'))) || (running ? 'running' : (ch.state || 'done'));

    return {
      id: ch.sessionId,
      parentId: effectiveParentId,
      title: title,
      label: label,
      name: teamMember ? teamMember.name : '',
      role: teamMember ? teamMember.role : (isTeam ? 'teammate' : 'subagent'),
      mode: mode,
      kind: kind,
      running: running,
      isRunning: running,
      state: state,
      status: (teamMember && (teamMember.status || teamMember.phase)) || state,
      model: (teamMember && teamMember.model) || (proj.modelSelection && proj.modelSelection.lastUsed && proj.modelSelection.lastUsed.model) || '',
      updatedAt: ch.updatedAt || catEntry.createdAt || 0,
      createdAt: catEntry.createdAt || 0,
      cwd: ch.cwd || targetCwd,
    };
  });

  // 如果 teamMembers 中有尚未在 items 中出现的成员（例如冷启动尚未进入 list），补充进去
  for (const m of teamMembers) {
    if (m && m.role === 'teammate' && !subagents.some(s => s.id === m.id)) {
      const isRunning = m.status === 'running' || m.phase === 'active';
      subagents.push({
        id: m.id,
        parentId: effectiveParentId,
        title: m.name + (m.description ? ' (' + m.description + ')' : ''),
        label: m.name,
        name: m.name,
        role: m.role,
        mode: 'team',
        kind: 'Agent Team',
        running: isRunning,
        isRunning: isRunning,
        state: isRunning ? 'running' : (m.status === 'failed' ? 'failed' : 'done'),
        status: m.status || m.phase || (isRunning ? 'running' : 'done'),
        model: m.model || '',
        updatedAt: 0,
        createdAt: 0,
        cwd: targetCwd,
      });
    }
  }

  subagents.sort((a, b) => {
    const ar = a.running ? 1 : 0;
    const br = b.running ? 1 : 0;
    if (br !== ar) return br - ar;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return { parentId: effectiveParentId, subagents, tasks: teamTasks, total: subagents.length };
}

/**
 * U2/F7：工作区归属判定（getWorkspaceSubagents 的 subagents 与 tasks 两处**必须同一判据**）。
 * live 补入行可合法缺 cwd：缺 cwd 时仅当父会话 cwd 已知且等于 normalizedCwd 才纳入，
 * 否则丢弃（宁缺勿串台，绝不把异工作区的子会话/团队任务混入本工作区看板）。
 * @param {any} row session/list 形状行（或 live 投影行）
 * @param {string} normalizedCwd 目标工作区绝对路径（空表示不做过滤）
 * @param {Map<string, any>} sessionById 本次 items 的 sid 索引（用于父会话 cwd 推导）
 */
function belongsToWorkspace(row, normalizedCwd, sessionById) {
  if (!normalizedCwd) return true;
  if (!row) return false;
  const rowCwd = row.cwd ? path.resolve(row.cwd) : '';
  if (rowCwd) return rowCwd === normalizedCwd;
  const parentId = row.parentSessionId ? String(row.parentSessionId) : '';
  const parentRow = (parentId && sessionById) ? sessionById.get(parentId) : null;
  const parentCwd = (parentRow && parentRow.cwd) ? path.resolve(parentRow.cwd) : '';
  return parentCwd === normalizedCwd;
}

/**
 * 汇总当前工作区内所有带子智能体关系的会话概览，或全局子任务列表。
 * C-3/C-6：只读已知快照 + 后台刷新；session/list 不可用时用 live 镜像兜底，绝不直接返回空。
 */
async function getWorkspaceSubagents(targetCwd) {
  scheduleHostSessionListRefresh();
  const items = mergeLiveSessionItems(peekHostSessionListFull());
  if (!Array.isArray(items) || items.length === 0) {
    return { cwd: targetCwd, subagents: [], tasks: [] };
  }
  const normalizedCwd = targetCwd ? path.resolve(targetCwd) : '';
  const subagents = [];

  // 1. 构建全量 session 快速索引以补全 teammate 成员详情
  const sessionById = new Map();
  for (const s of items) {
    if (s && s.sessionId) sessionById.set(s.sessionId, s);
  }

  for (const ch of items) {
    if (!ch) continue;
    const isSub = ch.origin === 'subagent' || !!ch.parentSessionId;
    if (!isSub) continue;
    // F7/U2：live 补入行可合法缺 cwd。缺 cwd 时不得放行（否则异工作区子会话串台），
    // 仅当父会话属于本工作区（父行 cwd 命中）时才纳入；否则丢弃（宁缺勿串台）。
    // 判据与下方 tasks 通道共用 belongsToWorkspace，两处必须一致。
    if (!belongsToWorkspace(ch, normalizedCwd, sessionById)) continue;

    const proj = (ch.projections && ch.projections.values) || {};
    const subMeta = proj.subagent || {};

    // 检查父级 session 中是否有该 member 的精准命名/角色
    let parentTeamMember = null;
    if (ch.parentSessionId && sessionById.has(ch.parentSessionId)) {
      const pSession = sessionById.get(ch.parentSessionId);
      const pTeam = pSession.projections && pSession.projections.values && pSession.projections.values.agentTeam;
      if (pTeam && Array.isArray(pTeam.members)) {
        parentTeamMember = pTeam.members.find(m => m && m.id === ch.sessionId);
      }
    }

    const isTeamMember = (ch.role === 'teammate') || (subMeta.mode === 'team') || (proj.agentTeam && Array.isArray(proj.agentTeam.members)) || (parentTeamMember && parentTeamMember.role === 'teammate');
    const mode = isTeamMember ? 'team' : (subMeta.mode || (ch.origin === 'subagent' ? 'subagent' : 'task'));
    let kind = '子Agent';
    if (mode === 'one-shot') kind = '后台任务';
    else if (mode === 'team' || proj.agentPreset === 'agent-team' || isTeamMember) kind = 'Agent Team';

    const label = (parentTeamMember && parentTeamMember.name) || subMeta.label || '';
    const title = (parentTeamMember && (parentTeamMember.name + (parentTeamMember.description ? ' (' + parentTeamMember.description + ')' : ''))) || label || proj.title || ch.title || ('子任务 ' + ch.sessionId.substring(0, 8));
    const running = (parentTeamMember && (parentTeamMember.status === 'running' || parentTeamMember.phase === 'active')) || !!ch.running;
    const state = (parentTeamMember && ((parentTeamMember.status === 'running' || parentTeamMember.phase === 'active') ? 'running' : (parentTeamMember.status === 'failed' ? 'failed' : 'done'))) || (running ? 'running' : (ch.state || 'done'));

    subagents.push({
      id: ch.sessionId,
      parentId: ch.parentSessionId || '',
      title: title,
      label: label,
      name: parentTeamMember ? parentTeamMember.name : '',
      role: parentTeamMember ? parentTeamMember.role : (isTeamMember ? 'teammate' : 'subagent'),
      mode: mode,
      kind: kind,
      running: running,
      isRunning: running,
      state: state,
      status: (parentTeamMember && (parentTeamMember.status || parentTeamMember.phase)) || state,
      updatedAt: ch.updatedAt || 0,
      cwd: ch.cwd || targetCwd,
    });
  }

  // 额外收集：如果 items 中有带 agentTeam.tasks 的会话，且属于当前工作区，提取活跃任务
  // U2（F7 修全）：tasks 与 subagents 两处必须**同一判据**，空 cwd 的 live 行不得放行。
  let teamTasks = [];
  for (const s of items) {
    if (!s) continue;
    if (!belongsToWorkspace(s, normalizedCwd, sessionById)) continue;
    const p = (s.projections && s.projections.values) || {};
    if (p.agentTeam && Array.isArray(p.agentTeam.tasks) && p.agentTeam.tasks.length > 0) {
      teamTasks = teamTasks.concat(p.agentTeam.tasks);
    }
  }

  // 汇总当前工作区内的子智能体与团队任务
  // 严格隔离：仅汇总明确属于 normalizedCwd 的子智能体与团队任务，绝不跨工作区或全局越界混入其他会话的任务与智能体
  subagents.sort((a, b) => {
    const ar = a.running ? 1 : 0;
    const br = b.running ? 1 : 0;
    if (br !== ar) return br - ar;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return { cwd: targetCwd, subagents, tasks: teamTasks, total: subagents.length };
}

/**
 * 当前会话目标折叠（对齐上游 dsh-goal durable 投影，不含进程态 activation）：
 * 顺序重放日志中的 goal/change 全快照与 goal 来源 user/message 轮次计数；
 * clear Tombstone 后记 null；修订号不连续的行保守跳过，绝不抛错污染统计主链路。
 */
function emptyGoalFold() {
  return { goal: null, rounds: 0, created: 0, updated: 0 };
}
function foldGoalLine(acc, o) {
  if (!acc || !o || typeof o.type !== 'string') return;
  if (o.type === 'goal/change') {
    const d = o.data;
    if (!d || d.kind !== 'goal/change' || d.version !== 1) return;
    if (d.operation === 'clear') {
      const c = d.cleared;
      if (!c || typeof c.id !== 'string' || typeof c.revision !== 'number') return;
      if (acc.goal && c.id === acc.goal.id && c.revision === acc.goal.revision + 1) {
        acc.goal = null; acc.rounds = 0; acc.created = 0; acc.updated = 0;
      }
      return;
    }
    const g = d.goal;
    if (!g || typeof g.id !== 'string' || typeof g.revision !== 'number' || typeof g.objective !== 'string') return;
    if (acc.goal) {
      if (g.id !== acc.goal.id || g.revision !== acc.goal.revision + 1) return;
    } else if (d.operation !== 'create' || g.revision !== 1) {
      return;
    }
    acc.goal = {
      id: g.id,
      revision: g.revision,
      objective: g.objective,
      phase: g.phase || 'active',
      maxGoalRounds: typeof g.maxGoalRounds === 'number' ? g.maxGoalRounds : 0,
    };
    if (g.blockedReason && typeof g.blockedReason.message === 'string') {
      acc.goal.blockedReason = { code: g.blockedReason.code || '', message: g.blockedReason.message };
    }
    acc.rounds = typeof d.roundsStarted === 'number' ? d.roundsStarted : 0;
    if (typeof d.createdAt === 'number') acc.created = d.createdAt;
    if (typeof d.updatedAt === 'number') acc.updated = d.updatedAt;
  } else if (o.type === 'user/message') {
    const src = o.data && o.data.source;
    if (src && src.kind === 'goal' && acc.goal && src.goalId === acc.goal.id &&
        typeof src.round === 'number' && src.round === acc.rounds + 1) {
      acc.rounds = src.round;
    }
  }
}
function goalViewOf(acc) {
  if (!acc || !acc.goal) return null;
  return {
    id: acc.goal.id,
    revision: acc.goal.revision,
    objective: acc.goal.objective,
    phase: acc.goal.phase,
    maxGoalRounds: acc.goal.maxGoalRounds,
    roundsStarted: acc.rounds,
    createdAt: acc.created,
    updatedAt: acc.updated,
    ...(acc.goal.blockedReason ? { blockedReason: acc.goal.blockedReason } : {}),
  };
}

/**
 * 读当前会话目标（本地 zstd 日志折叠，宿主离线可用）。
 * 非法 id / 无目录 / 无日志一律返回 null（与 stats 幽灵会话口径一致）。
 */
function getSessionGoal(targetCwd, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  let sessionDir = null;
  try {
    sessionDir = findSessionDir(targetCwd, sessionId);
  } catch {
    return null;
  }
  if (!sessionDir || !fs.existsSync(sessionDir)) return null;
  const zstdPath = findSessionZstdPath(sessionDir);
  if (!zstdPath) return null;
  let fullText = '';
  try {
    fullText = decompressAllZstdFrames(fs.readFileSync(zstdPath));
  } catch {
    return null;
  }
  const acc = emptyGoalFold();
  for (const l of fullText.split('\n')) {
    if (!l.trim()) continue;
    try {
      foldGoalLine(acc, JSON.parse(l));
    } catch {}
  }
  return goalViewOf(acc);
}

/**
 * Session statistics cache: cacheKey (zstdPath:mtime:size) -> { stats, at }
 */
const SESSION_STATS_CACHE_TTL_MS = 2000;
const sessionStatsCache = new Map();

async function getSessionStats(targetCwd, sessionId) {
  const normalizedCwd = path.resolve(targetCwd);
  if (!sessionId) {
    return {
      sessionId: '',
      cwd: normalizedCwd,
      title: '（新会话）',
      mode: 'standard',
      state: 'idle',
      isRunning: false,
      provider: '',
      model: '',
      turns: 0,
      steps: 0,
      toolCalls: 0,
      inputTokens: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      pressureTokens: 0,
      cacheHitRate: null,
      tokenSpeed: '0.0',
      durationMs: 0,
      goal: null,
    };
  }

  const sessionDir = findSessionDir(normalizedCwd, sessionId);
  const task = activeTasks.get(sessionId);
  const zstdPath = sessionDir ? findSessionZstdPath(sessionDir) : null;

  if (!zstdPath) {
    const isRunning = await isSessionUiRunning(task, sessionDir, sessionId);
    const inTokens = task?.usage?.inputTokens || 0;
    const outTokens = task?.usage?.outputTokens || 0;
    const crTokens = task?.usage?.cacheReadTokens || 0;
    const cwTokens = task?.usage?.cacheWriteTokens || 0;
    const billedIn = inTokens + crTokens + cwTokens;
    // 对齐 dsh：无计费输入时命中率无意义，返回 null（前端隐藏该行而非显示 0.0%）；
    // 精度对齐会话级 StatsPills（整数%，Turn 级面板才用 1 位小数）
    const hitPct = formatCacheHitPercent(crTokens, billedIn);
    const hitRate = hitPct === null ? null : hitPct + '%';
    return {
      sessionId,
      cwd: normalizedCwd,
      title: '（新会话）',
      mode: 'standard',
      state: isRunning ? 'running' : (task?.status || 'idle'),
      isRunning,
      provider: task?.provider || '',
      model: task?.model || '',
      turns: task ? 1 : 0,
      steps: 0,
      toolCalls: 0,
      inputTokens: billedIn,
      uncachedInputTokens: inTokens,
      cacheReadTokens: crTokens,
      cacheWriteTokens: cwTokens,
      outputTokens: outTokens,
      totalTokens: billedIn + outTokens,
      cacheHitRate: hitRate,
      tokenSpeed: '0.0',
      durationMs: 0,
      goal: null,
    };
  }

  const st = fs.statSync(zstdPath);
  const cacheKey = `${zstdPath}:${st.mtimeMs}:${st.size}`;
  const now = Date.now();
  const cached = sessionStatsCache.get(cacheKey);

  if (cached && now - cached.at < SESSION_STATS_CACHE_TTL_MS) {
    const isRunning = await isSessionUiRunning(task, sessionDir, sessionId);
    const state = isRunning ? 'running' : sessionTerminalState(zstdPath, task);
    return {
      ...cached.stats,
      provider: isRunning && task?.provider ? task.provider : cached.stats.provider,
      model: isRunning && task?.model ? task.model : cached.stats.model,
      isRunning,
      state,
    };
  }

  const buf = fs.readFileSync(zstdPath);
  const fullText = decompressAllZstdFrames(buf);
  const lines = fullText.split('\n');

  let header = null;
  let title = '';
  let mode = 'standard';
  let provider = '';
  let model = '';
  let turns = 0;
  let lastTurn = null;
  let steps = 0;
  let toolCalls = 0;
  // 对齐 dsh tokenUsageProjection：同 turn+step 重复样本替换（重试 settlement
  // 不双算）；usage 源为 data.usage，回退 stream 内嵌末个 {type:'usage'} chunk。
  const usageFold = createUsageFold();
  let totalOut = 0;
  let lastPressureTokens = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  let openStep = null;
  const goalAcc = emptyGoalFold();

  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      foldGoalLine(goalAcc, o);
      if (o.type === 'session') {
        header = o;
        if (o.agentPreset) mode = o.agentPreset;
        if (o.title) title = o.title;
      } else if (o.type === 'session/title') {
        if (o.data?.title) title = o.data.title;
      } else if (o.type === 'user/message') {
        if (!title) {
          const text = extractTextFromContent(o.data?.content || o.data?.message?.content);
          const genuine = cleanUserPrompt(text);
          if (genuine) {
            title = genuine.replace(/[\r\n\t]+/g, ' ').slice(0, 80);
          }
        }
      } else if (o.type === 'step/start') {
        openStep = { turn: o.data?.turn, step: o.data?.step, startTime: o.time || 0 };
      } else if (o.type === 'step/end') {
        // Aligned with dsh web: step lifecycle authority is step/end
        if (o.data?.turn !== undefined && lastTurn !== o.data.turn) {
          turns += 1;
          lastTurn = o.data.turn;
        }
        steps += 1;
        openStep = null;
      } else if (o.type === 'request/header') {
        if (o.data?.header?.config) {
          provider = o.data.header.config.provider || provider;
          model = o.data.header.config.model || model;
        }
      } else if (o.type === 'llm/retry-started') {
        // 对齐 dsh tokenUsageProjection 关槽：重试 settlement 全额累加
        if (o.data && typeof o.data.turn === 'number' && typeof o.data.step === 'number') {
          usageFold.closeRetrySlot(o.data.turn, o.data.step);
        }
      } else if (o.type === 'assistant/message' || o.type === 'assistant/attempt') {
        if (o.type === 'assistant/message' && o.data?.source) {
          provider = o.data.source.provider || provider;
          model = o.data.source.model || model;
        }
        // 失败/重试的 attempt settlement 同样计入（dsh tokenUsageProjection 对
        // assistant/message + assistant/attempt 一视同仁）；message 的 surface
        // 展示不受影响（展示仍只读 message）。
        const sample = extractEventUsage(o);
        if (sample) {
          usageFold.add(sample);
          // 最近一次单请求 prompt 侧压力（对齐 token-meter pressureFrom，不做全会话累计）
          lastPressureTokens = pressureFrom(sample.usage);
        }
        if (o.type === 'assistant/message' && openStep && openStep.turn === o.data?.turn && openStep.step === o.data?.step) {
          let firstToken = null;
          if (Array.isArray(o.data?.stream)) {
            for (const rec of o.data.stream) {
              if (rec) {
                const t = rec.time0 || (rec.type === 'chunk' && rec.time);
                if (t) { firstToken = t; break; }
              }
            }
          }
          const decodeStart = firstToken || openStep.startTime;
          const outTok = sample && sample.usage ? sample.usage.outputTokens : undefined;
          if (typeof outTok === 'number' && outTok > 0 && decodeStart) {
            decodeMs += Math.max(0, o.time - decodeStart);
            decodeTokens += outTok;
          }
          openStep = null;
        }
      } else if (
        o.type === 'tool/call' ||
        o.type === 'tool/execute' ||
        o.type === 'step/tool' ||
        o.type === 'tool/use'
      ) {
        toolCalls++;
      }
    } catch {}
  }

  const isRunning = await isSessionUiRunning(task, sessionDir, sessionId);
  const state = isRunning ? 'running' : sessionTerminalState(zstdPath, task);

  const folded = usageFold.totals();
  const uncachedIn = folded.uncachedInputTokens;
  const cacheRead = folded.cacheReadTokens;
  const cacheWrite = folded.cacheWriteTokens;
  totalOut = folded.outputTokens;
  const billedIn = billedInputTokens({ uncachedInputTokens: uncachedIn, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
  // 对齐 dsh：无计费输入时命中率无意义，返回 null（前端隐藏该行而非显示 0.0%）；
  // 精度对齐会话级 StatsPills（整数%，Turn 级面板才用 1 位小数）
  const hitPct = formatCacheHitPercent(cacheRead, billedIn);
  const hitRate = hitPct === null ? null : hitPct + '%';
  const totalTokens = billedIn + totalOut;
  const tps = decodeMs > 0 ? (decodeTokens / (decodeMs / 1000)) : 0;
  const tokenSpeed = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);

  const stats = {
    sessionId,
    cwd: header?.cwd || normalizedCwd,
    title: title || header?.title || '',
    mode: mode || 'standard',
    state,
    isRunning,
    provider: provider || '',
    model: model || '',
    turns,
    steps,
    toolCalls,
    inputTokens: billedIn,
    uncachedInputTokens: uncachedIn,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: totalOut,
    totalTokens,
    pressureTokens: lastPressureTokens,
    cacheHitRate: hitRate,
    tokenSpeed,
    durationMs: decodeMs,
    goal: goalViewOf(goalAcc),
  };

  if (sessionStatsCache.size > 500) sessionStatsCache.clear();
  sessionStatsCache.set(cacheKey, { stats, at: now });

  return stats;
}

/**
 * Handle HTTP request helper
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') {
      return true;
    }
    if (process.env.ALLOWED_ORIGINS) {
      const allowed = process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
      return allowed.includes(origin) || allowed.includes(u.origin);
    }
  } catch {}
  return false;
}

function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  if (isAllowedOrigin(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
  }
  return {};
}

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss:;",
};

// P0 降载：gzip 感知发送（默认关闭压缩，仅客户端显式声明才压；SSE 流不受影响）
const GZIP_MIN_BYTES = 1024;
function clientAcceptsGzip(req) {
  try {
    const ae = (req && req.headers && req.headers['accept-encoding']) || '';
    return /(^|,|\s)gzip(\s|,|;|$)/i.test(ae);
  } catch {
    return false;
  }
}
function sendJsonGzipAware(res, statusCode, bodyStr, req, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    ...SECURITY_HEADERS,
    ...getCorsHeaders(req),
    ...extraHeaders,
  };
  let payload = bodyStr;
  if (clientAcceptsGzip(req) && Buffer.byteLength(bodyStr, 'utf8') >= GZIP_MIN_BYTES) {
    try {
      payload = zlib.gzipSync(bodyStr);
      headers['Content-Encoding'] = 'gzip';
    } catch {
      payload = bodyStr;
    }
  }
  res.writeHead(statusCode, headers);
  res.end(payload);
}

function sendJson(res, statusCode, data, req = null, extraHeaders = {}) {
  const requestObj = req || res.req;
  sendJsonGzipAware(res, statusCode, JSON.stringify(data), requestObj, extraHeaders);
}

// P0 降载：静态资源弱 ETag（size-mtime 指纹）
function staticETag(stat) {
  return 'W/"' + stat.size.toString(16) + '-' + Number(stat.mtimeMs).toString(16) + '"';
}
function isStaticTextual(ext) {
  return ext === '.html' || ext === '.css' || ext === '.js' || ext === '.mjs' ||
    ext === '.json' || ext === '.svg' || ext === '.txt';
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Static file handler
 */
function serveStaticFile(reqPath, res) {
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.resolve(STATIC_DIR, '.' + path.sep + safePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    filePath = path.join(STATIC_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    filePath = path.join(STATIC_DIR, 'index.html');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    // P0 降载：静态缓存头 + 条件请求（拦截页 no-store 分支不受影响，本函数只服务 static/）
    const stat = fs.statSync(filePath);
    const etag = staticETag(stat);
    const lastMod = stat.mtime.toUTCString();
    const inm = res.req && res.req.headers ? (res.req.headers['if-none-match'] || '') : '';
    const ims = res.req && res.req.headers ? (res.req.headers['if-modified-since'] || '') : '';
    if ((inm && inm === etag) || (!inm && ims && ims === lastMod)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastMod, ...SECURITY_HEADERS });
      res.end();
      return;
    }
    let data = fs.readFileSync(filePath);
    const headers = {
      'Content-Type': contentType,
      ETag: etag,
      'Last-Modified': lastMod,
      'Cache-Control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
      ...getCorsHeaders(res.req),
    };
    if (isStaticTextual(ext) && clientAcceptsGzip(res.req) && data.length >= GZIP_MIN_BYTES) {
      try {
        data = zlib.gzipSync(data);
        headers['Content-Encoding'] = 'gzip';
      } catch {}
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(`Internal Server Error: ${err.message}`);
  }
}

/**
 * Authentication & Q20 Device Gate
 */
const AUTH_COOKIE_NAME = 'q20_session';
const MAX_SESSIONS = 1000;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const validSessions = new Map(); // sessionId -> { createdAt: number, expiresAt: number }
const loginAttempts = new Map(); // ip -> { count: number, failedCount: number, lockedUntil: number, windowStart: number }

// 限流阶梯锁定时长（毫秒）：失败达到 3 次开始指数递增锁定
const LOCKOUT_TIERS_MS = [
  60 * 1000,        // 3 次失败: 锁定 1 分钟
  5 * 60 * 1000,    // 4 次失败: 锁定 5 分钟
  15 * 60 * 1000,   // 5 次失败: 锁定 15 分钟
  30 * 60 * 1000,   // 6 次失败: 锁定 30 分钟
  60 * 60 * 1000,   // 7 次及以上: 锁定 60 分钟
];

// 定期清理过期 session 与限速记录（防内存堆积）
setInterval(() => {
  const now = Date.now();
  for (const [sid, sess] of validSessions.entries()) {
    if (!sess || now > sess.expiresAt) {
      validSessions.delete(sid);
    }
  }
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (!attempt || (now > attempt.lockedUntil && now - attempt.windowStart > 60 * 60 * 1000)) {
      loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function checkWeakAuthToken() {
  // P0 安全：弱登录令牌启动告警（只警告不阻断，轮换由运维执行）
  try {
    if (process.env.Q20_AUTH_TOKEN) {
      if (process.env.Q20_AUTH_TOKEN.trim().length < 16) {
        console.warn('[SECURITY] Q20_AUTH_TOKEN 低于 16 字符（建议 ≥32 随机字符），请轮换为强令牌');
      }
      return;
    }
    const tokenFile = path.join(__dirname, '.q20_token');
    if (fs.existsSync(tokenFile)) {
      const len = fs.readFileSync(tokenFile, 'utf8').trim().length;
      if (len < 16) {
        console.warn(`[SECURITY] .q20_token 仅 ${len} 字符（建议 ≥32 随机字符），请轮换为强令牌`);
      }
    } else {
      console.warn('[SECURITY] 未配置 Q20_AUTH_TOKEN 或 .q20_token，登录端点将返回 500');
    }
  } catch (err) {
    console.warn(`[SECURITY] 登录令牌检查失败: ${err.message}`);
  }
}

function getExpectedToken() {
  if (process.env.Q20_AUTH_TOKEN) {
    return process.env.Q20_AUTH_TOKEN.trim();
  }
  const tokenFile = path.join(__dirname, '.q20_token');
  try {
    if (fs.existsSync(tokenFile)) {
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      return token;
    }
  } catch (err) {
    console.error(`[AUTH] Failed to read token file: ${err.message}`);
  }
  return '';
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const key = parts.shift().trim();
      const rawVal = parts.join('=');
      try {
        list[key] = decodeURIComponent(rawVal);
      } catch {
        list[key] = rawVal;
      }
    }
  });
  return list;
}

function isQ20Client(req) {
  const ua = req.headers['user-agent'] || '';
  // BlackBerry 10 user agent contains "BB10" and "AppleWebKit/537" or "Version/10."
  return ua.includes('BB10') && (ua.includes('AppleWebKit') || ua.includes('Safari'));
}

function isLoopbackRequest(req) {
  const ip = req.socket?.remoteAddress || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    Boolean(process.env.SKIP_Q20_AUTH)
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (!attempt) return { allowed: true };

  // 1. 检查是否处于阶梯锁定期内
  if (attempt.lockedUntil && now < attempt.lockedUntil) {
    const remainingSeconds = Math.ceil((attempt.lockedUntil - now) / 1000);
    return { allowed: false, remainingSeconds, reason: 'locked' };
  }

  // 2. 每分钟尝试频次窗口滑动检查（限制每分钟最多 10 次请求）
  if (now - attempt.windowStart > 60 * 1000) {
    attempt.count = 0;
    attempt.windowStart = now;
  }
  if (attempt.count >= 10) {
    const remainingSeconds = Math.ceil((attempt.windowStart + 60 * 1000 - now) / 1000);
    return { allowed: false, remainingSeconds, reason: 'rate_limited' };
  }

  return { allowed: true };
}

function recordLoginAttempt(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || {
    count: 0,
    failedCount: 0,
    lockedUntil: 0,
    windowStart: now,
  };
  if (now - attempt.windowStart > 60 * 1000) {
    attempt.count = 0;
    attempt.windowStart = now;
  }
  attempt.count += 1;
  loginAttempts.set(ip, attempt);
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || {
    count: 1,
    failedCount: 0,
    lockedUntil: 0,
    windowStart: now,
  };
  attempt.failedCount += 1;

  // 失败 3 次以上触发指数避退阶梯锁定
  if (attempt.failedCount >= 3) {
    const tierIndex = Math.min(attempt.failedCount - 3, LOCKOUT_TIERS_MS.length - 1);
    const lockDuration = LOCKOUT_TIERS_MS[tierIndex];
    attempt.lockedUntil = now + lockDuration;
  }

  loginAttempts.set(ip, attempt);
}

function resetFailedAttempt(ip) {
  const attempt = loginAttempts.get(ip);
  if (attempt) {
    attempt.failedCount = 0;
    attempt.lockedUntil = 0;
  }
}

function isSessionValid(sessionId) {
  if (!sessionId) return false;
  const sess = validSessions.get(sessionId);
  if (!sess) return false;
  if (Date.now() > sess.expiresAt) {
    validSessions.delete(sessionId);
    return false;
  }
  return true;
}

function renderDeviceBlockedPage(res) {
  const artWind = `<svg width="140" height="72" viewBox="0 0 140 72"><rect x="46" y="6" width="58" height="30" rx="3" fill="#262626" stroke="#00897B" stroke-width="2"/><rect x="46" y="6" width="58" height="9" fill="#00897B"/><path d="M53 6 l6 9 M65 6 l6 9 M77 6 l6 9 M89 6 l6 9" stroke="#121212" stroke-width="2"/><rect x="70" y="36" width="6" height="9" fill="#4DB6AC"/><g stroke="#4DB6AC" stroke-width="2" stroke-linecap="round" fill="none"><path class="q20-w1" d="M4 50 h28 a5 5 0 1 0 -5 -5"/><path class="q20-w2" d="M4 60 h38 a5 5 0 1 1 -5 5"/><path class="q20-w3" d="M98 55 h34 a5 5 0 1 0 -5 -5"/></g></svg>`;
  const artTurtle = `<svg width="140" height="72" viewBox="0 0 140 72"><ellipse cx="70" cy="62" rx="32" ry="4" fill="#000000" opacity="0.35"/><g class="q20-stroll"><g class="q20-bob"><rect x="60" y="22" width="18" height="13" rx="1" fill="#E0E0E0" stroke="#9E9E9E" stroke-width="1"/><path d="M63 27 h12 M63 30 h12" stroke="#9E9E9E" stroke-width="1"/><ellipse cx="70" cy="46" rx="23" ry="13" fill="#00796B" stroke="#4DB6AC" stroke-width="2"/><path d="M53 41 l11 5 M70 37 l0 10 M87 41 l-11 5" stroke="#004D40" stroke-width="1.5"/><circle cx="95" cy="42" r="8" fill="#00796B" stroke="#4DB6AC" stroke-width="2"/><circle cx="97" cy="40" r="1.6" fill="#E0E0E0"/><ellipse class="q20-step1" cx="59" cy="58" rx="5" ry="3" fill="#4DB6AC"/><ellipse class="q20-step2" cx="81" cy="58" rx="5" ry="3" fill="#4DB6AC"/></g></g></svg>`;
  const artSleep = `<svg width="120" height="72" viewBox="0 0 120 72"><rect x="28" y="36" width="34" height="24" rx="3" fill="#262626" stroke="#00897B" stroke-width="2"/><path d="M62 40 h8 a6 6 0 0 1 0 12 h-6" fill="none" stroke="#00897B" stroke-width="2"/><path class="q20-steam1" d="M38 32 c-3 -5 3 -8 0 -13" fill="none" stroke="#4DB6AC" stroke-width="2" stroke-linecap="round"/><path class="q20-steam2" d="M50 32 c-3 -5 3 -8 0 -13" fill="none" stroke="#4DB6AC" stroke-width="2" stroke-linecap="round"/><text class="q20-z1" x="80" y="46" fill="#9E9E9E" font-size="15" font-weight="bold">Z</text><text class="q20-z2" x="93" y="34" fill="#616161" font-size="19" font-weight="bold">Z</text></svg>`;
  const artStars = `<svg width="140" height="72" viewBox="0 0 140 72"><circle cx="104" cy="20" r="12" fill="#FFD54F"/><circle cx="99" cy="17" r="10" fill="#121212"/><circle class="q20-tw1" cx="28" cy="16" r="3" fill="#E0E0E0"/><circle class="q20-tw2" cx="54" cy="32" r="2.2" fill="#4DB6AC"/><circle class="q20-tw3" cx="38" cy="48" r="2.6" fill="#E0E0E0"/><circle class="q20-tw2" cx="78" cy="12" r="2" fill="#E0E0E0"/><circle class="q20-tw1" cx="66" cy="50" r="2.4" fill="#4DB6AC"/><path d="M0 64 Q35 52 70 64 T140 64 V72 H0 Z" fill="#1E1E1E" stroke="#333333" stroke-width="1"/><rect x="30" y="52" width="12" height="9" fill="#262626" stroke="#00897B" stroke-width="1"/><path d="M30 52 l6 -5 6 5" fill="none" stroke="#00897B" stroke-width="1"/></svg>`;
  const artTea = `<svg width="120" height="72" viewBox="0 0 120 72"><ellipse cx="60" cy="62" rx="30" ry="4" fill="none" stroke="#333333" stroke-width="1.5"/><path d="M35 34 h50 l-6 22 h-38 z" fill="#262626" stroke="#00897B" stroke-width="2"/><ellipse cx="60" cy="34" rx="25" ry="4" fill="#004D40" stroke="#4DB6AC" stroke-width="1.5"/><path d="M85 38 h5 a7 7 0 0 1 0 14 h-4" fill="none" stroke="#00897B" stroke-width="2"/><path class="q20-steam1" d="M52 28 c-3 -5 3 -8 0 -13" fill="none" stroke="#4DB6AC" stroke-width="2" stroke-linecap="round"/><path class="q20-steam2" d="M66 28 c-3 -5 3 -8 0 -13" fill="none" stroke="#4DB6AC" stroke-width="2" stroke-linecap="round"/></svg>`;
  const playfulCards = [
    { text: '哎呀，你走错片场啦，这里什么都没有，只有穿堂风。', art: artWind },
    { text: '这只小乌龟驮着页面去散步了，暂时不在家。', art: artTurtle },
    { text: '茶水间公告：本页面正在午睡，请晚点再来。', art: artSleep },
    { text: '你找的页面去隔壁看星星了，今晚不回来。', art: artStars },
    { text: '此路不通，但风景不错，不如坐下来喝杯茶。', art: artTea },
  ];
  const pick = playfulCards[Math.floor(Math.random() * playfulCards.length)];
  res.writeHead(403, {
    'Content-Type': 'text/html; charset=utf-8',
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>走错片场了</title>
<style>
body { background: #121212; color: #E0E0E0; font-family: sans-serif; text-align: center; padding: 40px 20px; margin: 0; }
h1 { font-size: 18px; color: #00897B; margin-bottom: 12px; }
p { font-size: 13px; color: #9E9E9E; line-height: 1.5; margin: 8px 0; }
.box { border: 1px solid #333; background: #1E1E1E; padding: 16px; margin: 20px auto; max-width: 320px; }
.art { margin: 2px auto 10px; height: 78px; }
.art svg { display: block; margin: 0 auto; }
@-webkit-keyframes q20drift { 0%,100% { -webkit-transform: translateX(-5px); } 50% { -webkit-transform: translateX(5px); } }
@keyframes q20drift { 0%,100% { transform: translateX(-5px); } 50% { transform: translateX(5px); } }
@-webkit-keyframes q20stroll { 0%,100% { -webkit-transform: translateX(-26px); } 50% { -webkit-transform: translateX(26px); } }
@keyframes q20stroll { 0%,100% { transform: translateX(-26px); } 50% { transform: translateX(26px); } }
@-webkit-keyframes q20bob { 0%,100% { -webkit-transform: translateY(0); } 50% { -webkit-transform: translateY(-3px); } }
@keyframes q20bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@-webkit-keyframes q20steam { 0% { -webkit-transform: translateY(5px); opacity: 0; } 35% { opacity: .9; } 100% { -webkit-transform: translateY(-9px); opacity: 0; } }
@keyframes q20steam { 0% { transform: translateY(5px); opacity: 0; } 35% { opacity: .9; } 100% { transform: translateY(-9px); opacity: 0; } }
@-webkit-keyframes q20tw { 0%,100% { opacity: 1; } 50% { opacity: .15; } }
@keyframes q20tw { 0%,100% { opacity: 1; } 50% { opacity: .15; } }
@-webkit-keyframes q20floatz { 0% { -webkit-transform: translateY(7px); opacity: 0; } 30% { opacity: 1; } 100% { -webkit-transform: translateY(-11px); opacity: 0; } }
@keyframes q20floatz { 0% { transform: translateY(7px); opacity: 0; } 30% { opacity: 1; } 100% { transform: translateY(-11px); opacity: 0; } }
@-webkit-keyframes q20step { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes q20step { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.q20-w1 { -webkit-animation: q20drift 1.6s ease-in-out infinite; animation: q20drift 1.6s ease-in-out infinite; }
.q20-w2 { -webkit-animation: q20drift 2.1s ease-in-out .3s infinite; animation: q20drift 2.1s ease-in-out .3s infinite; }
.q20-w3 { -webkit-animation: q20drift 1.3s ease-in-out .6s infinite; animation: q20drift 1.3s ease-in-out .6s infinite; }
.q20-stroll { -webkit-animation: q20stroll 5s ease-in-out infinite; animation: q20stroll 5s ease-in-out infinite; }
.q20-bob { -webkit-animation: q20bob 1.2s ease-in-out infinite; animation: q20bob 1.2s ease-in-out infinite; }
.q20-step1 { -webkit-animation: q20step .6s linear infinite; animation: q20step .6s linear infinite; }
.q20-step2 { -webkit-animation: q20step .6s linear .3s infinite; animation: q20step .6s linear .3s infinite; }
.q20-steam1 { -webkit-animation: q20steam 2.4s ease-in-out infinite; animation: q20steam 2.4s ease-in-out infinite; }
.q20-steam2 { -webkit-animation: q20steam 2.4s ease-in-out 1.2s infinite; animation: q20steam 2.4s ease-in-out 1.2s infinite; }
.q20-tw1 { -webkit-animation: q20tw 1.8s ease-in-out infinite; animation: q20tw 1.8s ease-in-out infinite; }
.q20-tw2 { -webkit-animation: q20tw 2.3s ease-in-out .5s infinite; animation: q20tw 2.3s ease-in-out .5s infinite; }
.q20-tw3 { -webkit-animation: q20tw 1.5s ease-in-out 1s infinite; animation: q20tw 1.5s ease-in-out 1s infinite; }
.q20-z1 { -webkit-animation: q20floatz 2.8s ease-in-out infinite; animation: q20floatz 2.8s ease-in-out infinite; }
.q20-z2 { -webkit-animation: q20floatz 2.8s ease-in-out 1.4s infinite; animation: q20floatz 2.8s ease-in-out 1.4s infinite; }
</style>
</head>
<body>
<div class="box">
  <div class="art">${pick.art}</div>
  <h1>咦？这里空空如也</h1>
  <p>${pick.text}</p>
  <p>不如回去喝杯茶，明天再来碰碰运气。</p>
</div>
</body>
</html>`);
}

/**
 * Create HTTP Server
 */
const server = http.createServer((req, res) => {
  Promise.resolve().then(async () => {
    let parsedUrl;
    try {
      // 避免非法 Host 头注入导致 new URL 崩溃
      parsedUrl = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request: Invalid URL');
      return;
    }
    const { pathname, searchParams } = parsedUrl;

    console.log(`[REQ] ${req.method} ${pathname}`);
    if (pathname === '/api/chat/stream') {
      const sanitizedHeaders = { ...req.headers };
      if (sanitizedHeaders.cookie) {
        sanitizedHeaders.cookie = '[REDACTED]';
      }
      if (sanitizedHeaders.authorization) {
        sanitizedHeaders.authorization = '[REDACTED]';
      }
      console.log(`[STREAM REQ HEADERS] ${JSON.stringify(sanitizedHeaders)}`);
    }
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const corsHeaders = getCorsHeaders(req);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // --- Availability Probe (unauthenticated, UA-agnostic) ---
    // 须位于安全网关拦截器之前：Traefik/主机看门狗/人工探活无登录 Cookie 亦
    // 无 BB10 UA；`/` 会被 UA 门拦截、`api/*` 需鉴权，均不适合做存活探针。
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = JSON.stringify({ ok: true, service: 'dsh-bb10-web', uptime: Math.floor(process.uptime()) });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? '' : body);
      return;
    }

  // --- Security Gateway Interceptor ---
  const isLoopback = isLoopbackRequest(req);
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = (forwardedFor ? String(forwardedFor).split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown';

  // 1. Device UA restriction (Loopback & ACME challenges allowed)
  const isAcmeChallenge = pathname.startsWith('/.well-known/acme-challenge/');
  if (!isLoopback && !isAcmeChallenge) {
    if (!isQ20Client(req)) {
      renderDeviceBlockedPage(res);
      return;
    }
  }

  // 2. Authentication API endpoints
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[AUTH_COOKIE_NAME];
    const authenticated = isLoopback || isSessionValid(sessionToken);
    sendJson(res, 200, { authenticated, isLoopback });
    return;
  }

  // P0 安全：登出/吊销登录态（loopback 亦可调用；Cookie 校验后服务端删除 + Max-Age=0 覆盖）
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[AUTH_COOKIE_NAME];
    const revoked = Boolean(sessionToken) && validSessions.delete(sessionToken);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      ...SECURITY_HEADERS,
      ...getCorsHeaders(req),
    });
    res.end(JSON.stringify({ success: true, revoked }));
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      const waitMsg = rateCheck.remainingSeconds ? `请在 ${rateCheck.remainingSeconds} 秒后再试。` : '请稍后再试。';
      sendJson(res, 429, {
        error: rateCheck.reason === 'locked'
          ? `登录失败次数过多已被临时锁定，${waitMsg}`
          : `请求频率过高，${waitMsg}`,
        remainingSeconds: rateCheck.remainingSeconds,
      });
      return;
    }
    recordLoginAttempt(clientIp);
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON request' });
      return;
    }
    const submittedToken = (body.token || '').trim();
    const expectedToken = getExpectedToken();

    if (!expectedToken) {
      sendJson(res, 500, { error: 'Server authentication token not configured' });
      return;
    }

    // 防时序攻击：使用 SHA-256 计算定长摘要后再执行 timingSafeEqual，避免长度短路泄漏与字符串比较时序差异
    const submittedHash = crypto.createHash('sha256').update(submittedToken).digest();
    const expectedHash = crypto.createHash('sha256').update(expectedToken).digest();
    const isMatch = crypto.timingSafeEqual(submittedHash, expectedHash);

    if (isMatch) {
      resetFailedAttempt(clientIp);
      if (validSessions.size >= MAX_SESSIONS) {
        // 清理最老的一批 session
        const oldestSid = validSessions.keys().next().value;
        if (oldestSid) validSessions.delete(oldestSid);
      }
      const sessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
      validSessions.set(sessionId, { createdAt: Date.now(), expiresAt });

      // P0 安全：Q20_COOKIE_SECURE=1 时签发 Secure（生产 EdgeOne TLS 生效；源站直连 HTTP 时默认不设）
      const secureFlag = process.env.Q20_COOKIE_SECURE === '1' ? '; Secure' : '';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${AUTH_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}; HttpOnly; SameSite=Lax${secureFlag}`,
        ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ success: true }));
      return;
    } else {
      recordFailedAttempt(clientIp);
      sendJson(res, 401, { error: 'Invalid Access Token' });
      return;
    }
  }

  // 3. Check Session for Protected Endpoints
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[AUTH_COOKIE_NAME];
  const isAuthenticated = isLoopback || isSessionValid(sessionToken);

  // If trying to access API endpoints without auth
  if (!isAuthenticated && pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Unauthorized. Please login first.' });
    return;
  }

  // API routing
  if (req.method === 'GET' && pathname === '/api/dsh/status') {
    try {
      const force = searchParams.get('refresh') === '1';
      const dshAlive = await checkDshHostAlive(force);
      sendJson(res, 200, { ok: true, dshAlive });
    } catch (err) {
      sendJson(res, 500, { ok: false, dshAlive: false, error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    try {
      const { models, current, permissions } = await readModelCatalog();
      const workspaces = getWorkspaces();
      const dshAlive = await checkDshHostAlive(searchParams.get('refresh') === '1');
      sendJson(res, 200, {
        workspaces,
        models,
        permissions,
        dshAlive,
        current: {
          ...current,
          workspaceCwd: process.cwd(),
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    try {
      const cwd = searchParams.get('cwd');
      const filter = searchParams.get('filter') || 'hide-archived';
      const sessT0 = Date.now();
      console.log(`[API /api/sessions] fetching cwd: ${cwd}, filter: ${filter}`);
      if (!cwd) {
        sendJson(res, 400, { error: 'Missing query parameter "cwd"' });
        return;
      }
      if (searchParams.get('refresh') === '1') {
        invalidateSessionsCache(cwd);
      }
      // C-3：热路径只读已知快照，宿主刷新一律后台化（fire-and-forget）
      scheduleHostSessionListRefresh();
      const sessions = await getSessionsForCwdCached(cwd, filter);
      console.log(`[API /api/sessions] resolved ${sessions.length} sessions for cwd: ${cwd} in ${Date.now() - sessT0}ms`);
      sendJson(res, 200, sessions);
    } catch (err) {
      console.error(`[API /api/sessions ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  // 轻量运行状态端点（契约 C-8 v1.2 / C-18 / C-20）：纯内存读，零宿主 RPC、零磁盘 IO。
  // 响应：{ ok:true, at:<ms>, states:{ "<sid>":{ isRunning, state, known, source } } }
  if (req.method === 'GET' && pathname === '/api/sessions/status') {
    const idsRaw = searchParams.get('ids');
    if (idsRaw === null) {
      sendJson(res, 400, { ok: false, error: 'Missing query parameter "ids"' }, req);
      return;
    }
    const ids = String(idsRaw).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
    // F6：无原型对象，保证任意 id（含 __proto__/constructor）都能作为自有键出现在 JSON 响应里
    const states = Object.create(null);
    for (const sid of ids) {
      // F4：非法 id（含路径穿越）不进任何 fs 路径，直接给 known:false 形状
      states[sid] = isValidSessionId(sid)
        ? await sessionStatusFact(sid)
        : { isRunning: false, state: 'idle', known: false, source: '' };
    }
    sendJson(res, 200, { ok: true, at: Date.now(), states }, req);
    return;
  }

  // 未分组会话（对齐 dsh web Ungrouped）：无归属注册的落盘会话
  if (req.method === 'GET' && pathname === '/api/sessions/ungrouped') {
    try {
      // refresh=1 跳缓存（写后对账/测试宿主直写场景用；正常 GET 走 10s TTL 防双核阻塞）
      if (searchParams.get('refresh') === '1') invalidateUngroupedCache();
      const sessions = await getUngroupedSessions();
      sendJson(res, 200, sessions);
    } catch (err) {
      console.error(`[API /api/sessions/ungrouped ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    try {
      const cwd = searchParams.get('cwd');
      const id = searchParams.get('id');
      const limitRaw = searchParams.get('limit');
      const turnsRaw = searchParams.get('turns');
      const beforeRaw = searchParams.get('before');
      console.log(`[API /api/history] fetching cwd: ${cwd}, id: ${id}, limit: ${limitRaw}, turns: ${turnsRaw}, before: ${beforeRaw}`);
      if (!cwd || !id) {
        sendJson(res, 400, { error: 'Missing query parameter "cwd" or "id"' });
        return;
      }
      const history = getSessionHistory(cwd, id);
      console.log(`[API /api/history] resolved ${history.length} messages for session ${id}`);

      // Turn-based slicing for lazy loading: keep complete turns (user + assistant steps) together
      if (turnsRaw !== null && turnsRaw !== undefined) {
        const turnsLimit = Math.max(1, parseInt(turnsRaw, 10) || 5);
        // Identify turn boundaries: index of each user message represents the start of a turn
        const turnStartIndices = [];
        for (let i = 0; i < history.length; i++) {
          if (history[i].role === 'user') {
            turnStartIndices.push(i);
          }
        }

        // Total turns count: if history has items before the first user message, or has no user messages at all,
        // we treat those leading messages as part of turn 0.
        const totalTurns = turnStartIndices.length > 0 ? turnStartIndices.length : (history.length > 0 ? 1 : 0);
        let endTurnIndex = totalTurns; // 0-based exclusive
        let endMsgIndex = history.length;

        if (beforeRaw !== null && beforeRaw !== undefined) {
          const parsedBefore = parseInt(beforeRaw, 10);
          if (!isNaN(parsedBefore)) {
            // Clamp before to [0, history.length]
            endMsgIndex = Math.max(0, Math.min(history.length, parsedBefore));
            // Find which turn ends before this message index
            let tIdx = 0;
            for (let i = 0; i < turnStartIndices.length; i++) {
              if (turnStartIndices[i] < endMsgIndex) {
                tIdx = i + 1;
              } else {
                break;
              }
            }
            endTurnIndex = tIdx;
          }
        }

        const startTurnIndex = Math.max(0, endTurnIndex - turnsLimit);
        // When startTurnIndex is 0, we must always anchor to message index 0 (including any leading system/agent messages)
        let startMsgIndex = 0;
        if (endMsgIndex <= 0) {
          startMsgIndex = 0;
        } else if (startTurnIndex > 0 && startTurnIndex < turnStartIndices.length) {
          startMsgIndex = turnStartIndices[startTurnIndex];
        } else if (startTurnIndex >= turnStartIndices.length && turnStartIndices.length > 0) {
          startMsgIndex = endMsgIndex;
        }

        // Safe slicing
        if (startMsgIndex > endMsgIndex) {
          startMsgIndex = endMsgIndex;
        }

        const sliced = history.slice(startMsgIndex, endMsgIndex);
        sendJson(res, 200, {
          cwd: cwd,
          messages: sliced,
          total: history.length,
          startIndex: startMsgIndex,
          endIndex: endMsgIndex,
          hasMore: startMsgIndex > 0,
          totalTurns: totalTurns,
          startTurn: startTurnIndex,
          endTurn: endTurnIndex,
          hasMoreTurns: (endMsgIndex > 0) && (startTurnIndex > 0 || startMsgIndex > 0),
        });
        return;
      }

      // If limit query is provided, perform slicing for lazy loading
      if (limitRaw !== null && limitRaw !== undefined) {
        const limit = Math.max(1, parseInt(limitRaw, 10) || 20);
        const total = history.length;
        let endIndex = total;
        if (beforeRaw !== null && beforeRaw !== undefined) {
          const before = parseInt(beforeRaw, 10);
          if (!isNaN(before) && before >= 0 && before <= total) {
            endIndex = before;
          }
        }
        const startIndex = Math.max(0, endIndex - limit);
        const sliced = history.slice(startIndex, endIndex);
        sendJson(res, 200, {
          cwd: cwd,
          messages: sliced,
          total: total,
          startIndex: startIndex,
          endIndex: endIndex,
          hasMore: startIndex > 0,
        });
        return;
      }

      sendJson(res, 200, history);
    } catch (err) {
      console.error(`[API /api/history ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  // Q20 消息内文件预览·通道①：官方附件对象存储（sha256 内容寻址，只读）。
  // 无宿主 RPC 依赖（宿主 session/attachment 只覆盖 image 且需在线，
  // 与 /api/history 直读 zstd 的既有镜像口径一致）。
  // P0 安全：`name`/`mediaType` 只是调用方声明，不参与白名单与 Content-Type；
  // 存储叶名（存在即事实）或内容签名才是闸门。
  if (req.method === 'GET' && pathname === '/api/attachment') {
    const id = searchParams.get('id') || '';
    const name = searchParams.get('name') || '';
    if (!ATTACHMENT_ID_RE.test(id)) {
      sendJson(res, 400, { ok: false, error: 'Missing or invalid attachment "id"' }, req);
      return;
    }
    const resolved = resolveAttachmentObjectPath(id, name);
    if (!resolved) {
      sendJson(res, 404, { ok: false, error: 'attachment object not found' }, req);
      return;
    }
    // 内容寻址对象不可变：长缓存，避免窗口重渲染反复重下全分辨率图
    servePreviewFile(req, res, resolved.path, resolved.gateName, 'private, max-age=31536000, immutable');
    return;
  }

  // Q20 消息内文件预览·通道②：注册工作区内的图片 / txt / md（markdown 引用）。
  // P0 安全：闸门只用服务端 realpath 结果的 basename；调用方 name 一律忽略。
  if (req.method === 'GET' && pathname === '/api/file') {
    const resolved = resolveWorkspacePreviewPath(searchParams.get('cwd') || '', searchParams.get('path') || '');
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error }, req);
      return;
    }
    // 工作区文件可变：不缓存（内容敏感，改一次就该看到新内容）
    servePreviewFile(req, res, resolved.path, path.basename(resolved.path), 'private, no-cache');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session/stats') {
    try {
      const cwd = searchParams.get('cwd');
      const id = searchParams.get('id') || '';
      if (!cwd) {
        sendJson(res, 400, { error: 'Missing query parameter "cwd"' });
        return;
      }
      const stats = await getSessionStats(cwd, id);
      sendJson(res, 200, stats);
    } catch (err) {
      console.error(`[API /api/session/stats ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session/goal') {
    try {
      const cwd = searchParams.get('cwd');
      const id = searchParams.get('id') || '';
      if (!cwd) {
        sendJson(res, 400, { error: 'Missing query parameter "cwd"' });
        return;
      }
      const goal = getSessionGoal(cwd, id);
      sendJson(res, 200, { sessionId: id, goal });
    } catch (err) {
      console.error(`[API /api/session/goal ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session/subagents') {
    try {
      const cwd = searchParams.get('cwd');
      const id = searchParams.get('id') || '';
      if (!cwd) {
        sendJson(res, 400, { error: 'Missing query parameter "cwd"' });
        return;
      }
      const limitRaw = parseInt(searchParams.get('limit') || '', 10);
      const offsetRaw = parseInt(searchParams.get('offset') || '', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 0;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const lite = searchParams.get('lite') === '1' || searchParams.get('lite') === 'true';
      const data = id
        ? await getSessionSubagents(cwd, id)
        : await getWorkspaceSubagents(cwd);
      // 分页切片：缺省 limit=0 走全量（旧调用零影响）；显式 limit 时返回页 + total + page。
      if (limit > 0 && Array.isArray(data.subagents)) {
        const total = data.subagents.length;
        data.total = total;
        data.subagents = data.subagents.slice(offset, offset + limit);
        data.page = { limit, offset, total };
      } else if (typeof data.total !== 'number') {
        data.total = Array.isArray(data.subagents) ? data.subagents.length : 0;
      }
      // 懒加载精简：lite=1 只回列表所需的轻量字段（标题/徽章/状态），
      // 任务详情（description/blockedBy/writeScopes）与子智能体 model 按需另取。
      if (lite) {
        sendJson(res, 200, applySubagentLite(data));
        return;
      }
      sendJson(res, 200, data);
    } catch (err) {
      console.error(`[API /api/session/subagents ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/workspace/create') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    // 新契约：{ name } 单名 → ~/name（默认 ~/ 下，不接受其它路径）。
    // 兼容旧客户端 { path }：仅接受恰好落在 ~/ 之下的一段子目录（~/name），其余一律 400。
    let rawName = (body && typeof body.name === 'string') ? body.name : '';
    if (!rawName && body && typeof body.path === 'string') {
      const p = body.path.trim();
      const home = os.homedir();
      if (p === '~' || p === '~/') {
        rawName = '';
      } else if (p.startsWith('~/')) {
        rawName = p.slice(2);
      } else if (p.startsWith(home + '/')) {
        rawName = p.slice(home.length + 1);
      } else {
        rawName = p; // 交给 validateWorkspaceName 报非法（含 / 即拒）
      }
    }
    const nv = validateWorkspaceName(rawName);
    if (!nv.ok) {
      sendJson(res, 400, { error: (rawName ? nv.error : 'Missing required field "name"') });
      return;
    }
    try {
      const result = await createHomeWorkspace(nv.name);
      sendJson(res, 200, {
        ok: true,
        created: result.created,
        workspace: result.workspace,
      });
    } catch (err) {
      console.error(`[API /api/workspace/create ERROR] ${err.stack || err.message}`);
      const msg = sanitizeErrorMessage(err) || 'Failed to create workspace';
      const code = (msg.indexOf('已存在') !== -1 || msg.indexOf('同名') !== -1) ? 409 : 400;
      sendJson(res, code, { error: msg }, req);
    }
    return;
  }

  // 仅注销注册（对齐官方 delete：文件夹与会话保留，其会话落入 Ungrouped）。绝不删目录。
  if (req.method === 'POST' && pathname === '/api/workspace/remove') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
    if (!cwd) {
      sendJson(res, 400, { error: 'Missing required field "cwd"' });
      return;
    }
    try {
      const removed = await removeWorkspaceByCwd(cwd);
      sendJson(res, 200, { ok: true, removed });
    } catch (err) {
      console.error(`[API /api/workspace/remove ERROR] ${err.stack || err.message}`);
      const msg = sanitizeErrorMessage(err) || 'Failed to remove workspace';
      // 注册表不可读是服务端故障 → 500；其余按子串分流（生产 sanitize 下 404 语义靠 review，见 ADR）
      const code = (msg.indexOf('不可读') !== -1) ? 500
        : ((msg.indexOf('未注册') !== -1 || msg.indexOf('已移除') !== -1) ? 404 : 400);
      sendJson(res, code, { error: msg }, req);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/archive') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { cwd, sessionId } = body;
    if (!cwd || !sessionId) {
      sendJson(res, 400, { error: 'Missing required field "cwd" or "sessionId"' });
      return;
    }
    try {
      const sessionDir = findSessionDir(cwd, sessionId);
      if (!sessionDir || !fs.existsSync(sessionDir)) {
        sendJson(res, 404, { error: `Session ${sessionId} not found` });
        return;
      }
      // 与 DSH 官方一致：优先尝试通知 DSH 官方 Web 服务执行归档（令 Web 实时 UI 与 Feed 同步更新）
      const rpcResult = await callDshWebArchiveSession(sessionId);
      if (rpcResult && rpcResult.ok) {
        // DSH Web RPC 写入成功，它会自动将 sessionId 追加到 workspace.json 并通过 Feed 发送给所有连接客户端。
        // 官方落盘可能有延迟：先记内存遮罩保证本服务列表立即可见，再刷新本地文件缓存并失效工作区计数。
        markArchivedOverlay(sessionId);
        try {
          const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
          const doc = JSON.parse(fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8'));
          workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
        } catch {}
        workspacesCache = null;
        hostRunningCache = { ids: null, at: 0 };
        try { invalidateSessionsCache(); } catch {}
        try { invalidateUngroupedCache(); } catch {}
        console.log(`[API /api/session/archive] archived ${sessionId} via official DSH Web RPC`);
      } else {
        // DSH Web 服务未启动或 RPC 失败，本地原子写入 workspace.json 作为兜底保障
        appendArchivedSessionId(sessionId);
        markArchivedOverlay(sessionId);
        workspacesCache = null;
        hostRunningCache = { ids: null, at: 0 };
        try { invalidateSessionsCache(); } catch {}
        try { invalidateUngroupedCache(); } catch {}
        console.log(`[API /api/session/archive] archived ${sessionId} via local workspace domain write`);
      }
      sendJson(res, 200, { ok: true, message: `Session ${sessionId} archived successfully` });
    } catch (err) {
      console.error(`[API /api/session/archive ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  if (req.method === 'POST' && (pathname === '/api/session/unarchive' || pathname === '/api/session/restore')) {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { cwd, sessionId } = body;
    if (!cwd || !sessionId) {
      sendJson(res, 400, { error: 'Missing required field "cwd" or "sessionId"' });
      return;
    }
    try {
      // 优先通知 DSH 官方 Web 服务执行取消归档
      const rpcResult = await callDshWebUnarchiveSession(sessionId);
      if (rpcResult && rpcResult.ok) {
        unmarkArchivedOverlay(sessionId);
        try {
          const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
          const doc = JSON.parse(fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8'));
          workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
        } catch {}
        workspacesCache = null;
        hostRunningCache = { ids: null, at: 0 };
        try { invalidateSessionsCache(); } catch {}
        try { invalidateUngroupedCache(); } catch {}
        console.log(`[API /api/session/unarchive] unarchived ${sessionId} via official DSH Web RPC`);
      } else {
        removeArchivedSessionId(sessionId);
        unmarkArchivedOverlay(sessionId);
        workspacesCache = null;
        hostRunningCache = { ids: null, at: 0 };
        try { invalidateSessionsCache(); } catch {}
        try { invalidateUngroupedCache(); } catch {}
        console.log(`[API /api/session/unarchive] unarchived ${sessionId} via local workspace domain write`);
      }
      sendJson(res, 200, { ok: true, message: `Session ${sessionId} unarchived successfully` });
    } catch (err) {
      console.error(`[API /api/session/unarchive ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  // 从该轮分支为新会话：对齐官方 DSH Web session/fork { sessionId, atSeq? }。
  // atSeq 锚定到 turn/end 边界（宿主自动向后吸附）；成功后新会话由宿主写入
  // 工作区归属，需失效本地工作区缓存。仅走宿主管道（fork 即创建会话，
  // 宿主持有写租约，无本地兜底）。
  if (req.method === 'POST' && pathname === '/api/session/fork') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { sessionId, atSeq } = body;
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing required field "sessionId"' });
      return;
    }
    const forkReq = { sessionId };
    if (atSeq !== undefined && atSeq !== null) {
      const n = Number(atSeq);
      if (!Number.isSafeInteger(n) || n < 0) {
        sendJson(res, 400, { error: 'Invalid "atSeq": expected non-negative safe integer' });
        return;
      }
      forkReq.atSeq = n;
    }
    const forked = await callDshWebRpc('session/fork', forkReq, 15000);
    if (!forked.ok) {
      sendJson(res, 200, { ok: false, error: forked.error || 'session/fork failed' });
      return;
    }
    const childId = forked.value?.sessionId || '';
    // 对齐 dsh web increaseTitle：fork 成功后把源标题 +1 命名子会话
    // （Roadmap → Roadmap (1) → (2)；全角括号同理）。rename 失败不阻断，
    // 子会话已创建，标题缺失时前端列表回退显示 session- 短 id。
    try {
      const listRes = await callDshWebRpc('session/list', { _request: {} }, 6000, { rawArgs: true });
      const items = (listRes.ok && listRes.value && Array.isArray(listRes.value.items)) ? listRes.value.items : [];
      // 源标题在 projections.values.title（宿主计算的 title 投影，无独立 title 字段）。
      let sourceTitle = '';
      for (const it of items) {
        if (it && it.sessionId === sessionId) {
          const t = it.title || it.projections?.values?.title;
          if (typeof t === 'string' && t) {
            sourceTitle = t;
            break;
          }
        }
      }
      if (sourceTitle && childId) {
        await callDshWebRpc('session/rename', { sessionId: childId, title: increasedForkTitle(sourceTitle) }, 10000);
      }
    } catch {}
    workspaceDomainCache = { data: null, mtimeMs: 0 };
    workspacesCache = null;
    hostTitleCache = { map: null, at: 0 };
    hostRunningCache = { ids: null, at: 0 };
    try { invalidateSessionsCache(); } catch {}
    sendJson(res, 200, { ok: true, sessionId: childId });
    return;
  }

  if ((req.method === 'DELETE' || req.method === 'POST') && (pathname === '/api/session' || pathname === '/api/session/delete')) {
    let cwd = searchParams.get('cwd');
    let sessionId = searchParams.get('id') || searchParams.get('sessionId');
    if (req.method === 'POST' || !sessionId) {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch {
        body = {};
      }
      cwd = cwd || body.cwd;
      sessionId = sessionId || body.sessionId || body.id;
    }
    if (!cwd || !sessionId) {
      sendJson(res, 400, { error: 'Missing required parameter "cwd" or "sessionId"' });
      return;
    }
    try {
      const sessionDir = findSessionDir(cwd, sessionId);
      if (!sessionDir || !fs.existsSync(sessionDir)) {
        sendJson(res, 404, { error: `Session ${sessionId} not found` });
        return;
      }
      // 与 DSH 官方 Web 对齐：删除会话前先通知官方 DSH Web 执行归档（令 Web 实时 UI 与 Feed 同步隐藏该会话）
      try {
        const rpcResult = await callDshWebArchiveSession(sessionId);
        if (rpcResult && rpcResult.ok) {
          console.log(`[API delete session] archived ${sessionId} via official DSH Web RPC before deletion`);
        } else {
          appendArchivedSessionId(sessionId);
        }
      } catch (archiveErr) {
        console.warn(`[WARN] Pre-delete archive notice for ${sessionId} failed: ${archiveErr.message}`);
        try { appendArchivedSessionId(sessionId); } catch {}
      }

      fs.rmSync(sessionDir, { recursive: true, force: true });
      activeTasks.delete(sessionId);

      // 若所属父目录（工作区目录）已变为空目录，且属于临时目录或非官方目录，自动回收清理空父目录
      try {
        const parentDir = path.dirname(sessionDir);
        if (fs.existsSync(parentDir)) {
          const remaining = fs.readdirSync(parentDir).filter((f) => !f.startsWith('.'));
          if (remaining.length === 0) {
            fs.rmdirSync(parentDir);
            console.log(`[API delete session] cleaned up empty parent directory: ${parentDir}`);
          }
        }
      } catch (cleanErr) {
        // ignore parent cleanup failure
      }
      // 与 DSH 官方一致：删除会话时从工作区 sessionIds 列表中移除
      try {
        const raw = fs.readFileSync(WORKSPACE_DOMAIN_FILE, 'utf8');
        const doc = JSON.parse(raw);
        let modified = false;
        if (doc.tables && doc.tables.workspaces) {
          for (const ws of Object.values(doc.tables.workspaces)) {
            if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) {
              ws.sessionIds = ws.sessionIds.filter((id) => id !== sessionId);
              ws.updatedAt = new Date().toISOString();
              modified = true;
            }
          }
        }
        if (modified) {
          const tmp = path.join(path.dirname(WORKSPACE_DOMAIN_FILE), `.${crypto.randomUUID()}.tmp`);
          fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          fs.renameSync(tmp, WORKSPACE_DOMAIN_FILE);
          const st = fs.statSync(WORKSPACE_DOMAIN_FILE);
          workspaceDomainCache = { data: doc, mtimeMs: st.mtimeMs };
        }
      } catch (err) {
        console.warn(`[WARN] Failed to detach deleted session ${sessionId} from workspace: ${err.message}`);
      }
      try { invalidateUngroupedCache(); } catch {}
      workspacesCache = null;
      if (sessionId) createdSidsSeen.delete(sessionId);
      console.log(`[API delete session] deleted session directory ${sessionDir}`);
      sendJson(res, 200, { ok: true, message: `Session ${sessionId} deleted successfully` });
    } catch (err) {
      console.error(`[API delete session ERROR] ${err.stack || err.message}`);
      sendJson(res, 500, { error: sanitizeErrorMessage(err) }, req);
    }
    return;
  }

  // 运行中追发用户消息：排队（queue）进后续 FIFO 轮次，插队（steer）在最近
  // step 边界介入当前轮。直调宿主 session/prompt（与 runChatViaHostRpc 同 envelope）。
  // 仅本进程 activeTask running 时可投递：本地 SDK 引擎在途（无 rpc 通道）或
  // 会话未运行均诚实返回 ok:false，绝不静默丢弃或伪造成功。
  // Q20 文件上传代理：原生字节透传宿主 uploadFileBinary（严禁 JSON 信封）。
  if (pathname === '/api/session/upload') {
    // method 校验：宿主只收 POST，这里先行 405
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...getCorsHeaders(req), 'Allow': 'POST' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    // media 校验：只收 octet-stream（FormData/multipart 必 415）
    const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/octet-stream') {
      sendJson(res, 415, { ok: false, error: 'content type must be application/octet-stream' }, req);
      return;
    }
    const upSessionId = searchParams.get('sessionId') || '';
    const upName = searchParams.get('name') || '';
    if (!upSessionId) {
      sendJson(res, 400, { ok: false, error: 'Missing query parameter "sessionId"' }, req);
      return;
    }
    await proxyUploadToHost(req, res, upSessionId, upName);
    return;
  }
  // Q20 空会话预建：通用文件首条发送用。前端无 sid 选文件时调此建会话，
  // 拿到 sid 再走 /api/session/upload 传文件，随首问同发（DSH 官方 create 归属逻辑）。
  // 宿主不可达一律 502 fail-fast，严禁本地伪造 sid（收据归属必错）。
  if (req.method === 'POST' && pathname === '/api/session/ensure') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const cwdRaw = (body && body.cwd) || '';
    let targetCwd = '';
    try {
      targetCwd = cwdRaw ? path.resolve(String(cwdRaw)) : process.cwd();
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid "cwd"' }, req);
      return;
    }
    const sid = `session-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    // 归属与 runChatViaHostRpc 完全同源：workspaceId 优先，失败降级 cwd-only
    const workspaceId = await resolveWorkspaceIdByCwd(targetCwd);
    let created = await callDshWebRpc('session/create',
      workspaceId ? { sessionId: sid, workspaceId } : { sessionId: sid, cwd: targetCwd }, 10000);
    if (!created.ok && workspaceId && !created.unreachable) {
      created = await callDshWebRpc('session/create', { sessionId: sid, cwd: targetCwd }, 10000);
    }
    if (!created.ok) {
      if (created.unreachable) {
        sendJson(res, 502, { ok: false, error: 'host unreachable' }, req);
      } else {
        sendJson(res, 200, { ok: false, error: created.error || 'session/create failed' });
      }
      return;
    }
    const realSid = (created.value && created.value.sessionId) || sid;
    if (realSid && !createdSidsSeen.has(realSid)) {
      createdSidsSeen.add(realSid);
      workspacesCache = null;
    }
    sendJson(res, 200, { ok: true, sessionId: realSid }, req);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/session/prompt') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { sessionId, prompt, mode, receiptIds, image } = body;
    if (!sessionId || !prompt) {
      sendJson(res, 400, { error: 'Missing required field "sessionId" or "prompt"' });
      return;
    }
    // image：Q20 图片内联（png/jpeg/webp/gif + 规范 base64），形状对齐上游 PromptContentPart。
    const imgChecked = toPromptImagePart(image);
    if (!imgChecked.ok) {
      sendJson(res, 400, { error: imgChecked.error });
      return;
    }
    // receiptIds：Q20 上传返回的宿主收据（string[]，去重、上限 5 个）。
    // prompt 消费即单次核销：未知/异会话收据宿主报 FILE_NOT_STAGED，诚实回传不重试。
    let fileParts = [];
    if (receiptIds !== undefined) {
      if (!Array.isArray(receiptIds)) {
        sendJson(res, 400, { error: 'Invalid "receiptIds": expected string array' });
        return;
      }
      const seen = {};
      for (let ri = 0; ri < receiptIds.length; ri++) {
        const rid = receiptIds[ri];
        if (typeof rid !== 'string' || !rid) {
          sendJson(res, 400, { error: 'Invalid "receiptIds": expected string array' });
          return;
        }
        if (!seen[rid]) { seen[rid] = true; fileParts.push({ type: 'file', receiptId: rid }); }
        if (fileParts.length >= 5) break;
      }
    }
    if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
      sendJson(res, 400, { error: 'Invalid "mode": expected "queue" or "steer"' });
      return;
    }
    const promptMode = (mode === 'steer') ? 'steer' : 'queue';
    const task = activeTasks.get(sessionId);
    // C-7 + G1：插队/排队闸门与 /api/sessions、/api/sessions/status 共用**唯一判定函数**
    // （本地 task running → live 权威事实 → 快照命中 → 事实缓存 → C-20 冷启动桥接），
    // 保证三处同口径，且绝不因 session/list 失败/未跑而拒绝（缺陷 #4 根因）。
    const sidKey = String(sessionId);
    let gate = { isRunning: false, source: 'heuristic' };
    try {
      const bridgeCwd = (body && typeof body.cwd === 'string') ? body.cwd : '';
      const gateDir = sessionDirIndex.get(sidKey)
        || (bridgeCwd ? findSessionDir(bridgeCwd, sidKey) : null);
      gate = await resolveSessionRunning({ task: task, sessionDir: gateDir, sid: sidKey });
    } catch (err) {
      // 判定异常一律回落既有拒绝行为，绝不抛错
      gate = { isRunning: false, source: 'heuristic' };
      console.warn(`[PROMPT GATE] running resolution failed (non-fatal) sid=${sidKey} ${err && err.message}`);
    }
    if (!gate.isRunning) {
      sendJson(res, 200, { ok: false, error: 'session not running' });
      return;
    }
    // 无论是本地 activeTask 还是宿主在跑会话，均直接直连调用官方 DSH Web session/prompt
    const promptReqId = `q20-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptContent = fileParts.concat(
      imgChecked.part ? [imgChecked.part] : [],
      [{ type: 'text', text: prompt }]
    );
    const prompted = await callDshWebRpc('session/prompt', {
      requestId: promptReqId,
      sessionId,
      mode: promptMode,
      content: promptContent,
    }, 10000);
    if (!prompted.ok) {
      sendJson(res, 200, { ok: false, error: prompted.error || 'session/prompt failed' });
      return;
    }
    const queueRecord = {
      requestId: promptReqId,
      itemId: prompted.value?.itemId || '',
      text: prompt,
      time: Date.now()
    };
    if (task) {
      task.lastQueuedPrompt = queueRecord;
    }
    // 全局记录每个会话最新的排队信息，避免 task 对象生命周期脱钩
    lastQueuedPromptsBySession.set(sessionId, queueRecord);
    sendJson(res, 200, { ok: true, mode: promptMode, sessionId, requestId: promptReqId, itemId: queueRecord.itemId });
    return;
  }

  // 撤回/删除排队中的消息：对齐官方 DSH Web session/updateQueue { itemId, action: { kind: 'remove' } }
  if (req.method === 'POST' && pathname === '/api/session/queue/remove') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { sessionId, itemId } = body;
    console.log(`[QUEUE REMOVE] sessionId: ${sessionId}, itemId: ${itemId}`);
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing required field "sessionId"' });
      return;
    }
    const task = activeTasks.get(sessionId);
    console.log(`[QUEUE REMOVE] task found: ${!!task}, lastQueuedPrompt: ${JSON.stringify(task?.lastQueuedPrompt)}, inboxQueue: ${JSON.stringify(task?.inboxQueue)}`);
    // 查找待撤回的真实 itemId：优先直接查询宿主当前 session 的真实 inbox next-turn
    let targetItemId = itemId;
    try {
      const listRes = await callDshWebRpc('session/list', { _request: {} }, 5000, { rawArgs: true });
      if (listRes.ok && listRes.value && Array.isArray(listRes.value.items)) {
        const sObj = listRes.value.items.find(i => i.sessionId === sessionId);
        const nextTurn = sObj?.projections?.values?.inbox?.['next-turn'];
        if (Array.isArray(nextTurn) && nextTurn.length > 0) {
          // 如果传入了 targetItemId，优先精确匹配
          if (targetItemId) {
            const matched = nextTurn.find(m => m.id === targetItemId || m.source?.rpcId === targetItemId);
            if (matched && matched.id) {
              targetItemId = matched.id;
            }
          } else {
            // 未指定 itemId 则默认撤回 next-turn 中最新的一条
            const lastItem = nextTurn[nextTurn.length - 1];
            if (lastItem && lastItem.id) {
              targetItemId = lastItem.id;
            }
          }
        } else if (!targetItemId) {
          // 宿主 inbox 已经没有排队项（可能刚被模型认领进入执行）
          sendJson(res, 200, { ok: false, error: 'queued item is no longer pending' });
          return;
        }
      }
    } catch (eList) {
      console.warn(`[WARN] Failed to query session inbox projection: ${eList.message}`);
    }

    // 后备：使用本地 task 或全局记录的 itemId
    const globalQueued = lastQueuedPromptsBySession.get(sessionId);
    if (!targetItemId && task && task.lastQueuedPrompt) {
      targetItemId = task.lastQueuedPrompt.itemId;
    }
    if (!targetItemId && globalQueued) {
      targetItemId = globalQueued.itemId;
    }

    if (targetItemId) {
      const removed = await callDshWebRpc('session/updateQueue', {
        sessionId,
        itemId: targetItemId,
        action: { kind: 'remove' }
      }, 8000);
      if (removed.ok) {
        if (task && task.lastQueuedPrompt) {
          task.lastQueuedPrompt = null;
        }
        lastQueuedPromptsBySession.delete(sessionId);
        sendJson(res, 200, { ok: true, sessionId, itemId: targetItemId });
        return;
      }
      sendJson(res, 200, { ok: false, error: removed.error || 'queued item is no longer pending' });
      return;
    }
    sendJson(res, 200, { ok: false, error: 'queued item is no longer pending' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat/cancel') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const { sessionId } = body;
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing required field "sessionId"' });
      return;
    }
    const task = activeTasks.get(sessionId);
    if (task && task.status === 'running') {
      console.log(`[API /api/chat/cancel] cancelling task for session ${sessionId}`);
      task.status = 'cancelled';
      try {
        if (task.rpc && task.rpc.ws) {
          // 官方引擎：取消 = 宿主侧中止当前回合（durable 收尾由宿主写入）
          callDshWebRpc('session/cancel', { sessionId }, 5000);
        } else if (task.harness) {
          await task.harness.close();
        }
      } catch (err) {
        console.warn(`[WARN] Error closing harness for session ${sessionId}: ${err.message}`);
      }
      broadcastTaskEvent(task, 'cancelled', { sessionId, message: '用户已手动停止任务' });
      sendJson(res, 200, { ok: true, message: `Session ${sessionId} cancelled` });
    } else {
      sendJson(res, 200, { ok: true, message: `Session ${sessionId} not running or already stopped` });
    }
    return;
  }

  // 用户提问应答端点：浏览器作答组件的唯一回程。answer → waterfall result，
  // cancel → UserQuestionError/ASK_CANCELLED rejected（与 dsh web PendingQuestion 同语义）。
  if (req.method === 'POST' && pathname === '/api/session/question') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch {
      body = {};
    }
    const sessionId = body.sessionId;
    const eventId = body.eventId;
    const action = body.action;
    if (!sessionId || !eventId || (action !== 'answer' && action !== 'cancel')) {
      sendJson(res, 400, { ok: false, error: 'Missing or invalid "sessionId"/"eventId"/"action"' });
      return;
    }
    const task = activeTasks.get(sessionId);
    const pending = task ? task.pendingQuestion : null;
    if (!task || !pending || pending.eventId !== eventId) {
      sendJson(res, 200, { ok: false, error: 'no pending question for this session' });
      return;
    }
    if (action === 'answer') {
      const answers = validateAskAnswers(body.answers);
      if (!answers) {
        sendJson(res, 200, { ok: false, error: 'invalid answers payload' });
        return;
      }
      const settled = await settleUserEvent(task, eventId, { kind: 'result', value: { answers } });
      if (!settled.ok) {
        // 结算失败保持挂起，浏览器可重试
        console.warn(`[USER QUESTION] settle answer failed: ${settled.error}`);
        sendJson(res, 200, { ok: false, error: settled.error || 'settle failed' });
        return;
      }
      task.pendingQuestion = null;
      broadcastTaskEvent(task, 'question', { type: 'answered', eventId });
      console.log(`[USER QUESTION] session ${sessionId} answered`);
      sendJson(res, 200, { ok: true });
      return;
    }
    // action === 'cancel'
    const settledCancel = await settleUserEvent(task, eventId, {
      kind: 'rejected',
      error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' },
    });
    if (!settledCancel.ok) {
      console.warn(`[USER QUESTION] settle cancel failed: ${settledCancel.error}`);
      sendJson(res, 200, { ok: false, error: settledCancel.error || 'settle failed' });
      return;
    }
    task.pendingQuestion = null;
    broadcastTaskEvent(task, 'question', { type: 'cancelled', eventId });
    console.log(`[USER QUESTION] session ${sessionId} cancelled by user`);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session/attach') {
    const cwd = searchParams.get('cwd');
    const sessionId = searchParams.get('id');
    if (!cwd || !sessionId) {
      sendJson(res, 400, { error: 'Missing query parameter "cwd" or "id"' });
      return;
    }

    const sessionDir = findSessionDir(cwd, sessionId);
    const activeTask = activeTasks.get(sessionId);
    if (!sessionDir && !activeTask) {
      sendJson(res, 404, { error: `Session ${sessionId} not found` });
      return;
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...SECURITY_HEADERS,
      ...getCorsHeaders(req),
    });

    let closed = false;
    // seq 上 SSE 线（对齐 dsh assembler seq 保序）：task 内单调 seq 随 data
    // 同帧透传，客户端可见、可测、可按序渲染；缺省 0 表无序旧事件。
    const sendEvent = (event, data, seq) => {
      if (closed || res.writableEnded) return;
      try {
        const wire = (seq ? { ...data, _seq: seq } : data);
        res.write(`event: ${event}\ndata: ${JSON.stringify(wire)}\n\n`);
      } catch {
        // stream socket might be closed
      }
    };

    // Surface the live task model immediately when this is a local task.
    // Host-attached tasks have no request model here; stats remains the
    // authoritative transcript fallback for those sessions.
    sendEvent('start', {
      sessionId,
      attached: true,
      provider: activeTask && activeTask.provider ? activeTask.provider : '',
      model: activeTask && activeTask.model ? activeTask.model : '',
    });

    // 尝试接入运行中的会话：如果 activeTask 不在或者不在运行，但会话经判定客观正在运行，且宿主在线
    let liveTask = activeTask;
    if ((!liveTask || liveTask.status !== 'running') && sessionDir) {
      // 显式传入 forceFresh = true 强制穿透 10s 缓存，获得宿主权威 session/list 的即时 running 判定
      const isRunning = await isSessionUiRunning(liveTask, sessionDir, sessionId, true);
      if (isRunning) {
        console.log(`[ATTACH] Session ${sessionId} is running on host; bridging live follow stream...`);
        liveTask = await attachHostFollowToSession(sessionId, cwd);
      }
    }

    // If there is an in-memory active task running
    if (liveTask && liveTask.status === 'running') {
      console.log(`[ATTACH] Attaching live SSE stream to active task for session ${sessionId}`);
      
      // 1. Replay historical buffered events to the new connection.
      // 时序保证（对齐 dsh assembler seq 排序）：缓冲按 task 内单调 seq
      // 排序后 burst，客户端 arrival-order 渲染即为正确时序。
      // 提问 request 不重放：重放的 request 会让前端单例面板无条件重置草稿，
      // 多会话交叉时 A 会话正在填的答案会被 B 会话的 request 覆盖清空。
      // 挂起只走实时 listener；终态（answered/cancelled）照常重放以收口。
      const replayOrdered = liveTask.events.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const ev of replayOrdered) {
        if (ev.event === 'question' && ev.data && ev.data.type === 'request') continue;
        sendEvent(ev.event, ev.data, ev.seq);
      };
      // 若当前仍有未结算的提问挂起，重放结束后补发一次 request（单次，不进缓冲），
      // 让刚挂接的客户端能打开作答面板；已在面板中的客户端靠 eventId 去重保留草稿。
      try {
        const pendQ = liveTask.pendingQuestion;
        if (pendQ && pendQ.eventId && pendQ.questions && pendQ.questions.length) {
          sendEvent('question', { type: 'request', sessionId, eventId: pendQ.eventId, questions: pendQ.questions, replayed: true });
        }
      } catch {}
      // 1.5 Marker: replay burst finished. Clients gate live tokens/sec
      // measurement on this event so replayed deltas/usage (thousands of
      // tokens delivered in milliseconds) never poison the tps estimate.
      sendEvent('replay_end', { sessionId });

      // 2. Subscribe to new live events (15s SSE heartbeat keeps idle proxies alive)
      let liveHeartbeat = null;
      const listener = (event, data, seq) => {
        sendEvent(event, data, seq);
        if (event === 'done' || event === 'error' || event === 'cancelled') {
          if (liveHeartbeat) {
            clearInterval(liveHeartbeat);
            liveHeartbeat = null;
          }
          liveTask.listeners.delete(listener);
          if (!res.writableEnded) {
            res.end();
          }
        }
      };

      liveTask.listeners.add(listener);

      liveHeartbeat = setInterval(() => {
        sendEvent('ping', { sessionId, t: Date.now() });
      }, 15000);
      if (liveHeartbeat.unref) liveHeartbeat.unref();

      req.on('close', () => {
        closed = true;
        if (liveHeartbeat) {
          clearInterval(liveHeartbeat);
          liveHeartbeat = null;
        }
        liveTask.listeners.delete(listener);
      });
      return;
    }

    // If not in activeTasks (or task already done), fallback to file polling / snapshot
    let pollHeartbeat = setInterval(() => {
      sendEvent('ping', { sessionId, t: Date.now() });
    }, 15000);
    if (pollHeartbeat.unref) pollHeartbeat.unref();
    const clearPollHeartbeat = () => {
      if (pollHeartbeat) {
        clearInterval(pollHeartbeat);
        pollHeartbeat = null;
      }
    };
    req.on('close', () => {
      closed = true;
      clearPollHeartbeat();
    });

    let pollCount = 0;
    let idleStreak = 0;
    let everRunning = false;
    // Q20 perf guard: the old poller re-decoded and re-sent the FULL history
    // every tick, which froze weak clients on 900+ message sessions.
    //   - One tail snapshot (20 msgs + total) on connect: gives the client an
    //     instant view without a full decode (loadHistory covers full pages).
    //   - On file change: send ONLY a lightweight 'state' event — re-running
    //     getSessionHistory per change synchronously decodes the whole zstd
    //     transcript (17MB+ on long sessions) and blocks the event loop.
    const SYNC_TAIL_LIMIT = 20;
    let lastFileSync = '';
    let sentInitialSync = false;

    const readSessionFileSync = () => {
      try {
        const zstdPath = findSessionZstdPath(sessionDir);
        if (!zstdPath) return '';
        const st = fs.statSync(zstdPath);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '';
      }
    };

    const sessionStateNow = () => {
      const task = activeTasks.get(sessionId);
      const zstdPath = sessionDir ? findSessionZstdPath(sessionDir) : null;
      return sessionTerminalState(zstdPath, task);
    };

    const poll = async () => {
      if (closed || res.writableEnded) {
        clearPollHeartbeat();
        return;
      }
      try {
        const isRunning = sessionDir
          ? await isSessionUiRunning(activeTasks.get(sessionId), sessionDir, sessionId)
          : false;

        const fileSig = sessionDir ? readSessionFileSync() : '';
        const fileChanged = fileSig !== lastFileSync;
        if (sessionDir && !sentInitialSync) {
          sentInitialSync = true;
          lastFileSync = fileSig;
          const history = getSessionHistory(cwd, sessionId);
          if (history.length > 0) {
            // 对齐 /api/history 轮次切片：按完整轮次取尾段（最新 5 轮），
            // 保证用户消息与接续的全部 step 完整下发，杜绝断头轮次截断折叠
            const turnStarts = [];
            for (let hi = 0; hi < history.length; hi++) {
              if (history[hi].role === 'user') turnStarts.push(hi);
            }
            const turnsLimit = 5;
            let startIdx = 0;
            if (turnStarts.length > turnsLimit) {
              startIdx = turnStarts[turnStarts.length - turnsLimit];
            } else if (turnStarts.length === 0) {
              startIdx = Math.max(0, history.length - SYNC_TAIL_LIMIT);
            }
            const tail = history.slice(startIdx);
            sendEvent('sync', {
              messages: tail,
              total: history.length,
              startIndex: startIdx,
              isRunning,
              state: isRunning ? 'running' : sessionStateNow(),
            });
          } else {
            sendEvent('state', { isRunning, state: isRunning ? 'running' : 'idle' });
          }
        } else if (sessionDir && fileChanged) {
          lastFileSync = fileSig;
          const st = sessionStateNow();
          sendEvent('state', { isRunning, state: isRunning ? 'running' : st });
        }

        if (isRunning) {
          everRunning = true;
          idleStreak = 0;
        } else {
          if (everRunning) {
            idleStreak++;
            if (idleStreak >= 2) {
              sendEvent('done', { sessionId, finished: true });
              clearPollHeartbeat();
              res.end();
              return;
            }
          } else {
            // 对齐 dsh web：若会话自挂接时起从未进入 running 态（静态历史会话），
            // 在完成首轮 sync/state 快照同步后优雅结束连接，严禁下发虚假 done 事件诱发前端二次重载
            if (sentInitialSync) {
              clearPollHeartbeat();
              res.end();
              return;
            }
          }
        }

        pollCount++;
        setTimeout(poll, 1000);
      } catch (err) {
        clearPollHeartbeat();
        if (!closed && !res.writableEnded) {
          sendEvent('error', { message: err.message, code: 'local', source: 'local' });
          res.end();
        }
      }
    };

    poll();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat/stream') {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: `Invalid JSON body: ${err.message}` });
      return;
    }

    const { cwd, provider, model, permission, prompt, sessionId, mode, receiptIds, image } = body;
    console.log(`[POST /api/chat/stream] prompt: "${prompt}", cwd: ${cwd}, model: ${model}, session: ${sessionId}, mode: ${mode || 'queue'}`);
    if (!prompt) {
      sendJson(res, 400, { error: 'Missing required field "prompt"' });
      return;
    }
    // image 内联校验（与 /api/session/prompt 同契约）：SSE 头之前拦截，无副作用
    const streamImg = toPromptImagePart(image);
    if (!streamImg.ok) {
      sendJson(res, 400, { error: streamImg.error });
      return;
    }
    // receiptIds 校验：Q20 上传收据（string[]，去重上限 5 个在 runChatViaHostRpc 收口）。
    // 与 /api/session/prompt 同契约：非数组或元素非字符串一律 400。
    if (receiptIds !== undefined) {
      if (!Array.isArray(receiptIds)) {
        sendJson(res, 400, { error: 'Invalid "receiptIds": expected string array' });
        return;
      }
      for (let rii = 0; rii < receiptIds.length; rii++) {
        if (typeof receiptIds[rii] !== 'string' || !receiptIds[rii]) {
          sendJson(res, 400, { error: 'Invalid "receiptIds": expected string array' });
          return;
        }
      }
    }
    // mode 仅接受上游 session/prompt 契约值 queue（排队）|steer（插队），缺省 queue。
    if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
      sendJson(res, 400, { error: 'Invalid "mode": expected "queue" or "steer"' });
      return;
    }
    const promptMode = (mode === 'steer') ? 'steer' : 'queue';

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      ...SECURITY_HEADERS,
      ...getCorsHeaders(req),
    });

    let closed = false;
    const sendEvent = (event, data, seq) => {
      if (closed || res.writableEnded) return;
      try {
        const wire = (seq ? { ...data, _seq: seq } : data);
        res.write(`event: ${event}\ndata: ${JSON.stringify(wire)}\n\n`);
      } catch {
        // stream socket might be closed
      }
    };

    let task = null;
    let effectiveSessionId = (sessionId && sessionId.trim())
      ? sessionId.trim()
      : `session-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;

    // Keep the requested model on the live task so stats has a model before
    // the first durable transcript frame is flushed.
    const taskProvider = provider || '';
    const taskModel = model || '';

    // Send initial start event
    sendEvent('start', {
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      provider: taskProvider,
      model: taskModel,
      permission: permission || 'workspace-write',
      sessionId: effectiveSessionId,
    });

    // Create task object and register into activeTasks
    task = {
      sessionId: effectiveSessionId,
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      provider: taskProvider,
      model: taskModel,
      harness: null,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      listeners: new Set(),
      finalResponse: null,
      error: null,
    };

    // Register into activeTasks map immediately
    activeTasks.set(effectiveSessionId, task);

    const taskListener = (event, data, seq) => {
      sendEvent(event, data, seq);
      if (event === 'done' || event === 'error' || event === 'cancelled') {
        if (postHeartbeat) {
          clearInterval(postHeartbeat);
          postHeartbeat = null;
        }
        if (!res.writableEnded) {
          res.end();
        }
      }
    };
    task.listeners.add(taskListener);

    // 15s SSE heartbeat keeps idle proxies/Q20 radio alive on the POST stream
    // (mirrors /api/session/attach); clients ignore ping with zero DOM cost
    let postHeartbeat = setInterval(() => {
      sendEvent('ping', { sessionId: effectiveSessionId, t: Date.now() });
    }, 15000);
    if (postHeartbeat.unref) postHeartbeat.unref();

    // If client disconnects (phone screens off or network drops), DO NOT kill harness!
    req.on('close', () => {
      closed = true;
      if (postHeartbeat) {
        clearInterval(postHeartbeat);
        postHeartbeat = null;
      }
      console.log(`[REQ CLOSED - CLIENT DISCONNECTED] session: ${task.sessionId}, status: ${task.status}. Background task keeps running.`);
      task.listeners.delete(taskListener);
    });

    // Run execution in background async boundary
    (async () => {
      // 与宿主 RPC 引擎共用的 durable 会话事件解析器（delta/thought/tool）
      const handler = createSessionEventHandler(task);

      const onNotification = (notification) => {
        if (!notification) return;
        const { method, params } = notification;

        if (method === 'session.event' && params && params.event) {
          handler.handleSessionEvent(params.event);
        }
      };

      try {
        const { current } = readDshSettings();
        const targetCwd = cwd ? path.resolve(cwd) : process.cwd();
        const targetProvider = provider || current.provider;
        const targetModel = model || current.model;

        const Q20_SYSTEM_DIRECTIVE =
          '\n\n[重要交互规范：回答和汇报务必高度精炼、开门见山；仅简明扼要汇报核心结论与变更，除非用户主动要求细节。]';

        const isContinuation = (sessionId && sessionId.trim());
        const finalPrompt = isContinuation
          ? prompt
          : `${prompt}${Q20_SYSTEM_DIRECTIVE}`;

        // ── 官方引擎（DSH Web 在线时）：与 dsh web 同一归属逻辑 ──
        // session/create 时由宿主写入工作区归属，follow 流推送 durable 事件。
        // 若携带 receiptIds，必须确保以宿主在线 RPC 处理（宿主持有 staged receipt）
        const rpcOutcome = await runChatViaHostRpc(task, {
          targetCwd,
          provider: targetProvider,
          model: targetModel,
          promptText: finalPrompt,
          promptMode,
          receiptIds: receiptIds,
          imagePart: streamImg.part,
        }).catch((err) => {
          console.warn(`[ENGINE] host rpc unexpected failure: ${err.message}`);
          return 'failed';
        });

        if (rpcOutcome === 'done' || rpcOutcome === 'failed') {
          // Clean up task from memory after 10 minutes
          setTimeout(() => {
            if (task.sessionId) {
              activeTasks.delete(task.sessionId);
            }
          }, 10 * 60 * 1000);
          return;
        }
        console.log('[ENGINE] DSH Web unreachable → falling back to local SDK subprocess');

        // ── 回退引擎（DSH Web 离线）：本地 SDK 子进程 + workspace.json 直写兜底 ──
        const harness = new DeepSeekHarness({
          cwd: targetCwd,
          provider: targetProvider,
          model: targetModel,
        });
        task.harness = harness;

        const result = await harness.run(finalPrompt, {
          sessionId: effectiveSessionId || undefined,
          onNotification,
        });

        if (result.sessionId) {
          task.sessionId = result.sessionId;
          activeTasks.set(result.sessionId, task);
          // 离线兜底：宿主不在线时才直写 workspace.json 镜像（在线时归属永远由宿主写）
          await attachSessionToWorkspace(targetCwd, result.sessionId);
        }

        const sdkAccumulated = handler.state.accumulatedText;
        if (result.finalResponse && result.finalResponse.length > sdkAccumulated.length) {
          const delta = result.finalResponse.slice(sdkAccumulated.length);
          broadcastTaskEvent(task, 'delta', { text: delta });
        }

        if (!result.finalResponse && !sdkAccumulated) {
          const errMsg = '未能获取到有效模型响应 (上游服务异常或鉴权失败)';
          broadcastTaskEvent(task, 'delta', { text: errMsg });
          result.finalResponse = errMsg;
        }

        task.status = 'done';
        task.finalResponse = result.finalResponse;
        broadcastTaskEvent(task, 'done', {
          sessionId: result.sessionId,
          finalResponse: result.finalResponse,
        });
        console.log(`[TASK COMPLETED] sessionId: ${result.sessionId}, final len: ${result.finalResponse?.length}`);
      } catch (err) {
        if (task.status !== 'cancelled') {
          task.status = 'error';
          task.error = err.message;
          console.error(`[TASK ERROR] sessionId: ${task.sessionId}, ${err.stack || err.message}`);
          broadcastTaskEvent(task, 'error', { message: err.message, code: classifyDshError(err.message), source: 'dsh' });
        }
      } finally {
        try {
          if (task.harness) {
            await task.harness.close();
          }
        } catch {
          // ignore
        }
        // Clean up task from memory after 10 minutes
        setTimeout(() => {
          if (task.sessionId) {
            activeTasks.delete(task.sessionId);
          }
        }, 10 * 60 * 1000);
      }
    })();

    if (effectiveSessionId) {
      activeTasks.set(effectiveSessionId, task);
    }
    return;
  }

  // Static files
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStaticFile(pathname === '/' ? '/index.html' : pathname, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('Method Not Allowed');
  }).catch((err) => {
    console.error(`[UNHANDLED SERVER ERROR] ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Internal Server Error');
    }
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// P0 安全：默认仅回环监听。生产链（systemd/start.sh 显式 HOST=0.0.0.0，经内部反向代理回源）
// 保持环境变量覆盖，裸跑 `node server.mjs` 不再默认暴露到全网。
const PORT = parseInt(process.env.PORT || '3090', 10);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * C-16：Q20_MOCK_HOST=1 时按 §1.4 接缝同步播种 live 真源（不建真实 WS）。
 *   RUNNING_SESSIONS → status 事实；SUBAGENTS → added 事实。
 * 只在 mock 分支调用；生产路径绝不读取这些环境变量。
 */
function seedMockLiveTruth(state) {
  const runningIds = mockSeamRunningIds();
  for (const sid of runningIds) {
    state.noteEvent('api-session/status', [sid, true]);
  }
  for (const sub of mockSeamSubagents()) {
    state.noteEvent('api-session/added', [{
      sessionId: sub.sessionId,
      running: sub.running !== undefined ? !!sub.running : runningIds.indexOf(sub.sessionId) >= 0,
      parentSessionId: sub.parentSessionId || '',
      origin: sub.origin || 'subagent',
      cwd: sub.cwd || '',
      title: sub.title || '',
      updatedAt: Date.now(),
      projections: { values: { title: sub.title || '', subagent: sub } },
    }]);
  }
}

/**
 * C-23：常驻 live 流对**每一条** waterfall 帧立即委托回瀑布（否则宿主侧提问/审批永久挂起）。
 * 信封与既有 settleUserEvent 完全一致（rawArgs → payload.args = { clientId, eventId, outcome }）。
 * 语义「本 client 不认领」；失败只记日志，绝不抛错、绝不阻塞帧循环。
 */
function declineHostWaterfall(info) {
  const clientId = (info && info.clientId) ? String(info.clientId) : '';
  const eventId = (info && info.eventId) ? String(info.eventId) : '';
  const eventName = (info && info.event) ? String(info.event) : '';
  const conn = (info && info.conn) ? String(info.conn) : '-';
  if (!clientId || !eventId) {
    console.warn(`[HOST-LIVE] waterfall decline skipped conn=${conn} event=${eventName} eventId=${eventId || '-'}`);
    return;
  }
  try {
    Promise.resolve(callDshWebRpc('$events/result', { clientId, eventId, outcome: { kind: 'next' } }, 10000, { rawArgs: true }))
      .then((res) => {
        if (!res || !res.ok) {
          console.warn(`[HOST-LIVE] waterfall decline failed conn=${conn} event=${eventName} eventId=${eventId} clientId=${clientId} error=${(res && (res.error || res.code)) || 'unknown'}`);
        }
      })
      .catch((err) => {
        console.warn(`[HOST-LIVE] waterfall decline threw conn=${conn} event=${eventName} eventId=${eventId} clientId=${clientId} ${err && err.message}`);
      });
  } catch (err) {
    console.warn(`[HOST-LIVE] waterfall decline sync-error conn=${conn} event=${eventName} eventId=${eventId} ${err && err.message}`);
  }
}

/**
 * C-9/C-14/C-16：进程启动（listen 回调内）建立 live 状态单例并启动 $events 订阅。
 * - 生产路径注入真实 mux 连接参数（WebSocketImpl + url + headers），订阅必须真正在线，禁止静默 no-op；
 * - Q20_MOCK_HOST=1 不注入 transport（start() 安全 no-op），改由 §1.4 接缝同步播种真源；
 * - C-11：同时发起一次异步非阻塞的 session/list 冷启动播种（失败/超时不影响任何 API）。
 */
function startHostLiveState() {
  let WebSocketImpl = null;
  let url = '';
  let headers = {};
  if (!Q20_MOCK_HOST) {
    WebSocketImpl = loadWsModule();
    if (WebSocketImpl) {
      const authority = new URL(DSH_WEB_URL).host;
      url = DSH_WEB_URL.replace(/^http/, 'ws') + '/api/remote.mux';
      headers = { Host: authority, Origin: DSH_WEB_URL, Cookie: getDshWebAuthCookie(authority) || '' };
    } else {
      console.warn('[HOST-LIVE] ws module unavailable conn=-; $events subscription disabled (仅靠 session/list 播种)');
    }
  }
  hostLiveState = createHostLiveState({
    log: (msg) => console.log(msg),
    WebSocketImpl: WebSocketImpl,
    url: url,
    headers: headers,
    onWaterfallDecline: declineHostWaterfall, // C-23：常驻流必须委托回瀑布
  });
  if (Q20_MOCK_HOST) seedMockLiveTruth(hostLiveState);
  hostLiveState.start();
  if (Q20_MOCK_HOST) {
    console.log('[HOST-LIVE] mock host conn=' + (hostLiveState.getStreamId() || '-')
      + ': real WS disabled; live truth seeded from §1.4 seams (running='
      + mockSeamRunningIds().length + ', subagents=' + mockSeamSubagents().length + ')');
  }
  // C-11：冷启动播种（共享主通道，单一在飞 + 失败退避；绝不进入任何请求的热路径）
  scheduleHostSessionListRefresh();
  return hostLiveState;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  checkWeakAuthToken();
  const isLoopbackBind = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[FATAL] 端口 ${PORT} 已被占用，启动中止。先执行 ./stop.sh 清理残留（若由 systemd 托管则先 sudo systemctl stop dsh-bb10-web），再重新启动。`);
      console.error(`[FATAL] 若占用者仅监听 127.0.0.1: 回环占坑期间公网入口持续 502，务必确认存活进程绑定 0.0.0.0。`);
    } else {
      console.error(`[FATAL] listen 失败: ${err && err.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`DeepSeek Harness Server running at http://${HOST}:${PORT}`);
    // 契约 C-9/C-11/C-14/C-16：启动即建立常驻 $events 权威状态镜像并播种
    try {
      startHostLiveState();
    } catch (err) {
      console.error(`[HOST-LIVE] start failed conn=- (non-fatal): ${err && err.stack ? err.stack : err.message}`);
    }
    if (isLoopbackBind) {
      console.log('[BIND] WARN: 仅回环监听，非本机来源不可达；公网 Ingress 回源将 502。生产/公网入口须 HOST=0.0.0.0 启动。');
    } else {
      console.log(`[BIND] 对外监听 ${HOST}:${PORT}，可用 curl --noproxy http://${HOST}:${PORT}/healthz 确认回源可达。`);
    }
    // 首屏性能：分批预热转录头缓存，避免冷启动首个 /api/bootstrap 触发全树同步解压
    try {
      warmSessionHeaderCacheAsync();
    } catch (err) {
      console.error(`[WARM] failed to start (non-fatal): ${err && err.message}`);
    }
  });
}

export default server;
