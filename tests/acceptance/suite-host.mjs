/**
 * Q20 Wave 2026-10-16 验收套件（生产态 A8）：真宿主一致性
 * Owner: test-agent（冻结件，Executor 只读）
 *
 * 契约：.dev-team/contract-wave-2026-10-16.md §3 A8
 *   对真实 running 会话，/api/sessions/status 与 /api/sessions 一致报 running。
 *
 * 运行：node tests/acceptance/suite-host.mjs
 *   Q20_ACCEPT_BASE           生产态 Q20 实例（默认 http://127.0.0.1:3090）
 *   Q20_ACCEPT_RUNNING_SID    可选：已知正在运行的会话 id（建议在自身回合运行中传入）
 *                             —— 传入后为硬断言模式（该会话必须被两个端点一致报 running）
 *
 * 就绪探测（Lead 裁决）：/healthz + GET /api/sessions?cwd=... 双探，客户端超时 ≥15000ms。
 * 环境不具备 → 显式 SKIP（[RED DEGRADED: ...]，不计 PASS/FAIL，套件退出码 3，绝不伪装成绿）。
 * 环境具备而断言不成立 → FAIL，退出码 1。
 */
import {
  LIMITS, assertEqual, assertOk, assertTrue, assertLt,
  cleanupTempDirs, createRunner, fmtMs, redact, request, skip,
} from './lib/harness.mjs';

const BASE = process.env.Q20_ACCEPT_BASE || 'http://127.0.0.1:3090';
const HINT_SID = process.env.Q20_ACCEPT_RUNNING_SID || '';
const runner = createRunner('HOST');
const enc = (v) => encodeURIComponent(v);
const MAX_WORKSPACES = HINT_SID ? 8 : 4;
const PROBE_TIMEOUT_MS = 20000;   // ≥15000ms（Lead 裁决）
const SAMPLES_TIMEOUT_MS = 60000;

/** 失败诊断（Lead 裁决）：暴露实际观测到的终态推断与 mtime 新鲜度，便于定位 C-20/C-11 覆盖情况。 */
function rowDiag(x) {
  if (!x || !x.row) return '(no row)';
  const r = x.row;
  const age = (typeof r.updatedAt === 'number' && r.updatedAt > 0) ? Math.round(Date.now() - r.updatedAt) + 'ms' : 'n/a';
  return 'id=' + r.id + ' isRunning=' + r.isRunning + ' state=' + r.state
    + ' updatedAt=' + r.updatedAt + ' (mtime age=' + age + ') cwd=' + redact(r.cwd || x.cwd);
}

