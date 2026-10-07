/**
 * Message File Preview browser E2E (image / txt / md fullscreen preview).
 *
 * Runs a real Chromium at 720x720 against a running Q20 web companion service
 * and drives the actual client code paths:
 *   A. /api/history attachments -> clickable chip -> fullscreen image preview
 *   B. markdown image / local-file reference -> chip (externals & code spans untouched)
 *   C. md reference -> /api/file -> fullscreen markdown rendering (Esc closes)
 *   D. txt reference -> /api/file -> fullscreen <pre> with exact bytes
 *   E. markdown attachment image (same-origin URL) + modal keyboard guard
 *   F. out-of-workspace path -> honest refusal status
 *   G. local send echo (base64 image) -> chip -> fullscreen preview
 *
 * Prereqs:
 *   - service running (default http://127.0.0.1:3090; override with Q20_BASE)
 *   - Playwright importable: `npm i -D playwright`, or
 *     Q20_PLAYWRIGHT=/abs/path/to/playwright/index.mjs
 *
 * Usage: node test-preview-browser.mjs      (or: pnpm run test:preview)
 * Exit codes: 0 = pass, or SKIP when Playwright is unavailable; 1 = fail.
 * Note: sections A/E need an attachment-bearing session on this host. When none
 * exists they print SKIP instead of failing; the server contract for those
 * paths is still machine-checked by test-unit.mjs.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname;
const BASE = process.env.Q20_BASE || 'http://127.0.0.1:3090';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const FIXTURE_MD = '.q20-preview-browser-probe.md';
const FIXTURE_TXT = '.q20-preview-browser-probe.txt';
const FIXTURE_PNG = '.q20-preview-browser-probe.png';
const FIXTURE_TXT_BODY = 'Q20-BROWSER-PROBE-LINE-1\n第二行内容\n';
/** 1x1 transparent PNG — enough for a real decode assertion without a repo asset. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

async function loadPlaywright() {
  const candidates = [];
  if (process.env.Q20_PLAYWRIGHT) candidates.push(process.env.Q20_PLAYWRIGHT);
  candidates.push('playwright', 'playwright-core');
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) return chromium;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, BASE), { method: 'GET', timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 220) });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' :: ' + String(detail).slice(0, 200) : ''}`);
  return !!ok;
}

async function historyHasImage(cwd, sessionId) {
  const hist = await request(`/api/history?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(sessionId)}&turns=8`);
  const msgs = (hist.json && hist.json.messages) || (Array.isArray(hist.json) ? hist.json : []);
  for (const m of msgs) {
    if (!m || !Array.isArray(m.attachments)) continue;
    const image = m.attachments.find((a) => a && a.kind === 'image' && a.id);
    if (image) return image;
  }
  return null;
}

/** Session dir naming mirrors the server: `--<cwd with / -> ->--`. */
function sessionDirForCwd(cwd) {
  const leaf = '--' + String(cwd).replace(/^\/+|\/+$/g, '').replace(/\//g, '-') + '--';
  return path.join(DSH_HOME, 'sessions', leaf);
}

/** Multi-frame Zstd transcript reader (same framing as the server's decompressor). */
function readTranscriptText(file) {
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let idx = buf.indexOf(magic);
  let out = '';
  while (idx >= 0) {
    const next = buf.indexOf(magic, idx + 4);
    const end = next < 0 ? buf.length : next;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(idx, end)).toString('utf8');
    } catch {
      // skip corrupted frame
    }
    idx = next;
  }
  return out;
}

