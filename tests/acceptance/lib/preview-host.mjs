/**
 * Wave 2026-11-06（preview-policy）验收专用：高隔离 mock 实例 + 原始 HTTP 断言面。
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约：.dev-team/contract-wave-2026-11-06.md §1.3–§1.4 / §3 A6–A9 / §3bis AT-1…AT-3
 *
 * 为什么不直接复用 lib/harness.mjs 的 launchMock（该文件被其它套件共用，冻结不改）：
 *   1) launchMock 只暴露既有接缝，未透传本波次新增的 Q20_MOCK_HOST_PROJECTIONS /
 *      _FAIL / _DELAY_MS（契约 §1.4），而 A8/A9/AT-1/AT-3 全靠这三个接缝注入权威事实；
 *   2) A9.1 与 AT-1 要求断言服务端 stderr 的 `[PREVIEW] ... sid=<sid>` warn，必须捕获子进程输出；
 *   3) A8/A9/AT-3 要求「宿主投影 workingDirectory = 请求 cwd」，故必须让请求 cwd 在 spawn 前
 *      可预测：本模块把 Q20_MOCK_HOME 固定为 realpath 后的临时目录，工作区目录名即
 *      `workspacePath(name)`，与 POST /api/workspace/create 的结果逐字一致（见 assert 于调用侧）。
 *
 * 纪律：
 *   - 每实例独立端口 + 独立临时 DSH_HOME + 独立临时工作区根（零真实宿主 / 零真实 LLM / 零 ~/ 污染）；
 *   - 继承环境里所有 Q20_MOCK_* 一律剥除，接缝只由本文件显式注入（杜绝外部环境串味）；
 *   - 全部清理在 stop() 内完成（谁创建谁清理）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function health(base) {
  return new Promise((resolve) => {
    const req = http.get(base + '/healthz', { timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 剥除继承环境里的全部 Q20_MOCK_* 接缝（接缝只允许本模块显式注入）。 */
function inheritedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('Q20_MOCK_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 拉起一台隔离 mock 实例。
 * @param {{ env?: object|Function, rpcLog?: boolean }} opts
 *   env：额外接缝（Q20_MOCK_HOST_PROJECTIONS / _FAIL / _DELAY_MS / _LIST_* …）。
 *        也可传函数 `(ctx) => env`，ctx = { home, workspaceRoot, workspacePath(name) }：
 *        这是 A8/A9/AT-3 的唯一可行形态——宿主投影里的 workingDirectory 必须等于
 *        「尚未创建的工作区 cwd」，即必须在 spawn 前由可预测路径拼出来。
 *   rpcLog：true 时把 mock RPC 收据写到临时文件，可用于「零宿主调用」物理计量。
 * @returns {Promise<{ base, home, dshHome, workspaceRoot, workspacePath, stderrText, stop, rpcEntries }>}
 */
export async function launchPreviewHost(opts = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'q20-prev-')));
  const workspaceRoot = path.join(home, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const dshHome = path.join(home, 'dsh-home');
  const rpcLog = opts.rpcLog ? path.join(home, 'rpc.log') : '';
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;

  const ctx = { home, workspaceRoot, workspacePath: (n) => path.join(workspaceRoot, n) };
  const seamEnv = (typeof opts.env === 'function') ? (opts.env(ctx) || {}) : (opts.env || {});
  const env = {
    ...inheritedEnv(),
    PORT: String(port),
    HOST: '127.0.0.1',
    DSH_HOME: dshHome,
    DSH_WEB_URL: 'http://127.0.0.1:3080',
    Q20_MOCK_HOST: '1',
    Q20_MOCK_HOME: workspaceRoot,
    ...seamEnv,
  };
  if (rpcLog) env.Q20_MOCK_HOST_RPC_LOG = rpcLog;

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrText = '';
  let stdoutText = '';
  const cap = (prev, chunk) => {
    const next = prev + chunk.toString();
    return next.length > 64000 ? next.slice(-64000) : next;
  };
  if (child.stdout) child.stdout.on('data', (d) => { stdoutText = cap(stdoutText, d); });
  if (child.stderr) child.stderr.on('data', (d) => { stderrText = cap(stderrText, d); });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await health(base)) {
      return {
        base,
        home,
        dshHome,
        workspaceRoot,
        rpcLog,
        get stderrText() { return stderrText; },
        get stdoutText() { return stdoutText; },
        /** 工作区目录的绝对路径（POST /api/workspace/create name=<name> 的确定性结果）。 */
        workspacePath(name) { return path.join(workspaceRoot, name); },
        /** mock RPC 收据（未开 rpcLog 时为空数组）。 */
        rpcEntries() {
          if (!rpcLog || !fs.existsSync(rpcLog)) return [];
          const out = [];
          for (const line of fs.readFileSync(rpcLog, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { out.push({ method: '<unparsable>', raw: line }); }
          }
          return out;
        },
        async stop() {
          try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
          await new Promise((r) => setTimeout(r, 150));
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
        },
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { child.kill('SIGKILL'); } catch { /* noop */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
  throw new Error('preview mock host failed to start: ' + (stderrText.slice(-1500) || '(no stderr)'));
}

/**
 * 原生 HTTP 请求，保留 status / headers / 原始字节（/api/file 的字节等价断言必须看 buf）。
 * urlPath 原样作为 request path 发送（不做二次编码），以便构造 `..%2f` / `%00` 等畸形负载。
 * @returns {Promise<{status:number, headers:object, buf:Buffer, text:string, json:any, ms:number}>}
 */
export function rawRequest(base, urlPath, options = {}) {
  const bodyStr = options.body === undefined || options.body === null ? null
    : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  const headers = { ...(options.headers || {}) };
  if (bodyStr !== null) {
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
    if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
  }
  const url = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request(url, { method: options.method || 'GET', headers, timeout: options.timeoutMs || 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 体保留 null */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, text, json, ms: performance.now() - t0 });
      });
    });
    req.on('error', (err) => reject(new Error('HTTP ' + (options.method || 'GET') + ' ' + urlPath + ' 失败: ' + err.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP ' + (options.method || 'GET') + ' ' + urlPath + ' 超时 (>' + (options.timeoutMs || 20000) + 'ms)'));
    });
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

/** 造一个工作区（走真实 Q20 API，进官方注册表）；返回其绝对路径。 */
export async function createWorkspaceViaApi(server, name) {
  const res = await rawRequest(server.base, '/api/workspace/create', { method: 'POST', body: { name } });
  if (res.status !== 200 || !res.json || !res.json.workspace || !res.json.workspace.cwd) {
    throw new Error('POST /api/workspace/create 失败: ' + res.status + ' ' + res.text.slice(0, 300));
  }
  return res.json.workspace.cwd;
}

/**
 * 起实例 + 注册工作区（工作区名固定为 `ws-<id>`，故 cwd 在 spawn 前可预测）。
 * 调用方必须自行断言 `cwd === srv.workspacePath(name)`（宿主投影 workingDirectory 的事实来源）。
 */
export async function openPreviewWorkspace(id, env = {}, opts = {}) {
  const name = 'ws-' + id;
  const srv = await launchPreviewHost({ env, rpcLog: !!opts.rpcLog });
  const cwd = await createWorkspaceViaApi(srv, name);
  return { srv, cwd, name, predictedCwd: srv.workspacePath(name) };
}

/** 条件轮询等待日志出现（禁止盲 sleep 判定）。 */
export async function waitForLog(server, re, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const text = server.stderrText + '\n' + server.stdoutText;
    if (re.test(text)) return text;
    last = text.slice(-800);
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 取 mock RPC 收据里某 method 的条数。 */
export function countRpcMethod(server, method) {
  return server.rpcEntries().filter((e) => e && e.method === method).length;
}
