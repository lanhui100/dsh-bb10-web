/**
 * Q20 Wave 2026-10-19 验收套件（服务端 waiting 事实）：A1–A4
 * Owner: test-core（冻结件，Executor 只读；本文件为测试写域 tests/acceptance 独占）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-10-19.md §2 C-2 / §3 验收矩阵 A1–A4
 * 运行：node tests/acceptance/suite-statusqueue-core.mjs
 * 退出码：0=全绿；1=有真实失败；2=套件级致命错误（禁止把语法/导入错误当作红相）
 *
 * 纪律（test-expert L2）：
 *   1. 每条断言携带「期望 vs 实际」，禁止无断言验收。
 *   2. 不吞异常：纯函数抛错按断言失败记账（打印原始错误信息）。
 *   3. 全部用例高隔离：临时 DSH_HOME + 临时工作区根，零真实宿主 / 零真实 LLM。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ARTIFACT_DIR,
  assertEqual,
  assertFalse,
  assertNonEmptyArray,
  assertOk,
  assertTrue,
  cleanupTempDirs,
  createRunner,
  createWorkspace,
  fail,
  findSessionRow,
  fmtMs,
  launchMock,
  request,
  seedSession,
  tempDir,
  waitFor,
} from './lib/harness.mjs';
import { hasPendingQuestionFromEvents } from '../../lib/session-waiting.mjs';

const runner = createRunner('STATUSQUEUE-CORE');

const enc = (v) => encodeURIComponent(v);
const sessionsUrl = (cwd) => '/api/sessions?cwd=' + enc(cwd) + '&refresh=1';
const statusUrl = (sid) => '/api/sessions/status?ids=' + enc(sid);

// ─────────────────────────── 合成转录工具（zstd 帧拼接口径） ───────────────────────────

const ZSTD_MAGIC = 0xfd2fb528;

/** 与 server.mjs scanZstdFrames 同口径的帧扫描（多帧拼接文件合法，服务端按 magic 扫描）。 */
function scanZstdFrames(buffer) {
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
    if ((descriptor & 0x18) !== 0) break;
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
  }
  return frames;
}

/** 定位 mock 宿主 DSH_HOME 下该会话的 zstd 转录（projectKey 布局，深搜 sid 目录）。 */
function findSessionTranscript(dshHome, sid) {
  const root = path.join(dshHome, 'sessions');
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd') && p.split(path.sep).includes(sid)) found.push(p);
    }
  };
  walk(root);
  assertNonEmptyArray(found, 'mock 宿主必须落盘会话 zstd 转录 (sid=' + sid + ', root=' + root + ')');
  return found[0];
}

/** 解压全部帧 → 追加合成事件行 → 以单帧写回（服务端 scanZstdFrames 同样可读）。 */
function appendTranscriptEvents(file, events) {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  assertNonEmptyArray(frames, '转录文件必须含合法 zstd 帧: ' + file);
  let text = '';
  for (const f of frames) text += zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
  if (text && !text.endsWith('\n')) text += '\n';
  text += events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  const st = fs.statSync(file);
  return { file, size: st.size, mtimeMs: st.mtimeMs, events: events.length };
}

/** 造「未结算 ask_user_question」的合成事件（对齐 dsh 转录口径：data.callId/data.name/data.arguments）。 */
function pendingQuestionCallEvents() {
  return [
    {
      type: 'tool/call',
      seq: 900,
      time: Date.now(),
      data: {
        callId: 'call_wait_1',
        name: 'ask_user_question',
        arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'confirm?' }] }),
      },
    },
  ];
}

/** 结算同一 callId（生产转录口径：data.message.source.callId）。 */
function settleQuestionResultEvents() {
  return [
    {
      type: 'tool/result',
      seq: 901,
      time: Date.now(),
      data: {
        message: { source: { callId: 'call_wait_1' } },
        content: [{ toolCallId: 'call_wait_1' }],
        isError: false,
      },
    },
  ];
}

/** 纯函数调用：非 boolean 或抛异常一律按断言失败记账（不吞、不伪造）。 */
function invokePure(lines, label) {
  let verdict;
  try {
    verdict = hasPendingQuestionFromEvents(lines);
  } catch (err) {
    fail(label + ' 调用抛异常', '返回 boolean（C-2 纯函数，零副作用）', (err && err.message) || String(err));
  }
  assertOk(typeof verdict === 'boolean', label + ' 返回类型必须为 boolean', 'boolean', typeof verdict + ' / ' + String(verdict));
  return verdict;
}

