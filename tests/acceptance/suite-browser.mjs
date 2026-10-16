/**
 * Q20 Wave 2026-10-16 验收套件（浏览器真实链路 A9）：C/U 面板 + Console Error=0 + 截图
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约：.dev-team/contract-wave-2026-10-16.md §1.3 F-1…F-4 / §3 A9
 *   A9-C：C 面板「全工作区进行中」必须显示 live 镜像中 running 会话（终态不得残留）
 *   A9-U：U 面板有子智能体时必须非空
 *   两例均要求 Console Error = 0，并把关键界面截图落盘 tests/acceptance/artifacts/
 * 运行：node tests/acceptance/suite-browser.mjs
 * 环境不具备（playwright-core 缺失 / chromium 无法启动）→ 显式 SKIP（[RED DEGRADED: ...]，
 * 不计 PASS/FAIL，套件退出码 3，绝不伪装成绿）。环境具备而断言不成立 → FAIL，退出码 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_DIR, assertEqual, assertOk,
  cleanupTempDirs, createRunner, createWorkspace, fail, launchMock, redact, seedSession, skip, tempDir,
} from './lib/harness.mjs';

const runner = createRunner('BROWSER');
const SID = 'session-acc-a9-parent';
const CHILD = 'session-acc-a9-child';
const CHILD_TITLE = 'acc-child-a9';

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

/**
 * 取浏览器句柄（懒启动 + 多候选回退）。环境不具备时抛 DegradedSkip（用例记为 SKIP，绝不记 PASS）。
 */
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

/** 启动浏览器（多候选回退）；全部失败返回 null。 */
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

/** 拉起隔离 mock 实例（1 个 running 父会话 + 1 个 SUBAGENTS 子会话）。 */
async function startFixture() {
  const wsRoot = tempDir('q20-acc-a9-');
  const wsPath = path.join(wsRoot, 'ws-a9');
  const srv = await launchMock({
    running: [SID],
    workspaceRoot: wsRoot,
    subagents: [{ sessionId: CHILD, parentSessionId: SID, origin: 'subagent', cwd: wsPath, title: CHILD_TITLE, running: true }],
  });
  const cwd = await createWorkspace(srv.base, 'ws-a9');
  await seedSession(srv.base, { cwd, sessionId: SID });
  return { srv, cwd };
}

/** 打开页面并等待 bootstrap 完成（ws-select 有选项），返回 { context, page, errors }。 */
async function openApp(browser, srv, cwd) {
  const context = await browser.newContext({ viewport: { width: 720, height: 720 } });
  // 预置当前工作区/会话（对齐真实客户端 localStorage 契约），避免空 cwd 轮询噪声
  await context.addInitScript(function (o) {
    try {
      localStorage.setItem('dsh_q20_cwd', o.cwd);
      localStorage.setItem('dsh_q20_session_id', o.sid);
    } catch (e) { /* 隐私模式下忽略 */ }
  }, { cwd, sid: SID });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('[console.error] ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('[pageerror] ' + err.message));
  const resp = await page.goto(srv.base + '/', { waitUntil: 'load', timeout: 30000 });
  assertOk(resp && resp.status() === 200, 'A9 页面 HTTP 状态', 200, resp ? resp.status() : '(no response)');
  try {
    await page.waitForFunction(() => {
      const sel = document.getElementById('ws-select');
      return !!sel && sel.options.length > 0;
    }, null, { timeout: 20000 });
  } catch {
    fail('A9 bootstrap 未完成（20s 内 #ws-select 无工作区选项）', '#ws-select 选项数 ≥ 1',
      await page.evaluate(() => {
        const sel = document.getElementById('ws-select');
        return 'options=' + (sel ? sel.options.length : 'no-element');
      }));
  }
  return { context, page, errors };
}

/**
 * 通过真实 UI 选中目标会话（与运行状态无关，故 A9-U 不依赖 C 面板的运行态过滤）：
 *   按 W 打开工作区面板 → 点工作区行（内部 selectWorkspace → openSess 模式 0）
 *   → 等会话行 → 点会话行（selectSession）
 * 随后断言 getSid() 已就位（前置条件失败时归因清晰，不伪装成被测行为失败）。
 */
async function selectSessionViaUi(page) {
  await page.keyboard.press('w');
  await page.waitForSelector('#ws-tree .tree-ws', { timeout: 15000 });
  await page.click('#ws-tree .tree-ws');
  await page.waitForSelector('#sess-tree .tree-sess', { timeout: 20000 });
  await page.click('#sess-tree .tree-sess');
  try {
    await page.waitForFunction((sid) => typeof getSid === 'function' && getSid() === sid, SID, { timeout: 15000 });
  } catch {
    fail('A9 前置条件：通过真实 UI 选中会话失败（getSid() !== ' + SID + '）',
      'getSid() === ' + SID,
      await page.evaluate(() => {
        try { return 'getSid()=' + getSid() + '; cwd=' + getCwd(); } catch (e) { return 'getSid 不可用: ' + e.message; }
      }));
  }
}

function dumpTree(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return '(元素不存在: ' + sel + ')';
    return (el.innerText || el.textContent || '').slice(0, 400);
  }, selector);
}

