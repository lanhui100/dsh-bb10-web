/**
 * Q20 Wave 2026-10-18 验收套件（思考强度 reasoningEffort + 模型目录刷新）：A1–A8
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-10-18.md
 *   §0 根因 / §1.1 bootstrap 目录 reasoning 透传 / §1.2 ?refresh=1 绕过 30s TTL
 *   §1.3 /api/chat/stream reasoningEffort 校验与 selectModel 透传
 *   §1.4 /api/session/stats reasoningEffort / §1.5 mock 宿主接缝三点 / §1.6 前端 / §3 验收矩阵
 *
 * 运行：node tests/acceptance/suite-reasoning.mjs
 * 退出码（与 run-all 一致，绝不伪装成绿）：
 *   0 = 全部 PASS
 *   1 = 存在 FAIL（断言失败 / SEAM-MISSING / 执行异常）
 *   2 = 套件启动失败（含语法/导入错误）
 *   3 = 无 FAIL 但存在显式 SKIP(DEGRADED)（真链路环境不可用）
 *
 * 纪律（test-expert L2-T + L2-AT）：
 *   1. 每条断言都是真实行为断言（HTTP / RPC 收据 / 真实浏览器 / 源码接线），失败信息带「期望 vs 实际」。
 *   2. 严禁吞异常：非断言异常同样记 FAIL 并打印堆栈。
 *   3. 环境不具备 → 显式 [RED DEGRADED: 原因] + exit 3；绝不静默跳过、绝不计入 PASS。
 *   4. 每条用例独立 mock 实例（临时 DSH_HOME + 临时工作区根），零真实宿主 / 零真实 LLM。
 *   5. A6（ES5 全量内联脚本门禁）属回归护栏：实施前应 PASS，实施后必须保持 PASS。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ARTIFACT_DIR, REPO_ROOT,
  assertEqual, assertNonEmptyArray, assertOk,
  cleanupTempDirs, countRpc, createRunner, createWorkspace, fail, fmtMs,
  launchMock, readRpcLog, redact, request, requireSeam, seedSession, skip, sse, startMockServer, tempDir, waitFor,
} from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const runner = createRunner('REASONING');

const enc = (v) => encodeURIComponent(v);
const MOCK_PROVIDER = 'ponyllm';
const MOCK_MODEL = 'glm-5.3-flash';

function briefStr(value, max = 240) {
  let s;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function findModel(models, provider, model) {
  if (!Array.isArray(models)) return null;
  return models.find((m) => m && m.provider === provider && m.model === model) || null;
}

/** 造一个不会污染真实家目录的 RPC 收据文件（父目录已存在，mock 直接 appendFileSync）。 */
function newRpcLog() {
  const file = path.join(tempDir('q20-acc-red-rpc-'), 'rpc.log');
  fs.writeFileSync(file, '');
  return file;
}

function rpcEntries(file) {
  return readRpcLog(file) || [];
}

/** 全部内联 <script> 块（跳过带 src 的外链）。 */
function extractInlineScripts(html) {
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

/** 通用 AST 遍历（acorn ESTree：仅遍历对象/数组字段，跳过 type/start/end 取值）。 */
function walkAst(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, fn);
    return;
  }
  if (typeof node.type === 'string') fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (v && typeof v === 'object') walkAst(v, fn);
  }
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** 含指定源码片段的最内层函数（防外层 IIFE 兜底命中导致空洞通过）。 */
function deepestFunctionContaining(code, ast, needle) {
  let best = null;
  walkAst(ast, (node) => {
    if (!FUNCTION_TYPES.has(node.type)) return;
    const span = node.end - node.start;
    if (best && span >= best.span) return;
    const text = code.slice(node.start, node.end);
    if (text.indexOf(needle) < 0) return;
    best = { span, text };
  });
  return best;
}

// ────────────────────────────── A7 浏览器（playwright-core）──────────────────────────────

async function loadPlaywright() {
  const candidates = [];
  if (process.env.Q20_PLAYWRIGHT) candidates.push(process.env.Q20_PLAYWRIGHT);
  candidates.push('playwright', 'playwright-core');
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return chromium;
    } catch { /* 尝试下一个候选 */ }
  }
  return null;
}

/** 候选 chromium 可执行文件（playwright 自带版本可能未安装，回退到本机已有浏览器）。 */
function chromiumCandidates() {
  const out = [];
  if (process.env.Q20_CHROMIUM) out.push(process.env.Q20_CHROMIUM);
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  const rev = (d) => parseInt(String(d).replace(/^\D+/, ''), 10) || 0;
  try {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort((a, b) => rev(b) - rev(a))) {
      out.push(path.join(cache, d, 'chrome-linux64', 'chrome'));
      out.push(path.join(cache, d, 'chrome-linux', 'chrome'));
    }
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort((a, b) => rev(b) - rev(a))) {
      out.push(path.join(cache, d, 'chrome-linux64', 'chrome-headless-shell'));
      out.push(path.join(cache, d, 'chrome-linux', 'headless_shell'));
    }
  } catch { /* 无缓存目录 */ }
  out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  return out.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

let _browserPromise = null;

/** 取浏览器句柄（懒启动 + 多候选回退）。环境不具备时抛 DegradedSkip（SKIP，绝不记 PASS）。 */
function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const chromium = await loadPlaywright();
      if (!chromium) skip('playwright-core 不可用（import 失败）：A7 真实浏览器链路无法执行');
      const browser = await launchBrowser(chromium);
      if (!browser) skip('chromium 无法启动（所有候选均失败）：A7 真实浏览器链路无法执行');
      return browser;
    })();
  }
  return _browserPromise;
}

async function launchBrowser(chromium) {
  const attempts = [{ label: 'playwright default', opts: { args: ['--no-sandbox'] } }];
  for (const exe of chromiumCandidates()) {
    attempts.push({ label: exe, opts: { args: ['--no-sandbox'], executablePath: exe } });
  }
  let launchErrors = '';
  for (const a of attempts) {
    try {
      const browser = await chromium.launch(a.opts);
      console.log('  (chromium: ' + redact(a.label) + ')');
      return browser;
    } catch (err) {
      launchErrors += redact(a.label) + ' → ' + redact(err.message) + '; ';
    }
  }
  console.log('  (chromium 启动全部失败: ' + redact(launchErrors).slice(0, 300) + ')');
  return null;
}

function treeText(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return '(元素不存在: ' + sel + ')';
    return (el.innerText || el.textContent || '').slice(0, 500);
  }, selector);
}

