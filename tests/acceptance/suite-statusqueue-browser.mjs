/**
 * Q20 Wave 2026-10-19 验收套件 STATUSQUEUE-BROWSER（浏览器真实链路 A5/A6/A7）
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-10-19.md
 *   A5（§C-3）列表快照含 pendingInteraction:'question' → 会话列表行渲染黄 `?`（.wait-dot），非蓝 ●（.run-dot）
 *   A6（§C-1）排队槽存在 + 收到匹配 prompt-claimed → #queue-dock 隐藏且槽清除；不追加重复用户气泡；
 *             历史已含该文本时切走再切回不得复活停靠条
 *   A7（§C-1/C-4 对抗）prompt-claimed 空文本/畸形 JSON/其它会话文本：不抛异常、Console Error=0、当前槽不被误清
 *   三例均要求 Console Error = 0，A5 另需截图落盘 tests/acceptance/artifacts/
 *
 * 运行：node tests/acceptance/suite-statusqueue-browser.mjs
 * 环境不具备（playwright-core 缺失 / chromium 无法启动）→ 显式 SKIP（[RED DEGRADED: ...]，
 * 不计 PASS/FAIL，套件退出码 3，绝不伪装成绿）。环境具备而断言不成立 → FAIL，退出码 1。
 *
 * 注入手段（契约允许且推荐）：page.route 拦截 /api/sessions 响应改写行；拦截并挂起
 * /api/session/attach，在需要的时刻注入 SSE 帧（prompt-claimed）。绝不触碰真实宿主 / 真实 LLM。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_DIR, assertEqual, assertOk, cleanupTempDirs, createRunner, createWorkspace,
  fail, launchMock, redact, seedSession, skip, tempDir, waitFor,
} from './lib/harness.mjs';

const runner = createRunner('STATUSQUEUE-BROWSER');

const SID_A5 = 'session-acc-sq-a5-wait';
const SID_A6 = 'session-acc-sq-a6-queue';
const SID_A6_OTHER = 'session-acc-sq-a6-other';
const SID_A7 = 'session-acc-sq-a7-adversarial';
const SID_A7_OTHER = 'session-acc-sq-a7-other';
const SID_A8 = 'session-acc-sq-a8-stale-wait';
const SID_A9 = 'session-acc-sq-a9-dup-prompt';
const SID_A9_OTHER = 'session-acc-sq-a9-other';
const SID_A10 = 'session-acc-sq-a10-replay-gate';
const SID_A11 = 'session-acc-sq-a11-stream-poll';

const TEXT_A6 = 'A6 排队消息已被上游认领的回归文本';
const TEXT_A6_OTHER = 'A6 另一个会话的历史文本';
const TEXT_A7 = 'A7 对抗守卫的当前排队文本';
const TEXT_A7_OTHER = 'A7 其它会话的文本，不得误清当前槽';
const TEXT_A9 = 'A9 与旧轮次完全相同的排队文本';
const TEXT_A9_OTHER = 'A9 另一个会话的历史文本';
const TEXT_A10 = 'A10 回放门控的排队文本';
const TEXT_A11_SEND = 'A11 流式提问：请分段输出';
const TEXT_A11_QUEUE = 'A11 流式期间追发的排队消息';

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

let _browserPromise = null;

/** 取浏览器句柄（懒启动 + 多候选回退）；环境不具备时 skip()，绝不记 PASS。 */
function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const chromium = await loadPlaywright();
      if (!chromium) skip('playwright-core 不可用（import 失败）：无法执行真实浏览器链路');
      const browser = await launchBrowser(chromium);
      if (!browser) skip('chromium 无法启动（所有候选均失败）：无法执行真实浏览器链路');
      return browser;
    })();
  }
  return _browserPromise;
}

// ─────────────────────────── 注入工具（page.route） ───────────────────────────

/** 改写 /api/sessions 响应：把 id===sid 的行合并 overrideRow（契约 A5 行快照注入）。 */
async function overrideSessionsRow(page, sid, overrideRow) {
  await page.route(/\/api\/sessions\?/, async (route) => {
    try {
      const response = await route.fetch();
      const raw = await response.text();
      let rows = null;
      try { rows = JSON.parse(raw); } catch { rows = null; }
      const patched = Array.isArray(rows)
        ? rows.map((r) => ((r && r.id === sid) ? Object.assign({}, r, overrideRow) : r))
        : rows;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(patched) });
    } catch (err) {
      console.log('  (sessions 注入失败: ' + redact(err.message) + ')');
      try { await route.continue(); } catch { /* 页面已关闭 */ }
    }
  });
}

/** 挂起（不响应）/api/session/attach，供后续按需注入 SSE 帧（模拟上游推送）。 */
async function holdAttach(page) {
  const held = [];
  await page.route(/\/api\/session\/attach\?/, async (route) => {
    held.push(route); // 故意不 fulfill/continue：保持真实 SSE 长连的“暂无数据”形态
  });
  return {
    held,
    /** 等待至少 n 个 attach 请求被挂起。 */
    async waitHeld(n = 1) {
      await waitFor(() => held.length >= n, { timeoutMs: 20000, label: 'attach 请求出现（第 ' + n + ' 个）' });
    },
    /** 用给定 SSE 帧响应最近一个挂起的 attach（帧注入点）。 */
    async inject(frames) {
      if (!held.length) fail('注入 prompt-claimed 前置条件', '已挂起 ≥1 个 /api/session/attach 请求', '0 个');
      const route = held[held.length - 1];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: frames,
      });
    },
  };
}

/** 构造一帧 SSE；payload 为对象时 JSON 序列化，字符串按原样（用于畸形 JSON 注入）。 */
function sseFrame(event, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return 'event: ' + event + '\ndata: ' + data + '\n\n';
}