async function main() {
  console.log('# Q20 验收套件 BROWSER (A9 真实页面) — 时间: ' + new Date().toISOString());

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  // ── A9-C: C 面板「全工作区进行中」必须显示 running 会话 ──
  await runner.run('A9-C C 面板：全工作区进行中显示 running 会话（终态不得残留）+ Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture();
    let context = null;
    try {
      const app = await openApp(browser, fx.srv, fx.cwd);
      context = app.context;
      const page = app.page;
      await page.keyboard.press('c');
      try {
        await page.waitForFunction(() => document.querySelectorAll('#sess-tree .tree-sess').length > 0, null, { timeout: 20000 });
      } catch {
        fail('A9-C C 面板必须渲染出 running 会话行（20s 内未出现任何会话行）',
          '≥1 行 .tree-sess 且状态图标为 run-dot',
          '行数=0; #sess-tree 文本=' + JSON.stringify(await dumpTree(page, '#sess-tree')));
      }
      const info = await page.evaluate(() => {
        const rows = document.querySelectorAll('#sess-tree .tree-sess');
        let runRows = 0;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].innerHTML.indexOf('run-dot') >= 0) runRows += 1;
        }
        const overlay = document.getElementById('sess-overlay');
        const title = document.getElementById('sess-panel-title');
        return { count: rows.length, runRows, overlayDisplay: overlay ? overlay.style.display : null, title: title ? title.innerHTML : '' };
      });
      const shot = path.join(ARTIFACT_DIR, 'a9-c-panel.png');
      await page.screenshot({ path: shot });
      assertEqual(info.overlayDisplay, 'block', 'A9-C C 面板必须打开（#sess-overlay display）');
      assertOk(info.title.indexOf('进行中') >= 0, 'A9-C C 面板标题必须为「进行中」视图', '含「进行中」', info.title);
      assertEqual(info.count, 1, 'A9-C C 面板行数（隔离实例只有 1 个 running 会话，终态会话不得残留）');
      assertEqual(info.runRows, 1, 'A9-C C 面板必须恰有 1 行 running 图标（.run-dot）');
      assertEqual(app.errors.length, 0, 'A9-C 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shot), 'A9-C 截图必须落盘', redact(shot), '(missing)');
      return 'rows=' + info.count + ' runRows=' + info.runRows + ' consoleErrors=0 截图=' + path.basename(shot);
    } finally {
      if (context) { try { await context.close(); } catch { /* 已关闭 */ } }
      await fx.srv.stop();
    }
  });

  // ── A9-U: U 面板有子智能体时必须非空 ──
  await runner.run('A9-U U 面板：存在子智能体时必须非空渲染 + Console Error=0 + 截图', async () => {
    const browser = await getBrowser();
    const fx = await startFixture();
    let context = null;
    try {
      const app = await openApp(browser, fx.srv, fx.cwd);
      context = app.context;
      const page = app.page;
      await selectSessionViaUi(page);
      await page.keyboard.press('u');
      try {
        await page.waitForFunction((t) => {
          const el = document.getElementById('subagent-tree');
          return !!el && (el.textContent || '').indexOf(t) >= 0;
        }, CHILD_TITLE, { timeout: 20000 });
      } catch {
        fail('A9-U U 面板必须渲染出子智能体（20s 内未出现 ' + CHILD_TITLE + '）',
          '包含 "' + CHILD_TITLE + '"', '#subagent-tree 文本=' + JSON.stringify(await dumpTree(page, '#subagent-tree')));
      }
      const info = await page.evaluate(() => {
        const el = document.getElementById('subagent-tree');
        const overlay = document.getElementById('subagent-overlay');
        return {
          text: el ? (el.textContent || '') : '',
          nodes: el ? el.querySelectorAll('.tree-sess').length : -1,
          overlayDisplay: overlay ? overlay.style.display : null,
        };
      });
      const shot = path.join(ARTIFACT_DIR, 'a9-u-panel.png');
      await page.screenshot({ path: shot });
      assertEqual(info.overlayDisplay, 'block', 'A9-U U 面板必须打开（#subagent-overlay display）');
      assertOk(info.text.indexOf('暂无子智能体') < 0, 'A9-U U 面板不得呈现空态文案（存在子智能体）',
        '不含「暂无子智能体」', info.text.slice(0, 200));
      assertOk(info.text.indexOf(CHILD_TITLE) >= 0, 'A9-U U 面板必须显示子会话标题', '含 ' + CHILD_TITLE, info.text.slice(0, 200));
      assertEqual(app.errors.length, 0, 'A9-U 浏览器 Console Error 数必须为 0');
      assertOk(fs.existsSync(shot), 'A9-U 截图必须落盘', redact(shot), '(missing)');
      return 'nodes=' + info.nodes + ' consoleErrors=0 截图=' + path.basename(shot);
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
  console.error('[BROWSER SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
