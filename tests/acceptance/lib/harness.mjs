/**
 * Q20 Wave 2026-10-16 验收测试共享骨架（Owner: test-agent，冻结件）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-10-16.md（相对仓库根）
 *   - §1.4 mock 宿主测试接缝（RUNNING_SESSIONS / LIST_DELAY_MS / LIST_FAIL / SUBAGENTS / RPC_LOG）
 *   - §3 验收矩阵 A1–A10
 *
 * 纪律（test-expert L2-T + L2-AT）：
 *   1. 每条断言都是真实行为断言，失败信息必须携带「期望 vs 实际」。
 *   2. 严禁吞异常：非断言异常同样记为 FAIL 并打印堆栈。
 *   3. 每条用例独立打印 PASS/FAIL + 耗时；退出码 0=全绿，非 0=有失败。
 *   4. 环境不具备时显式打印 [RED DEGRADED: ...]，绝不静默跳过。
 *   5. 全部测试实例高隔离：临时 DSH_HOME + 临时工作区根，零真实宿主 / 零真实 LLM。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '../../../lib/test-mock-host.mjs';

export { startMockServer };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'tests', 'acceptance', 'artifacts');

/** 契约 §1.2 C-3 / §3 冻结阈值（不得放宽）。 */
export const LIMITS = {
  sessionsP95Ms: 1500, // /api/sessions 单次响应
  statusMs: 300,       // /api/sessions/status 单次响应
  listRpcMax: 1,       // 连续 3 次 /api/sessions 后共享主通道 session/list 调用数
};

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * 契约 §1.4 接缝缺失（mock 未实现 RUNNING_SESSIONS / LIST_DELAY_MS / LIST_FAIL / SUBAGENTS / RPC_LOG）。
 * 与「断言失败」分列：这是测试注入点不存在，而非被测行为判负。
 */
export class SeamMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeamMissingError';
  }
}

/** 环境不具备 → 显式 SKIP（不计入 PASS，也不计入 FAIL；套件退出码 3）。 */
export class DegradedSkip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'DegradedSkip';
  }
}

export function fmtMs(ms) {
  return (Math.round(Number(ms) * 100) / 100) + 'ms';
}

/**
 * 输出脱敏：把绝对家目录前缀（家目录 + 用户名 + 斜杠）替换为 `~`，杜绝本地拓扑路径进入 stdout / 日志 / 版本库
 * （对齐仓库 pre-commit secret-scan 规则 B-internal）。
 */