// ─────────────────────────── 页面夹具 ───────────────────────────

/** 拉起隔离 mock 实例（running 接缝指定运行中会话）+ 工作区。 */
async function startFixture(runningSids) {
  const wsRoot = tempDir('q20-acc-sq-');
  const srv = await launchMock({ running: runningSids, workspaceRoot: wsRoot });
  const cwd = await createWorkspace(srv.base, 'ws-sq');
  return { srv, cwd };
}

/** 打开页面并等待 bootstrap 完成；routeSetup 会在 goto 之前完成拦截器安装。 */
async function openApp(browser, srv, cwd, sid, routeSetup, extraInit) {
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
  if (extraInit && extraInit.fn) await context.addInitScript(extraInit.fn, extraInit.arg || null);
  if (routeSetup) await routeSetup(page);
  const resp = await page.goto(srv.base + '/', { waitUntil: 'load', timeout: 30000 });
  assertOk(resp && resp.status() === 200, 'STATUSQUEUE 页面 HTTP 状态', 200, resp ? resp.status() : '(no response)');
  try {
    await page.waitForFunction(() => {
      const sel = document.getElementById('ws-select');
      return !!sel && sel.options.length > 0;
    }, null, { timeout: 20000 });
  } catch {
    fail('STATUSQUEUE bootstrap 未完成（20s 内 #ws-select 无工作区选项）', '#ws-select 选项数 ≥ 1',
      await page.evaluate(() => {
        const sel = document.getElementById('ws-select');
        return 'options=' + (sel ? sel.options.length : 'no-element');
      }));
  }
  return { context, page, errors };
}

/** 通过真实 UI（W 面板 → 工作区行 → 会话行）选中指定 sid 的会话。 */
async function ensureWsPanel(page) {
  const open = await page.evaluate(() => {
    const o = document.getElementById('ws-overlay');
    return !!o && o.style.display !== 'none';
  });
  if (!open) await page.keyboard.press('w');
  try {
    await page.waitForSelector('#ws-tree .tree-ws', { state: 'visible', timeout: 15000 });
  } catch {
    fail('前置条件：工作区面板（按 W）未打开', '#ws-tree .tree-ws 可见',
      await page.evaluate(() => {
        const o = document.getElementById('ws-overlay');
        return 'ws-overlay.display=' + (o ? o.style.display : '(missing)');
      }));
  }
}

async function selectSessionBySid(page, sid) {
  await ensureWsPanel(page);
  await page.click('#ws-tree .tree-ws');
  await page.waitForSelector('#sess-tree .tree-sess', { state: 'visible', timeout: 20000 });
  const total = await page.evaluate(() => document.querySelectorAll('#sess-tree .tree-sess').length);
  for (let i = 0; i < total; i += 1) {
    await ensureWsPanel(page);
    await page.click('#ws-tree .tree-ws');
    await page.waitForSelector('#sess-tree .tree-sess', { state: 'visible', timeout: 15000 });
    await page.click('#sess-tree .tree-sess >> nth=' + i);
    let got = '';
    try {
      await page.waitForFunction((want) => typeof getSid === 'function' && getSid() === want, sid, { timeout: 4000 });
      got = sid;
    } catch {
      got = await page.evaluate(() => { try { return getSid(); } catch (e) { return '(getSid 不可用)'; } });
    }
    if (got === sid) return;
  }
  fail('前置条件：通过真实 UI 选中目标会话失败', 'getSid() === ' + sid,
    '遍历 ' + total + ' 行均未命中; 末次 getSid()=' + await page.evaluate(() => {
      try { return getSid(); } catch (e) { return '(getSid 不可用)'; }
    }));
}

/** 会话列表面板内定位一行并读取状态点事实（A5）。 */
function readSessRow(page, marker) {
  return page.evaluate((mk) => {
    const rows = document.querySelectorAll('#sess-tree .tree-sess');
    const out = { count: rows.length, found: false, text: '', hasWait: false, hasRun: false, hasStop: false, hasErr: false, dotText: '' };
    for (let i = 0; i < rows.length; i += 1) {
      const t = rows[i].textContent || '';
      if (t.indexOf(mk) >= 0) {
        out.found = true;
        out.text = t.slice(0, 60);
        const w = rows[i].querySelector('.wait-dot');
        const r = rows[i].querySelector('.run-dot');
        out.hasWait = !!w;
        out.hasRun = !!r;
        out.hasStop = !!rows[i].querySelector('.stop-dot');
        out.hasErr = !!rows[i].querySelector('.err-dot');
        out.dotText = w ? (w.textContent || '') : (r ? (r.textContent || '') : '');
        break;
      }
    }
    return out;
  }, marker);
}

/** 统计聊天区包含指定文本的用户气泡数量（window 化渲染只算已渲染节点）。 */
function countUserBubbles(page, text) {
  return page.evaluate((t) => {
    const nodes = document.querySelectorAll('#chat-container .msg-user');
    let n = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      if ((nodes[i].textContent || '').indexOf(t) >= 0) n += 1;
    }
    return n;
  }, text);
}

function readDock(page) {
  return page.evaluate(() => {
    const d = document.getElementById('queue-dock');
    return {
      exists: !!d,
      display: d ? d.style.display : null,
      text: d ? (d.textContent || '') : '',
      slot: (typeof queuedPromptStore !== 'undefined' && typeof getSid === 'function')
        ? !!queuedPromptStore[getSid()] : null,
      pending: (typeof pendingQueuedItem !== 'undefined') ? (pendingQueuedItem ? pendingQueuedItem.prompt : null) : null,
    };
  });
}