async function main() {
  console.log('# Q20 验收套件 HOST (A8 真宿主一致性) — BASE=' + BASE
    + (HINT_SID ? ' HINT_SID=' + HINT_SID : ' (未提供 Q20_ACCEPT_RUNNING_SID，采样模式)'));
  console.log('# 时间: ' + new Date().toISOString());

  await runner.run('A8 生产态：/api/sessions/status 与 /api/sessions 对真实 running 会话一致（且 <300ms）', async () => {
    // 1) 就绪探测（一）：/healthz
    let hz;
    try {
      hz = await request(BASE, '/healthz', { timeoutMs: PROBE_TIMEOUT_MS });
    } catch (err) {
      skip('生产实例 /healthz 不可达: ' + err.message);
    }
    if (hz.status !== 200) skip('生产实例 /healthz 异常: HTTP ' + hz.status);

    // 2) 宿主存活
    let status;
    try {
      status = await request(BASE, '/api/dsh/status', { timeoutMs: PROBE_TIMEOUT_MS });
    } catch (err) {
      skip('GET /api/dsh/status 失败: ' + err.message);
    }
    if (status.status !== 200 || !status.body || status.body.dshAlive !== true) {
      skip('宿主离线或实例异常 (HTTP ' + status.status + ', body=' + JSON.stringify(status.body) + ')');
    }

    // 3) 工作区清单
    let boot;
    try {
      boot = await request(BASE, '/api/bootstrap', { timeoutMs: 30000 });
    } catch (err) {
      skip('GET /api/bootstrap 失败: ' + err.message);
    }
    const workspaces = (boot.body && Array.isArray(boot.body.workspaces)) ? boot.body.workspaces : [];
    if (!workspaces.length) skip('/api/bootstrap 未返回任何工作区，无法采样真实会话');
    const ordered = workspaces.slice().sort((a, b) => {
      const prefer = (w) => (w && w.cwd && w.cwd.indexOf('dsh-q20-web') >= 0 ? 0 : 1);
      return prefer(a) - prefer(b);
    }).slice(0, MAX_WORKSPACES);

    // 4) 就绪探测（二）+ 采样：直接用 GET /api/sessions?cwd=...（客户端超时 60s）
    const rows = [];
    const sampledCwds = [];
    const sampleErrors = [];
    for (const ws of ordered) {
      if (!ws || !ws.cwd) continue;
      sampledCwds.push(ws.cwd);
      try {
        const r = await request(BASE, '/api/sessions?cwd=' + enc(ws.cwd) + '&refresh=1', { timeoutMs: SAMPLES_TIMEOUT_MS });
        if (r.status === 200 && Array.isArray(r.body)) {
          for (const row of r.body) rows.push({ row, cwd: ws.cwd });
        } else {
          sampleErrors.push(redact(ws.cwd) + ' → HTTP ' + r.status);
        }
        if (HINT_SID && rows.some((x) => x.row && x.row.id === HINT_SID)) break;
      } catch (err) {
        sampleErrors.push(redact(ws.cwd) + ' → ' + redact(err.message));
      }
    }
    if (!rows.length) {
      skip('GET /api/sessions 采样 ' + sampledCwds.length + ' 个工作区未取到任何会话行'
        + (sampleErrors.length ? '；错误: ' + sampleErrors.join(' | ') : ''));
    }

    // 5) 选定被验证的 running 集合
    let targets = rows.filter((x) => x.row && x.row.isRunning === true);
    if (HINT_SID) {
      const hinted = rows.find((x) => x.row && x.row.id === HINT_SID);
      assertOk(!!hinted, 'A8 指定的 running 会话必须出现在采样到的 /api/sessions 中',
        '含 id=' + HINT_SID + ' 的行', '未命中; 采样 cwd=' + redact(JSON.stringify(sampledCwds))
          + '; 采样 sid=' + JSON.stringify(rows.map((x) => x.row.id).slice(0, 30)));
      assertTrue(hinted.row.isRunning === true,
        'A8 指定会话 /api/sessions 行 isRunning [诊断 ' + rowDiag(hinted) + ']');
      assertEqual(hinted.row.state, 'running',
        'A8 指定会话 /api/sessions 行 state [诊断 ' + rowDiag(hinted) + ']');
      targets = [hinted];
    } else if (!targets.length) {
      skip('采样 ' + rows.length + ' 行真实会话，窗口内无 running 会话可验证；诊断: '
        + rows.slice(0, 3).map(rowDiag).join(' | ')
        + '；如需硬断言请设 Q20_ACCEPT_RUNNING_SID=<正在运行的会话 id>（建议在自身回合运行中执行）');
    }

    // 6) 状态端点一致性（running 行为硬断言）
    const ids = targets.map((x) => x.row.id);
    const st = await request(BASE, '/api/sessions/status?ids=' + enc(ids.join(',')), { timeoutMs: PROBE_TIMEOUT_MS });
    console.log('  (status 诊断: HTTP ' + st.status + ' raw=' + redact(String(st.raw || '').slice(0, 300)) + ')');
    assertEqual(st.status, 200, 'A8 GET /api/sessions/status 状态码');
    assertOk(st.body && st.body.ok === true, 'A8 响应体 ok', '{ok:true}',
      st.body === null ? String(st.raw || '').slice(0, 200) : st.body);
    for (const id of ids) {
      const s = st.body.states && st.body.states[id];
      assertOk(!!s, 'A8 states 必须含真实 running 会话 ' + id, 'states[' + id + '] 存在', st.body && st.body.states);
      assertTrue(s.isRunning === true, 'A8 真实 running 会话 ' + id + ' 的 isRunning [status=' + JSON.stringify(s) + ']');
      assertEqual(s.state, 'running', 'A8 真实 running 会话 ' + id + ' 的 state [status=' + JSON.stringify(s) + ']');
    }
    assertLt(st.ms, LIMITS.statusMs, 'A8 /api/sessions/status 单次响应耗时（C-8 纯内存零宿主 RPC）');

    // 7) 全量一致性（采样到的所有行都必须与状态端点一致）
    const sample = rows.slice(0, 60);
    const allSt = await request(BASE, '/api/sessions/status?ids=' + enc(sample.map((x) => x.row.id).join(',')), { timeoutMs: PROBE_TIMEOUT_MS });
    assertEqual(allSt.status, 200, 'A8 全量一致性查询状态码');
    for (const x of sample) {
      const s = allSt.body.states && allSt.body.states[x.row.id];
      assertOk(!!s, 'A8 states 必须含采样会话 ' + x.row.id, 'states[' + x.row.id + '] 存在', allSt.body && allSt.body.states);
      assertEqual(s.isRunning, x.row.isRunning === true,
        'A8 状态端点与 /api/sessions 的 isRunning 必须一致 (' + x.row.id + ')');
    }

    return 'sampled=' + rows.length + ' running=' + ids.length + ' statusTime=' + fmtMs(st.ms)
      + (HINT_SID ? ' (hint=' + HINT_SID + ')' : '');
  });

  const { failCount, degradedCount } = runner.report();
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[HOST SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