export function redact(value) {
  const s = String(value === undefined || value === null ? '' : value);
  let out = s;
  try {
    const home = os.homedir();
    if (home) out = out.split(home).join('~');
  } catch { /* 无家目录信息时退化为正则兜底 */ }
  return out.replace(/\/(home|Users)\/[^/\s"']+/g, '~');
}

function brief(value, max = 300) {
  let s;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 断言失败：统一「期望 vs 实际」口径。 */
export function fail(what, expected, actual) {
  throw new AssertionError(what + ' → 期望: ' + brief(expected) + '；实际: ' + brief(actual));
}

export function assertTrue(actual, what) {
  if (actual !== true) fail(what, true, actual);
}

export function assertFalse(actual, what) {
  if (actual !== false) fail(what, false, actual);
}

export function assertEqual(actual, expected, what) {
  if (!Object.is(actual, expected)) fail(what, expected, actual);
}

export function assertNotEqual(actual, unexpected, what) {
  if (Object.is(actual, unexpected)) fail(what, '≠ ' + brief(unexpected), actual);
}

export function assertOk(cond, what, expected, actual) {
  if (!cond) fail(what, expected, actual);
}

export function assertLt(actual, limit, what) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || !(actual < limit)) {
    fail(what, '< ' + limit, actual);
  }
}

export function assertArray(value, what) {
  if (!Array.isArray(value)) fail(what, 'Array', value);
  return value;
}

export function assertNonEmptyArray(value, what) {
  assertArray(value, what);
  if (value.length === 0) fail(what, '非空数组 (length ≥ 1)', '[] (length 0)');
  return value;
}

/** 契约 §1.4 接缝活性断言：缺失时抛 SeamMissingError（与行为断言失败分列）。 */
export function requireSeam(cond, what, expected, actual) {
  if (!cond) {
    throw new SeamMissingError('SEAM-MISSING（契约 §1.4 未实现）: ' + what
      + ' → 期望: ' + brief(expected) + '；实际: ' + brief(actual));
  }
}

/** 环境不具备 → 显式 SKIP：打印 [RED DEGRADED: ...] 并抛 DegradedSkip（绝不伪装成 PASS）。 */
export function skip(reason) {
  console.log('  [RED DEGRADED: ' + reason + ']');
  throw new DegradedSkip(reason);
}

export function createRunner(suiteName) {
  const results = [];
  return {
    results,
    async run(name, fn) {
      console.log('▶ [' + suiteName + '] ' + name);
      const t0 = performance.now();
      const entry = { name, status: 'fail', ms: 0, error: null, detail: '' };
      try {
        const detail = await fn();
        entry.status = 'pass';
        if (detail !== undefined && detail !== null && detail !== '') entry.detail = String(detail);
      } catch (err) {
        entry.error = err;
        entry.status = (err instanceof DegradedSkip) ? 'degraded' : 'fail';
      }
      entry.ms = performance.now() - t0;
      entry.ok = entry.status === 'pass';
      results.push(entry);
      if (entry.status === 'pass') {
        console.log('  ✔ PASS [' + fmtMs(entry.ms) + '] ' + name + (entry.detail ? ' — ' + entry.detail : ''));
      } else if (entry.status === 'degraded') {
        console.log('  ⏭ SKIP [' + fmtMs(entry.ms) + '] ' + name + ' — [RED DEGRADED: ' + entry.error.message + ']');
      } else {
        const isSeam = entry.error instanceof SeamMissingError;
        console.log('  ✖ FAIL [' + fmtMs(entry.ms) + '] ' + name);
        console.log('      ' + (isSeam ? 'SEAM-MISSING' : (entry.error instanceof AssertionError ? '断言失败' : '执行异常'))
          + ': ' + entry.error.message);
        if (!isSeam && !(entry.error instanceof AssertionError) && entry.error.stack) {
          console.log(entry.error.stack.split('\n').slice(1, 4).join('\n'));
        }
      }
      return entry.status;
    },
    report() {
      const pass = results.filter((r) => r.status === 'pass').length;
      const failCount = results.filter((r) => r.status === 'fail').length;
      const degradedCount = results.filter((r) => r.status === 'degraded').length;
      console.log('\n──────── ' + suiteName + ' 报告 ────────');
      for (const r of results) {
        const tag = r.status === 'pass' ? '✔ PASS' : (r.status === 'degraded' ? '⏭ SKIP(DEGRADED)' : '✖ FAIL');
        console.log(tag + ' [' + fmtMs(r.ms) + '] ' + r.name);
        if (r.status !== 'pass') console.log('        ' + r.error.message);
      }
      console.log('合计: ' + results.length + ' 用例, PASS ' + pass + ', FAIL ' + failCount + ', SKIP(degraded) ' + degradedCount);
      console.log('SUITE-' + suiteName + ' SUMMARY: total=' + results.length + ' pass=' + pass
        + ' fail=' + failCount + ' degraded=' + degradedCount);
      return { pass, failCount, degradedCount };
    },
  };
}

/** 原生 HTTP 请求（真实网络，非 mock 内存调用）。 */
export function request(base, urlPath, options = {}) {
  const url = new URL(urlPath, base);
  const bodyStr = options.body === undefined ? null
    : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  const headers = { ...(options.headers || {}) };
  if (bodyStr !== null && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }
  if (bodyStr !== null && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(url, { method: options.method || 'GET', headers, timeout: options.timeoutMs || 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* 非 JSON 体保留 null */ }
        resolve({ status: res.statusCode, body: parsed, raw, ms: performance.now() - t0 });
      });
    });
    req.on('error', (err) => reject(new Error('HTTP ' + (options.method || 'GET') + ' ' + urlPath + ' 失败: ' + err.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP ' + (options.method || 'GET') + ' ' + urlPath + ' 超时 (>' + (options.timeoutMs || 15000) + 'ms)'));
    });
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

/** SSE 请求：读到终态事件（done/error/cancelled）或超时为止。 */
export function sse(base, urlPath, body, options = {}) {
  const url = new URL(urlPath, base);
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const events = [];
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: options.timeoutMs || 20000,
    }, (res) => {
      let buf = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { req.destroy(); } catch { /* already closed */ }
        resolve({ status: res.statusCode, events, ms: performance.now() - t0 });
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: 'message', data: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
              const rawData = line.slice(6);
              try { ev.data = JSON.parse(rawData); } catch { ev.data = rawData; }
            }
          }
          if (frame.trim()) events.push(ev);
        }
        if (events.some((e) => e.event === 'done' || e.event === 'error' || e.event === 'cancelled')) finish();
      });
      res.on('end', finish);
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new Error('SSE ' + urlPath + ' 流错误: ' + err.message));
      });
    });
    req.on('error', (err) => reject(new Error('SSE ' + urlPath + ' 连接失败: ' + err.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SSE ' + urlPath + ' 超时 (>' + (options.timeoutMs || 20000) + 'ms)'));
    });
    req.write(bodyStr);
    req.end();
  });
}