/** 等待聊天区出现包含指定文本的用户气泡（历史加载完成的可观测信号）。 */
async function waitChatBubble(page, text, timeoutMs = 20000) {
  try {
    await page.waitForFunction((t) => {
      const nodes = document.querySelectorAll('#chat-container .msg-user');
      for (let i = 0; i < nodes.length; i += 1) {
        if ((nodes[i].textContent || '').indexOf(t) >= 0) return true;
      }
      return false;
    }, text, { timeout: timeoutMs });
  } catch {
    fail('前置条件：聊天区未渲染历史用户气泡', '含文本「' + text + '」的 .msg-user ≥ 1',
      await page.evaluate(() => (document.getElementById('chat-container') || {}).textContent || '(no chat)'));
  }
}

/** 通过真实 UI 发一条运行中追发（默认 queue 模式：只停靠 #queue-dock，不进入消息流）。 */
async function sendQueuedPrompt(page, text) {
  const composerOpen = await page.evaluate(() => {
    const p = document.getElementById('composer-panel');
    return !!p && p.style.display === 'block';
  });
  if (!composerOpen) await page.click('#composer-trigger-btn');
  await page.fill('#input-box', text);
  await page.press('#input-box', 'Enter');
  try {
    await page.waitForFunction((t) => {
      const d = document.getElementById('queue-dock');
      return !!d && d.style.display === 'block' && (d.textContent || '').indexOf(t) >= 0;
    }, text, { timeout: 15000 });
  } catch {
    fail('前置条件：queue 模式追发后 #queue-dock 未出现', '#queue-dock display=block 且含「' + text + '」',
      JSON.stringify(await readDock(page)));
  }
}

/** 轮询等待 #queue-dock 变为隐藏；超时返回 actual（交给断言给出「期望 vs 实际」）。 */
async function waitDockHidden(page, timeoutMs = 3000) {
  try {
    await page.waitForFunction(() => {
      const d = document.getElementById('queue-dock');
      return !!d && d.style.display === 'none';
    }, null, { timeout: timeoutMs });
  } catch { /* 落到下面的 readDock 报实际值 */ }
  return readDock(page);
}

/**
 * 构造「僵尸排队槽」：会话仍登记为运行态、槽仍存在（D-1 缺陷现场）。
 * 仅写入前端内存态（不触达生产代码），用于验证 restoreQueuedPrompt 的「历史已消费」守卫。
 */
async function injectStaleQueueSlot(page, sid, text) {
  return page.evaluate((o) => {
    const cwd = getCwd();
    queuedPromptStore[o.sid] = { sid: o.sid, prompt: o.text, itemId: 'stale-item', mode: 'queue' };
    const list = (typeof sessCache !== 'undefined' && sessCache[cwd]) ? sessCache[cwd] : [];
    let rowSet = false;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === o.sid) {
        list[i].isRunning = true;
        list[i].state = 'running';
        rowSet = true;
        break;
      }
    }
    return { rowSet: rowSet, slot: !!queuedPromptStore[o.sid] };
  }, { sid: sid, text: text });
}

/** /api/sessions 行注入（可变 poison：首屏注入 pendingInteraction，随后停止注入以模拟“快照变陈旧”）。 */
async function overrideSessionsRowDynamic(page, sid, buildOverride) {
  await page.route(/\/api\/sessions\?/, async (route) => {
    try {
      const response = await route.fetch();
      const raw = await response.text();
      let rows = null;
      try { rows = JSON.parse(raw); } catch { rows = null; }
      const patched = Array.isArray(rows)
        ? rows.map((r) => {
          if (!r || r.id !== sid) return r;
          const ov = buildOverride();
          return ov ? Object.assign({}, r, ov) : r;
        })
        : rows;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(patched) });
    } catch (err) {
      console.log('  (sessions 注入失败: ' + redact(err.message) + ')');
      try { await route.continue(); } catch { /* 页面已关闭 */ }
    }
  });
}

/** /api/sessions/status 固定回包：所有被询问的 id 一律 running（无 pendingInteraction 字段）。 */
async function overrideStatusRunning(page) {
  await page.route(/\/api\/sessions\/status\?/, async (route) => {
    try {
      const url = new URL(route.request().url());
      const ids = String(url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
      const states = {};
      for (let i = 0; i < ids.length; i += 1) {
        states[ids[i]] = { isRunning: true, state: 'running', known: true };
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, at: Date.now(), states: states }),
      });
    } catch {
      try { await route.continue(); } catch { /* 页面已关闭 */ }
    }
  });
}

