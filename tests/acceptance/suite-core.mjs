/**
 * Q20 Wave 2026-10-16 验收套件（核心）：A1–A7 + A10
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约：.dev-team/contract-wave-2026-10-16.md §1.2 C-1…C-8 / §1.4 接缝 / §3 验收矩阵
 * 运行：node tests/acceptance/suite-core.mjs
 * 退出码：0=全绿；非 0=有失败（失败必须是真实断言失败，禁止语法/导入错误）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ARTIFACT_DIR, LIMITS, REPO_ROOT,
  assertEqual, assertOk, assertTrue, assertLt, assertNonEmptyArray,
  cleanupTempDirs, countRpc, createRunner, createWorkspace, fail, findSessionRow, fmtMs,
  launchMock, readRpcLog, redact, request, requireSeam, seedSession, skip, tempDir, waitFor,
} from './lib/harness.mjs';

const require = createRequire(import.meta.url);
const runner = createRunner('CORE');

const enc = (v) => encodeURIComponent(v);
const sessionsUrl = (cwd) => '/api/sessions?cwd=' + enc(cwd) + '&refresh=1';

/** 造行 + 断言 running 的共用流程（A1/A2/A3 同口径）。 */
async function assertRunningRow(base, cwd, sid, label) {
  const res = await request(base, sessionsUrl(cwd), { timeoutMs: 20000 });
  assertEqual(res.status, 200, label + ' GET /api/sessions 状态码');
  const row = findSessionRow(res.body, sid);
  assertOk(!!row, label + ' 会话行必须存在于 /api/sessions（磁盘 zstd 转录 + 注册表）',
    '含 id=' + sid + ' 的行', res.body);
  assertTrue(row.isRunning === true, label + ' 行 isRunning');
  assertEqual(row.state, 'running', label + ' 行 state（C-5 与 isRunning 同源）');
  return { res, row };
}

