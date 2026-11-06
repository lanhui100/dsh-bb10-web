/**
 * Q20 Wave 2026-11-06 验收套件：preview-policy（L2-T 功能契约）
 * Owner: test-agent（独立验收方，冻结件；Executor 只读，绝不可改）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-11-06.md
 *   §1.1 纯函数签名/字段（含 requestCwd）· §1.2 错误码表 · §1.3 /api/file 处理顺序
 *   §1.4 测试接缝（PROJECTIONS / _FAIL / _DELAY_MS）· §2 决策顺序真值表 · §3 验收矩阵 A1–A9
 *   + 契约 amend R-4（敏感路径 denylist → PREVIEW_SENSITIVE_PATH）/ R-5（归属不可核验 fail-closed）
 *   + R-6（未注册 cwd 一律 b 步越界文案）/ Gate-1 ADVISORY ⑤（客户端接线静态断言）
 *   → 本套件 A1–A13
 *
 * 运行：node tests/acceptance/suite-preview-policy.mjs
 * 退出码：0=全绿；1=存在真实断言失败；3=显式 SKIP(DEGRADED)；2=套件启动失败
 *   —— 红相必须是「断言失败」，不得是 import / SYNTAX 失败。
 *
 * 纪律（test-expert L2-T + L2-AT）：
 *   1. 每条断言携带「期望 vs 实际」；纯函数 throw 视为断言失败（契约 §1.1 永不 throw）。
 *   2. 隔离：每用例独立 mock 实例（临时 DSH_HOME + 临时工作区根），零真实宿主 / 零真实 LLM / 零 ~/ 污染。
 *   3. 接缝活性（SEAM-MISSING）与行为断言分列：接缝不存在不算「实现行为判负」。
 *   4. 禁止 skip 冒充 PASS；禁止无断言用例。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decidePreviewReadAccess, FULL_ACCESS_POLICY } from '../../lib/preview-policy.mjs';
import {
  ARTIFACT_DIR, REPO_ROOT,
  assertEqual, assertFalse, assertOk, cleanupTempDirs, createRunner, fail, redact, tempDir,
} from './lib/harness.mjs';
import {
  countRpcMethod, launchPreviewHost, openPreviewWorkspace, rawRequest, waitForLog,
} from './lib/preview-host.mjs';

const runner = createRunner('PREVIEW-POLICY');

const enc = (v) => encodeURIComponent(v);
const fileUrl = (cwd, p) => '/api/file?cwd=' + enc(cwd) + '&path=' + enc(p);
const fileUrlSession = (cwd, p, sid) => fileUrl(cwd, p) + '&session=' + enc(sid);
const projEnv = (obj) => ({ Q20_MOCK_HOST_PROJECTIONS: JSON.stringify(obj) });
const FULL = FULL_ACCESS_POLICY;
const WRITE = 'workspace-write';

/** A6 向后兼容铁律的基线响应体（契约 §1.3 铁律 / R-2：逐字节等价，不含 code）。 */
const LEGACY_ESCAPE_BODY = '{"ok":false,"error":"path escapes the workspace root"}';
/** 旧未注册文案：契约 R-3 明确 Test A6b 以「接受集合」断言（实施侧无需保留旧文案）。 */
const LEGACY_UNREGISTERED_BODY = '{"ok":false,"error":"workspace is not registered"}';
/** R-8 成员闸门新增错误码（error 原文待 amend 冻结，见 RED-PHASE §10.7）。 */
const NOT_IN_DELIVERABLES = 'PREVIEW_NOT_IN_DELIVERABLES';

const writeFile = (dir, name, content) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

/** 打开一台隔离实例并注册工作区 `ws-<id>`；env 可为对象或 (ctx)=>对象（ctx.workspacePath）。 */
async function openHost(id, env = {}, opts = {}) {
  const { srv, cwd, name, predictedCwd } = await openPreviewWorkspace(id, env, opts);
  assertEqual(cwd, predictedCwd,
    id + ' 工作区 cwd 必须等于 spawn 前可预测路径（宿主投影 workingDirectory 的事实来源）');
  return { srv, cwd, name };
}

/** 403 拒绝不得夹带文件字节 / 绝对路径。 */
function assertNoLeak(res, forbidden, label) {
  for (const token of forbidden) {
    assertOk(res.text.indexOf(token) === -1,
      label + ' 响应体不得夹带文件字节或绝对路径片段', '不含 ' + JSON.stringify(token), redact(res.text));
  }
}

// ────────────────────────── 纯函数断言原语（A1–A5）──────────────────────────

/** 调纯函数并捕获 throw —— 抛错在契约 §1.1 下就是断言失败，不是执行异常。 */
function callDecision(input) {
  try {
    return { threw: false, value: decidePreviewReadAccess(input) };
  } catch (err) {
    return { threw: true, error: err };
  }
}

function assertFourFields(value, label) {
  assertOk(value !== null && typeof value === 'object' && !Array.isArray(value),
    label + ' 必须返回对象', '{ok,status,code,error}', value);
  const keys = Object.keys(value).sort().join(',');
  assertEqual(keys, 'code,error,ok,status', label + ' 必须恒返回四字段对象（不得多/少字段）');
  assertEqual(typeof value.ok, 'boolean', label + ' .ok 类型');
  assertEqual(typeof value.status, 'number', label + ' .status 类型');
  assertEqual(typeof value.code, 'string', label + ' .code 类型');
  assertEqual(typeof value.error, 'string', label + ' .error 类型');
}

/** 断言一次判定的完整结果（ok/status/code/error 四字段逐条比对）。 */
function expectDecision(input, expected, label) {
  const d = callDecision(input);
  if (d.threw) {
    fail(label + ' 不得 throw（契约 §1.1：纯函数永不 throw，畸形/缺字段一律落拒绝分支）',
      '四字段对象', 'threw: ' + (d.error && d.error.message ? d.error.message : String(d.error)));
  }
  assertFourFields(d.value, label);
  assertEqual(d.value.ok, expected.ok, label + ' → ok');
  assertEqual(d.value.status, expected.status, label + ' → status');
  assertEqual(d.value.code, expected.code, label + ' → code');
  assertEqual(d.value.error, expected.error, label + ' → error');
}