/** 等待某个点（.wait-dot / .run-dot）出现；返回是否出现（不抛异常，由断言给期望/实际）。 */
async function waitRowDot(page, selector, marker, timeoutMs) {
  try {
    await page.waitForFunction((o) => {
      const rows = document.querySelectorAll('#sess-tree .tree-sess');
      for (let i = 0; i < rows.length; i += 1) {
        if ((rows[i].textContent || '').indexOf(o.mk) >= 0) return !!rows[i].querySelector(o.sel);
      }
      return false;
    }, { sel: selector, mk: marker }, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** 等待 attach XHR 收口（readyState 4 已释放），作为“注入帧已被处理”的可观测信号。 */
async function waitAttachDrained(page, timeoutMs = 8000) {
  await waitFor(() => page.evaluate(() => typeof attachXhr !== 'undefined' && attachXhr === null),
    { timeoutMs: timeoutMs, label: 'attach 流收口（帧处理完成）' });
}

/** 触发一次重连挂载（真实 UI 通道：window focus → checkAndReattach）。 */
async function triggerReattach(page) {
  await page.evaluate(() => {
    sessState.running = true;
    try { window.dispatchEvent(new Event('focus')); } catch (e) { window.dispatchEvent(document.createEvent('Event')); }
  });
}

/**
 * 页面级 XHR 测试桩（仅测试侧，绝不改生产码）：
 * 让 POST /api/chat/stream 以真实 SSE 形态分段放行（readyState 3 增量 → readyState 4 收口），
 * 从而能在「流式在途」期间跨越 5s 兜底探测窗口做非破坏性观测。
 * 同时计数 /api/history 请求（证明 F5/R1 兜底探测确实在本窗口内跑过）。
 */
function streamStubInit(cfgInPage) {
    var NativeXHR = window.XMLHttpRequest;
    var nativeOpen = NativeXHR.prototype.open;
    window.__a11 = { histFetches: 0, frames: 0, removed: 0, minChildren: 99, started: false };

    NativeXHR.prototype.open = function (method, url) {
      var u = String(url || '');
      if (u.indexOf('/api/history') >= 0) window.__a11.histFetches += 1;
      if (method === 'POST' && u.indexOf('/api/chat/stream') >= 0) {
        var self = this;
        var st = { rs: 1, status: 0, text: '', timers: [] };
        this.__a11stub = st;
        try {
          Object.defineProperty(this, 'readyState', { configurable: true, get: function () { return st.rs; } });
          Object.defineProperty(this, 'status', { configurable: true, get: function () { return st.status; } });
          Object.defineProperty(this, 'responseText', { configurable: true, get: function () { return st.text; } });
          Object.defineProperty(this, 'response', { configurable: true, get: function () { return st.text; } });
          Object.defineProperty(this, 'statusText', { configurable: true, get: function () { return 'OK'; } });
        } catch (eDef) { /* 老引擎忽略 */ }
        this.setRequestHeader = function () {};
        this.getResponseHeader = function () { return 'text/event-stream'; };
        this.getAllResponseHeaders = function () { return 'content-type: text/event-stream\r\n'; };
        this.abort = function () {
          try { for (var ai = 0; ai < st.timers.length; ai++) clearTimeout(st.timers[ai]); } catch (eAb) {}
          st.timers = [];
          this.__aborted = true;
          st.rs = 4;
        };
        this.send = function () {
          st.status = 200;
          st.rs = 2;
          if (self.onreadystatechange) { try { self.onreadystatechange(); } catch (e2) {} }
          st.rs = 3;
          window.__a11.started = true;
          var steps = cfgInPage.steps;
          for (var si = 0; si < steps.length; si += 1) {
            (function (step) {
              st.timers.push(setTimeout(function () {
                if (self.__aborted) return;
                try {
                  st.text += step.frame;
                  if (step.terminal) st.rs = 4; else st.rs = 3;
                  if (self.onreadystatechange) self.onreadystatechange();
                  window.__a11.frames += 1;
                } catch (e3) { /* 帧回调异常不得中断时间线 */ }
              }, step.delay));
            })(steps[si]);
          }
        };
        return;
      }
    return nativeOpen.apply(this, arguments);
  };
}

/** 记录流式在途节点身份 + chatContainer 破坏性变更（清空/替换）。 */
async function armStreamWatcher(page) {
  return page.evaluate(() => {
    var nodes = document.querySelectorAll('#chat-container .msg-assistant');
    window.__a11Live = nodes.length ? nodes[nodes.length - 1] : null;
    window.__a11Text0 = window.__a11Live ? (window.__a11Live.textContent || '') : '';
    window.__a11.frames0 = window.__a11.frames;
    window.__a11.removed = 0;
    var cc = document.getElementById('chat-container');
    window.__a11.minChildren = cc ? cc.childElementCount : 0;
    window.__a11.ccText0 = cc ? (cc.textContent || '').length : 0;
    window.__a11Obs = new MutationObserver(function (muts) {
      if (!cc) return;
      if (cc.childElementCount < window.__a11.minChildren) window.__a11.minChildren = cc.childElementCount;
      for (var i = 0; i < muts.length; i += 1) {
        var m = muts[i];
        if (m.type === 'childList' && m.removedNodes && m.removedNodes.length) {
          if (window.__a11Live && !window.__a11Live.isConnected) window.__a11.removed += m.removedNodes.length;
        }
      }
    });
    window.__a11Obs.observe(cc, { childList: true, subtree: true });
    return { len0: window.__a11Text0.length, ccText0: window.__a11.ccText0, frames0: window.__a11.frames0 };
  });
}

// ─────────────────────────── 用例 ───────────────────────────

async function main() {
  console.log('# Q20 验收套件 STATUSQUEUE-BROWSER (A5/A6/A7 真实页面) — 时间: ' + new Date().toISOString());

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  // ── A5：pendingInteraction:'question' 行渲染黄 ?（wait-dot），非蓝 ●（run-dot）──
  await runner.run('A5 列表行 pendingInteraction=question 渲染 wait-dot（?）且无 run-dot + Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A5]);
    let context = null;
    try {
      // 真实落盘会话（/api/sessions 的行真源），再由 route 注入 pendingInteraction 快照
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A5, prompt: 'A5 等待作答会话种子' });
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A5, async (page) => {
        await overrideSessionsRow(page, SID_A5, {
          id: SID_A5, title: 'wait', state: 'running', isRunning: true, pendingInteraction: 'question',
        });
      });
      context = app.context;
      const page = app.page;
      await page.keyboard.press('w');
      await page.waitForSelector('#ws-tree .tree-ws', { timeout: 15000 });
      await page.click('#ws-tree .tree-ws');
      try {
        await page.waitForFunction(() => document.querySelectorAll('#sess-tree .tree-sess').length > 0, null, { timeout: 20000 });
      } catch {
        fail('A5 会话列表必须渲染出被注入的 waiting 行（20s 内无任何会话行）', '≥1 行 .tree-sess 且首字符为 .wait-dot',
          await page.evaluate(() => {
            const el = document.getElementById('sess-tree');
            return el ? (el.textContent || '').slice(0, 200) : '(no #sess-tree)';
          }));
      }
      const info = await readSessRow(page, 'wait');
      const shot = path.join(ARTIFACT_DIR, 'a5-pending-interaction.png');
      await page.screenshot({ path: shot });
      assertOk(info.found, 'A5 会话列表必须存在标题为 wait 的行（/api/sessions 注入行）', '存在含「wait」的 .tree-sess', JSON.stringify(info));
      assertOk(info.hasWait, 'A5 该行必须渲染黄色等待点 .wait-dot（pendingInteraction 优先于 running）', '含 .wait-dot', JSON.stringify(info));
      assertEqual(info.hasRun, false, 'A5 该行不得残留蓝色运行点 .run-dot');
      assertEqual(info.dotText, '?', 'A5 等待点文本必须为 ?');
      assertEqual(app.errors.length, 0, 'A5 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shot), 'A5 截图必须落盘', redact(shot), '(missing)');
      return 'row=' + info.text + ' consoleErrors=0 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A6：排队槽 + 匹配 prompt-claimed → 清槽、不重复气泡、切回不复活 ──
  await runner.run('A6 prompt-claimed 匹配清槽 + 不重复用户气泡 + 历史已含文本切回不复活 + Console Error=0', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A6]);
    let context = null;
    try {
      // 历史真源：当前会话历史已含同一文本（模拟上游已把追发写入转录），另一会话用于切走/切回
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A6, prompt: TEXT_A6 });
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A6_OTHER, prompt: TEXT_A6_OTHER });

      let attach = null;
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A6, async (page) => {
        attach = await holdAttach(page);
      });
      context = app.context;
      const page = app.page;

      await selectSessionBySid(page, SID_A6);
      await waitChatBubble(page, TEXT_A6);
      await attach.waitHeld(1);

      // 运行中追发（默认 queue 模式）→ 仅停靠 #queue-dock，不进入消息流
      await sendQueuedPrompt(page, TEXT_A6);
      const beforeShot = path.join(ARTIFACT_DIR, 'a6-queue-dock-before.png');
      await page.screenshot({ path: beforeShot });

      // 注入上游认领信号：一帧 prompt-claimed（文本与槽内 prompt 归一化相等）
      // 真实 attach 流形态：回放 burst 结束（replay_end）之后的实时帧才可清槽
      await attach.inject(sseFrame('replay_end', { total: 0 }) + sseFrame('prompt-claimed', { text: TEXT_A6 }));

      const after = await waitDockHidden(page);
      const bubblesAfter = await countUserBubbles(page, TEXT_A6);
      const afterShot = path.join(ARTIFACT_DIR, 'a6-queue-claimed.png');
      await page.screenshot({ path: afterShot });

      // 僵尸槽守卫（E1）：先切走，再登记「运行中 + 槽仍在」的僵尸现场，切回时不得复活停靠条
      await selectSessionBySid(page, SID_A6_OTHER);
      const stale = await injectStaleQueueSlot(page, SID_A6, TEXT_A6);
      await selectSessionBySid(page, SID_A6);
      await waitChatBubble(page, TEXT_A6);
      const back = await readDock(page);
      const bubblesBack = await countUserBubbles(page, TEXT_A6);

      console.log('  (A6 观测: ' + JSON.stringify({
        僵尸槽登记: stale.slot, claimed后停靠条: after.display, claimed后槽存在: after.slot,
        claimed后气泡数: bubblesAfter, 切回后停靠条: back.display, 切回后气泡数: bubblesBack,
      }) + ')');
      assertEqual(stale.rowSet, true, 'A6 前置条件：僵尸现场必须登记成功（会话行 isRunning=true 且槽存在）');
      assertEqual(after.display, 'none', 'A6 收到匹配 prompt-claimed 后 #queue-dock 必须隐藏（认领即清槽）');
      assertEqual(after.slot, false, 'A6 认领后当前会话排队槽必须已清除（queuedPromptStore[getSid()] 不存在）');
      assertEqual(bubblesAfter, 1, 'A6 prompt-claimed 不得追加重复用户气泡（历史同步负责渲染，只应出现 1 次）');
      assertEqual(back.display, 'none', 'A6 历史已含该文本时切走再切回不得复活停靠条（#queue-dock display）');
      assertEqual(bubblesBack, 1, 'A6 切回后该文本用户气泡仍只应出现 1 次');
      assertEqual(app.errors.length, 0, 'A6 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(afterShot), 'A6 截图必须落盘', redact(afterShot), '(missing)');
      return 'bubbles=' + bubblesAfter + ' consoleErrors=0 截图=' + path.basename(afterShot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A7：空文本 / 畸形 JSON / 其它会话文本的 prompt-claimed 不得误清当前槽 ──
  await runner.run('A7 空文本+畸形 JSON+跨会话 prompt-claimed：不抛异常、Console Error=0、当前槽不被误清', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A7]);
    let context = null;
    try {
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A7, prompt: TEXT_A7 });
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A7_OTHER, prompt: TEXT_A7_OTHER });

      let attach = null;
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A7, async (page) => {
        attach = await holdAttach(page);
      });
      context = app.context;
      const page = app.page;

      await selectSessionBySid(page, SID_A7);
      await waitChatBubble(page, TEXT_A7);
      await attach.waitHeld(1);
      await sendQueuedPrompt(page, TEXT_A7);
      const before = await readDock(page);

      // 三帧对抗输入：空文本 / 畸形 JSON / 其它会话文本
      await attach.inject(
        sseFrame('replay_end', { total: 0 })
          + sseFrame('prompt-claimed', { text: '' })
          + sseFrame('prompt-claimed', '{this is not valid json}')
          + sseFrame('prompt-claimed', { text: TEXT_A7_OTHER }),
      );
      // 等待事件处理落定：仅观察，不盲 sleep（轮询到 attach 已收口或超时）
      await waitFor(() => page.evaluate(() => {
        const d = document.getElementById('queue-dock');
        return !!d && typeof renderQueueDock === 'function';
      }), { timeoutMs: 3000, label: '页面在畸形 claimed 后仍可响应（renderQueueDock 可用）' });
      const after = await readDock(page);
      const shot = path.join(ARTIFACT_DIR, 'a7-claimed-adversarial.png');
      await page.screenshot({ path: shot });

      assertEqual(app.errors.length, 0, 'A7 畸形/空/跨会话 prompt-claimed 不得产生 Console Error');
      assertEqual(after.display, 'block', 'A7 未匹配的 claimed 不得误清当前会话排队槽（#queue-dock 仍显示）');
      assertOk(after.text.indexOf(TEXT_A7) >= 0, 'A7 停靠条内容必须仍是当前会话的排队文本', '含「' + TEXT_A7 + '」', after.text);
      assertEqual(after.slot, true, 'A7 当前会话排队槽必须保留（不得被畸形/跨会话 claimed 清掉）');
      assertEqual(before.display, 'block', 'A7 前置条件：注入前 #queue-dock 必须已显示');
      return 'consoleErrors=0 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A8（L3-A 回归）：陈旧 waiting 必须被 /api/sessions/status 补丁清除 ──
  await runner.run('A8 陈旧 pendingInteraction 被 running 状态补丁清除（wait-dot → run-dot，不发散为停止键）+ Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A8]);
    let context = null;
    try {
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A8, prompt: 'A8 陈旧等待态会话种子' });
      let poison = true; // 首屏快照含 pendingInteraction；随后“变陈旧”（不再注入）
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A8, async (page) => {
        await overrideSessionsRowDynamic(page, SID_A8, () => (poison
          ? { id: SID_A8, title: 'wait', state: 'running', isRunning: true, pendingInteraction: 'question' }
          : { id: SID_A8, title: 'wait', state: 'running', isRunning: true }));
        await overrideStatusRunning(page); // 权威补丁：running 且无 pendingInteraction
      });
      context = app.context;
      const page = app.page;

      await page.keyboard.press('w');
      await page.waitForSelector('#ws-tree .tree-ws', { timeout: 15000 });
      await page.click('#ws-tree .tree-ws');
      const initialWait = await waitRowDot(page, '.wait-dot', 'wait', 15000);
      const initial = await readSessRow(page, 'wait');
      // 关键隔离：快照持续保持“陈旧”（每次 /api/sessions 仍带 pendingInteraction），
      // 因此行变为 run-dot 只可能来自 /api/sessions/status 状态补丁，而非列表重取换行。
      const cleared = await waitRowDot(page, '.run-dot', 'wait', 9000);
      poison = false; // 已观测到收敛后放开注入，避免下一轮重取再次毒化导致末态抖动
      const final = await readSessRow(page, 'wait');
      const shot = path.join(ARTIFACT_DIR, 'a8-stale-waiting-cleared.png');
      await page.screenshot({ path: shot });

      console.log('  (A8 观测: ' + JSON.stringify({
        首屏waitDot: initial.hasWait, 补丁后runDot: final.hasRun, 补丁后waitDot: final.hasWait, 补丁后stopDot: final.hasStop,
      }) + ')');
      assertEqual(initial.hasWait, true, 'A8 前置（C-3 契约）：注入 pendingInteraction 行必须首屏渲染 wait-dot');
      assertEqual(cleared, true, 'A8 陈旧 waiting 必须被 running 状态补丁清除（row 出现 .run-dot）');
      assertEqual(final.hasRun, true, 'A8 状态补丁后该行必须渲染蓝 ●（.run-dot）');
      assertEqual(final.hasWait, false, 'A8 状态补丁后不得残留 .wait-dot（陈旧 pendingInteraction 必须被清除）');
      assertEqual(final.hasStop, false, 'A8 状态补丁后不得发散为停止键（.stop-dot）');
      assertEqual(final.hasErr, false, 'A8 状态补丁后不得发散为错误键（.err-dot）');
      assertEqual(app.errors.length, 0, 'A8 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shot), 'A8 截图必须落盘', redact(shot), '(missing)');
      return 'runDot=' + final.hasRun + ' 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A9（L3-A 回归）：历史含同文本旧轮次不得误判“已消费” ──
  await runner.run('A9 历史旧轮次同文本不得误判已消费（宿主未认领时排队槽必须保留）+ Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A9]);
    let context = null;
    try {
      // 旧轮次历史文本 X 与稍后登记的排队槽文本完全相同；宿主从未认领（attach 全程挂起，无 claimed 帧）
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A9, prompt: TEXT_A9 });
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A9_OTHER, prompt: TEXT_A9_OTHER });

      let attach = null;
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A9, async (page) => {
        attach = await holdAttach(page);
      });
      context = app.context;
      const page = app.page;

      await selectSessionBySid(page, SID_A9);
      await waitChatBubble(page, TEXT_A9);
      await attach.waitHeld(1);
      await sendQueuedPrompt(page, TEXT_A9);
      const queued = await readDock(page);

      await selectSessionBySid(page, SID_A9_OTHER);
      await selectSessionBySid(page, SID_A9);
      await waitChatBubble(page, TEXT_A9);
      const back = await readDock(page);
      const bubbles = await countUserBubbles(page, TEXT_A9);
      const shot = path.join(ARTIFACT_DIR, 'a9-duplicate-prompt-slot.png');
      await page.screenshot({ path: shot });

      console.log('  (A9 观测: ' + JSON.stringify({
        追发后停靠条: queued.display, 切回后停靠条: back.display, 切回后槽存在: back.slot, 历史气泡数: bubbles,
      }) + ')');
      assertEqual(queued.display, 'block', 'A9 前置条件：queue 追发后 #queue-dock 必须可见');
      assertEqual(back.display, 'block', 'A9 历史含旧轮次同文本不得误判已消费：切回后 #queue-dock 必须仍显示');
      assertOk(back.text.indexOf(TEXT_A9) >= 0, 'A9 停靠条必须仍显示排队文本', '含「' + TEXT_A9 + '」', back.text);
      assertEqual(back.slot, true, 'A9 排队槽必须保留（不得被历史同文本误清）');
      assertEqual(bubbles, 1, 'A9 历史用户气泡只应 1 条（不得重复追加）');
      assertEqual(app.errors.length, 0, 'A9 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shot), 'A9 截图必须落盘', redact(shot), '(missing)');
      return '槽保留=' + back.slot + ' 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A10（L3-A 回归）：replay_end 之前的旧 claimed 帧不得清槽 ──
  await runner.run('A10 重放门控：replay_end 之前的 prompt-claimed 不得清槽，之后的实时帧才清槽 + Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([SID_A10]);
    let context = null;
    try {
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A10, prompt: 'A10 历史种子轮次' });

      let attach = null;
      const app = await openApp(browser, fx.srv, fx.cwd, SID_A10, async (page) => {
        attach = await holdAttach(page);
      });
      context = app.context;
      const page = app.page;

      await selectSessionBySid(page, SID_A10);
      await waitChatBubble(page, 'A10 历史种子轮次');
      await attach.waitHeld(1);
      await sendQueuedPrompt(page, TEXT_A10);
      const before = await readDock(page);

      // 第 1 段：回放 burst 内（replay_end 之前）注入与槽匹配的旧 claimed 帧
      await attach.inject(sseFrame('prompt-claimed', { text: TEXT_A10 }) + sseFrame('replay_end', { total: 0 }));
      await waitAttachDrained(page);
      const gated = await readDock(page);
      const shot = path.join(ARTIFACT_DIR, 'a10-replay-gate.png');
      await page.screenshot({ path: shot });

      // 第 2 段：重连挂载后，replay_end 之后的实时 claimed 帧（此时才允许清槽）
      await triggerReattach(page);
      await attach.waitHeld(2);
      await attach.inject(sseFrame('replay_end', { total: 0 }) + sseFrame('prompt-claimed', { text: TEXT_A10 }));
      await waitAttachDrained(page);
      const live = await readDock(page);

      console.log('  (A10 观测: ' + JSON.stringify({
        注入前停靠条: before.display, replay_end前claimed后停靠条: gated.display, replay_end前claimed后槽存在: gated.slot,
        实时claimed后停靠条: live.display,
      }) + ')');
      assertEqual(before.display, 'block', 'A10 前置条件：queue 追发后 #queue-dock 必须可见');
      assertEqual(gated.display, 'block', 'A10 replay_end 之前的旧 prompt-claimed 不得清槽（回放门控）');
      assertEqual(gated.slot, true, 'A10 回放阶段的旧 claimed 不得清掉排队槽');
      assertEqual(live.display, 'none', 'A10 replay_end 之后的实时 prompt-claimed 必须清槽（停靠条隐藏）');
      assertEqual(app.errors.length, 0, 'A10 浏览器 Console Error 数必须为 0');
      return 'gated=block live=' + live.display + ' 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A11（L3-A2 回归）：流式在途期间的 F5 兜底探测不得破坏在途回答 ──
  await runner.run('A11 流式在途跨 5s 兜底探测：回答节点不被清空/替换、delta 继续、气泡不重复、终态完整 + Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture([]); // 会话非运行态：走正常发送推流路径
    let context = null;
    try {
      await seedSession(fx.srv.base, { cwd: fx.cwd, sessionId: SID_A11, prompt: 'A11 历史种子轮次' });

      const tokens = [];
      for (let i = 0; i < 18; i += 1) tokens.push('A11段' + i + '；');
      const fullText = tokens.join('');
      const steps = [
        { delay: 100, frame: sseFrame('start', { sessionId: SID_A11, provider: 'ponyllm', model: 'glm-5.3-flash' }) },
        { delay: 160, frame: sseFrame('replay_end', { total: 0 }) },
      ];
      for (let i = 0; i < tokens.length; i += 1) {
        steps.push({ delay: 300 + i * 430, frame: sseFrame('delta', { text: tokens[i] }) });
      }
      steps.push({ delay: 8300, frame: sseFrame('done', { finalResponse: fullText }), terminal: true });

      const app = await openApp(browser, fx.srv, fx.cwd, SID_A11, async (page) => {
        // 追发回执桩：仅替换 POST /api/session/prompt 的 ok 回执（真实 UI 追发路径保持完整）
        await page.route(/\/api\/session\/prompt(\?|$)/, async (route) => {
          if (route.request().method() !== 'POST') { try { await route.continue(); } catch { /* 已关闭 */ } return; }
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, itemId: 'a11-item' }) });
        });
      }, { fn: streamStubInit, arg: { steps: steps } });
      context = app.context;
      const page = app.page;

      await selectSessionBySid(page, SID_A11);
      await waitChatBubble(page, 'A11 历史种子轮次');

      // 1) 正常发送 → 页面级 SSE 桩分段放行（真实 readyState 3 增量）
      const composerOpen = await page.evaluate(() => {
        const p = document.getElementById('composer-panel');
        return !!p && p.style.display === 'block';
      });
      if (!composerOpen) await page.click('#composer-trigger-btn');
      await page.fill('#input-box', TEXT_A11_SEND);
      await page.press('#input-box', 'Enter');
      await waitFor(() => page.evaluate(() => {
        const nodes = document.querySelectorAll('#chat-container .msg-assistant');
        return nodes.length > 0 && (nodes[nodes.length - 1].textContent || '').length > 0;
      }), { timeoutMs: 12000, label: '首个 delta 渲染出 assistant 气泡' });
      const armed = await armStreamWatcher(page);

      // 2) 流式在途期间真实 UI 追发 → 登记排队槽，触发 F5/R1 兜底探测定时器
      await sendQueuedPrompt(page, TEXT_A11_QUEUE);
      await page.evaluate(() => {
        window.__a11.regAt = Date.now();
        window.__a11.histBefore = window.__a11.histFetches;
        window.__a11.framesBefore = window.__a11.frames;
      });

      // 3) 越过 5s 兜底探测窗口（≥6.4s），全程流式在途
      await waitFor(() => page.evaluate(() => Date.now() - window.__a11.regAt >= 6400),
        { timeoutMs: 14000, intervalMs: 200, label: '越过 5s 兜底探测窗口（流式在途）' });
      const snap = await page.evaluate(() => {
        const nodes = document.querySelectorAll('#chat-container .msg-assistant');
        const last = nodes.length ? nodes[nodes.length - 1] : null;
        return {
          liveConnected: !!(window.__a11Live && window.__a11Live.isConnected),
          liveLen: window.__a11Live ? (window.__a11Live.textContent || '').length : -1,
          len0: window.__a11Text0.length,
          removed: window.__a11.removed,
          minChildren: window.__a11.minChildren,
          ccLen: (function () {
            const cc = document.getElementById('chat-container');
            return cc ? (cc.textContent || '').length : -1;
          })(),
          ccText0: window.__a11.ccText0,
          histDelta: window.__a11.histFetches - window.__a11.histBefore,
          framesDelta: window.__a11.frames - window.__a11.framesBefore,
          lastLen: last ? (last.textContent || '').length : -1,
          streaming: (typeof isStreaming !== 'undefined') ? !!isStreaming : null,
        };
      });
      const bubblesDuring = await countUserBubbles(page, TEXT_A11_SEND);
      const shotDuring = path.join(ARTIFACT_DIR, 'a11-stream-during-poll.png');
      await page.screenshot({ path: shotDuring });

      // 4) 放行 done（桩时间线终态），断言最终文本完整 + 停靠条收口
      await waitFor(() => page.evaluate(() => (typeof isStreaming !== 'undefined') && !isStreaming),
        { timeoutMs: 16000, intervalMs: 150, label: '流式终态（done 帧处理完成）' });
      const finalSnap = await page.evaluate(() => {
        const chat = document.getElementById('chat-container');
        const dock = document.getElementById('queue-dock');
        return { chatText: chat ? (chat.textContent || '') : '', dock: dock ? dock.style.display : null };
      });
      const bubblesFinal = await countUserBubbles(page, TEXT_A11_SEND);
      const missingTokens = tokens.filter((t) => finalSnap.chatText.indexOf(t) < 0);
      const shotDone = path.join(ARTIFACT_DIR, 'a11-stream-done.png');
      await page.screenshot({ path: shotDone });

      console.log('  (A11 观测: ' + JSON.stringify({
        流式在途: snap.streaming, 探测次数: snap.histDelta, 期间新增帧: snap.framesDelta,
        在途节点存活: snap.liveConnected, 被移除节点数: snap.removed, 容器最少子节点: snap.minChildren,
        文本长度: {'观测前': snap.ccText0, '观测点': snap.ccLen, '最终': finalSnap.chatText.length},
        在途气泡文本: {'观测前': snap.len0, '观测点': snap.liveLen},
        用户气泡数: {'期间': bubblesDuring, '终态': bubblesFinal}, 缺失片段数: missingTokens.length,
        终态停靠条: finalSnap.dock,
      }) + ')');

      assertEqual(snap.streaming, true, 'A11 前置条件：观测点必须仍处流式在途（跨 5s 窗口后才放行 done）');
      assertOk(snap.histDelta >= 1, 'A11 前置条件：兜底探测必须在本窗口内真实触发（GET /api/history 次数）', '≥ 1', snap.histDelta);
      assertEqual(snap.liveConnected, true, 'A11 兜底探测不得清空/替换在途回答节点（原 assistant 气泡必须仍在文档中）');
      assertEqual(snap.removed, 0, 'A11 MutationObserver 不得观测到在途回答节点被移除');
      assertOk(snap.framesDelta >= 8, 'A11 探测期间 delta 后续帧必须继续到达（回放不得中断推流）', '≥ 8', snap.framesDelta);
      assertOk(snap.ccLen > snap.ccText0, 'A11 在途回答文本必须继续增长（不得被历史快照整体替换）',
        '> ' + snap.ccText0, snap.ccLen);
      assertOk(snap.minChildren > 0, 'A11 #chat-container 不得被整体清空', '> 0', snap.minChildren);
      assertEqual(bubblesDuring, 1, 'A11 流式期间用户气泡不得重复');
      assertEqual(missingTokens.length, 0, 'A11 终态回答必须完整（18 个 delta 片段全部落屏）');
      assertEqual(bubblesFinal, 1, 'A11 终态用户气泡不得重复');
      assertEqual(finalSnap.dock, 'none', 'A11 终态停靠条必须收口隐藏（排队槽在 done 后失效）');
      assertEqual(app.errors.length, 0, 'A11 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shotDuring) && fs.existsSync(shotDone), 'A11 截图必须落盘',
        redact(shotDuring) + ' / ' + redact(shotDone), '(missing)');
      return '在途节点存活=' + snap.liveConnected + ' 期间帧=' + snap.framesDelta + ' 缺失片段=' + missingTokens.length;
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  if (_browserPromise) {
    try { const b = await _browserPromise; await b.close(); } catch { /* 未创建或已关闭 */ }
  }
  const { failCount, degradedCount } = runner.report();
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[STATUSQUEUE-BROWSER SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