/** 允许任意 Q20_MOCK_* 注入的 mock 实例（launchMock 只暴露既有接缝子集，harness.mjs 冻结不可改）。 */
async function launchMockEnv(extraEnv, prefix) {
  const wsRoot = tempDir(prefix || 'q20-acc-mock-');
  const srv = await startMockServer({ workspaceRoot: wsRoot, env: extraEnv || {} });
  srv.workspaceRoot = wsRoot;
  const originalStop = srv.stop;
  srv.stop = async () => {
    await originalStop();
    try { fs.rmSync(wsRoot, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  };
  return srv;
}

function badgeText(page) {
  return page.evaluate(() => {
    const el = document.getElementById('model-badge-text');
    return el ? (el.textContent || '') : '';
  });
}

/** 显式条件轮询徽标文案（禁止盲 sleep 判定）。 */
async function waitBadge(page, check, what) {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    last = await badgeText(page);
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  fail(what, '徽标条件成立', '15s 内未成立；末次徽标=' + JSON.stringify(last));
}

/** 观察窗口内徽标的「终值」（捕捉回包迟到后的回滚；窗口内每 100ms 采样一次）。 */
async function observeBadge(page, windowMs) {
  const deadline = Date.now() + windowMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await badgeText(page);
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** 通过真实 UI 选中目标会话（W 面板 → 工作区行 → 会话行），确保 currentSessionId 就位。 */
async function selectSessionViaUi(page, sid) {
  try {
    await page.keyboard.press('w');
    await page.waitForSelector('#ws-tree .tree-ws', { timeout: 15000 });
    await page.click('#ws-tree .tree-ws');
    await page.waitForSelector('#sess-tree .tree-sess', { timeout: 20000 });
    await page.click('#sess-tree .tree-sess');
    await page.waitForFunction((s) => typeof getSid === 'function' && getSid() === s, sid, { timeout: 15000 });
  } catch {
    fail('前置：通过真实 UI 选中会话失败（' + sid + '）', 'getSid() === ' + sid,
      await page.evaluate(() => {
        try { return 'getSid()=' + getSid() + '; cwd=' + getCwd(); } catch (e) { return 'getSid 不可用: ' + e.message; }
      }));
  }
}
/** 打开唯一模型面板（M 键/徽标同源）：对话框未展开时先展开（徽标仅 compose 态可见），再点徽标。 */
async function openModelPanel(page) {
  let visible = false;
  try {
    visible = await page.evaluate(() => {
      const el = document.getElementById('model-badge');
      return !!el && el.style.display !== 'none';
    });
  } catch { /* 页面尚未就绪，走展开路径 */ }
  if (!visible) await page.keyboard.press('i');
  try {
    await page.waitForSelector('#model-badge', { state: 'visible', timeout: 15000 });
  } catch {
    fail('前置：#model-badge 必须可见（对话框已展开）', 'display=inline-block',
      await page.evaluate(() => {
        const el = document.getElementById('model-badge');
        return 'display=' + (el ? el.style.display : 'no-element');
      }));
  }
  await page.click('#model-badge');
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('model-overlay');
      return !!el && el.style.display === 'block';
    }, null, { timeout: 15000 });
  } catch {
    fail('前置：模型面板必须打开（#model-overlay display=block）', 'display=block',
      await page.evaluate(() => {
        const el = document.getElementById('model-overlay');
        return 'display=' + (el ? el.style.display : 'no-element');
      }));
  }
}

/** 点选思考强度档位（面板须已打开）。 */
async function clickEffort(page, label, ctx) {
  const loc = page.locator('#model-tree .tree-item', { hasText: label }).first();
  const n = await loc.count();
  assertOk(n > 0, '思考强度档位「' + label + '」必须可点选（' + (ctx || '') + '）',
    '≥1 个 .tree-item 文本含 ' + label,
    'count=' + n + '; #model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
  await loc.click({ timeout: 10000 });
}

/** 打开页面并等待 bootstrap 完成（#ws-select 有工作区选项）。 */
async function openApp(browser, srv, cwd, sid) {
  const context = await browser.newContext({ viewport: { width: 720, height: 720 } });
  await context.addInitScript(function (o) {
    try {
      localStorage.setItem('dsh_q20_cwd', o.cwd);
      localStorage.setItem('dsh_q20_session_id', o.sid);
    } catch (e) { /* 隐私模式下忽略 */ }
  }, { cwd, sid });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));
  const resp = await page.goto(srv.base + '/', { waitUntil: 'load', timeout: 30000 });
  assertOk(resp && resp.status() === 200, 'A7 页面 HTTP 状态', 200, resp ? resp.status() : '(no response)');
  try {
    await page.waitForFunction(() => {
      const sel = document.getElementById('ws-select');
      return !!sel && sel.options.length > 0;
    }, null, { timeout: 20000 });
  } catch {
    fail('A7 bootstrap 未完成（20s 内 #ws-select 无工作区选项）', '#ws-select 选项数 ≥ 1',
      'options=' + (await page.evaluate(() => {
        const sel = document.getElementById('ws-select');
        return sel ? sel.options.length : 'no-element';
      })));
  }
  return { context, page, errors };
}

// ────────────────────────────────── 用例 ──────────────────────────────────