const ALLOW = { ok: true, status: 200, code: '', error: '' };
const OUT_OF_SCOPE = { ok: false, status: 403, code: 'PREVIEW_OUT_OF_SCOPE', error: 'path escapes the workspace root' };
const MISMATCH = { ok: false, status: 403, code: 'PREVIEW_SESSION_MISMATCH', error: 'session does not own this workspace' };
const PERMISSION = {
  ok: false, status: 403, code: 'PREVIEW_PERMISSION_REQUIRED',
  error: 'session permission does not allow reading outside the workspace',
};
const UNAVAILABLE = { ok: false, status: 403, code: 'PREVIEW_POLICY_UNAVAILABLE', error: 'session permission is unavailable' };

async function main() {
  console.log('# Q20 验收套件 PREVIEW-POLICY (A1–A9) — 契约 .dev-team/contract-wave-2026-11-06.md');
  console.log('# 时间: ' + new Date().toISOString());
  console.log('# 红相：lib/preview-policy.mjs 为一行 throw 空桩时 A1–A5/A8/A9 必须真实断言失败；');
  console.log('#       A6/A7 是既有行为的向后兼容护栏（实施前即绿，实施后必须保持绿）。');

  // ── A1 快路径 a：contained && registered → 200，且不看 session/permission ──
  await runner.run('A1 快路径 a：contained+registered → 200，快路径不看 session/permission', async () => {
    expectDecision({ contained: true, registered: true }, ALLOW, 'A1 最小合法参 {contained:true,registered:true}');
    expectDecision({ contained: true, registered: true, sessionId: '', permission: WRITE },
      ALLOW, 'A1 快路径不得因 permission=workspace-write 被拦');
    expectDecision({ contained: true, registered: true, sessionId: 's1', sessionCwd: '/other', permission: 'read-only' },
      ALLOW, 'A1 快路径优先于 c/d（会话不匹配/权限不足都不得影响 a）');
    expectDecision({ contained: true, registered: true, sessionId: undefined, sessionCwd: undefined, permission: undefined },
      ALLOW, 'A1 真值表 T1（其余字段全缺失）');
    return '4 组快路径判定全部 200 且 code/error 为空串';
  });

  // ── A2 无 session / 越界 → 403 PREVIEW_OUT_OF_SCOPE（旧文案逐字等价）──
  await runner.run('A2 无 session 越界：403 PREVIEW_OUT_OF_SCOPE + 旧文案（b 步优先于 c/d）', async () => {
    expectDecision({ contained: false, registered: true }, OUT_OF_SCOPE, 'A2 {contained:false,registered:true}');
    expectDecision({ contained: false, registered: false }, OUT_OF_SCOPE, 'A2 {contained:false,registered:false}');
    expectDecision({ contained: false, registered: true, sessionId: '' }, OUT_OF_SCOPE, 'A2 sessionId 空串');
    expectDecision({ contained: false, registered: false, permission: FULL },
      OUT_OF_SCOPE, 'A2 b 优先于 d（无 session 时不得改报 PREVIEW_PERMISSION_REQUIRED）');
    return '4 组均 403 PREVIEW_OUT_OF_SCOPE + path escapes the workspace root';
  });

  // ── A3 会话归属 c 步 ──
  await runner.run('A3 c 步会话不匹配：sessionCwd≠requestCwd → 403 PREVIEW_SESSION_MISMATCH；相等则放行', async () => {
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/other', permission: FULL,
    }, MISMATCH, 'A3 会话 cwd=/other ≠ 请求 cwd=/ws（即便完全权限也必须拒绝）');
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws', permission: FULL,
    }, ALLOW, 'A3 sessionCwd === requestCwd 时 c 步不命中（完全权限放行，真值表 T9）');
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: undefined, sessionCwd: '/ws', permission: FULL,
    }, MISMATCH, 'A3 requestCwd 缺失（无法核验归属）+ sessionCwd 非空 → 命中 c（§1.1 例外说明）');
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: undefined, sessionCwd: '', permission: FULL,
    }, ALLOW, 'A3 requestCwd 缺失但 sessionCwd 为空 → 不受 c 影响，只由 permission 决定');
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '', permission: FULL,
    }, ALLOW, 'A3 真值表 T6：sessionCwd 为空视为「未知」而非不匹配');
    return 'c 步 5 组判定（命中/不命中/归属无法核验/未知）符合冻结真值表';
  });

  // ── A4 权限 d 步 ──
  await runner.run('A4 d 步权限不足：workspace-write/read-only/空/缺失 → 403 PREVIEW_PERMISSION_REQUIRED', async () => {
    assertEqual(FULL, 'danger-full-access', 'A4 FULL_ACCESS_POLICY 常量冻结值');
    for (const permission of [WRITE, 'read-only', '', undefined, null]) {
      expectDecision({
        contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws', permission,
      }, PERMISSION, 'A4 permission=' + JSON.stringify(permission));
    }
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws',
    }, PERMISSION, 'A4 permission 字段整体缺失');
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws', permission: FULL,
    }, ALLOW, 'A4 正向对照：完全权限 + 同 cwd → 200（e 步）');
    return '6 组非完全权限全部 403 PREVIEW_PERMISSION_REQUIRED + 1 组完全权限 200';
  });

  // ── A5 e 步放行 + 畸形输入不 throw ──
  await runner.run('A5 e 步放行 + 畸形输入不 throw：恒返回四字段且落拒绝', async () => {
    expectDecision({
      contained: false, registered: true, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws', permission: FULL,
    }, ALLOW, 'A5 合法全通参');
    expectDecision({
      contained: false, registered: false, sessionId: 's1', requestCwd: '/ws', sessionCwd: '/ws', permission: FULL,
    }, ALLOW, 'A5 T2 语义：registered=false 只关闭快路径 a，不额外拒绝（继续 b→e）');
    const malformed = [
      ['{}', {}],
      ['null', null],
      ['undefined', undefined],
      ["'str'", 'str'],
      ['42', 42],
      ['[]', []],
      ["{permission:'danger-full-access'}", { permission: FULL }],
      ["{contained:'true',registered:true}（字符串不是布尔）", { contained: 'true', registered: true }],
      ['{contained:true}（缺 registered）', { contained: true }],
    ];
    for (const [label, input] of malformed) {
      const d = callDecision(input);
      if (d.threw) {
        fail('A5 畸形输入 ' + label + ' 不得 throw（契约 §1.1 / 真值表 T10）', '四字段拒绝对象',
          'threw: ' + (d.error && d.error.message ? d.error.message : String(d.error)));
      }
      assertFourFields(d.value, 'A5 畸形输入 ' + label);
      assertFalse(d.value.ok, 'A5 畸形输入 ' + label + ' 必须落拒绝（缺字段=拒绝铁律）');
      assertEqual(d.value.status, 403, 'A5 畸形输入 ' + label + ' → status');
    }
    return '合法全通 200 + T2 语义 200 + 9 组畸形输入不 throw 且 403';
  });

  // ── A6 服务端向后兼容（不带 session）──
  await runner.run('A6 向后兼容：无 session 越界=403 逐字节等价（不含 code）；工作区内 200 内容一致', async () => {
    const { srv, cwd } = await openHost('a6', {}, { rpcLog: true });
    try {
      const outsideDir = tempDir('q20-prev-out-a6-');
      const outsideFile = writeFile(outsideDir, 'outside-a6.txt', 'OUTSIDE-A6-BYTES\n');
      const insideContent = 'INSIDE-A6-BYTES\n';
      const insideFile = writeFile(cwd, 'inside-a6.md', insideContent);

      const out = await rawRequest(srv.base, fileUrl(cwd, outsideFile));
      assertEqual(out.status, 403, 'A6 无 session 越界 → status');
      assertEqual(out.text, LEGACY_ESCAPE_BODY,
        'A6 无 session 越界 → 响应体必须与今天逐字节等价（不含 code 字段）');
      assertEqual(out.json && out.json.code, undefined, 'A6 旧响应体不得出现 code 字段（逐字节等价铁律）');
      assertEqual(out.headers['content-type'], 'application/json; charset=utf-8', 'A6 403 → Content-Type');
      assertNoLeak(out, [outsideDir, 'OUTSIDE-A6-BYTES'], 'A6 越界 403');

      const ins = await rawRequest(srv.base, fileUrl(cwd, insideFile));
      assertEqual(ins.status, 200, 'A6 工作区内白名单文件 → status');
      assertEqual(ins.text, insideContent, 'A6 工作区内文件内容必须与磁盘逐字节一致');
      assertEqual(ins.headers['content-type'], 'text/plain; charset=utf-8', 'A6 工作区内 .md → Content-Type');
      const calls = countRpcMethod(srv, 'session/projections');
      assertEqual(calls, 0, 'A6 无 session 请求不得触发 session/projections（两条路径都不查宿主）');
      return 'out=403 ' + out.text.length + 'B 逐字节等价; in=200 ' + ins.text.length + 'B 内容一致; RPC=0';
    } finally {
      await srv.stop();
    }
  });

  // ── A6b 未注册工作区（契约 R-3：接受集合 {'path escapes…','workspace is not registered'}）──
  await runner.run('A6b 未注册工作区（无 session）：403 且响应体为契约 R-3 接受集合之一（不含 code）', async () => {
    const { srv } = await openHost('a6b');
    try {
      const outsideDir = tempDir('q20-prev-out-a6b-');
      const outsideFile = writeFile(outsideDir, 'outside-a6b.txt', 'OUTSIDE-A6B\n');
      const unregistered = tempDir('q20-prev-unreg-a6b-');
      const res = await rawRequest(srv.base, fileUrl(unregistered, outsideFile));
      assertEqual(res.status, 403, 'A6b 未注册 cwd → status');
      // 契约 R-3 明文：A6b 以接受集合断言（实施侧无需保留旧文案）；存在性 oracle 由 A12/A15 单独收口。
      assertOk(res.text === LEGACY_ESCAPE_BODY || res.text === LEGACY_UNREGISTERED_BODY,
        'A6b 未注册工作区响应体必须为契约 R-3 接受集合之一（且不得含 code）',
        LEGACY_ESCAPE_BODY + ' 或 ' + LEGACY_UNREGISTERED_BODY, res.text);
      assertEqual(res.json && res.json.code, undefined, 'A6b 无 session 的拒绝体不得含 code（R-2）');
      assertNoLeak(res, [unregistered, outsideDir], 'A6b 未注册 403');
      return '未注册 cwd → 403（' + (res.text === LEGACY_ESCAPE_BODY ? 'b 步文案' : '旧文案') + '）';
    } finally {
      await srv.stop();
    }
  });

  // ── A7 快路径零宿主调用 ──
  await runner.run('A7 快路径零宿主调用：PROJECTIONS_FAIL=1 下工作区内文件仍 200（RPC 收据 0 次）', async () => {
    const { srv, cwd } = await openHost('a7', { Q20_MOCK_HOST_PROJECTIONS_FAIL: '1' }, { rpcLog: true });
    try {
      const insideContent = 'INSIDE-A7-BYTES\n';
      const insideFile = writeFile(cwd, 'inside-a7.txt', insideContent);
      const res = await rawRequest(srv.base, fileUrl(cwd, insideFile));
      assertEqual(res.status, 200, 'A7 工作区内文件在宿主投影必失败时仍必须 200（快路径 a 不查宿主）');
      assertEqual(res.text, insideContent, 'A7 内容必须与磁盘逐字节一致');
      assertEqual(countRpcMethod(srv, 'session/projections'), 0,
        'A7 快路径命中时 session/projections RPC 次数（零宿主调用）');
      return 'in=200 ' + res.text.length + 'B; session/projections RPC=0';
    } finally {
      await srv.stop();
    }
  });

  // ── A8 完全权限会话放行越界白名单文件 ──
  await runner.run('A8 完全权限会话（danger-full-access + 同 cwd）放行越界白名单文件：200 + Content-Type + 内容一致', async () => {
    const sid = 'session-a8-full';
    const shared = 'PREVIEW-POLICY-A8-SHARED-BYTES\n';
    const outsideDir = tempDir('q20-prev-out-a8-');
    const outsideFile = writeFile(outsideDir, 'a8-outside.md', shared);
    const { srv, cwd } = await openHost('a8', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a8') } }),
      // R-8 迁移（契约演进，非放宽）：越界读取必须命中本会话交付物清单。
      Q20_MOCK_HOST_SESSION_DELIVERABLES: JSON.stringify({ [sid]: [outsideFile] }),
    }), { rpcLog: true });
    try {
      const insideFile = writeFile(cwd, 'a8-inside.md', shared);

      const ins = await rawRequest(srv.base, fileUrl(cwd, insideFile));
      assertEqual(ins.status, 200, 'A8 前置：工作区内同一内容文件必须 200');

      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 200, 'A8 完全权限 + 同 cwd + 越界白名单文件 → status');
      assertEqual(res.headers['content-type'], 'text/plain; charset=utf-8', 'A8 越界 .md → Content-Type');
      assertEqual(res.text, shared, 'A8 越界文件内容必须与磁盘逐字节一致');
      assertOk(res.buf.equals(ins.buf), 'A8 越界读取结果必须与工作区内同一内容读取结果逐字节一致',
        '完全相同的 Buffer', '不同字节');
      assertEqual(res.headers['cache-control'], 'private, no-cache', 'A8 Cache-Control 语义不变');
      assertOk(countRpcMethod(srv, 'session/projections') >= 1,
        'A8 接缝活性：策略查询必须真的走 session/projections（禁新建取数通道）',
        '≥1 次 session/projections', countRpcMethod(srv, 'session/projections'));
      return 'out=200 ' + res.text.length + 'B; CT=' + res.headers['content-type'] + '; 与区内读取字节一致';
    } finally {
      await srv.stop();
    }
  });

  // ── A9.1a 宿主失败（FAIL 接缝 + 该 sid 本可放行）→ fail-closed ──
  await runner.run('A9.1a 宿主投影失败（PROJECTIONS_FAIL=1，该 sid 本为完全权限）→ 403 PREVIEW_POLICY_UNAVAILABLE + [PREVIEW] warn', async () => {
    const sid = 'session-a9-1a';
    const { srv, cwd } = await openHost('a9-1a', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a9-1a') } }),
      Q20_MOCK_HOST_PROJECTIONS_FAIL: '1',
    }));
    try {
      const outsideDir = tempDir('q20-prev-out-a91a-');
      const outsideFile = writeFile(outsideDir, 'a9-1a-outside.md', 'A9-1A-SECRET-BYTES\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'A9.1a 宿主失败 → status');
      assertEqual(res.json && res.json.ok, false, 'A9.1a → ok=false');
      assertEqual(res.json && res.json.code, UNAVAILABLE.code, 'A9.1a → code');
      assertEqual(res.json && res.json.error, UNAVAILABLE.error, 'A9.1a → error 原文');
      assertNoLeak(res, [outsideDir, 'A9-1A-SECRET-BYTES'], 'A9.1a 宿主失败 403');

      const log = await waitForLog(srv, new RegExp('\\[PREVIEW\\][^\\n]*sid=' + sid));
      assertOk(!!log, 'A9.1a 服务端必须落 warn 且含 [PREVIEW] 与 sid=' + sid + '（日志可关联）',
        '[PREVIEW] ... sid=' + sid, log ? '(found)' : 'stderr 未见（末段: ' + redact((srv.stderrText || '').slice(-400)) + '）');
      return '403 ' + UNAVAILABLE.code + '; warn 命中 [PREVIEW] sid=' + sid;
    } finally {
      await srv.stop();
    }
  });

  // ── A9.1b 该 sid 无投影（接缝缺该 sid）→ 缺字段=拒绝 ──
  await runner.run('A9.1b 接缝缺该 sid（values 无 permissions）→ 403 PREVIEW_POLICY_UNAVAILABLE（缺字段=拒绝）', async () => {
    const sid = 'session-a9-1b';
    const other = 'session-a9-other-projections';
    const { srv, cwd } = await openHost('a9-1b', ({ workspacePath }) => projEnv({
      [other]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a9-1b') },
    }));
    try {
      const outsideDir = tempDir('q20-prev-out-a91b-');
      const outsideFile = writeFile(outsideDir, 'a9-1b-outside.md', 'A9-1B-SECRET-BYTES\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'A9.1b 无投影 sid → status');
      assertEqual(res.json && res.json.code, UNAVAILABLE.code, 'A9.1b → code（缺 permissions 视为不可用，不得默认放行）');
      assertEqual(res.json && res.json.error, UNAVAILABLE.error, 'A9.1b → error 原文');
      assertNoLeak(res, [outsideDir, 'A9-1B-SECRET-BYTES'], 'A9.1b 无投影 403');
      const log = await waitForLog(srv, new RegExp('\\[PREVIEW\\][^\\n]*sid=' + sid));
      assertOk(!!log, 'A9.1b 宿主无该 sid 投影同样必须落 warn（[PREVIEW] 前缀 + sid=' + sid + '）',
        '[PREVIEW] ... sid=' + sid, 'stderr 未见（末段: ' + redact((srv.stderrText || '').slice(-400)) + '）');
      return '403 ' + UNAVAILABLE.code + '（缺字段=拒绝）; warn 命中 sid';
    } finally {
      await srv.stop();
    }
  });

  // ── A9.2 + A9.3 + A9.4 同实例分组（三个不同 sid，各自投影）──
  await runner.run('A9.2 workspace-write 越界 → 403 PREVIEW_PERMISSION_REQUIRED', async () => {
    const sid = 'session-a9-2write';
    const { srv, cwd } = await openHost('a9-2', ({ workspacePath }) => projEnv({
      [sid]: { permissions: { currentValue: WRITE }, workingDirectory: workspacePath('ws-a9-2') },
    }));
    try {
      const outsideDir = tempDir('q20-prev-out-a92-');
      const outsideFile = writeFile(outsideDir, 'a9-2-outside.md', 'A9-2-SECRET-BYTES\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'A9.2 → status');
      assertEqual(res.json && res.json.code, PERMISSION.code, 'A9.2 → code');
      assertEqual(res.json && res.json.error, PERMISSION.error, 'A9.2 → error 原文');
      assertNoLeak(res, [outsideDir, 'A9-2-SECRET-BYTES'], 'A9.2 403');
      return '403 ' + PERMISSION.code;
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A9.3 session 指向别的工作区 cwd → 403 PREVIEW_SESSION_MISMATCH', async () => {
    const sid = 'session-a9-3mismatch';
    const { srv, cwd } = await openHost('a9-3', ({ workspacePath }) => projEnv({
      [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a9-3other') },
    }));
    try {
      // 同一个实例内注册第二个工作区：会话 cwd 必须是真实存在的目录（实现会 realpath 归一）
      const otherCwd = await (async () => {
        const r = await rawRequest(srv.base, '/api/workspace/create', { method: 'POST', body: { name: 'ws-a9-3other' } });
        assertEqual(r.status, 200, 'A9.3 前置：注册第二个工作区 ws-a9-3other');
        return r.json.workspace.cwd;
      })();
      assertEqual(otherCwd, path.join(srv.workspaceRoot, 'ws-a9-3other'),
        'A9.3 第二个工作区 cwd 必须等于 spawn 前可预测路径');
      assertFalse(otherCwd === cwd, 'A9.3 前置：两个工作区路径必须不同');

      const outsideDir = tempDir('q20-prev-out-a93-');
      const outsideFile = writeFile(outsideDir, 'a9-3-outside.md', 'A9-3-SECRET-BYTES\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'A9.3 → status（会话拥有别的工作区，不得读本工作区外的文件）');
      assertEqual(res.json && res.json.code, MISMATCH.code, 'A9.3 → code');
      assertEqual(res.json && res.json.error, MISMATCH.error, 'A9.3 → error 原文');
      assertNoLeak(res, [outsideDir, 'A9-3-SECRET-BYTES'], 'A9.3 403');
      return '403 ' + MISMATCH.code;
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A9.4 完全权限放行后：非白名单扩展名仍 415、>2MB 文本仍 413（策略不放宽上限）', async () => {
    const sid = 'session-a9-4full';
    const outsideDir = tempDir('q20-prev-out-a94-');
    const binFile = writeFile(outsideDir, 'a9-4-payload.bin', 'BINARY-ISH-BYTES\n');
    const bigMarker = 'Q20-BIG-TEXT-MARKER';
    const bigFile = writeFile(outsideDir, 'a9-4-big.md', bigMarker + 'X'.repeat(2 * 1024 * 1024 + 1024));
    const { srv, cwd } = await openHost('a9-4', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a9-4') } }),
      // R-8 迁移：两个越界文件都列入清单，使判定走到 servePreviewFile，验证 415/413 不被完全权限放宽。
      Q20_MOCK_HOST_SESSION_DELIVERABLES: JSON.stringify({ [sid]: [binFile, bigFile] }),
    }));
    try {
      const bin = await rawRequest(srv.base, fileUrlSession(cwd, binFile, sid));
      assertEqual(bin.status, 415, 'A9.4 非白名单扩展名（.bin）在完全权限下 → status');
      assertEqual(bin.json && bin.json.error, 'unsupported preview type', 'A9.4 415 → error 原文');
      assertNoLeak(bin, [outsideDir, 'BINARY-ISH-BYTES'], 'A9.4 415');

      const big = await rawRequest(srv.base, fileUrlSession(cwd, bigFile, sid));
      assertEqual(big.status, 413, 'A9.4 >2MB 文本在完全权限下 → status');
      assertEqual(big.json && big.json.error, 'file too large for preview', 'A9.4 413 → error 原文');
      assertEqual(big.json && big.json.maxBytes, 2 * 1024 * 1024, 'A9.4 413 → maxBytes 必须仍是 2MB（不得放宽）');
      assertNoLeak(big, [outsideDir, bigMarker], 'A9.4 413');
      return '415 unsupported preview type; 413 file too large (maxBytes=2097152)';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A10 敏感路径 denylist（契约 amend R-4；仅非快路径生效）═══════════
  // 冻结事实（Lead 裁决 2026-11-06）：denylist 只作用于 !(contained && registered) 的非快路径；
  // 工作区内快路径行为与今天完全一致（test-unit.mjs:2994-3008 已冻结「工作区内 .q20_token = 415」）。
  await runner.run('A10a 越界敏感路径 denylist（6 类凭据/配置文件）→ 403 PREVIEW_SENSITIVE_PATH 且无字节出网', async () => {
    const sid = 'session-a10-full';
    const { srv, cwd } = await openHost('a10a', ({ workspacePath }) => projEnv({
      [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a10a') },
    }));
    try {
      const outsideDir = tempDir('q20-a10-out-');
      const x = path.join(outsideDir, 'x');
      fs.mkdirSync(x, { recursive: true });
      const sensitive = [
        ['.credentials.yaml', path.join(x, '.credentials.yaml'), 'A10A-CREDENTIALS-MARKER'],
        ['cordis.patch.yml', path.join(x, 'cordis.patch.yml'), 'A10A-CORDIS-MARKER'],
        ['settings.yaml', path.join(x, 'settings.yaml'), 'A10A-SETTINGS-MARKER'],
        ['vertex.pem', path.join(x, 'vertex.pem'), 'A10A-VERTEXPEM-MARKER'],
        ['aws.key', path.join(x, 'aws.key'), 'A10A-AWSKEY-MARKER'],
        ['.env.yaml', path.join(x, '.env.yaml'), 'A10A-ENVYAML-MARKER'],
      ];
      for (const [label, file, marker] of sensitive) {
        fs.writeFileSync(file, marker + '\n');
      }
      const observed = [];
      for (const [label, file, marker] of sensitive) {
        const res = await rawRequest(srv.base, fileUrlSession(cwd, file, sid));
        assertEqual(res.status, 403, 'A10a 越界敏感文件 ' + label + ' → status');
        assertEqual(res.json && res.json.code, 'PREVIEW_SENSITIVE_PATH',
          'A10a 越界敏感文件 ' + label + ' → code（denylist 先于扩展名白名单，403 不得退化为 415）');
        assertEqual(res.json && res.json.error, 'preview of sensitive files is not allowed',
          'A10a 越界敏感文件 ' + label + ' → error 原文');
        assertEqual(res.headers['content-type'], 'application/json; charset=utf-8',
          'A10a 越界敏感文件 ' + label + ' → 必须是 JSON 拒绝，不是文件流');
        assertNoLeak(res, [marker, outsideDir], 'A10a ' + label);
        observed.push(label + '=403');
      }
      return observed.join(', ');
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A10b 对照组：越界普通 notes.md 仍 200（denylist 不得误杀）；越界普通 .bin 仍 415（见 A9.4）', async () => {
    const sid = 'session-a10b-full';
    const outsideDir = tempDir('q20-a10b-out-');
    const x = path.join(outsideDir, 'x');
    fs.mkdirSync(x, { recursive: true });
    // 与敏感文件同目录、同层级，只有文件名不同 → 证明拒绝依据是 denylist 而非目录
    writeFile(x, '.credentials.yaml', 'A10B-CRED-MARKER\n');
    const content = 'A10B-NOTES-OK\n';
    const notes = writeFile(x, 'notes.md', content);
    const { srv, cwd } = await openHost('a10b', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a10b') } }),
      // R-8 迁移：对照组 notes.md 必须列入交付物清单（否则撞成员闸门而非验证「denylist 不误杀」）。
      Q20_MOCK_HOST_SESSION_DELIVERABLES: JSON.stringify({ [sid]: [notes] }),
    }));
    try {
      const res = await rawRequest(srv.base, fileUrlSession(cwd, notes, sid));
      assertEqual(res.status, 200, 'A10b 越界普通 notes.md（完全权限 + 同 cwd）→ status');
      assertEqual(res.text, content, 'A10b notes.md 内容必须逐字节一致');
      return 'notes.md=200 (' + res.text.length + 'B)；同目录 .credentials.yaml 仍 403（见 A10a）';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A10c 工作区内快路径不受 denylist 影响：区内 .credentials.yaml 仍 200；区内 .q20_token 仍 415', async () => {
    const { srv, cwd } = await openHost('a10c');
    try {
      const credContent = 'A10C-INSIDE-CREDENTIALS\n';
      const insideCred = writeFile(cwd, '.credentials.yaml', credContent);
      const insideToken = writeFile(cwd, '.q20_token', 'q20-inside-token-abc\n');

      const cred = await rawRequest(srv.base, fileUrl(cwd, insideCred));
      assertEqual(cred.status, 200,
        'A10c 工作区内 .credentials.yaml → status（快路径与今天完全一致，denylist 不得介入）');
      assertEqual(cred.text, credContent, 'A10c 工作区内 .credentials.yaml 内容逐字节一致');

      const token = await rawRequest(srv.base, fileUrl(cwd, insideToken));
      assertEqual(token.status, 415,
        'A10c 工作区内 .q20_token（无白名单扩展名）→ status（与 test-unit.mjs:2994-3008 冻结断言一致）');
      assertEqual(token.json && token.json.error, 'unsupported preview type', 'A10c .q20_token → error 原文');
      return 'inside .credentials.yaml=200; inside .q20_token=415';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A10d 无 session 越界命中敏感文件 → 403 且响应体不含 code（R-2 一致）', async () => {
    const { srv, cwd } = await openHost('a10d');
    try {
      const outsideDir = tempDir('q20-a10d-out-');
      const secret = writeFile(outsideDir, '.credentials.yaml', 'A10D-CRED-MARKER\n');
      const res = await rawRequest(srv.base, fileUrl(cwd, secret));
      assertEqual(res.status, 403, 'A10d 无 session 越界敏感文件 → status');
      assertEqual(res.json && res.json.code, undefined,
        'A10d 无 session 的拒绝体不得出现 code 字段（R-2 逐字节等价铁律）');
      assertOk(res.json && (res.json.error === 'path escapes the workspace root'
        || res.json.error === 'preview of sensitive files is not allowed'),
      'A10d 无 session 越界敏感文件 → error 必须是 §1.2 冻结文案之一',
      'path escapes the workspace root 或 preview of sensitive files is not allowed', res.json && res.json.error);
      assertNoLeak(res, ['A10D-CRED-MARKER', outsideDir], 'A10d');
      return '403 无 code（error=' + (res.json && res.json.error) + '）';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A11 归属不可核验 fail-closed（契约 amend R-5）═══════════
  await runner.run('A11 workingDirectory 不可核验（~/ws-x 非绝对/不可 realpath）→ 403 PREVIEW_POLICY_UNAVAILABLE + [PREVIEW] warn', async () => {
    const sid = 'session-a11-unknown-cwd';
    const { srv, cwd } = await openHost('a11', projEnv({
      [sid]: { permissions: { currentValue: FULL }, workingDirectory: '~/ws-x' },
    }));
    try {
      const outsideDir = tempDir('q20-a11-out-');
      const outsideFile = writeFile(outsideDir, 'a11-notes.md', 'A11-SECRET-BYTES\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403,
        'A11 归属不可核验必须 fail-closed（不得因 realpath 失败把 sessionCwd 置空后跳过 c 步而放行）');
      assertEqual(res.json && res.json.code, 'PREVIEW_POLICY_UNAVAILABLE', 'A11 → code');
      assertEqual(res.json && res.json.error, 'session permission is unavailable', 'A11 → error 原文');
      assertNoLeak(res, [outsideDir, 'A11-SECRET-BYTES'], 'A11');
      const log = await waitForLog(srv, new RegExp('\\[PREVIEW\\][^\\n]*sid=' + sid));
      assertOk(!!log, 'A11 归属不可核验必须落可审计 warn（[PREVIEW] 前缀 + sid=' + sid + '，可附 reason）',
        '[PREVIEW] ... sid=' + sid, 'stderr 未见（末段: ' + redact((srv.stderrText || '').slice(-400)) + '）');
      return '403 PREVIEW_POLICY_UNAVAILABLE; warn 命中 sid';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A12 未注册 cwd 状态语义（契约 amend R-6）═══════════
  await runner.run('A12 未注册 cwd + 目标不存在 → 403 越界文案（不得 404 存在性探针）；已注册 + 目标不存在 → 404 不变', async () => {
    const { srv, cwd } = await openHost('a12');
    try {
      const unregistered = os.tmpdir();
      const nope = path.join(unregistered, 'q20-nope-' + process.pid + '-' + Date.now() + '.md');
      assertFalse(fs.existsSync(nope), 'A12 前置：探测目标必须不存在');
      const probe = await rawRequest(srv.base, fileUrl(unregistered, nope));
      assertEqual(probe.status, 403,
        'A12 未注册 cwd + 不存在目标 → 必须 403（不得用 404 暴露任意绝对路径存在性）');
      assertEqual(probe.text, LEGACY_ESCAPE_BODY,
        'A12 未注册 cwd → 响应体必须是 b 步越界文案（不含 code）');
      assertNoLeak(probe, [unregistered], 'A12 未注册 cwd');

      const registeredMissing = await rawRequest(srv.base, fileUrl(cwd, path.join(cwd, 'a12-missing.md')));
      assertEqual(registeredMissing.status, 404, 'A12 已注册 cwd + 目标不存在 → status 必须仍是 404');
      assertEqual(registeredMissing.json && registeredMissing.json.error, 'preview file not found',
        'A12 已注册 cwd + 目标不存在 → error 原文不变');
      return '未注册+不存在=403 越界文案; 已注册+不存在=404 preview file not found';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A14 交付物成员闸门（契约 amend R-8；mock 接缝 Q20_MOCK_HOST_SESSION_DELIVERABLES）═══════════
  // 接缝约定（测试侧先行定义，mock 实现待补，见 RED-PHASE §10.4）：
  //   Q20_MOCK_HOST_SESSION_DELIVERABLES = { "<sid>": ["<abs path>" | "<relative to sessionCwd>", ... ] }
  // 语义（R-8）：越界（非快路径）读取**只有命中本会话交付物清单**才放行；清单项允许相对 sessionCwd。
  const deliverEnv = (sid, list) => JSON.stringify({ [sid]: list });
  const CODES_NOT_IN_DELIVERABLES = NOT_IN_DELIVERABLES;

  await runner.run('A14a 越界文件在交付物清单内（完全权限 + 同 cwd）→ 200 且内容一致', async () => {
    const sid = 'session-a14a-full';
    const marker = 'A14A-IN-LIST-BYTES\n';
    const outsideDir = tempDir('q20-a14-out-');
    const listed = writeFile(outsideDir, 'a14a-listed.md', marker);
    const { srv, cwd } = await openHost('a14a', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a14a') } }),
      Q20_MOCK_HOST_SESSION_DELIVERABLES: deliverEnv(sid, [listed]),
    }));
    try {
      const res = await rawRequest(srv.base, fileUrlSession(cwd, listed, sid));
      assertEqual(res.status, 200, 'A14a 清单内越界文件 → status');
      assertEqual(res.text, marker, 'A14a 清单内越界文件内容必须逐字节一致');
      assertEqual(res.headers['content-type'], 'text/plain; charset=utf-8', 'A14a → Content-Type');
      return 'in-list=200 (' + res.text.length + 'B)';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A14b 同参数但文件不在清单内（同扩展名 .md）→ 403 PREVIEW_NOT_IN_DELIVERABLES 且无字节出网', async () => {
    const sid = 'session-a14b-full';
    const listMarker = 'A14B-LISTED-BYTES\n';
    const unlistedMarker = 'A14B-UNLISTED-SECRET-BYTES\n';
    const outsideDir = tempDir('q20-a14b-out-');
    const listed = writeFile(outsideDir, 'a14b-listed.md', listMarker);
    const unlisted = writeFile(outsideDir, 'a14b-unlisted.md', unlistedMarker);
    const { srv, cwd } = await openHost('a14b', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a14b') } }),
      Q20_MOCK_HOST_SESSION_DELIVERABLES: deliverEnv(sid, [listed]),
    }));
    try {
      const res = await rawRequest(srv.base, fileUrlSession(cwd, unlisted, sid));
      assertEqual(res.status, 403, 'A14b 清单外同扩展名文件 → status（不得因完全权限放行）');
      assertEqual(res.json && res.json.code, CODES_NOT_IN_DELIVERABLES, 'A14b → code');
      assertOk(res.json && typeof res.json.error === 'string' && res.json.error.length > 0,
        'A14b → error 必须是非空原文（文案待 amend 冻结）', '非空字符串', res.json && res.json.error);
      assertOk(res.json && res.json.error.indexOf(outsideDir) === -1 && res.json.error.indexOf('/') === -1,
        'A14b error 不得夹带绝对路径', '不含路径', redact(res.json && res.json.error));
      assertEqual(res.headers['content-type'], 'application/json; charset=utf-8', 'A14b 必须是 JSON 拒绝，不是文件流');
      assertNoLeak(res, [unlistedMarker, outsideDir], 'A14b');
      return 'unlisted=403 ' + CODES_NOT_IN_DELIVERABLES;
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A14c 清单项为相对路径（相对 sessionCwd）→ 归一后命中 → 200（证明归一语义）', async () => {
    const sid = 'session-a14c-full';
    const marker = 'A14C-RELATIVE-LIST-BYTES\n';
    const outsideDir = tempDir('q20-a14c-out-');
    const target = writeFile(outsideDir, 'a14c-rel.md', marker);
    const { srv, cwd } = await openHost('a14c', ({ workspacePath }) => {
      // 相对路径必须相对 sessionCwd（= 请求 cwd）计算，故这里需要预测 cwd —— 与 openHost 的断言同源。
      const predictedCwd = workspacePath('ws-a14c');
      const rel = path.relative(predictedCwd, target);
      return {
        ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: predictedCwd } }),
        Q20_MOCK_HOST_SESSION_DELIVERABLES: deliverEnv(sid, [rel]),
      };
    });
    try {
      assertOk(path.isAbsolute(target) && !path.isAbsolute(path.relative(cwd, target)),
        'A14c 前置：清单项必须真的是相对路径', '相对路径', path.relative(cwd, target));
      const res = await rawRequest(srv.base, fileUrlSession(cwd, target, sid));
      assertEqual(res.status, 200, 'A14c 相对路径清单项归一命中 → status');
      assertEqual(res.text, marker, 'A14c 归一命中后内容必须逐字节一致');
      return 'relative(' + path.relative(cwd, target) + ')=200';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A14d 工作区内文件即使不在清单内 → 仍 200（快路径不受成员闸门影响）', async () => {
    const sid = 'session-a14d-full';
    const outsideDir = tempDir('q20-a14d-out-');
    const listed = writeFile(outsideDir, 'a14d-listed.md', 'A14D-OTHER\n');
    const { srv, cwd } = await openHost('a14d', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a14d') } }),
      Q20_MOCK_HOST_SESSION_DELIVERABLES: deliverEnv(sid, [listed]),
    }));
    try {
      const insideContent = 'A14D-INSIDE-NOT-LISTED\n';
      const insideFile = writeFile(cwd, 'a14d-inside.md', insideContent);
      const res = await rawRequest(srv.base, fileUrl(cwd, insideFile));
      assertEqual(res.status, 200, 'A14d 工作区内未列入清单的文件 → status（快路径不变）');
      assertEqual(res.text, insideContent, 'A14d 内容逐字节一致');
      const resWithSid = await rawRequest(srv.base, fileUrlSession(cwd, insideFile, sid));
      assertEqual(resWithSid.status, 200, 'A14d 带 session 的工作区内文件 → status（快路径仍零宿主调用）');
      return 'in-workspace not-listed=200（有/无 session 均 200）';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('A14e 无合法 session + 越界命中清单 → 403 旧文案（不含 code，R-2 一致）', async () => {
    const sid = 'session-a14e-full';
    const marker = 'A14E-LISTED-BYTES\n';
    const outsideDir = tempDir('q20-a14e-out-');
    const listed = writeFile(outsideDir, 'a14e-listed.md', marker);
    const { srv, cwd } = await openHost('a14e', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-a14e') } }),
      Q20_MOCK_HOST_SESSION_DELIVERABLES: deliverEnv(sid, [listed]),
    }));
    try {
      const res = await rawRequest(srv.base, fileUrl(cwd, listed));
      assertEqual(res.status, 403, 'A14e 无 session 越界（即便在清单内）→ status');
      assertEqual(res.text, LEGACY_ESCAPE_BODY,
        'A14e 无合法 session 的拒绝体必须与今天逐字节等价（b 步优先，不含 code）');
      assertNoLeak(res, [marker, outsideDir], 'A14e');
      return 'no-session=403 逐字节等价（清单不改变无 session 语义）';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A15 存在性 oracle 收口（契约 amend R-9：合法 session + 未注册 cwd）═══════════
  await runner.run('A15 合法 session + 未注册 cwd + 目标不存在 → 403（不得 404）；已注册 + 不存在 → 404 不变', async () => {
    const sid = 'session-a15-full';
    const unregistered = os.tmpdir();
    const { srv, cwd } = await openHost('a15', projEnv({
      // 会话 cwd = 未注册目录本身（c 步可通过），因此 403 只能来自「未注册 + 目标不存在」的收口规则
      [sid]: { permissions: { currentValue: FULL }, workingDirectory: unregistered },
    }));
    try {
      const nope = path.join(unregistered, 'q20-nope-a15-' + process.pid + '-' + Date.now() + '.md');
      assertFalse(fs.existsSync(nope), 'A15 前置：探测目标必须不存在');
      const probe = await rawRequest(srv.base, fileUrlSession(unregistered, nope, sid));
      assertEqual(probe.status, 403,
        'A15 合法 session + 未注册 cwd + 目标不存在 → 必须 403（不得用 404 暴露绝对路径存在性）');
      assertOk(probe.json && (probe.json.code === CODES_NOT_IN_DELIVERABLES
        || probe.json.code === 'PREVIEW_OUT_OF_SCOPE'),
      'A15 → code（R-8 成员闸门或 b 步语义，二者皆 fail-closed）',
      CODES_NOT_IN_DELIVERABLES + ' 或 PREVIEW_OUT_OF_SCOPE', probe.json && probe.json.code);
      assertNoLeak(probe, [unregistered], 'A15 未注册 + 不存在');

      const registeredMissing = await rawRequest(srv.base, fileUrlSession(cwd, path.join(cwd, 'a15-missing.md'), sid));
      assertEqual(registeredMissing.status, 404, 'A15 已注册 cwd + 目标不存在 → status 必须仍是 404');
      assertEqual(registeredMissing.json && registeredMissing.json.error, 'preview file not found',
        'A15 已注册 cwd + 目标不存在 → error 原文不变');
      return '未注册+不存在(合法 session)=403 ' + (probe.json && probe.json.code) + '; 已注册+不存在=404';
    } finally {
      await srv.stop();
    }
  });

  // ═══════════ A13 客户端接线静态断言（Gate-1 ADVISORY ⑤，防「客户端漏接仍全绿」）═══════════
  await runner.run('A13 客户端接线静态断言：data-fpsid ×2 + &session= 拼接 + 403 code→文案映射（含 SENSITIVE / NOT_IN_DELIVERABLES）', async () => {
    const file = path.join(REPO_ROOT, 'static', 'index.html');
    assertOk(fs.existsSync(file), 'A13 static/index.html 必须存在', redact(file), '(missing)');
    const html = fs.readFileSync(file, 'utf8');

    const fpsidCount = (html.match(/data-fpsid/g) || []).length;
    assertOk(fpsidCount >= 2,
      'A13 交付卡片与 fpChipHtml 必须都写 data-fpsid（会话 id 真源）', '≥2 处 data-fpsid', fpsidCount + ' 处');

    assertOk(/&session='\s*\+\s*encodeURIComponent\(/.test(html),
      'A13 fpBuildTarget 必须把会话 id 拼进 /api/file 的 &session= 参数',
      "&session=' + encodeURIComponent(<sid>)", '(未匹配)');

    const codeKeys = [
      'PREVIEW_PERMISSION_REQUIRED',
      'PREVIEW_SESSION_MISMATCH',
      'PREVIEW_POLICY_UNAVAILABLE',
      'PREVIEW_SENSITIVE_PATH',
      'PREVIEW_NOT_IN_DELIVERABLES',
    ];
    const missing = codeKeys.filter((k) => html.indexOf(k) === -1);
    assertEqual(missing.length, 0,
      'A13 403 响应 code→文案映射必须覆盖 §1.2 全部冻结码（缺失: ' + (missing.join(',') || '无') + '）');
    return 'data-fpsid=' + fpsidCount + ' 处; &session= 拼接命中; code 映射 ' + codeKeys.length + '/' + codeKeys.length;
  });

  const { failCount, degradedCount } = runner.report();
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  cleanupTempDirs();
  process.exit(failCount > 0 ? 1 : (degradedCount > 0 ? 3 : 0));
}

main().catch((err) => {
  console.error('[PREVIEW-POLICY SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