const TEMP_DIRS = new Set();

/** 受控临时目录（谁创建谁清理：套件结束时统一回收，零环境污染）。 */
export function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.add(d);
  return d;
}

/** 回收本进程创建的全部临时目录（套件收尾调用）。 */
export function cleanupTempDirs() {
  for (const d of TEMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
  TEMP_DIRS.clear();
}

/**
 * 拉起隔离 mock 实例（Q20_MOCK_HOST=1）。
 * @param {{running?:string[], listDelayMs?:number, listFail?:boolean, subagents?:object[], rpcLog?:string}} seam
 */
export async function launchMock(seam = {}) {
  const workspaceRoot = seam.workspaceRoot || tempDir('q20-acc-ws-');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = {};
  if (seam.running && seam.running.length) env.Q20_MOCK_HOST_RUNNING_SESSIONS = seam.running.join(',');
  if (seam.listDelayMs) env.Q20_MOCK_HOST_LIST_DELAY_MS = String(seam.listDelayMs);
  if (seam.listFail) env.Q20_MOCK_HOST_LIST_FAIL = '1';
  if (seam.subagents && seam.subagents.length) env.Q20_MOCK_HOST_SUBAGENTS = JSON.stringify(seam.subagents);
  if (seam.rpcLog) env.Q20_MOCK_HOST_RPC_LOG = seam.rpcLog;
  const server = await startMockServer({ workspaceRoot, env });
  server.workspaceRoot = workspaceRoot;
  const originalStop = server.stop;
  server.stop = async () => {
    await originalStop();
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  };
  return server;
}

/**
 * 注册一个 mock 工作区（契约 §1.4 行构造配方第 2 步：必须走 Q20 API 造行）。
 * 返回工作区绝对路径（用于 /api/sessions?cwd= 与会话 cwd）。
 */
export async function createWorkspace(base, name) {
  const res = await request(base, '/api/workspace/create', { method: 'POST', body: { name }, timeoutMs: 15000 });
  assertEqual(res.status, 200, 'POST /api/workspace/create 状态码 (name=' + name + ')');
  const ws = res.body && res.body.workspace;
  assertOk(ws && typeof ws.cwd === 'string' && ws.cwd,
    'POST /api/workspace/create 必须返回 workspace.cwd', '{workspace:{cwd:"..."}}', res.body);
  assertOk(fs.existsSync(ws.cwd), '工作区目录必须物理存在', ws.cwd, '(missing)');
  return ws.cwd;
}

/**
 * 用真实 Q20 API 造出「磁盘上有 zstd 转录」的会话行（契约 §1.4 行构造配方）。
 * /api/chat/stream 会带显式 sessionId 走 session/create + mock 合成回合，
 * 从而在 DSH_HOME/sessions/projectKey(cwd)/<sid> 落盘真实转录。
 */
export async function seedSession(base, opts) {
  const res = await sse(base, '/api/chat/stream', {
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    prompt: opts.prompt || ('acceptance-seed-' + opts.sessionId),
  }, { timeoutMs: opts.timeoutMs || 20000 });
  assertEqual(res.status, 200, 'seed POST /api/chat/stream 状态码');
  const errEv = res.events.find((e) => e.event === 'error');
  assertOk(!errEv, 'seed 回合不得报错', '无 error 事件', errEv ? brief(errEv.data) : '(none)');
  const doneEv = res.events.find((e) => e.event === 'done');
  assertOk(!!doneEv, 'seed 回合必须到达 done 终态', 'event: done',
    res.events.map((e) => e.event).join(',') || '(no events)');
  return { events: res.events, ms: res.ms };
}

/** 等待条件成立（显式条件轮询，禁止盲 sleep 判定）。 */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  fail('等待 ' + label + ' 超时 (' + timeoutMs + 'ms)', label + ' 成立', '未成立; 末次观测=' + brief(last));
}

/** 读取 RPC_LOG（契约 §1.4 物理收据：可数请求次数）。缺失返回 null。 */
export function readRpcLog(file) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { out.push({ method: '<unparsable>', raw: l }); }
  }
  return out;
}

export function countRpc(entries, method) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter((e) => e && e.method === method).length;
}

/** 在 /api/sessions 响应里定位一行（行 id 字段为 `id`）。 */
export function findSessionRow(rows, sid) {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => r && (r.id === sid || r.sessionId === sid)) || null;
}
