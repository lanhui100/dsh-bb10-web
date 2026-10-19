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

const TEXT_A6 = 'A6 排队消息已被上游认领的回归文本';
const TEXT_A6_OTHER = 'A6 另一个会话的历史文本';
const TEXT_A7 = 'A7 对抗守卫的当前排队文本';
const TEXT_A7_OTHER = 'A7 其它会话的文本，不得误清当前槽';

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
async function openApp(browser, srv, cwd, sid, routeSetup) {
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
    const out = { count: rows.length, found: false, text: '', hasWait: false, hasRun: false, dotText: '' };
    for (let i = 0; i < rows.length; i += 1) {
      const t = rows[i].textContent || '';
      if (t.indexOf(mk) >= 0) {
        out.found = true;
        out.text = t.slice(0, 60);
        const w = rows[i].querySelector('.wait-dot');
        const r = rows[i].querySelector('.run-dot');
        out.hasWait = !!w;
        out.hasRun = !!r;
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
      await attach.inject(sseFrame('prompt-claimed', { text: TEXT_A6 }));

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
        sseFrame('prompt-claimed', { text: '' })
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
