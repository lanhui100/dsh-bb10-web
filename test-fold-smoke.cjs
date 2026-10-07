// DOM smoke test for turn-process fold helpers (extracted from static/index.html).
// Usage: node test-fold-smoke.cjs  (requires google-chrome / chromium)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function sliceOf(startMark, endMark) {
  const s = script.indexOf(startMark);
  if (s < 0) throw new Error('start marker missing: ' + startMark);
  const e = script.indexOf(endMark, s);
  if (e < 0) throw new Error('end marker missing: ' + endMark);
  return script.slice(s + startMark.length, e);
}

const escapeFn = sliceOf('    function escapeHtml(str) {', '\n    }\n');
const foldSrc = sliceOf('    var turnProcessOpenMap = {};', '    function renderAssistantBlocks(');
const extraTitle = sliceOf('/* @Q20-TOOL-TITLE-START */', '/* @Q20-TOOL-TITLE-END */');

const pageJs =
  'var currentSessionId = "sess-smoke";\n' +
  'function escapeHtml(str) {' + escapeFn + '\n}\n' +
  '    var turnProcessOpenMap = {};' + foldSrc;

const lines = [];
lines.push('(function() {');
lines.push('  var out = [];');
lines.push('  function ok(name, cond, extra) { out.push((cond ? "PASS " : "FAIL ") + name + (extra ? " | " + extra : "")); }');
lines.push('  function mkPill(text, running) {');
lines.push('    var p = document.createElement("div");');
lines.push('    p.className = running ? "tool-pill running" : "tool-pill";');
lines.push('    p.appendChild(document.createTextNode(text));');
lines.push('    var d = document.createElement("div"); d.className = "tool-detail"; d.style.display = "none"; p.appendChild(d);');
lines.push('    return p; }');
lines.push('  function mkThought(t) {');
lines.push('    var c = document.createElement("div"); c.className = "thought-card";');
lines.push('    var h = document.createElement("div"); h.className = "thought-header"; h.appendChild(document.createTextNode("think"));');
lines.push('    var b = document.createElement("div"); b.className = "thought-body"; b.style.display = "none"; b.appendChild(document.createTextNode(t));');
lines.push('    c.appendChild(h); c.appendChild(b); return c; }');
lines.push('  function mkText(t) { var b = document.createElement("div"); b.className = "msg-assistant"; b.appendChild(document.createTextNode(t)); return b; }');
lines.push('  function mkWrap() { var w = document.createElement("div"); w.className = "msg-wrap"; return w; }');
lines.push('  function byClass(root, cn) { return root.getElementsByClassName(cn); }');
lines.push('  function rowText(w) { return byClass(w, "turn-process-row")[0].textContent; }');
// A: live-send wrap scope — thought + 2 tool pills + final answer bubble stays
lines.push('  var wrap = document.createElement("div");');
lines.push('  var th = mkThought("reasoning...");');
lines.push('  var tc = document.createElement("div"); tc.className = "tools-container";');
lines.push('  tc.appendChild(mkPill("Bash - ls [done]", false));');
lines.push('  tc.appendChild(mkPill("read - a.txt [done]", false));');
lines.push('  var bub = mkText("final answer");');
lines.push('  wrap.appendChild(th); wrap.appendChild(tc); wrap.appendChild(bub);');
lines.push('  document.body.appendChild(wrap);');
lines.push('  ok("A-fold-true", foldProcessChildren(wrap, "k1") === true);');
lines.push('  ok("A-one-fold", byClass(wrap, "turn-process").length === 1);');
lines.push('  ok("A-label", rowText(wrap) === "\\u25b6 2 \\u6b21\\u5de5\\u5177\\u8c03\\u7528", rowText(wrap));');
lines.push('  ok("A-body-3", byClass(wrap, "turn-process-body")[0].childNodes.length === 3);');
lines.push('  ok("A-bubble-stays", bub.parentNode === wrap && byClass(wrap, "msg-assistant").length === 1);');
lines.push('  ok("A-container-gone", byClass(wrap, "tools-container").length === 0);');
lines.push('  byClass(wrap, "turn-process-row")[0].click();');
lines.push('  ok("A-expand", byClass(wrap, "turn-process-body")[0].style.display === "block");');
lines.push('  ok("A-map-kept", turnProcessOpenMap["k1"] === true);');
lines.push('  byClass(wrap, "turn-process-row")[0].click();');
lines.push('  ok("A-collapse", byClass(wrap, "turn-process-body")[0].style.display === "none");');
lines.push('  document.body.removeChild(wrap);');
// B: running pill keeps flow open until settle; single fold label counts 1 call
lines.push('  var wrapB = document.createElement("div");');
lines.push('  var thB = mkThought("t");');
lines.push('  var runPill = mkPill("read - f (running)", true);');
lines.push('  wrapB.appendChild(thB); wrapB.appendChild(runPill);');
lines.push('  document.body.appendChild(wrapB);');
lines.push('  ok("B-running-keeps-open", foldProcessChildren(wrapB, "kB") === false);');
lines.push('  ok("B-nodes-unmoved", thB.parentNode === wrapB && runPill.parentNode === wrapB && byClass(wrapB, "turn-process").length === 0);');
lines.push('  finalizeLiveProcess(wrapB);');
lines.push('  ok("B-settled-folded", runPill.className === "tool-pill" && byClass(wrapB, "turn-process").length === 1);');
lines.push('  ok("B-label-1call", rowText(wrapB) === "\\u25b6 1 \\u6b21\\u5de5\\u5177\\u8c03\\u7528", rowText(wrapB));');
lines.push('  document.body.removeChild(wrapB);');
// C: single process item must NOT fold (meaningless disclosure row)
lines.push('  var wrapC1 = document.createElement("div"); wrapC1.appendChild(mkThought("only thinking"));');
lines.push('  document.body.appendChild(wrapC1);');
lines.push('  ok("C1-single-thought-nofold", foldProcessChildren(wrapC1, null) === false && byClass(wrapC1, "turn-process").length === 0);');
lines.push('  document.body.removeChild(wrapC1);');
lines.push('  var wrapC2 = document.createElement("div"); wrapC2.appendChild(mkThought("t1")); wrapC2.appendChild(mkThought("t2"));');
lines.push('  document.body.appendChild(wrapC2); foldProcessChildren(wrapC2, null);');
lines.push('  ok("C2-body-2", byClass(wrapC2, "turn-process-body")[0].childNodes.length === 2);');
lines.push('  ok("C2-label-thought", rowText(wrapC2) === "\\u25b6 \\u5df2\\u601d\\u8003", rowText(wrapC2));');
lines.push('  document.body.removeChild(wrapC2);');
// D: trailing fold on attach chatContainer — history wraps are hard boundaries
lines.push('  var chat = document.createElement("div");');
lines.push('  var userW = mkWrap(); var userB = document.createElement("div"); userB.className = "msg-user"; userW.appendChild(userB);');
lines.push('  var oldW = mkWrap(); var oldTh = mkThought("old thought"); var oldBub = mkText("old answer");');
lines.push('  oldW.appendChild(oldTh); oldW.appendChild(oldBub);');
lines.push('  var tailTh = mkThought("new thought"); var tailPill = mkPill("Bash - pwd [done]", false);');
lines.push('  var tail = document.createElement("div"); tail.id = "sess-status-tail";');
lines.push('  chat.appendChild(userW); chat.appendChild(oldW);');
lines.push('  chat.appendChild(tailTh); chat.appendChild(tailPill); chat.appendChild(tail);');
lines.push('  document.body.appendChild(chat);');
lines.push('  ok("D-trailing-fold", foldTrailingProcess(chat) === true);');
lines.push('  ok("D-one-fold", byClass(chat, "turn-process").length === 1);');
lines.push('  ok("D-old-untouched", oldTh.parentNode === oldW && oldBub.parentNode === oldW);');
lines.push('  ok("D-tail-last", chat.lastChild === tail);');
lines.push('  ok("D-tail-moved", tailTh.parentNode !== chat && tailPill.parentNode !== chat);');
lines.push('  document.body.removeChild(chat);');
// D2: trailing fold passes over the attach answer wrap exactly once
lines.push('  var chat2 = document.createElement("div");');
lines.push('  var uW2 = mkWrap(); var uB2 = document.createElement("div"); uB2.className = "msg-user"; uW2.appendChild(uB2);');
lines.push('  var th2 = mkThought("live thought"); var pill2 = mkPill("bash - ls [done]", false);');
lines.push('  var ansW = mkWrap(); var ansB = mkText("attach answer"); ansW.appendChild(ansB);');
lines.push('  var tail2 = document.createElement("div"); tail2.id = "sess-status-tail";');
lines.push('  chat2.appendChild(uW2); chat2.appendChild(th2); chat2.appendChild(pill2); chat2.appendChild(ansW); chat2.appendChild(tail2);');
lines.push('  document.body.appendChild(chat2);');
lines.push('  ok("D2-passover-fold", foldTrailingProcess(chat2) === true);');
lines.push('  ok("D2-one-fold", byClass(chat2, "turn-process").length === 1);');
lines.push('  ok("D2-answer-kept", ansB.parentNode === ansW && ansW.parentNode === chat2);');
lines.push('  ok("D2-fold-before-answer", ansW.previousSibling.className === "turn-process");');
lines.push('  document.body.removeChild(chat2);');
// E: nothing to fold
lines.push('  var wrapE = document.createElement("div"); wrapE.appendChild(mkText("just text"));');
lines.push('  document.body.appendChild(wrapE);');
lines.push('  ok("E-empty-false", foldProcessChildren(wrapE, null) === false && byClass(wrapE, "turn-process").length === 0);');
lines.push('  document.body.removeChild(wrapE);');
// G: history turn-group fold (dsh turn-process semantics)
lines.push('  var rootG = document.createElement("div");');
lines.push('  var guW = mkWrap(); var guB = document.createElement("div"); guB.className = "msg-user"; guW.appendChild(guB);');
lines.push('  var g1 = mkWrap(); var g1th = mkThought("s1 think"); var g1pill = mkPill("bash - pwd [done]", false); var g1bub = mkText("let me check");');
lines.push('  g1.appendChild(g1th); g1.appendChild(g1pill); g1.appendChild(g1bub);');
lines.push('  var g2 = mkWrap(); var g2th = mkThought("s2 think"); var g2bub = mkText("final answer");');
lines.push('  g2.appendChild(g2th); g2.appendChild(g2bub);');
lines.push('  rootG.appendChild(guW); rootG.appendChild(g1); rootG.appendChild(g2);');
lines.push('  document.body.appendChild(rootG);');
lines.push('  ok("G-group-fold", foldTurnGroupInDom([g1, g2], "kG") === true);');
lines.push('  ok("G-one-fold", byClass(rootG, "turn-process").length === 1);');
lines.push('  ok("G-label-counts", rowText(rootG) === "\\u25b6 1 \\u6b21\\u5de5\\u5177\\u8c03\\u7528 \\u00b7 1 \\u6761\\u6d88\\u606f", rowText(rootG));');
lines.push('  ok("G-body-4", byClass(rootG, "turn-process-body")[0].childNodes.length === 4);');
lines.push('  ok("G-intermediate-wrap-gone", g1.parentNode === null);');
lines.push('  ok("G-answer-wrap-kept", g2.parentNode === rootG && g2bub.parentNode === g2 && g2th.parentNode !== g2);');
lines.push('  ok("G-answer-last", rootG.lastChild === g2);');
lines.push('  byClass(rootG, "turn-process-row")[0].click();');
lines.push('  ok("G-map-kept", turnProcessOpenMap["kG"] === true);');
lines.push('  document.body.removeChild(rootG);');
// G2: single tool call only — no fold (meaningless row removed)
lines.push('  var rootG2 = document.createElement("div");');
lines.push('  var gp = mkWrap(); gp.appendChild(mkPill("bash - ls [done]", false));');
lines.push('  rootG2.appendChild(gp);');
lines.push('  document.body.appendChild(rootG2);');
lines.push('  ok("G2-single-call-nofold", foldTurnGroupInDom([gp], null) === false && byClass(rootG2, "turn-process").length === 0);');
lines.push('  document.body.removeChild(rootG2);');
// G3: interrupted turn without answer — whole group folds, counts intermediate msg
lines.push('  var rootG3 = document.createElement("div");');
lines.push('  var h1 = mkWrap(); var h1th = mkThought("t"); var h1pill = mkPill("bash - a [done]", false); h1.appendChild(h1th); h1.appendChild(h1pill);');
lines.push('  var h2 = mkWrap(); h2.appendChild(mkPill("read - f [done]", false));');
lines.push('  rootG3.appendChild(h1); rootG3.appendChild(h2);');
lines.push('  document.body.appendChild(rootG3);');
lines.push('  ok("G3-no-answer-fold", foldTurnGroupInDom([h1, h2], null) === true);');
lines.push('  ok("G3-label", rowText(rootG3) === "\\u25b6 2 \\u6b21\\u5de5\\u5177\\u8c03\\u7528 \\u00b7 1 \\u6761\\u6d88\\u606f", rowText(rootG3));');
lines.push('  ok("G3-wraps-gone", h1.parentNode === null && h2.parentNode === null);');
lines.push('  document.body.removeChild(rootG3);');
// G4: running group must stay open
lines.push('  var rootG4 = document.createElement("div");');
lines.push('  var r1 = mkWrap(); var r1pill = mkPill("bash - x (running)", true); r1.appendChild(r1pill);');
lines.push('  rootG4.appendChild(r1);');
lines.push('  document.body.appendChild(rootG4);');
lines.push('  ok("G4-running-nofold", foldTurnGroupInDom([r1], null) === false && byClass(rootG4, "turn-process").length === 0);');
lines.push('  document.body.removeChild(rootG4);');
lines.push('  ok("F-title", toolTitleFor("web_search") === "\\u7f51\\u9875\\u641c\\u7d22" && toolTitleFor("mystery_tool") === "\\u5de5\\u5177\\u8c03\\u7528");');
lines.push('  ok("F-summary", toolSummaryFor("mystery_tool", "x") === "mystery_tool \\u00b7 x" && toolSummaryFor("bash", "x") === "x");');
lines.push('  var pre = document.createElement("pre"); pre.id = "smoke-out";');
lines.push('  pre.appendChild(document.createTextNode(out.join("\\n")));');
lines.push('  document.body.appendChild(pre);');
lines.push('})();');
const testJs = lines.join('\n');

const page = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<script>' + pageJs + '\n' + extraTitle + '\n' + testJs + '</script>' +
  '</body></html>';
const pagePath = path.join(dir, '.fold-smoke.html');
fs.writeFileSync(pagePath, page);

const bins = ['google-chrome', 'chromium', 'chromium-browser'];
let bin = null;
for (const b of bins) {
  try {
    execFileSync(b, ['--version'], { stdio: 'ignore' });
    bin = b;
    break;
  } catch (e) { /* try next */ }
}
if (!bin) throw new Error('no chromium binary found');

const dom = execFileSync(bin, [
  '--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'file://' + pagePath,
], { encoding: 'utf8', timeout: 60000 });
const m = dom.match(/<pre id="smoke-out">([\s\S]*?)<\/pre>/);
fs.unlinkSync(pagePath);
if (!m) throw new Error('smoke output missing');
const out = m[1].split('\n').filter(Boolean);
console.log(out.join('\n'));
const failed = out.filter((l) => l.indexOf('FAIL') === 0);
if (failed.length > 0) { console.error('SMOKE FAILED: ' + failed.length); process.exit(1); }
console.log('SMOKE ALL PASS (' + out.length + ')');