async function fetchRow(srv, cwd, sid, label) {
  const res = await request(srv.base, sessionsUrl(cwd), { timeoutMs: 20000 });
  assertEqual(res.status, 200, label + ' GET /api/sessions 状态码');
  const row = findSessionRow(res.body, sid);
  assertOk(!!row, label + ' 会话行必须存在于 /api/sessions（磁盘 zstd 转录 + 注册表）', '含 id=' + sid + ' 的行', res.body);
  return { res, row };
}

async function main() {
  console.log('# Q20 验收套件 STATUSQUEUE-CORE (A1–A4) — 契约 .dev-team/contract-wave-2026-10-19.md');
  console.log('# 时间: ' + new Date().toISOString());

  // ── A1: 纯函数 hasPendingQuestionFromEvents（无需服务器）─────────────────
  await runner.run('A1 纯函数：未结算 ask_user_question → true；同 callId 结算 → false；无提问 → false；JSON 字符串行亦支持', async () => {
    const call = pendingQuestionCallEvents()[0];
    const resultMsgSource = settleQuestionResultEvents()[0];

    // ① 未结算 → true
    assertTrue(invokePure([call], 'A1 未结算提问'), 'A1 未结算 ask_user_question 必须判定为等待作答 (true)');

    // ② 同 callId 有 tool/result（生产口径 data.message.source.callId）→ false
    assertFalse(invokePure([call, resultMsgSource], 'A1 已结算提问'), 'A1 同 callId 已结算后必须判定为非等待 (false)');

    // ③ 同 callId 结算（简化口径 data.callId）→ false
    const resultFlat = { type: 'tool/result', seq: 903, time: Date.now(), data: { callId: 'call_wait_1', isError: false } };
    assertFalse(invokePure([call, resultFlat], 'A1 已结算提问(data.callId)'), 'A1 data.callId 结算后必须判定为非等待 (false)');

    // ④ 无提问 → false
    const plainUser = { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: 'hello' }] } };
    assertFalse(invokePure([plainUser], 'A1 无提问'), 'A1 无 ask_user_question 的转录必须判定为非等待 (false)');

    // ⑤ 其它工具调用未结算也 → false（不可误判）
    const otherTool = { type: 'tool/call', seq: 2, time: Date.now(), data: { callId: 'call_bash_1', name: 'bash', arguments: '{}' } };
    assertFalse(invokePure([otherTool], 'A1 非提问工具'), 'A1 非 ask_user_question 的工具调用必须判定为非等待 (false)');

    // ⑥ JSON 字符串行输入 → true
    const jsonLines = [JSON.stringify(call)];
    assertTrue(invokePure(jsonLines, 'A1 JSON 字符串行'), 'A1 JSON 字符串行输入必须支持并判定为等待作答 (true)');
    assertFalse(invokePure([JSON.stringify(call), JSON.stringify(resultMsgSource)], 'A1 JSON 字符串行已结算'),
      'A1 JSON 字符串行输入下的已结算提问必须判定为非等待 (false)');

    // ⑦ 空输入 → false（边界）
    assertFalse(invokePure([], 'A1 空数组'), 'A1 空事件数组必须判定为非等待 (false)');

    return '7 组纯函数断言';
  });

  // ── A2: mock 宿主 + 未结算 ask_user_question 转录 → 行 waiting ───────────
  await runner.run('A2 mock：含未结算 ask_user_question 的会话行 state=waiting && pendingInteraction=question && isRunning=true', async () => {
    const sid = 'session-acc-sq-a2-0001';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-sq-a2-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-sq-a2');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const file = findSessionTranscript(srv.dshHome, sid);
      const written = appendTranscriptEvents(file, pendingQuestionCallEvents());

      // 接缝活性证据：必须先证明服务端真的读到了合成追加的事件行，否则后续断言可能空洞通过
      const hist = await request(srv.base, '/api/history?cwd=' + enc(cwd) + '&id=' + enc(sid), { timeoutMs: 20000 });
      assertEqual(hist.status, 200, 'A2 GET /api/history 状态码');
      const histFlat = JSON.stringify(hist.body || {});
      assertOk(histFlat.includes('ask_user_question') && histFlat.includes('call_wait_1'),
        'A2 接缝活性：服务端必须解析到追加的 tool/call 行（zstd 重写可读）',
        'history 含 ask_user_question/call_wait_1', histFlat.slice(0, 300));

      const { res, row } = await fetchRow(srv, cwd, sid, 'A2');
      assertTrue(row.isRunning === true, 'A2 行 isRunning（waiting 与会话运行正交，C-2 明确保持 true）');
      assertEqual(row.pendingInteraction, 'question', 'A2 行 pendingInteraction');
      assertEqual(row.state, 'waiting', 'A2 行 state（C-2：isRunning=true 且等待作答 → waiting）');
      return 'time=' + fmtMs(res.ms) + ' state=' + row.state + ' pendingInteraction=' + row.pendingInteraction
        + ' transcript=' + path.basename(written.file) + ' size=' + written.size;
    } finally {
      await srv.stop();
    }
  });

  // ── A3: 同一会话提问结算后不得残留 waiting ──────────────────────────────
  await runner.run('A3 mock：同 callId tool/result 结算后不残留 waiting（running 时回到 state=running）', async () => {
    const sid = 'session-acc-sq-a3-0001';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-sq-a3-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-sq-a3');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const file = findSessionTranscript(srv.dshHome, sid);
      appendTranscriptEvents(file, pendingQuestionCallEvents());

      // 前置：先证明在结算前确实处于 waiting（否则 A3 会空洞通过 = 假测试）
      const before = await fetchRow(srv, cwd, sid, 'A3 结算前');
      assertEqual(before.row.state, 'waiting', 'A3 结算前必须先进入 waiting（前置条件，防空洞断言）');
      assertEqual(before.row.pendingInteraction, 'question', 'A3 结算前 pendingInteraction');

      // 结算：追加 tool/result 并重写（帧 size/mtime 变化即失效 (path:mtime:size) 缓存）
      appendTranscriptEvents(file, settleQuestionResultEvents());

      // 契约 C-2 允许 (path:mtime:size)+2s TTL 缓存 → 显式条件轮询（非盲 sleep）
      const after = await waitFor(async () => {
        const r = await fetchRow(srv, cwd, sid, 'A3 结算后');
        return r.row.state === 'waiting' || r.row.pendingInteraction ? null : r;
      }, { timeoutMs: 6000, intervalMs: 200, label: 'A3 结算后脱离 waiting' });

      assertEqual(after.row.state, 'running', 'A3 结算后行 state（会话仍 running → 回到 running，不得残留 waiting）');
      assertOk(!after.row.pendingInteraction, 'A3 结算后不得输出 pendingInteraction',
        'undefined/null', after.row.pendingInteraction);
      assertTrue(after.row.isRunning === true, 'A3 结算后 isRunning 仍为 true');
      return 'before=waiting after=' + after.row.state + ' pendingInteraction=' + String(after.row.pendingInteraction);
    } finally {
      await srv.stop();
    }
  });

  // ── A4: /api/sessions/status 与 A2 同口径 ───────────────────────────────
  await runner.run('A4 mock：/api/sessions/status?ids= 对等待作答会话返回 state=waiting（与 A2 同口径）', async () => {
    const sid = 'session-acc-sq-a4-0001';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-sq-a4-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-sq-a4');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const file = findSessionTranscript(srv.dshHome, sid);
      appendTranscriptEvents(file, pendingQuestionCallEvents());

      // 先对 /api/sessions 取证，保证 status 与列表是同一事实（C-2 单点口径）
      const { row } = await fetchRow(srv, cwd, sid, 'A4');
      assertEqual(row.state, 'waiting', 'A4 前置：/api/sessions 行必须为 waiting（单点口径）');

      const res = await request(srv.base, statusUrl(sid), { timeoutMs: 20000 });
      assertEqual(res.status, 200, 'A4 GET /api/sessions/status 状态码');
      assertOk(res.body && res.body.states && typeof res.body.states === 'object',
        'A4 响应必须含 states 对象', '{states:{<sid>:{...}}}', res.body);
      const fact = res.body.states[sid];
      assertOk(!!fact, 'A4 states 必须包含请求的 sid', 'states[' + sid + '] 存在', Object.keys(res.body.states));
      assertEqual(fact.state, 'waiting', 'A4 status.state（与 /api/sessions 同口径）');
      assertEqual(fact.pendingInteraction, 'question', 'A4 status.pendingInteraction');
      assertTrue(fact.isRunning === true, 'A4 status.isRunning（waiting 下仍可停止）');
      return 'time=' + fmtMs(res.ms) + ' state=' + fact.state + ' isRunning=' + fact.isRunning;
    } finally {
      await srv.stop();
    }
  });

  const { failCount, degradedCount } = runner.report();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[STATUSQUEUE-CORE SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
