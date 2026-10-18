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
  launchMock, readRpcLog, redact, request, requireSeam, seedSession, skip, sse, tempDir,
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