/** First durable image reference inside a local transcript, or null. */
function scanTranscriptForImage(transcriptText) {
  for (const line of transcriptText.split('\n')) {
    if (line.indexOf('"type":"image"') < 0 || line.indexOf('attachmentId') < 0) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj.data && obj.data.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const a = part && part.attachment;
        if (part && part.type === 'image' && a && a.attachmentId) {
          return { id: String(a.attachmentId), name: a.name ? String(a.name) : 'image.png', kind: 'image' };
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return null;
}

/**
 * Find a workspace + a session that actually carries an image attachment.
 * Candidate order: the workspace session list, then an mtime-ordered scan of the
 * workspace's on-disk transcripts (archived sessions are not listed).
 */
async function discoverHistoryFixture() {
  const boot = await request('/api/bootstrap');
  const workspaces = (boot.json && boot.json.workspaces) || [];
  const repoWs = workspaces.find((w) => w && w.cwd === REPO_ROOT)
    || workspaces.find((w) => w && w.cwd && fs.existsSync(w.cwd));
  if (!repoWs) return null;
  const cwd = repoWs.cwd;

  const listed = await request(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
  const list = Array.isArray(listed.json) ? listed.json : [];
  for (const s of list.slice(0, 12)) {
    if (!s || !s.id) continue;
    try {
      const att = await historyHasImage(cwd, s.id);
      if (att) return { cwd, sessionId: s.id, attachment: att, source: 'session list' };
    } catch { /* keep scanning */ }
  }

  const dir = sessionDirForCwd(cwd);
  if (!fs.existsSync(dir)) return { cwd, sessionId: '', attachment: null, source: 'none' };
  const candidates = fs.readdirSync(dir)
    .map((name) => {
      try {
        const p = path.join(dir, name);
        if (!fs.statSync(p).isDirectory()) return null;
        return { name, mtime: fs.statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    const sessionPath = path.join(dir, candidate.name);
    let files = [];
    try { files = fs.readdirSync(sessionPath); } catch { continue; }
    const zstd = files.find((f) => f.endsWith('.jsonl.zstd'));
    if (!zstd) continue;
    try {
      const attachment = scanTranscriptForImage(readTranscriptText(path.join(sessionPath, zstd)));
      if (attachment) return { cwd, sessionId: candidate.name, attachment, source: 'transcript scan' };
    } catch { /* keep scanning */ }
  }
  return { cwd, sessionId: '', attachment: null, source: 'none' };
}

const chromium = await loadPlaywright();
if (!chromium) {
  const msg = 'playwright not importable (set Q20_PLAYWRIGHT=<abs playwright index.mjs>)';
  if (process.env.Q20_REQUIRE_PREVIEW_E2E === '1') {
    console.log(`✖ ${msg} and Q20_REQUIRE_PREVIEW_E2E=1`);
    process.exit(1);
  }
  console.log(`SKIP: ${msg}; 靠 review 手工执行（设 Q20_REQUIRE_PREVIEW_E2E=1 可把跳过变成失败）`);
  process.exit(0);
}

const discovered = await discoverHistoryFixture();
if (!discovered) {
  console.log(`✖ cannot discover an on-disk registered workspace via ${BASE}/api/bootstrap`);
  process.exit(1);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 720, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 240)));

const cleanupPaths = [];

try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof loadHistory === 'function', undefined, { timeout: 30000 });
  await page.waitForFunction(() => window.bootLoading === false, undefined, { timeout: 30000 });
  // bootLoading 早于 renderBootstrap 填充 #ws-select：必须等到工作区真正就绪
  await page.waitForFunction(() => {
    const el = document.getElementById('ws-select');
    return !!el && !!el.value;
  }, undefined, { timeout: 30000 });
  await page.waitForTimeout(800);

  // Fixtures must live in the workspace the client currently has selected,
  // because markdown chips resolve relative paths against wsSelect.value.
  const selected = await page.evaluate(() => {
    const el = document.getElementById('ws-select');
    return el ? el.value : '';
  });
  const probeCwd = (selected && fs.existsSync(selected)) ? selected : discovered.cwd;
  const fixtureMdPath = path.join(probeCwd, FIXTURE_MD);
  const fixtureTxtPath = path.join(probeCwd, FIXTURE_TXT);
  const fixturePngPath = path.join(probeCwd, FIXTURE_PNG);
  // md 内容自身带一张图引用：用于验证"预览层内再点卡片就地换页"
  fs.writeFileSync(
    fixtureMdPath,
    '# Q20 browser probe\n\n- markdown 渲染探针\n\n![内嵌图](' + FIXTURE_PNG + ')\n',
    'utf8',
  );
  fs.writeFileSync(fixtureTxtPath, FIXTURE_TXT_BODY, 'utf8');
  fs.writeFileSync(fixturePngPath, PNG_1X1);
  cleanupPaths.push(fixtureMdPath, fixtureTxtPath, fixturePngPath);
  if (!fs.existsSync(fixtureMdPath)) throw new Error('fixture write failed: ' + fixtureMdPath);

  // ---- A. history attachment image -> chip -> fullscreen ----
  if (discovered.sessionId && discovered.attachment) {
    await page.evaluate(([cwd, sid]) => {
      currentSessionId = sid;
      loadHistory(cwd, sid);
    }, [discovered.cwd, discovered.sessionId]);
    await page.waitForSelector('.msg-user', { timeout: 30000 });
    await page.waitForTimeout(400);
    const chip = page.locator('[data-fpchip="1"][data-fpkind="image"]').first();
    check('history image chip from /api/history attachments', await chip.count() > 0,
      `${discovered.attachment.name} (via ${discovered.source})`);
    await chip.click();
    await page.waitForSelector('#file-preview-overlay', { state: 'visible', timeout: 10000 });
    check('overlay opens on chip click', await page.locator('#file-preview-overlay').isVisible());
    await page.waitForFunction(() => {
      const im = document.getElementById('file-preview-image');
      return !!im && im.complete && im.naturalWidth > 0;
    }, undefined, { timeout: 30000 });
    const nat = await page.evaluate(() => {
      const im = document.getElementById('file-preview-image');
      return { w: im.naturalWidth, h: im.naturalHeight };
    });
    check('fullscreen image decoded', nat.w > 0, JSON.stringify(nat));
    await page.screenshot({ path: '/tmp/q20-preview-image.png' });
    await page.click('#file-preview-close');
    await page.waitForTimeout(200);
    check('close button hides overlay', !(await page.locator('#file-preview-overlay').isVisible()));
  } else {
    console.log('SKIP: no attachment-bearing session on this host (section A)');
    console.log('SKIP: markdown attachment-image checks (sections B image chip / E)');
  }

  // ---- B. markdown references -> chips, literals untouched ----
  const mdLines = [
    '[文档](' + FIXTURE_MD + ')',
    '[日志](' + FIXTURE_TXT + ')',
    '[外链](https://example.com/page)',
    '`![code](' + FIXTURE_MD + ')`',
  ];
  if (discovered.attachment) {
    mdLines.unshift(
      '![att](/api/attachment?id=' + discovered.attachment.id + '&kind=image&name='
      + encodeURIComponent(discovered.attachment.name || 'image.png') + '&mediaType=image/png)',
    );
  }
  await page.evaluate((md) => {
    const container = document.getElementById('chat-container');
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'msg-assistant';
    bubble.id = 'q20-probe-bubble';
    bubble.innerHTML = formatContent(md);
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  }, mdLines.join('\n'));
  await page.waitForTimeout(300);

  const probe = await page.evaluate(() => {
    const bubble = document.getElementById('q20-probe-bubble');
    return {
      chips: bubble.querySelectorAll('[data-fpchip="1"]').length,
      pathChips: bubble.querySelectorAll('[data-fppath]').length,
      imgChips: bubble.querySelectorAll('[data-fpchip="1"][data-fpkind="image"]').length,
      text: bubble.textContent,
    };
  });
  const expectedChips = discovered.attachment ? 3 : 2;
  check(`markdown file chips rendered (expected ${expectedChips})`, probe.chips === expectedChips,
    JSON.stringify({ chips: probe.chips, pathChips: probe.pathChips, imgChips: probe.imgChips }));
  check('external link left as literal text', probe.text.indexOf('[外链](https://example.com/page)') >= 0, probe.text);
  check('code-span reference left literal (no chip)', probe.text.indexOf('![code](') >= 0, probe.text);

  // ---- C. md reference -> fullscreen markdown; Esc closes ----
  await page.locator('#q20-probe-bubble [data-fppath="' + FIXTURE_MD + '"]').first().click();
  await page.waitForSelector('#file-preview-md', { timeout: 20000 });
  const mdText = await page.locator('#file-preview-md').innerText();
  check('md preview fetched via /api/file and rendered', mdText.indexOf('markdown 渲染探针') >= 0, mdText.slice(0, 80));
  check('md preview uses markdown markup', (await page.locator('#file-preview-md h1').count()) > 0);
  await page.screenshot({ path: '/tmp/q20-preview-md.png' });
  // 预览层内的卡片必须可点（遮罩不在 #chat-container 委托范围内，需自带委托）
  const innerChip = page.locator('#file-preview-md [data-fpchip="1"]').first();
  check('md preview renders inner file chips', await innerChip.count() > 0);
  await innerChip.click();
  await page.waitForFunction(() => {
    const im = document.getElementById('file-preview-image');
    return !!im && im.complete && im.naturalWidth > 0;
  }, undefined, { timeout: 20000 });
  const innerTitle = await page.locator('#file-preview-title').innerText();
  check('inner chip opens preview in place (delegation)', innerTitle.indexOf(FIXTURE_PNG) >= 0, innerTitle);
  await page.click('#file-preview-close');
  // 重新打开 md 预览验证 Esc 关闭
  await page.locator('#q20-probe-bubble [data-fppath="' + FIXTURE_MD + '"]').first().click();
  await page.waitForSelector('#file-preview-md', { timeout: 20000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc closes preview (PC fallback)', !(await page.locator('#file-preview-overlay').isVisible()));

  // ---- D. txt reference -> <pre> exact content ----
  await page.locator('#q20-probe-bubble [data-fppath="' + FIXTURE_TXT + '"]').first().click();
  await page.waitForSelector('#file-preview-text', { timeout: 20000 });
  const txt = await page.locator('#file-preview-text').textContent();
  check('txt preview exact content', txt.indexOf('Q20-BROWSER-PROBE-LINE-1') >= 0 && txt.indexOf('第二行内容') >= 0,
    JSON.stringify(txt));
  await page.screenshot({ path: '/tmp/q20-preview-txt.png' });
  await page.click('#file-preview-close');

  // ---- E. markdown attachment image (same-origin URL) + modal key guard ----
  if (discovered.attachment) {
    // 修复 F2 后 markdown 附件图卡片按 id 重建 URL（不再携带内嵌 src）
    const attChip = page.locator('#q20-probe-bubble [data-fpid]').first();
    check('markdown attachment image chip', await attChip.count() > 0);
    await attChip.click();
    const attDecoded = await page.waitForFunction(() => {
      const im = document.getElementById('file-preview-image');
      return !!im && im.complete && im.naturalWidth > 0 ? { w: im.naturalWidth, h: im.naturalHeight } : false;
    }, undefined, { timeout: 30000 }).then((h) => h.jsonValue());
    check('markdown attachment image decodes', attDecoded.w > 0, JSON.stringify(attDecoded));
    await page.keyboard.press('t');
    await page.waitForTimeout(150);
    check('shortcuts swallowed while preview modal is open', await page.locator('#file-preview-overlay').isVisible());
    await page.click('#file-preview-close');
  }

  // ---- F. honest refusal for an out-of-workspace path ----
  await page.evaluate(() => {
    const container = document.getElementById('chat-container');
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'msg-assistant';
    bubble.id = 'q20-probe-escape';
    const chip = document.createElement('span');
    chip.className = 'fp-chip';
    chip.setAttribute('data-fpchip', '1');
    chip.setAttribute('data-fpname', 'hostname');
    chip.setAttribute('data-fppath', '/etc/hostname');
    chip.textContent = 'probe-escape';
    bubble.appendChild(chip);
    wrap.appendChild(bubble);
    container.appendChild(wrap);
  });
  await page.locator('#q20-probe-escape [data-fpchip="1"]').click();
  await page.waitForSelector('#file-preview-overlay .fp-status', { timeout: 10000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('#file-preview-overlay .fp-status');
    return !!status && status.textContent.indexOf('正在读取') < 0;
  }, undefined, { timeout: 10000 });
  const escStatus = await page.locator('#file-preview-overlay .fp-status').innerText();
  check('out-of-workspace path refused with honest message', /不在当前工作区|不存在|失败/.test(escStatus), escStatus);
  await page.click('#file-preview-close');

  // ---- H. P0 回归：别名/内嵌 cwd 不得越权（安全评审 F1/F2）----
  const hiddenFile = '.q20_token';
  const hiddenPath = path.join(probeCwd, hiddenFile);
  if (fs.existsSync(hiddenPath)) {
    // H1: 内嵌 cwd + 非白名单路径的 markdown 必须保持字面（不生成可点卡片）
    const crossMd = '[跨工作区](/api/file?cwd=' + encodeURIComponent(probeCwd)
      + '&path=' + encodeURIComponent(hiddenFile) + '&name=a.txt)';
    const literal = await page.evaluate((md) => {
      const box = document.createElement('div');
      box.innerHTML = formatContent(md);
      return { chips: box.querySelectorAll('[data-fpchip="1"]').length, text: box.textContent };
    }, crossMd);
    check('F2: embedded-cwd / non-whitelisted markdown stays literal', literal.chips === 0, literal.text);

    // H2: 服务端闸门——伪造白名单别名 + 真实非白名单文件必须 415，绝不回显
    const aliasRes = await request(`/api/file?cwd=${encodeURIComponent(probeCwd)}&path=${encodeURIComponent(hiddenFile)}&name=a.txt`);
    check('F1: alias cannot unlock a non-whitelisted workspace file', aliasRes.status === 415,
      `status=${aliasRes.status} type=${aliasRes.headers['content-type']}`);

    // H3: 客户端构造的越权卡片点击后只得到诚实拒绝，overlay 内不出现文件内容
    await page.evaluate(([file, name]) => {
      const container = document.getElementById('chat-container');
      const wrap = document.createElement('div');
      wrap.className = 'msg-wrap';
      const bubble = document.createElement('div');
      bubble.className = 'msg-assistant';
      bubble.id = 'q20-probe-alias';
      const chip = document.createElement('span');
      chip.className = 'fp-chip';
      chip.setAttribute('data-fpchip', '1');
      chip.setAttribute('data-fpname', name);
      chip.setAttribute('data-fppath', file);
      chip.textContent = 'probe-alias';
      bubble.appendChild(chip);
      wrap.appendChild(bubble);
      container.appendChild(wrap);
    }, [hiddenFile, 'a.txt']);
    await page.locator('#q20-probe-alias [data-fpchip="1"]').click();
    await page.waitForSelector('#file-preview-overlay .fp-status', { timeout: 10000 });
    await page.waitForFunction(() => {
      const status = document.querySelector('#file-preview-overlay .fp-status');
      return !!status && status.textContent.indexOf('正在读取') < 0;
    }, undefined, { timeout: 10000 });
    const aliasStatus = await page.locator('#file-preview-overlay .fp-status').innerText();
    check('F1: forged chip shows honest refusal (no content)', /不支持预览|不存在|失败|不在当前工作区/.test(aliasStatus), aliasStatus);
    await page.click('#file-preview-close');
  } else {
    console.log(`SKIP: ${hiddenFile} not present in probe workspace (section H)`);
  }

  // ---- I. 视觉/规则回归：无缩略图图片卡不塌陷、表格内引用成卡、协议字面 ----
  const visualMd = [
    '![无缩略图](' + FIXTURE_PNG + ')',
    '',
    '| 表头 | 文件 |',
    '| --- | --- |',
    '| a | [表内](' + FIXTURE_MD + ') |',
    '',
    '[m](mailto:a@b.md) [v](vscode:foo.md)',
  ].join('\n');
  await page.evaluate((md) => {
    const container = document.getElementById('chat-container');
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'msg-assistant';
    bubble.id = 'q20-probe-bubble2';
    bubble.innerHTML = formatContent(md);
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  }, visualMd);
  await page.waitForTimeout(300);
  const visual = await page.evaluate(() => {
    const box = document.getElementById('q20-probe-bubble2');
    const imgChip = box.querySelector('[data-fpchip="1"][data-fpkind="image"]');
    return {
      chipHeight: imgChip ? imgChip.offsetHeight : -1,
      chipText: imgChip ? imgChip.innerText : '',
      tableChips: box.querySelectorAll('.md-table [data-fpchip="1"]').length,
      chips: box.querySelectorAll('[data-fpchip="1"]').length,
      text: box.textContent,
    };
  });
  check('thumbless image chip is not a collapsed sliver',
    visual.chipHeight >= 16 && visual.chipText.indexOf('q20-preview-browser-probe.png') >= 0, JSON.stringify(visual));
  check('table cell references become chips', visual.tableChips >= 1, JSON.stringify(visual));
  check('scheme targets stay literal', visual.chips === 2 && visual.text.indexOf('[m](mailto:a@b.md)') >= 0,
    JSON.stringify(visual));

  // ---- J. 智能体生成交付物列表（对齐 DSH Web Deliverables / PresentedFileCard）----
  await page.evaluate(([pngFile, mdFile]) => {
    const container = document.getElementById('chat-container');
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap';
    const msg = {
      role: 'assistant',
      text: '已为您生成最终交付物文件：',
      deliverables: [
        { path: pngFile, name: 'delivered_card.png', description: '全新生成海报首图', kind: 'image' },
        { path: mdFile, name: 'delivered_verdict.md', description: '最终验收意见书', kind: 'text' },
      ],
    };
    renderAssistantBlocks(wrap, msg);
    wrap.id = 'q20-probe-deliverables';
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
  }, [FIXTURE_PNG, FIXTURE_MD]);
  await page.waitForTimeout(300);

  const dCardsCount = await page.locator('#q20-probe-deliverables .deliverable-card').count();
  check('assistant message deliverables cards rendered', dCardsCount === 2, 'count=' + dCardsCount);
  const dCardTitle = await page.locator('#q20-probe-deliverables .deliverable-card .deliverable-name').first().innerText();
  check('deliverable card name matches', dCardTitle === 'delivered_card.png', dCardTitle);

  // 点击交付物卡片弹出全屏预览
  await page.locator('#q20-probe-deliverables .deliverable-card').first().click();
  await page.waitForFunction(() => {
    const im = document.getElementById('file-preview-image');
    return !!im && im.complete && im.naturalWidth > 0;
  }, undefined, { timeout: 20000 });
  const dPreviewTitle = await page.locator('#file-preview-title').innerText();
  check('deliverables card click opens fullscreen preview', dPreviewTitle.indexOf('delivered_card.png') >= 0, dPreviewTitle);
  await page.click('#file-preview-close');

  // ---- G. local send echo (base64 image) -> chip -> fullscreen + title ----
  await page.evaluate((data) => {
    plusFile = {
      name: 'local-echo.png', size: data.length, receiptId: '', state: 'ready', err: '',
      kind: 'image', data: data, mediaType: 'image/png',
    };
    appendMessage('user', '本地回显测试', fpLocalEchoAttachments());
    plusFile = null;
  }, PNG_1X1.toString('base64'));
  await page.waitForTimeout(300);
  const echo = await page.evaluate(() => {
    const chips = document.querySelectorAll('.msg-user [data-fpchip="1"][data-fpkind="image"]');
    if (!chips.length) return { count: 0, name: '', inlineThumb: false };
    const last = chips[chips.length - 1];
    const img = last.querySelector('img.fp-thumb');
    return {
      count: chips.length,
      name: last.getAttribute('data-fpname'),
      inlineThumb: !!img && (img.getAttribute('src') || '').indexOf('data:image/png;base64,') === 0,
    };
  });
  check('local echo image chip in user bubble', echo.count > 0 && echo.name === 'local-echo.png', JSON.stringify(echo));
  check('local echo thumb is inline data URL (no round-trip)', echo.inlineThumb);
  if (echo.count > 0) {
    await page.locator('.msg-user [data-fpchip="1"][data-fpkind="image"]').last().click();
    await page.waitForFunction(() => {
      const im = document.getElementById('file-preview-image');
      return !!im && im.complete && im.naturalWidth > 0;
    }, undefined, { timeout: 20000 });
    const echoTitle = await page.locator('#file-preview-title').innerText();
    check('local echo fullscreen preview + title', echoTitle.indexOf('local-echo.png') >= 0, echoTitle);
    await page.click('#file-preview-close');
  }
} catch (err) {
  check('E2E run completed without exception', false, err && err.message);
} finally {
  try { await browser.close(); } catch { /* ignore */ }
  for (const p of cleanupPaths) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

const failed = results.filter((r) => !r.ok);
console.log('\n==== FILE PREVIEW E2E SUMMARY ====');
console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
console.log(`history attachment fixture: ${discovered.attachment ? 'found (' + discovered.source + ')' : 'NOT FOUND (sections A/E skipped)'}`);
for (const f of failed) console.log('FAILED:', f.name, '::', f.detail);
process.exit(failed.length === 0 ? 0 : 1);