async function main() {
  console.log('# Q20 验收套件 REASONING (A1–A8) — 契约 .dev-team/contract-wave-2026-10-18.md');
  console.log('# 时间: ' + new Date().toISOString());

  // ── A1: bootstrap 目录透传 reasoning（§1.1）+ mock 接缝 §1.5.1 ─────────────
  await runner.run('A1 /api/bootstrap 目录透传 reasoning：glm-5.3-flash 三档 efforts + defaultEffort=high；current.reasoningEffort 非空', async () => {
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a1-') });
    try {
      const res = await request(srv.base, '/api/bootstrap', { timeoutMs: 20000 });
      assertEqual(res.status, 200, 'A1 GET /api/bootstrap 状态码');
      const models = assertNonEmptyArray(res.body && res.body.models, 'A1 bootstrap.models 必须非空');
      const target = findModel(models, MOCK_PROVIDER, MOCK_MODEL);
      assertOk(!!target, 'A1 models 必须含 ' + MOCK_PROVIDER + '/' + MOCK_MODEL + '（契约 §1.5.1 mock 目录）',
        '含 provider=' + MOCK_PROVIDER + ' model=' + MOCK_MODEL + ' 的项',
        briefStr(models.map((m) => m && (m.provider + '/' + m.model))));
      const reasoning = target && target.reasoning;
      assertOk(!!reasoning && typeof reasoning === 'object',
        'A1 ' + MOCK_MODEL + ' 必须携带 reasoning 元数据（契约 §1.1；根因 R2 当前整体丢弃）',
        '{ efforts:[{id,name}...], defaultEffort:"high" }', target);
      const efforts = assertNonEmptyArray(reasoning.efforts, 'A1 reasoning.efforts 必须为非空数组');
      assertEqual(efforts.length, 3, 'A1 reasoning.efforts 档位数（契约 §1.5.1: off/low/high）');
      for (const e of efforts) {
        assertOk(e && typeof e.id === 'string' && e.id !== '', 'A1 每个 effort 项 id 必须为非空 string',
          '非空 string id', e);
        assertOk(typeof e.name === 'string' && e.name !== '', 'A1 每个 effort 项 name 必须为非空 string',
          '非空 string name', e);
      }
      assertEqual(efforts.map((e) => e.id).join(','), 'off,low,high', 'A1 reasoning.efforts 档位 id 序列');
      assertEqual(reasoning.defaultEffort, 'high', 'A1 reasoning.defaultEffort（契约 §1.5.1）');
      const cur = (res.body && res.body.current) || {};
      assertOk(typeof cur.reasoningEffort === 'string' && cur.reasoningEffort !== '',
        'A1 current.reasoningEffort 必须为非空 string（契约 §1.1，来自宿主 default.reasoningEffort）',
        '非空 string', cur.reasoningEffort);
      assertEqual(cur.reasoningEffort, 'high', 'A1 current.reasoningEffort 值（mock default=high）');
      const other = findModel(models, MOCK_PROVIDER, 'deepseek-v4-flash');
      assertOk(!!other && other.reasoning === undefined,
        'A1 宿主未携 reasoning 的模型不得凭空出现该字段（契约 §1.5.1「其余模型不带 reasoning」）',
        'reasoning 字段不存在', other && other.reasoning);
      return 'efforts=' + efforts.map((e) => e.id).join('/') + ' defaultEffort=' + reasoning.defaultEffort
        + ' current.reasoningEffort=' + cur.reasoningEffort;
    } finally {
      await srv.stop();
    }
  });

  // ── A2: 30s TTL + ?refresh=1 强制绕过（§1.2；根因 R6–R9）─────────────────
  await runner.run('A2 目录缓存：30s TTL 内连续两次普通 /api/bootstrap 的 modelCatalog 收据 ≤1；?refresh=1 必须 +1', async () => {
    const rpcLog = newRpcLog();
    const srv = await launchMock({ rpcLog, workspaceRoot: tempDir('q20-acc-a2-') });
    try {
      // 只统计请求窗口内的收据：清空启动期可能的写入
      fs.writeFileSync(rpcLog, '');
      const r1 = await request(srv.base, '/api/bootstrap', { timeoutMs: 20000 });
      assertEqual(r1.status, 200, 'A2 第 1 次普通 GET /api/bootstrap 状态码');
      assertNonEmptyArray(r1.body && r1.body.models, 'A2 第 1 次 /api/bootstrap models 必须非空');
      const r2 = await request(srv.base, '/api/bootstrap', { timeoutMs: 20000 });
      assertEqual(r2.status, 200, 'A2 第 2 次普通 GET /api/bootstrap 状态码');
      const n1 = countRpc(rpcEntries(rpcLog), 'session/modelCatalog');
      assertOk(n1 <= 1, 'A2 30s TTL 内连续两次普通 /api/bootstrap 的 session/modelCatalog 收据数（契约 §1.2）',
        '≤ 1 次', n1 + ' 次');

      const r3 = await request(srv.base, '/api/bootstrap?refresh=1', { timeoutMs: 20000 });
      assertEqual(r3.status, 200, 'A2 GET /api/bootstrap?refresh=1 状态码');
      assertNonEmptyArray(r3.body && r3.body.models, 'A2 refresh=1 响应 models 必须非空');
      const n2 = countRpc(rpcEntries(rpcLog), 'session/modelCatalog');
      assertOk(n2 === n1 + 1,
        'A2 refresh=1 必须绕过 30s MODEL_CATALOG_TTL_MS 并额外产生 1 次 session/modelCatalog 收据（契约 §1.2；根因 R8）',
        n1 + 1 + ' 次', n2 + ' 次');
      return 'plain×2 receipts=' + n1 + ' → refresh=1 后=' + n2;
    } finally {
      await srv.stop();
    }
  });

  // ── A3: 发送透传 selectModel.args.reasoningEffort（§1.3 + §1.5.2）─────────
  await runner.run('A3 /api/chat/stream 发送透传：带 reasoningEffort=low → selectModel 收据 args.reasoningEffort=low 且 provider/model 正确；不带该键时收据无 reasoningEffort', async () => {
    const rpcLog = newRpcLog();
    const srv = await launchMock({ rpcLog, workspaceRoot: tempDir('q20-acc-a3-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a3');
      const lowSid = 'session-acc-a3-low';
      const plainSid = 'session-acc-a3-plain';

      const lowRes = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: lowSid,
        prompt: 'acceptance-a3-with-effort', reasoningEffort: 'low',
      }, { timeoutMs: 20000 });
      assertEqual(lowRes.status, 200, 'A3 带 reasoningEffort 的回合 /api/chat/stream 状态码');
      assertOk(!lowRes.events.some((e) => e.event === 'error'), 'A3 带 effort 的回合不得报错',
        '无 error 事件', briefStr(lowRes.events.filter((e) => e.event === 'error')));
      assertOk(lowRes.events.some((e) => e.event === 'done'), 'A3 带 effort 的回合必须到达 done 终态',
        'event: done', lowRes.events.map((e) => e.event).join(','));

      const plainRes = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: plainSid,
        prompt: 'acceptance-a3-without-effort',
      }, { timeoutMs: 20000 });
      assertEqual(plainRes.status, 200, 'A3 不带 reasoningEffort 的回合 /api/chat/stream 状态码');
      assertOk(plainRes.events.some((e) => e.event === 'done'), 'A3 不带 effort 的回合必须到达 done 终态',
        'event: done', plainRes.events.map((e) => e.event).join(','));

      const entries = rpcEntries(rpcLog);
      const selects = entries.filter((e) => e && e.method === 'session/selectModel');
      assertOk(selects.length >= 2, 'A3 两个回合必须各自下发一次 session/selectModel（契约 §1.3）',
        '≥ 2 条收据', selects.length + ' 条');
      // 接缝活性（§1.5.2）：收据行必须带 args=<request>，否则无法断言透传内容
      requireSeam(selects.every((e) => e.args && typeof e.args === 'object'),
        'A3 mock RPC 收据必须携带 args（契约 §1.5.2 收据行 {"method","at","args":<request>}）',
        '每条 session/selectModel 收据含 args 对象', briefStr(selects.slice(-2)));

      const lowRec = selects.find((e) => e.args.sessionId === lowSid);
      assertOk(!!lowRec, 'A3 可按 sessionId 定位带 effort 回合的 selectModel 收据',
        'args.sessionId === ' + lowSid, briefStr(selects.map((e) => e.args && e.args.sessionId)));
      assertEqual(lowRec.args.provider, MOCK_PROVIDER, 'A3 selectModel args.provider');
      assertEqual(lowRec.args.model, MOCK_MODEL, 'A3 selectModel args.model');
      assertEqual(lowRec.args.reasoningEffort, 'low',
        'A3 selectModel args.reasoningEffort 必须透传请求体合法值（契约 §1.3；根因 R3）');

      const plainRec = selects.find((e) => e.args.sessionId === plainSid);
      assertOk(!!plainRec, 'A3 可按 sessionId 定位无 effort 回合的 selectModel 收据',
        'args.sessionId === ' + plainSid, briefStr(selects.map((e) => e.args && e.args.sessionId)));
      assertOk(!('reasoningEffort' in plainRec.args),
        'A3 缺省 reasoningEffort 时 selectModel args 不得携带该键（契约 §1.3 仅当非空才带）',
        '无 reasoningEffort 键', briefStr(plainRec.args));
      return 'low.args.reasoningEffort=' + lowRec.args.reasoningEffort
        + ' provider=' + lowRec.args.provider + ' model=' + lowRec.args.model + '；无键回合 args 无该字段';
    } finally {
      await srv.stop();
    }
  });

  // ── A4: 非法 reasoningEffort 必须在 SSE 头之前 400（§1.3）────────────────
  await runner.run('A4 入参校验：reasoningEffort=123 → 400 且文案含 reasoningEffort；超长(>64) → 400；空串 → 照常 200 流', async () => {
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a4-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a4');
      const bad = await request(srv.base, '/api/chat/stream', {
        method: 'POST',
        body: {
          cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: 'session-acc-a4-type',
          prompt: 'acceptance-a4-invalid-type', reasoningEffort: 123,
        },
        timeoutMs: 20000,
      });
      assertEqual(bad.status, 400, 'A4 非 string 的 reasoningEffort 必须 400（SSE 头之前拦截，契约 §1.3）');
      assertOk(bad.body && typeof bad.body.error === 'string' && bad.body.error.indexOf('reasoningEffort') >= 0,
        'A4 400 错误文案必须含 "reasoningEffort"', 'error 含 reasoningEffort', briefStr(bad.body));

      const tooLong = await request(srv.base, '/api/chat/stream', {
        method: 'POST',
        body: {
          cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: 'session-acc-a4-long',
          prompt: 'acceptance-a4-too-long', reasoningEffort: 'x'.repeat(65),
        },
        timeoutMs: 20000,
      });
      assertEqual(tooLong.status, 400, 'A4 长度 > 64 的 reasoningEffort 必须 400（契约 §1.3）');

      const emptyRes = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: 'session-acc-a4-empty',
        prompt: 'acceptance-a4-empty-effort', reasoningEffort: '',
      }, { timeoutMs: 20000 });
      assertEqual(emptyRes.status, 200, "A4 reasoningEffort='' 必须照常放行（契约 §1.3 缺省/空串不下发）");
      assertOk(emptyRes.events.some((e) => e.event === 'done'),
        "A4 reasoningEffort='' 回合必须正常到达 done", 'event: done',
        emptyRes.events.map((e) => e.event).join(','));
      return '123→400 文案含 reasoningEffort；65 字符→400；空串→200/done';
    } finally {
      await srv.stop();
    }
  });

  // ── A5: /api/session/stats 暴露 reasoningEffort（§1.4 + §1.5.3）──────────
  await runner.run('A5 会话 stats：带 reasoningEffort=low 的回合 → /api/session/stats 返回 reasoningEffort=low；无 effort 会话 → ""', async () => {
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a5-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a5');
      const lowSid = 'session-acc-a5-low';
      const plainSid = 'session-acc-a5-plain';

      // §1.5.3：mock seed 回合必须携 reasoningEffort 落转录（header config + request/header 事件）
      const seedLow = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: lowSid,
        prompt: 'acceptance-a5-low', reasoningEffort: 'low',
      }, { timeoutMs: 20000 });
      assertEqual(seedLow.status, 200, 'A5 seed 回合 /api/chat/stream 状态码');
      assertOk(seedLow.events.some((e) => e.event === 'done'), 'A5 seed 回合必须到达 done 终态',
        'event: done', seedLow.events.map((e) => e.event).join(','));
      const res = await request(srv.base, '/api/session/stats?cwd=' + enc(cwd) + '&id=' + enc(lowSid), { timeoutMs: 20000 });
      assertEqual(res.status, 200, 'A5 带 effort 会话 GET /api/session/stats 状态码');
      assertOk(res.body && typeof res.body === 'object', 'A5 stats 响应必须是 JSON 对象', '{...}', briefStr(res.raw));
      assertEqual(res.body.reasoningEffort, 'low',
        'A5 stats.reasoningEffort 必须来自转录 request/header.config.reasoningEffort（契约 §1.4；根因 R5）');

      await seedSession(srv.base, { cwd, sessionId: plainSid, prompt: 'acceptance-a5-plain' });
      const res2 = await request(srv.base, '/api/session/stats?cwd=' + enc(cwd) + '&id=' + enc(plainSid), { timeoutMs: 20000 });
      assertEqual(res2.status, 200, 'A5 无 effort 会话 GET /api/session/stats 状态码');
      assertEqual(res2.body.reasoningEffort, '',
        'A5 无 effort 会话 stats.reasoningEffort 必须为 ""（契约 §1.4 均缺失 → ""）');
      return '带 effort stats.reasoningEffort=low；无 effort stats.reasoningEffort=""';
    } finally {
      await srv.stop();
    }
  });

  // ── A6: ES5 全量内联脚本门禁（回归护栏，实施前应 PASS）───────────────────
  await runner.run('A6 ES5 门禁（回归护栏）：static/index.html 全部内联 script 通过 acorn {ecmaVersion:5}', async () => {
    let acorn;
    try {
      acorn = require('acorn');
    } catch (err) {
      skip('acorn 不可用 (' + err.code + ')：ES5 门禁无法机器判定');
    }
    const file = path.join(REPO_ROOT, 'static', 'index.html');
    assertOk(fs.existsSync(file), 'A6 static/index.html 必须存在', redact(file), '(missing)');
    const inline = extractInlineScripts(fs.readFileSync(file, 'utf8'));
    assertNonEmptyArray(inline, 'A6 必须存在内联 <script> 块');
    for (let i = 0; i < inline.length; i++) {
      try {
        acorn.parse(inline[i], { ecmaVersion: 5 });
      } catch (err) {
        fail('A6 内联脚本 #' + (i + 1) + ' ES5 解析', 'acorn {ecmaVersion:5} PASS', err.message);
      }
    }
    return 'ES5 PASS (' + inline.length + ' 个内联 script, acorn ' + acorn.version + ')';
  });

  // ── A7: 真实浏览器 —— 面板思考强度分组 / 档位生效 / 徽标 / Console Error=0 ─
  await runner.run('A7 真实浏览器：点模型徽标 → 出现「思考强度」分组与档位；点 Low → 徽标含 "· Low" 且面板收起；Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const sid = 'session-acc-a7-browser';
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a7-') });
    let context = null;
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a7');
      await seedSession(srv.base, { cwd, sessionId: sid, prompt: 'acceptance-a7-browser' });
      const app = await openApp(browser, srv, cwd, sid);
      context = app.context;
      const page = app.page;

      // 展开对话框（徽标仅在 compose 态可见）→ 点模型徽标打开唯一模型面板
      await page.keyboard.press('i');
      try {
        await page.waitForSelector('#model-badge', { state: 'visible', timeout: 15000 });
      } catch {
        fail('A7 前置：展开对话框后 #model-badge 必须可见', '#model-badge display=inline-block',
          await page.evaluate(() => {
            const el = document.getElementById('model-badge');
            return 'display=' + (el ? el.style.display : 'no-element');
          }));
      }
      await page.click('#model-badge');
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('model-overlay');
          return !!el && el.style.display === 'block';
        }, null, { timeout: 15000 });
      } catch {
        fail('A7 模型面板必须打开（#model-overlay display=block）', 'display=block',
          await page.evaluate(() => {
            const el = document.getElementById('model-overlay');
            return 'display=' + (el ? el.style.display : 'no-element');
          }));
      }

      const shotPanel = path.join(ARTIFACT_DIR, 'a7-effort-panel.png');

      // 面板渲染完成即落盘红相物理证据（红相下应看不到「思考强度」分组）
      try {
        await page.waitForFunction(() => document.querySelectorAll('#model-tree .tree-item').length > 0,
          null, { timeout: 15000 });
      } catch {
        fail('A7 模型面板必须渲染出模型行（15s 内 #model-tree 无 .tree-item）',
          '≥1 个 .tree-item', '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      }
      await page.screenshot({ path: shotPanel });

      // 思考强度分组必须存在（契约 §1.6：模型分组之后追加可折叠分组 ⚙ 思考强度（…））
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('model-tree');
          return !!el && (el.textContent || '').indexOf('思考强度') >= 0;
        }, null, { timeout: 15000 });
      } catch {
        fail('A7 模型面板必须渲染「思考强度」分组（契约 §1.6；根因 R4 面板只有模型行）',
          '#model-tree 文本含「思考强度」', '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      }
      // 分组就绪后重拍：绿相物理凭据（面板可见思考强度档位）
      await page.screenshot({ path: shotPanel });

      const tiers = await page.evaluate(() => {
        const rows = document.querySelectorAll('#model-tree .tree-item');
        const texts = [];
        for (let i = 0; i < rows.length; i++) texts.push((rows[i].textContent || '').replace(/^\s+|\s+$/g, ''));
        return texts;
      });
      for (const label of ['Low', 'High']) {
        assertOk(tiers.some((t) => t.indexOf(label) >= 0),
          'A7 面板思考强度分组必须含档位 ' + label + '（契约 §1.5.1 off/low/high）',
          '存在含 ' + label + ' 的 .tree-item', briefStr(tiers));
      }
      const hasCurrentMarker = await page.evaluate(() => {
        const rows = document.querySelectorAll('#model-tree .tree-item');
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i].textContent || '';
          if (t.indexOf('High') >= 0 && t.indexOf('●') >= 0) return true;
        }
        return false;
      });
      assertOk(hasCurrentMarker, 'A7 当前生效档位（defaultEffort=high）必须以 ● 标记（契约 §1.6）',
        '含 ● 与 High 的 .tree-item', briefStr(tiers));

      const lowItem = page.locator('#model-tree .tree-item', { hasText: 'Low' }).first();
      const lowCount = await lowItem.count();
      assertOk(lowCount > 0, 'A7 面板必须可点选 Low 档位', '≥1 个 .tree-item 文本含 Low', 'count=' + lowCount);
      await lowItem.click({ timeout: 10000 });

      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('model-badge-text');
          const t = el ? (el.textContent || '') : '';
          return t.indexOf('·') >= 0 && t.indexOf('Low') >= 0;
        }, null, { timeout: 15000 });
      } catch {
        fail('A7 选择 Low 后模型徽标必须含 "·" 与 "Low"（契约 §1.6 徽标后缀）',
          '"<模型名> · Low"',
          'badge=' + JSON.stringify(await page.evaluate(() => {
            const el = document.getElementById('model-badge-text');
            return el ? (el.textContent || '') : '(no-element)';
          })));
      }
      const overlayDisplay = await page.evaluate(() => {
        const el = document.getElementById('model-overlay');
        return el ? el.style.display : 'no-element';
      });
      assertEqual(overlayDisplay, 'none', 'A7 选定档位后模型面板必须收起（契约 §1.6）');

      const shotBadge = path.join(ARTIFACT_DIR, 'a7-effort-badge.png');
      await page.screenshot({ path: shotBadge });

      assertEqual(app.errors.length, 0, 'A7 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shotPanel) && fs.existsSync(shotBadge), 'A7 截图必须落盘',
        redact(shotPanel) + ' + ' + redact(shotBadge), '(missing)');
      return '档位含 Low/High 且 ● 命中 High；徽标含 "· Low"；consoleErrors=0；截图='
        + path.basename(shotPanel) + ',' + path.basename(shotBadge);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await srv.stop();
    }
  });

  // ── A8: 静态接线（AST 结构断言）─────────────────────────────────────────
  await runner.run('A8 静态接线：openModel() 必须发 /api/bootstrap?refresh=1；/api/chat/stream 发送函数载荷必须含 reasoningEffort', async () => {
    let acorn;
    try {
      acorn = require('acorn');
    } catch (err) {
      skip('acorn 不可用 (' + err.code + ')：A8 静态接线无法机器判定');
    }
    const file = path.join(REPO_ROOT, 'static', 'index.html');
    assertOk(fs.existsSync(file), 'A8 static/index.html 必须存在', redact(file), '(missing)');
    const scripts = extractInlineScripts(fs.readFileSync(file, 'utf8'));
    assertNonEmptyArray(scripts, 'A8 必须存在内联 <script> 块');

    let openModelText = null;
    let streamFn = null;
    for (const code of scripts) {
      let ast;
      try {
        ast = acorn.parse(code, { ecmaVersion: 5 });
      } catch (err) {
        fail('A8 内联脚本 ES5 解析（与 A6 同源门禁）', 'acorn {ecmaVersion:5} PASS', err.message);
      }
      walkAst(ast, (node) => {
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name === 'openModel') {
          openModelText = code.slice(node.start, node.end);
        }
      });
      const found = deepestFunctionContaining(code, ast, '/api/chat/stream');
      if (found && (!streamFn || found.span < streamFn.span)) streamFn = found;
    }

    assertOk(!!openModelText, 'A8 必须能定位 openModel() 函数体（契约 §1.6 目录刷新入口）',
      'function openModel() {...}', '(未找到)');
    const refreshOk = openModelText.indexOf('/api/bootstrap') >= 0 && openModelText.indexOf('refresh=1') >= 0;
    const sendOk = !!streamFn && streamFn.text.indexOf('reasoningEffort') >= 0;
    assertOk(refreshOk && sendOk,
      'A8 静态接线（契约 §1.6）：openModel 必须触发 /api/bootstrap?refresh=1（修 R7），且 /api/chat/stream 发送函数载荷必须含 reasoningEffort（修 R3 前端侧）',
      'openModel 含 /api/bootstrap 且 refresh=1；发送函数含 reasoningEffort',
      'openModel 目录刷新=' + refreshOk + '；发送函数 reasoningEffort=' + sendOk
        + '（openModel 片段: ' + briefStr(openModelText, 200) + '）');
    return 'openModel→bootstrap?refresh=1 命中；/api/chat/stream 发送函数（' + streamFn.span + 'B）含 reasoningEffort';
  });

  // ── A9: 真实浏览器 + 延迟 stats 回包 → 不得回滚用户刚选的档位（契约 v1.1 §5.3.3）──
  await runner.run('A9 真实浏览器：延迟 /api/session/stats 回包不得回滚用户档位 —— 转录 effort=low 时选 High，在途 stats 到达后徽标仍 "· High" 且发送载荷 reasoningEffort=high', async () => {
    const browser = await getBrowser();
    const sid = 'session-acc-a9-race';
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a9-') });
    let context = null;
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a9-race');
      // 前置：转录末次 request/header effort=low（在途 stats 回包将携带该值）
      const seed = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: sid,
        prompt: 'acceptance-a9-race', reasoningEffort: 'low',
      }, { timeoutMs: 20000 });
      assertEqual(seed.status, 200, 'A9 seed 回合 /api/chat/stream 状态码');
      assertOk(seed.events.some((e) => e.event === 'done'), 'A9 seed 回合必须到达 done 终态',
        'event: done', seed.events.map((e) => e.event).join(','));
      const seedStats = await request(srv.base, '/api/session/stats?cwd=' + enc(cwd) + '&id=' + enc(sid), { timeoutMs: 20000 });
      assertEqual(seedStats.status, 200, 'A9 seed 会话 /api/session/stats 状态码');
      assertEqual(seedStats.body && seedStats.body.reasoningEffort, 'low',
        'A9 前置：转录末次 effort 必须为 low（延迟回包携带该值）');

      const app = await openApp(browser, srv, cwd, sid);
      context = app.context;
      const page = app.page;

      // 路由闸门：delayMs>0 时扣住 stats 回包，模拟 Q20 上整份转录解压导致的慢回包
      let delayMs = 0;
      let statsIssued = 0;
      let statsInFlight = 0;
      const statsDone = new Set();
      await page.route('**/api/session/stats*', async (route) => {
        const id = ++statsIssued;
        statsInFlight += 1;
        const hold = delayMs;
        if (hold > 0) await new Promise((r) => setTimeout(r, hold));
        try { await route.continue(); } catch (e) { /* 页面已关闭 */ }
        statsInFlight -= 1;
        statsDone.add(id);
      });

      // 1) 真实 UI 选中会话：currentSessionId 就位后 openModel() 才会触发 loadSessionStats
      await selectSessionViaUi(page, sid);

      // 2) 展开对话框，等首屏 stats 落地（转录 low 校真生效）
      await page.keyboard.press('i');
      await page.waitForSelector('#model-badge', { state: 'visible', timeout: 15000 });
      await waitFor(() => statsIssued > 0,
        { timeoutMs: 8000, intervalMs: 80, label: 'A9 会话 stats 请求发出' });
      await waitFor(() => statsInFlight === 0,
        { timeoutMs: 12000, intervalMs: 80, label: 'A9 首屏 stats 回包落地' });
      const badgeLow = await waitBadge(page, (t) => t.indexOf('·') >= 0 && t.indexOf('Low') >= 0,
        'A9 stats 校真后徽标必须为 Low（转录 effort=low）');

      // 3) 打开面板：openModel() 自身触发 loadSessionStats（在途），扣住 2500ms
      delayMs = 2500;
      const issuedBefore = statsIssued;
      await page.click('#model-badge');
      await waitFor(() => statsIssued > issuedBefore,
        { timeoutMs: 8000, intervalMs: 50, label: 'A9 面板触发的在途 stats 请求' });
      const heldId = statsIssued;

      // 4) 在途回包尚未到达时，用户选定 High
      await clickEffort(page, 'High', 'A9 在途 stats 未返回时选择 High');
      const badgePicked = await badgeText(page);
      assertOk(badgePicked.indexOf('·') >= 0 && badgePicked.indexOf('High') >= 0,
        'A9 选定 High 后徽标必须立即显示 High', '含 "· High"', badgePicked);

      // 5) 等在途 stats 回包落地，观察 1.5s 内徽标是否被回滚
      await waitFor(() => statsDone.has(heldId),
        { timeoutMs: 20000, intervalMs: 100, label: 'A9 在途 stats 回包落地' });
      const observed = await observeBadge(page, 1500);
      const shotRace = path.join(ARTIFACT_DIR, 'a9-effort-rollback.png');
      await page.screenshot({ path: shotRace });
      assertOk(observed.indexOf('·') >= 0 && observed.indexOf('High') >= 0,
        'A9 在途 stats 回包不得回滚用户刚选的档位（契约 v1.1 §5.3.3：effort 变更须与模型变更同权推进版本/脏标记）',
        '徽标保持 "· High"',
        '观察 1.5s 终值=' + JSON.stringify(observed) + '（选择后即时值=' + JSON.stringify(badgePicked)
          + '；在途回包值=low；校真前徽标=' + JSON.stringify(badgeLow) + '）');

      // 6) 回包后再开面板，等新一轮 stats 落地：当前生效项 ● 必须仍是 High
      delayMs = 0;
      const issuedBefore2 = statsIssued;
      await page.click('#model-badge');
      await waitFor(() => statsIssued > issuedBefore2,
        { timeoutMs: 8000, intervalMs: 50, label: 'A9 重开面板 stats 请求' });
      const reopenId = statsIssued;
      await waitFor(() => statsDone.has(reopenId),
        { timeoutMs: 12000, intervalMs: 100, label: 'A9 重开面板 stats 回包落地' });
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('model-tree');
          return !!el && (el.textContent || '').indexOf('思考强度') >= 0;
        }, null, { timeout: 15000 });
      } catch {
        fail('A9 面板必须渲染「思考强度」分组', '#model-tree 文本含「思考强度」',
          '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      }
      const markerOk = await page.evaluate(() => {
        const rows = document.querySelectorAll('#model-tree .tree-item');
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i].textContent || '';
          if (t.indexOf('High') >= 0 && t.indexOf('●') >= 0) return true;
        }
        return false;
      });
      assertOk(markerOk, 'A9 回包后重开面板，当前生效档位必须仍为「● High」（不得回落到 ● Low）',
        '含 ● 与 High 的 .tree-item',
        '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));

      // 7) 下一轮发送载荷必须仍是 high
      await page.click('#model-close-btn');
      let sendPayload = null;
      await page.route('**/api/chat/stream', async (route) => {
        try { sendPayload = JSON.parse(route.request().postData() || 'null'); } catch (e) { sendPayload = null; }
        try { await route.continue(); } catch (e2) { /* 页面已关闭 */ }
      });
      await page.fill('#input-box', 'a9 effort probe');
      await page.press('#input-box', 'Enter');
      await waitFor(() => sendPayload !== null, { timeoutMs: 20000, intervalMs: 100, label: 'A9 发送请求发出' });
      assertEqual(sendPayload && sendPayload.reasoningEffort, 'high',
        'A9 下一轮发送载荷 reasoningEffort 必须为 high（不得被在途 stats 回滚为 low）');
      return '种子 stats=low；选 High 后徽标=' + JSON.stringify(badgePicked) + '；回包后观察终值=' + JSON.stringify(observed)
        + '；面板 ● High 命中；发送载荷 reasoningEffort=high';
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await srv.stop();
    }
  });

  // ── A10: stats 不继承旧回合（契约 v1.1 §5.1）──────────────────────────────
  await runner.run('A10 服务端 stats 不继承旧回合：turn1 带 effort=low、turn2 不带 → /api/session/stats.reasoningEffort 必须 ""', async () => {
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a10-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a10');
      const sid = 'session-acc-a10-turns';
      const t1 = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: sid,
        prompt: 'acceptance-a10-turn1-with-effort-low', reasoningEffort: 'low',
      }, { timeoutMs: 20000 });
      assertEqual(t1.status, 200, 'A10 turn1 /api/chat/stream 状态码');
      assertOk(t1.events.some((e) => e.event === 'done'), 'A10 turn1 必须到达 done 终态',
        'event: done', t1.events.map((e) => e.event).join(','));
      const st1 = await request(srv.base, '/api/session/stats?cwd=' + enc(cwd) + '&id=' + enc(sid), { timeoutMs: 20000 });
      assertEqual(st1.status, 200, 'A10 turn1 后 GET /api/session/stats 状态码');
      assertEqual(st1.body && st1.body.reasoningEffort, 'low',
        'A10 前置：turn1 带 effort=low，stats 必须为 low');

      // turn2 不带 reasoningEffort：prompt 长度刻意不同，确保转录 size 变化（避开 stats 缓存键）
      const t2 = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: sid,
        prompt: 'acceptance-a10-turn2-default-effort-no-key-present',
      }, { timeoutMs: 20000 });
      assertEqual(t2.status, 200, 'A10 turn2 /api/chat/stream 状态码');
      assertOk(t2.events.some((e) => e.event === 'done'), 'A10 turn2 必须到达 done 终态',
        'event: done', t2.events.map((e) => e.event).join(','));
      const st2 = await request(srv.base, '/api/session/stats?cwd=' + enc(cwd) + '&id=' + enc(sid), { timeoutMs: 20000 });
      assertEqual(st2.status, 200, 'A10 turn2 后 GET /api/session/stats 状态码');
      assertEqual(st2.body && st2.body.reasoningEffort, '',
        'A10 最新回合未带 effort → stats.reasoningEffort 必须为 ""（契约 v1.1 §5.1：最新 request/header 整体替换，禁止保留最近非空值）');
      return 'turn1 stats=low → turn2（无键）stats=""';
    } finally {
      await srv.stop();
    }
  });

  // ── A11: 换模型档位语义（契约 v1.1 §5.3.1 + §5.4）────────────────────────
  await runner.run('A11 真实浏览器：glm-5.3-flash 选 Low 后切 kimi-k3 → 生效档位取新模型 defaultEffort=high（面板 ● High）', async () => {
    const browser = await getBrowser();
    const sid = 'session-acc-a11-switch';
    const srv = await launchMock({ workspaceRoot: tempDir('q20-acc-a11-') });
    let context = null;
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a11');
      const seed = await sse(srv.base, '/api/chat/stream', {
        cwd, provider: MOCK_PROVIDER, model: MOCK_MODEL, sessionId: sid,
        prompt: 'acceptance-a11-switch',
      }, { timeoutMs: 20000 });
      assertEqual(seed.status, 200, 'A11 seed 回合 /api/chat/stream 状态码');
      assertOk(seed.events.some((e) => e.event === 'done'), 'A11 seed 回合必须到达 done 终态',
        'event: done', seed.events.map((e) => e.event).join(','));
      const app = await openApp(browser, srv, cwd, sid);
      context = app.context;
      const page = app.page;

      // stats 计数：保证每次断言都在「回包落地之后」判定，不吃时序红利
      let statsIssued = 0;
      let statsInFlight = 0;
      const statsDone = new Set();
      await page.route('**/api/session/stats*', async (route) => {
        const id = ++statsIssued;
        statsInFlight += 1;
        try { await route.continue(); } catch (e) { /* 页面已关闭 */ }
        statsInFlight -= 1;
        statsDone.add(id);
      });

      await selectSessionViaUi(page, sid);
      await page.keyboard.press('i');
      await page.waitForSelector('#model-badge', { state: 'visible', timeout: 15000 });
      await waitFor(() => statsInFlight === 0,
        { timeoutMs: 12000, intervalMs: 80, label: 'A11 会话首屏 stats 回包落地' });

      const kimiReason = await page.evaluate(() => {
        try { return modelReasoningMap['ponyllm:::kimi-k3'] || null; } catch (e) { return 'unavailable:' + e.message; }
      });

      await openModelPanel(page);
      await clickEffort(page, 'Low', 'A11 先在同 provider 的 glm 上选 Low');
      const badgeLow = await waitBadge(page, (t) => t.indexOf('·') >= 0 && t.indexOf('Low') >= 0,
        'A11 glm 选 Low 后徽标');

      // 切到同 provider 的另一个带 reasoning 模型 kimi-k3（§5.3.1：换任何模型一律取新模型 defaultEffort）
      await openModelPanel(page);
      const kimiItem = page.locator('#model-tree .tree-item', { hasText: 'Kimi-K3' }).first();
      const kimiCount = await kimiItem.count();
      assertOk(kimiCount > 0, 'A11 面板必须含 kimi-k3 模型行（mock 目录 §1.5.1）',
        '≥1 个 .tree-item 文本含 Kimi-K3',
        'count=' + kimiCount + '; #model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      await kimiItem.click({ timeout: 10000 });
      const badgeKimi = await waitBadge(page, (t) => t.toLowerCase().indexOf('kimi') >= 0,
        'A11 切换到 kimi-k3 后徽标');
      assertOk(badgeKimi.indexOf('·') >= 0 && badgeKimi.indexOf('High') >= 0,
        'A11 换模型后生效档位必须取新模型 reasoning.defaultEffort=high（契约 v1.1 §5.3.1；§5.4 要求 kimi-k3 携 reasoning low/high + defaultEffort high），不得沿用上一模型的 Low',
        '徽标含 "· High"',
        '实际徽标=' + JSON.stringify(badgeKimi) + '（切换前 glm 徽标=' + JSON.stringify(badgeLow)
          + '）；kimi 目录 reasoning=' + JSON.stringify(kimiReason));

      // 面板当前生效项 ● 必须落在 High（等重开面板触发的 stats 回包落地后判定）
      const issuedBefore = statsIssued;
      await openModelPanel(page);
      await waitFor(() => statsIssued > issuedBefore,
        { timeoutMs: 8000, intervalMs: 50, label: 'A11 重开面板 stats 请求' });
      const reopenId = statsIssued;
      await waitFor(() => statsDone.has(reopenId),
        { timeoutMs: 12000, intervalMs: 100, label: 'A11 重开面板 stats 回包落地' });
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('model-tree');
          return !!el && (el.textContent || '').indexOf('思考强度') >= 0;
        }, null, { timeout: 15000 });
      } catch {
        fail('A11 kimi-k3 面板必须渲染「思考强度」分组（§5.4 目录 reasoning 缺失）',
          '#model-tree 文本含「思考强度」', '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      }
      // 扫描限定为「同时含 ● 与 High」的档位行：选中模型行同样以 '● ' 前缀渲染（既有 UI），
      // 故不能用「首个含 ● 的 .tree-item」——那必然命中模型行，对任何合规实现都不可满足
      // （与 A7/A9 的「● 且 High」合取扫描同口径）。
      const hasEffortMarker = await page.evaluate(() => {
        const rows = document.querySelectorAll('#model-tree .tree-item');
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i].textContent || '';
          if (t.indexOf('●') >= 0 && t.indexOf('High') >= 0) return true;
        }
        return false;
      });
      assertOk(hasEffortMarker, 'A11 面板当前生效档位 ● 必须落在 High（kimi defaultEffort；扫描限定「● 且 High」，避免命中同样带 ● 的选中模型行）',
        '含 ● 与 High 的 .tree-item',
        '#model-tree 文本=' + JSON.stringify(await treeText(page, '#model-tree')));
      return 'glm 选 Low 后徽标=' + JSON.stringify(badgeLow) + '；切 kimi 后徽标=' + JSON.stringify(badgeKimi)
        + '；面板档位 ● High 命中；kimi reasoning=' + JSON.stringify(kimiReason);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await srv.stop();
    }
  });

  // ── A12: 强制回源失败不得丢弃有效目录缓存（契约 v1.1 §5.2 + §5.4 接缝裁定）──
  await runner.run('A12 目录刷新容错：Q20_MOCK_HOST_CATALOG_FAIL=1 接缝生效；FAIL_AFTER=1 时 ?refresh=1 仍返回上一份含 reasoning 的目录（不塌缩磁盘镜像）', async () => {
    // 12.1 接缝活性：catalog 全失败 → 不得再返回宿主目录（reasoning 唯一来源）
    const failSrv = await launchMockEnv({ Q20_MOCK_HOST_CATALOG_FAIL: '1' }, 'q20-acc-a12a-');
    try {
      const r = await request(failSrv.base, '/api/bootstrap', { timeoutMs: 20000 });
      assertEqual(r.status, 200, 'A12（接缝探针）catalog 全失败时 /api/bootstrap 状态码');
      const models = Array.isArray(r.body && r.body.models) ? r.body.models : [];
      const leaked = models.filter((m) => m && m.reasoning);
      assertOk(leaked.length === 0,
        'A12 Q20_MOCK_HOST_CATALOG_FAIL=1 接缝必须生效：宿主目录不可用时不得仍返回宿主目录（§1.1 磁盘兜底路径不产出 reasoning）',
        '无任何模型携带 reasoning（退回磁盘镜像）',
        '仍有 ' + leaked.length + ' 个模型携带 reasoning: ' + briefStr(leaked.map((m) => m.provider + '/' + m.model)));
    } finally {
      await failSrv.stop();
    }

    // 12.2 主断言：先暖缓存（宿主目录成功）→ 其后 modelCatalog 注入失败 → ?refresh=1 必须返回缓存目录
    const srv = await launchMockEnv({ Q20_MOCK_HOST_CATALOG_FAIL_AFTER: '1' }, 'q20-acc-a12b-');
    try {
      const warm = await request(srv.base, '/api/bootstrap', { timeoutMs: 20000 });
      assertEqual(warm.status, 200, 'A12 首次 /api/bootstrap 状态码');
      const glmWarm = findModel(warm.body && warm.body.models, MOCK_PROVIDER, MOCK_MODEL);
      assertOk(!!glmWarm && glmWarm.reasoning && Array.isArray(glmWarm.reasoning.efforts) && glmWarm.reasoning.efforts.length === 3,
        'A12 前置：首次 bootstrap 必须取得含 reasoning 的宿主目录（暖缓存）',
        MOCK_MODEL + ' reasoning.efforts=3', glmWarm);

      const refreshed = await request(srv.base, '/api/bootstrap?refresh=1', { timeoutMs: 20000 });
      assertEqual(refreshed.status, 200, 'A12 宿主失败时 GET /api/bootstrap?refresh=1 仍应 200');
      const glmAfter = findModel(refreshed.body && refreshed.body.models, MOCK_PROVIDER, MOCK_MODEL);
      const effortsAfter = glmAfter && glmAfter.reasoning && Array.isArray(glmAfter.reasoning.efforts)
        ? glmAfter.reasoning.efforts.length : 0;
      assertOk(effortsAfter === 3,
        'A12 ?refresh=1 在宿主目录失败时必须返回上一份有效目录（含 reasoning），不得塌缩为无 reasoning 的磁盘镜像（契约 v1.1 §5.2）',
        MOCK_MODEL + ' reasoning.efforts=3',
        '实际 efforts=' + effortsAfter + '；' + MOCK_MODEL + '=' + briefStr(glmAfter));
      assertEqual(refreshed.body && refreshed.body.current && refreshed.body.current.reasoningEffort, 'high',
        'A12 强制刷新失败时 current.reasoningEffort 必须仍来自缓存目录');
      return 'FAIL=1 接缝生效；FAIL_AFTER=1：暖缓存 3 档 → ?refresh=1 仍 3 档 + current.reasoningEffort=high';
    } finally {
      await srv.stop();
    }
  });

  if (_browserPromise) {
    try { const b = await _browserPromise; await b.close(); } catch { /* 未创建或已关闭 */ }
  }
  const { failCount, degradedCount } = runner.report();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[REASONING SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