async function main() {
  console.log('# Q20 验收套件 CORE (A1–A7, A10) — 契约 .dev-team/contract-wave-2026-10-16.md');
  console.log('# 时间: ' + new Date().toISOString());

  // ── A1: mock + RUNNING_SESSIONS → /api/sessions 报 running ────────────────
  await runner.run('A1 运行真源：RUNNING_SESSIONS 下 /api/sessions 报 isRunning=true/state=running', async () => {
    const sid = 'session-acc-a1-0001';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-a1-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a1');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const { res, row } = await assertRunningRow(srv.base, cwd, sid, 'A1');
      return 'time=' + fmtMs(res.ms) + ' isRunning=' + row.isRunning + ' state=' + row.state;
    } finally {
      await srv.stop();
    }
  });

  // ── A2: mock + RUNNING_SESSIONS + LIST_FAIL=1 → 同 A1（L2-AT 对抗注入）───
  await runner.run('A2 对抗注入 session/list 不可达（LIST_FAIL=1）：running 真源不得依赖 session/list 成功', async () => {
    const sid = 'session-acc-a2-0001';
    const srv = await launchMock({ running: [sid], listFail: true, workspaceRoot: tempDir('q20-acc-a2-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a2');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const { res, row } = await assertRunningRow(srv.base, cwd, sid, 'A2');
      return 'time=' + fmtMs(res.ms) + ' isRunning=' + row.isRunning + ' state=' + row.state;
    } finally {
      await srv.stop();
    }
  });

  // ── A3: mock + LIST_DELAY_MS=8000 → 热路径不阻塞（C-3 ≤1500ms）──────────
  await runner.run('A3 对抗注入 session/list 慢链路（LIST_DELAY_MS=8000）：/api/sessions 单次 <1500ms 且仍报 running', async () => {
    const sid = 'session-acc-a3-0001';
    const rpcLog = path.join(tempDir('q20-acc-rpc-'), 'rpc.log');
    const srv = await launchMock({ running: [sid], listDelayMs: 8000, rpcLog, workspaceRoot: tempDir('q20-acc-a3-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a3');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const { res, row } = await assertRunningRow(srv.base, cwd, sid, 'A3');
      assertLt(res.ms, LIMITS.sessionsP95Ms, 'A3 /api/sessions 单次响应耗时（C-3 P95 ≤1500ms）');
      // 接缝活性证据（SEAM-MISSING 类）：LIST_DELAY_MS 必须真的注入，否则耗时断言可能空洞通过
      let entries = null;
      const seamDeadline = Date.now() + 12000;
      while (Date.now() < seamDeadline && !entries) {
        const e = readRpcLog(rpcLog);
        if (e && countRpc(e, 'session/list') > 0) entries = e;
        else await new Promise((r) => setTimeout(r, 200));
      }
      requireSeam(!!entries, 'A3 Q20_MOCK_HOST_LIST_DELAY_MS/RPC_LOG 接缝活性（RPC_LOG 必须记录 session/list）',
        'RPC_LOG 含 ≥1 条 method=session/list', '12s 内未出现; RPC_LOG=' + redact(JSON.stringify(readRpcLog(rpcLog))));
      return 'time=' + fmtMs(res.ms) + ' isRunning=' + row.isRunning + ' state=' + row.state
        + ' rpcLogSessionList=' + countRpc(entries, 'session/list');
    } finally {
      await srv.stop();
    }
  });

  // ── A4: LIST_FAIL=1 + 3 次 /api/sessions → session/list 调用 ≤1（C-1/C-2）─
  await runner.run('A4 单一在飞 + 失败退避：LIST_FAIL=1 下连续 3 次 /api/sessions，共享主通道 session/list 调用 ≤1', async () => {
    const sid = 'session-acc-a4-0001';
    const rpcLog = path.join(tempDir('q20-acc-rpc-'), 'rpc.log');
    const srv = await launchMock({ running: [sid], listFail: true, rpcLog, workspaceRoot: tempDir('q20-acc-a4-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a4');
      await seedSession(srv.base, { cwd, sessionId: sid });
      // 接缝活性（SEAM-MISSING 类）：RPC_LOG 必须由 mock 真实写入，否则计数断言空洞通过
      let logged = null;
      const seamDeadline = Date.now() + 5000;
      while (Date.now() < seamDeadline && !logged) {
        const e = readRpcLog(rpcLog);
        if (e && e.length > 0) logged = e;
        else await new Promise((r) => setTimeout(r, 150));
      }
      requireSeam(!!logged, 'A4 Q20_MOCK_HOST_RPC_LOG 接缝活性（mock 必须写入 RPC 收据）',
        'RPC_LOG 文件存在且 ≥1 条记录', '5s 内未写入/为空: ' + redact(rpcLog));
      // 等启动播种的 session/list 落账后再清零计数窗口，避免把冷启动播种算进窗口
      try {
        await waitFor(() => {
          const e = readRpcLog(rpcLog);
          return e && countRpc(e, 'session/list') > 0;
        }, { timeoutMs: 5000, intervalMs: 150, label: 'startup seed' });
      } catch { /* C-11 播种非本用例断言项：窗口内计数仍以 ≤1 判定 */ }
      fs.writeFileSync(rpcLog, '');

      const calls = [];
      for (let i = 0; i < 3; i++) {
        const r = await request(srv.base, sessionsUrl(cwd), { timeoutMs: 20000 });
        assertEqual(r.status, 200, 'A4 第 ' + (i + 1) + ' 次 GET /api/sessions 状态码');
        calls.push(Math.round(r.ms));
      }
      await new Promise((r) => setTimeout(r, 1200)); // 让后台刷新/在途请求落账
      const after = readRpcLog(rpcLog) || [];
      const n = countRpc(after, 'session/list');
      assertOk(n <= LIMITS.listRpcMax, 'A4 共享主通道 session/list 调用次数（C-1 单一在飞 + C-2 失败退避 ≥60s）',
        '≤ ' + LIMITS.listRpcMax, n + ' 次 (methods=' + JSON.stringify(after.map((e) => e.method)) + ')');
      return '3 次 /api/sessions 耗时=' + JSON.stringify(calls) + 'ms, session/list=' + n + ' 次';
    } finally {
      await srv.stop();
    }
  });

  // ── A5: SUBAGENTS + LIST_FAIL=1 → /api/session/subagents 非空（C-6）──────
  await runner.run('A5 子智能体真源：LIST_FAIL=1 下 /api/session/subagents?id=<parent> 仍含 SUBAGENTS 子会话', async () => {
    const parent = 'session-acc-a5-parent';
    const child = 'session-acc-a5-child';
    const wsRoot = tempDir('q20-acc-a5-');
    const wsPath = path.join(wsRoot, 'ws-a5');
    const srv = await launchMock({
      running: [parent],
      listFail: true,
      workspaceRoot: wsRoot,
      subagents: [{ sessionId: child, parentSessionId: parent, origin: 'subagent', cwd: wsPath, title: 'acc-child-a5', running: true }],
    });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a5');
      await seedSession(srv.base, { cwd, sessionId: parent });
      const res = await request(srv.base, '/api/session/subagents?cwd=' + enc(cwd) + '&id=' + enc(parent), { timeoutMs: 20000 });
      assertEqual(res.status, 200, 'A5 GET /api/session/subagents 状态码');
      const subs = assertNonEmptyArray(res.body && res.body.subagents,
        'A5 subagents 必须非空（live 镜像 parentSessionId 兜底，即使 session/list 不可用）');
      const hit = subs.find((s) => s && (s.id === child || s.sessionId === child));
      assertOk(!!hit, 'A5 子会话必须出现在 subagents 中', '含 id=' + child + ' 的元素', subs.map((s) => s && s.id));
      return 'subagents=' + subs.length + ' time=' + fmtMs(res.ms);
    } finally {
      await srv.stop();
    }
  });

  // ── A6: RUNNING_SESSIONS → POST /api/session/prompt {mode:'steer'} ok:true ─
  await runner.run("A6 插队闸门（C-7）：live 镜像判定 running 时 POST /api/session/prompt {mode:'steer'} 返回 ok:true", async () => {
    const sid = 'session-acc-a6-0001';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-a6-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a6');
      await seedSession(srv.base, { cwd, sessionId: sid });
      const res = await request(srv.base, '/api/session/prompt', {
        method: 'POST',
        body: { sessionId: sid, prompt: 'acceptance steer probe', mode: 'steer' },
        timeoutMs: 20000,
      });
      assertEqual(res.status, 200, 'A6 POST /api/session/prompt 状态码');
      assertOk(res.body && res.body.ok === true, "A6 steer 必须放行（不得因 session/list 失败/未跑而拒绝）",
        '{ok:true}', res.body);
      return 'ok=' + res.body.ok + ' mode=' + res.body.mode + ' time=' + fmtMs(res.ms);
    } finally {
      await srv.stop();
    }
  });

  // ── A7: GET /api/sessions/status（C-8：纯内存、零宿主 RPC、<300ms）────────
  await runner.run('A7 轻量状态端点（C-8）：/api/sessions/status?ids=<sid> → isRunning=true 且 <300ms', async () => {
    const sid = 'session-acc-a7-0001';
    const unknown = 'session-acc-a7-unknown';
    const srv = await launchMock({ running: [sid], workspaceRoot: tempDir('q20-acc-a7-') });
    try {
      const cwd = await createWorkspace(srv.base, 'ws-a7');
      await seedSession(srv.base, { cwd, sessionId: sid });

      const res = await request(srv.base, '/api/sessions/status?ids=' + enc(sid), { timeoutMs: 10000 });
      assertEqual(res.status, 200, 'A7 GET /api/sessions/status 状态码');
      assertOk(res.body && res.body.ok === true, 'A7 响应体 ok', '{ok:true}', res.body);
      assertOk(typeof res.body.at === 'number' && res.body.at > 0, 'A7 响应体 at 为毫秒时间戳', 'number > 0', res.body && res.body.at);
      const st = res.body.states && res.body.states[sid];
      assertOk(!!st, 'A7 states 必须含请求的 sid', 'states[' + sid + '] 存在', res.body && res.body.states);
      assertTrue(st.isRunning === true, 'A7 states[sid].isRunning');
      assertEqual(st.state, 'running', 'A7 states[sid].state');
      assertLt(res.ms, LIMITS.statusMs, 'A7 /api/sessions/status 单次响应耗时（C-8 纯内存零宿主 RPC）');

      // C-8 边界：未知 sid → {isRunning:false, state:'idle'}
      const unkRes = await request(srv.base, '/api/sessions/status?ids=' + enc(unknown), { timeoutMs: 10000 });
      assertEqual(unkRes.status, 200, 'A7 未知 sid 状态码');
      const unk = unkRes.body && unkRes.body.states && unkRes.body.states[unknown];
      assertOk(!!unk, 'A7 未知 sid 必须返回条目', 'states[' + unknown + '] 存在', unkRes.body);
      assertTrue(unk.isRunning === false, 'A7 未知 sid isRunning');
      assertEqual(unk.state, 'idle', 'A7 未知 sid state');

      // C-8 边界：ids 为空 → states:{}
      const emptyRes = await request(srv.base, '/api/sessions/status?ids=', { timeoutMs: 10000 });
      assertEqual(emptyRes.status, 200, 'A7 空 ids 状态码');
      assertOk(emptyRes.body && emptyRes.body.states && Object.keys(emptyRes.body.states).length === 0,
        'A7 空 ids 必须返回 states:{}', '{}', emptyRes.body && emptyRes.body.states);

      // C-8 边界：缺失 ids → 400
      const missRes = await request(srv.base, '/api/sessions/status', { timeoutMs: 10000 });
      assertEqual(missRes.status, 400, 'A7 缺失 ids 必须 400');

      return 'time=' + fmtMs(res.ms) + ' isRunning=' + st.isRunning + ' state=' + st.state + ' (含 C-8 边界 3 项)';
    } finally {
      await srv.stop();
    }
  });

  // ── A10: ES5 门禁（acorn ecmaVersion:5）───────────────────────────────────
  await runner.run('A10 ES5 门禁：static/index.html 内联脚本通过 acorn {ecmaVersion:5}', async () => {
    let acorn;
    try {
      acorn = require('acorn');
    } catch (err) {
      skip('acorn 不可用 (' + err.code + ')：ES5 门禁无法机器判定');
    }
    const file = path.join(REPO_ROOT, 'static', 'index.html');
    assertOk(fs.existsSync(file), 'A10 static/index.html 必须存在', redact(file), '(missing)');
    const html = fs.readFileSync(file, 'utf8');
    const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
    const inline = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] || '';
      if (/\ssrc\s*=/.test(attrs)) continue;
      inline.push(m[2]);
    }
    assertNonEmptyArray(inline, 'A10 必须存在内联 <script> 块');
    for (let i = 0; i < inline.length; i++) {
      try {
        acorn.parse(inline[i], { ecmaVersion: 5 });
      } catch (err) {
        fail('A10 内联脚本 #' + (i + 1) + ' ES5 解析', 'acorn {ecmaVersion:5} PASS', err.message);
      }
    }
    return 'ES5 PASS (' + inline.length + ' 个内联 script, acorn ' + acorn.version + ')';
  });

  const { failCount, degradedCount } = runner.report();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[CORE SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
