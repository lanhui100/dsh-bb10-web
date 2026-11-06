/**
 * Q20 Wave 2026-11-06 对抗套件：preview-policy（L2-AT 三类确定性对抗）
 * Owner: test-agent（独立验收方，冻结件；Executor 只读，绝不可改）
 *
 * 契约唯一来源：.dev-team/contract-wave-2026-11-06.md §1.2 错误码表 / §1.4 接缝 / §3bis AT-1/AT-2/AT-3
 * 运行：node tests/acceptance/adversarial/preview-policy-attack.mjs
 * 退出码：0=全绿；1=存在真实断言失败；3=显式 SKIP(DEGRADED)；2=套件启动失败
 *
 * 三类对抗（确定性，无 sleep 竞态判定）：
 *   AT-1 失败/超时注入 → fail-closed + 墙钟上限 + 无文件字节出网
 *   AT-2 畸形负载（编码穿越 / NUL / 超长 / 相对逃逸 / 伪造与重复 session / 客户端自述权限）→ 一律拒绝且不泄字节
 *   AT-3 竞态（danger-full-access vs workspace-write 同实例 barrier 并发 20 轮）→ 无策略串味
 *
 * 纪律：每用例独立 mock 实例（临时 DSH_HOME + 临时工作区根）；跨用例不复用实例，
 *       以规避 session/projections 的 15s 正/负缓存串味（契约 §3bis 对抗前提）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { FULL_ACCESS_POLICY } from '../../../lib/preview-policy.mjs';
import {
  ARTIFACT_DIR,
  assertEqual, assertFalse, assertLt, assertOk, cleanupTempDirs, createRunner, fail, redact, tempDir,
} from '../lib/harness.mjs';
import {
  countRpcMethod, openPreviewWorkspace, rawRequest, waitForLog,
} from '../lib/preview-host.mjs';

const runner = createRunner('PREVIEW-AT');

const enc = (v) => encodeURIComponent(v);
const FULL = FULL_ACCESS_POLICY;
const WRITE = 'workspace-write';
const fileUrl = (cwd, p) => '/api/file?cwd=' + enc(cwd) + '&path=' + enc(p);
const fileUrlSession = (cwd, p, sid) => fileUrl(cwd, p) + '&session=' + enc(sid);
const projEnv = (obj) => ({ Q20_MOCK_HOST_PROJECTIONS: JSON.stringify(obj) });

/** 契约 §1.2 冻结错误码（只读核对用）。 */
const CODES = {
  outOfScope: 'PREVIEW_OUT_OF_SCOPE',
  mismatch: 'PREVIEW_SESSION_MISMATCH',
  permission: 'PREVIEW_PERMISSION_REQUIRED',
  unavailable: 'PREVIEW_POLICY_UNAVAILABLE',
};
const LEGACY_ESCAPE_BODY = '{"ok":false,"error":"path escapes the workspace root"}';

const writeFile = (dir, name, content) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

async function openHost(id, env = {}, opts = {}) {
  const { srv, cwd, name, predictedCwd } = await openPreviewWorkspace(id, env, opts);
  assertEqual(cwd, predictedCwd,
    id + ' 工作区 cwd 必须等于 spawn 前可预测路径（宿主投影 workingDirectory 的事实来源）');
  return { srv, cwd, name };
}

/** 拒绝响应不得夹带文件字节 / 绝对路径（契约 §3bis 全体：无字节出网）。 */
function assertNoLeak(res, forbidden, label) {
  for (const token of forbidden) {
    assertOk(res.text.indexOf(token) === -1,
      label + ' 响应体不得夹带文件字节或绝对路径', '不含 ' + JSON.stringify(token), redact(res.text));
  }
}

/** 4096+ 字节超长 path 负载（保持合法 URL 字符集，走真实查询串）。 */
function longPath() {
  const seg = 'a'.repeat(200);
  return Array.from({ length: 24 }, () => seg).join('/') + '/x.md';
}

async function main() {
  console.log('# Q20 对抗套件 PREVIEW-AT (AT-1/AT-2/AT-3) — 契约 .dev-team/contract-wave-2026-11-06.md §3bis');
  console.log('# 时间: ' + new Date().toISOString());

  // ═══════════════════ AT-1 失败/超时注入 → fail-closed ═══════════════════

  // ── AT-1a 宿主 RPC 失败：该 sid 的接缝本为完全权限，FAIL 注入后必须拒绝而非放行 ──
  await runner.run('AT-1a PROJECTIONS_FAIL=1（该 sid 本为完全权限）→ 403 PREVIEW_POLICY_UNAVAILABLE，无文件字节出网', async () => {
    const sid = 'session-at1-fail';
    const marker = 'AT1A-SECRET-FILE-BYTES';
    const { srv, cwd } = await openHost('at1a', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at1a') } }),
      Q20_MOCK_HOST_PROJECTIONS_FAIL: '1',
    }));
    try {
      const outsideDir = tempDir('q20-at1-out-');
      const outsideFile = writeFile(outsideDir, 'at1a-secret.md', marker + '\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'AT-1a → status');
      assertEqual(res.json && res.json.code, CODES.unavailable, 'AT-1a → code');
      assertEqual(res.json && res.json.error, 'session permission is unavailable', 'AT-1a → error 原文');
      assertEqual(res.headers['content-type'], 'application/json; charset=utf-8', 'AT-1a → 必须是 JSON 拒绝，不是文件流');
      assertEqual(res.headers['content-length'], String(Buffer.byteLength(res.text)),
        'AT-1a Content-Length 必须为 JSON 体长度（证明未夹带文件字节）');
      assertNoLeak(res, [marker, outsideDir], 'AT-1a');
      const log = await waitForLog(srv, new RegExp('\\[PREVIEW\\][^\\n]*sid=' + sid));
      assertOk(!!log, 'AT-1a 服务端必须落 warn 且含 [PREVIEW] 与 sid=' + sid,
        '[PREVIEW] ... sid=' + sid, 'stderr 未见（末段: ' + redact((srv.stderrText || '').slice(-400)) + '）');
      return '403 ' + CODES.unavailable + '; 无字节出网; warn 命中 sid';
    } finally {
      await srv.stop();
    }
  });

  // ── AT-1b 宿主 RPC 超时：DELAY_MS=6000（> PROJECTIONS_TIMEOUT_MS=2500）→ fail-closed 且墙钟受限 ──
  await runner.run('AT-1b PROJECTIONS_DELAY_MS=6000 + 越界 → 403 PREVIEW_POLICY_UNAVAILABLE 且单请求墙钟 ≤3000ms', async () => {
    const sid = 'session-at1-delay';
    const marker = 'AT1B-SECRET-FILE-BYTES';
    const { srv, cwd } = await openHost('at1b', ({ workspacePath }) => ({
      ...projEnv({ [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at1b') } }),
      Q20_MOCK_HOST_PROJECTIONS_DELAY_MS: '6000',
    }));
    try {
      const outsideDir = tempDir('q20-at1b-out-');
      const outsideFile = writeFile(outsideDir, 'at1b-secret.md', marker + '\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid), { timeoutMs: 15000 });
      assertEqual(res.status, 403, 'AT-1b → status（不得挂死 / 不得 500 / 不得退回放行）');
      assertEqual(res.json && res.json.code, CODES.unavailable, 'AT-1b → code');
      assertLt(res.ms, 3000, 'AT-1b 单请求墙钟（契约上限 2500ms + 500ms 调度抖动）');
      assertNoLeak(res, [marker, outsideDir], 'AT-1b');

      // 同实例：工作区内路径必须不受宿主延迟影响（快路径零宿主调用）
      const insideContent = 'AT1B-INSIDE-BYTES\n';
      const insideFile = writeFile(cwd, 'at1b-inside.md', insideContent);
      const inside = await rawRequest(srv.base, fileUrl(cwd, insideFile), { timeoutMs: 15000 });
      assertEqual(inside.status, 200, 'AT-1b 工作区内（同延迟注入）→ status');
      assertEqual(inside.text, insideContent, 'AT-1b 工作区内内容必须逐字节一致');
      assertLt(inside.ms, 500, 'AT-1b 工作区内快路径墙钟（宿主延迟不得渗透快路径）');
      return '越界 403 in ' + Math.round(res.ms) + 'ms; 区内 200 in ' + Math.round(inside.ms) + 'ms';
    } finally {
      await srv.stop();
    }
  });

  // ── AT-1c 该 sid 无投影（接缝 values={}）→ 缺字段=拒绝 ──
  await runner.run('AT-1c 接缝返回无该 sid 投影（values={}）→ 403 PREVIEW_POLICY_UNAVAILABLE（缺字段=拒绝）', async () => {
    const sid = 'session-at1-empty';
    const marker = 'AT1C-SECRET-FILE-BYTES';
    const { srv, cwd } = await openHost('at1c', ({ workspacePath }) => projEnv({
      'session-at1-unrelated': { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at1c') },
    }));
    try {
      const outsideDir = tempDir('q20-at1c-out-');
      const outsideFile = writeFile(outsideDir, 'at1c-secret.md', marker + '\n');
      const res = await rawRequest(srv.base, fileUrlSession(cwd, outsideFile, sid));
      assertEqual(res.status, 403, 'AT-1c → status');
      assertEqual(res.json && res.json.code, CODES.unavailable, 'AT-1c → code（不得因缺 permissions 默认放行）');
      assertNoLeak(res, [marker, outsideDir], 'AT-1c');
      return '403 ' + CODES.unavailable;
    } finally {
      await srv.stop();
    }
  });

  // ═══════════════════ AT-2 畸形负载 → 一律拒绝且不泄字节 ═══════════════════

  await runner.run('AT-2a 编码穿越（..%2f 形态）：未授权必拒且无字节出网；完全权限仅按 realpath 事实放行', async () => {
    const sidFull = 'session-at2-traverse-full';
    const sidWrite = 'session-at2-traverse-write';
    const marker = 'AT2A-TRAVERSAL-SECRET';
    const { srv, cwd } = await openHost('at2a', ({ workspacePath }) => projEnv({
      [sidFull]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at2a') },
      [sidWrite]: { permissions: { currentValue: WRITE }, workingDirectory: workspacePath('ws-at2a') },
    }));
    try {
      const outsideDir = tempDir('q20-at2a-out-');
      const outsideFile = writeFile(outsideDir, 'at2a-secret.md', marker + '\n');
      const rel = path.relative(cwd, outsideFile);
      assertOk(rel.startsWith('..' + path.sep), 'AT-2a 前置：目标必须在工作区外', '../ 开头', rel);
      // 显式构造 `..%2f` 编码穿越形态（服务端解码后等价于含 ../ 的相对路径）
      const encoded = rel.split(path.sep).map((seg) => (seg === '..' ? '..' : enc(seg))).join('%2f');
      const attackUrl = '/api/file?cwd=' + enc(cwd) + '&path=' + encoded;

      const noSession = await rawRequest(srv.base, attackUrl);
      assertEqual(noSession.status, 403, 'AT-2a 无 session 编码穿越 → status');
      assertEqual(noSession.text, LEGACY_ESCAPE_BODY, 'AT-2a 无 session 编码穿越 → 旧文案逐字节等价');
      assertNoLeak(noSession, [marker, outsideDir], 'AT-2a 无 session');

      const writeRes = await rawRequest(srv.base, attackUrl + '&session=' + enc(sidWrite));
      assertEqual(writeRes.status, 403, 'AT-2a workspace-write 会话编码穿越 → status（不得越权 200）');
      assertOk(writeRes.json && (writeRes.json.code === CODES.permission || writeRes.json.code === CODES.mismatch),
        'AT-2a workspace-write 越界拒绝码', CODES.permission + ' 或 ' + CODES.mismatch, writeRes.json && writeRes.json.code);
      assertNoLeak(writeRes, [marker, outsideDir], 'AT-2a workspace-write');

      // 完全权限：契约 §2 允许按 realpath 事实放行；若放行则内容必须是「解析后的真实目标」，不得读任意其它文件；
      // 若实现选择更严格的 fail-closed 拒绝亦接受（安全侧收紧），但绝不接受 500 / 空体 200。
      const fullRes = await rawRequest(srv.base, attackUrl + '&session=' + enc(sidFull));
      assertFalse(fullRes.status === 500, 'AT-2a 完全权限编码穿越 → 不得 500');
      if (fullRes.status === 200) {
        assertEqual(fullRes.text, marker + '\n',
          'AT-2a 放行时必须返回 realpath 解析出的那个真实目标文件（不得借穿越扩大可达面）');
      } else {
        assertOk([400, 403, 404].indexOf(fullRes.status) !== -1,
          'AT-2a 完全权限编码穿越 → 只允许 400/403/404 的 fail-closed 拒绝', '400|403|404 或 200', fullRes.status);
        assertNoLeak(fullRes, [marker, outsideDir], 'AT-2a 完全权限拒绝');
      }
      return 'no-session=403 逐字节等价; write=403 ' + (writeRes.json && writeRes.json.code)
        + '; full=' + fullRes.status;
    } finally {
      await srv.stop();
    }
  });

  await runner.run('AT-2b/c NUL(%00) 与 ≥4096 字节超长 path：绝不 200/500，响应体不泄绝对路径', async () => {
    const sid = 'session-at2-malformed';
    const { srv, cwd } = await openHost('at2bc', ({ workspacePath }) => projEnv({
      [sid]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at2bc') },
    }));
    try {
      const leakForbidden = ['/tmp/', '/home/', '/etc/', cwd, srv.workspaceRoot];
      const nuls = await rawRequest(srv.base, '/api/file?cwd=' + enc(cwd) + '&path=' + enc('%00etc%00passwd%00.md') + '&session=' + enc(sid));
      assertOk([400, 403, 404].indexOf(nuls.status) !== -1, 'AT-2b NUL path → 只允许 400/403/404',
        '400|403|404', nuls.status);
      assertNoLeak(nuls, leakForbidden, 'AT-2b NUL');

      const longP = longPath();
      assertOk(Buffer.byteLength(longP) >= 4096, 'AT-2c 负载长度必须 ≥4096 字节', '≥4096', Buffer.byteLength(longP));
      const longRes = await rawRequest(srv.base,
        '/api/file?cwd=' + enc(cwd) + '&path=' + enc(longP) + '&session=' + enc(sid));
      assertOk([400, 403, 404].indexOf(longRes.status) !== -1, 'AT-2c 超长 path → 只允许 400/403/404',
        '400|403|404（绝不 200/500）', longRes.status);
      assertNoLeak(longRes, leakForbidden, 'AT-2c 超长 path');

      const relEscape = await rawRequest(srv.base,
        '/api/file?cwd=' + enc(cwd) + '&path=' + enc('../../etc/passwd') + '&session=' + enc(sid));
      assertFalse(relEscape.status === 200, 'AT-2c 相对逃逸 ../../etc/passwd 无归属核验时不得 200');
      assertFalse(relEscape.status === 500, 'AT-2c 相对逃逸 ../../etc/passwd 不得 500');
      assertNoLeak(relEscape, ['root:x:', '/etc/passwd'], 'AT-2c 相对逃逸');
      return 'NUL=' + nuls.status + '; long(' + Buffer.byteLength(longP) + 'B)=' + longRes.status
        + '; ../../etc/passwd=' + relEscape.status;
    } finally {
      await srv.stop();
    }
  });

  await runner.run('AT-2d 伪造 session 参数（穿越/超长/含分隔符/空串）→ 一律按缺失处理：403 旧文案且不发起 RPC', async () => {
    // DELAY=3000 让「发起了 RPC 却没超时」这件事在墙钟上可见
    const { srv, cwd } = await openHost('at2d', { Q20_MOCK_HOST_PROJECTIONS_DELAY_MS: '3000' }, { rpcLog: true });
    try {
      const outsideDir = tempDir('q20-at2d-out-');
      const outsideFile = writeFile(outsideDir, 'at2d-outside.md', 'AT2D-BYTES\n');
      const badSids = [
        ['编码穿越', '..%2f..%2fx'],
        ['超长 200 字符', 'a'.repeat(200)],
        ['含路径分隔', 'session-../../x'],
        ['空串', ''],
      ];
      const observed = [];
      for (const [label, rawSid] of badSids) {
        const url = '/api/file?cwd=' + enc(cwd) + '&path=' + enc(outsideFile) + '&session=' + rawSid;
        const res = await rawRequest(srv.base, url, { timeoutMs: 10000 });
        assertEqual(res.status, 403, 'AT-2d 非法 session(' + label + ') → status');
        // 契约 §1.3 的「逐字节等价」只约束「不带 session」的请求；带非法 session 时
        // 响应体可以追加 code，但 error 文案必须是 b 步旧文案（须按缺失处理，不得改报策略码）。
        assertEqual(res.json && res.json.error, 'path escapes the workspace root',
          'AT-2d 非法 session(' + label + ') → 必须按「无 session」b 步旧文案处理，不得改报策略码');
        assertOk(res.json && (res.json.code === undefined || res.json.code === CODES.outOfScope),
          'AT-2d 非法 session(' + label + ') → code 只允许缺省或 ' + CODES.outOfScope,
          'undefined 或 ' + CODES.outOfScope, res.json && res.json.code);
        assertLt(res.ms, 1000, 'AT-2d 非法 session(' + label + ') 墙钟（证明未发起宿主 RPC：接入缝延迟 3000ms）');
        observed.push(label + '=' + res.status + '/' + Math.round(res.ms) + 'ms');
      }
      assertEqual(countRpcMethod(srv, 'session/projections'), 0,
        'AT-2d 非法 session 一律不得触发 session/projections RPC（零宿主调用）');
      // 重复 session 参数：契约 §3bis 期待「按缺失处理」，但 §1.3 未规定多值语义
      // （`searchParams.get()` 只取首值 `a`，而 `a` 恰好通过 isValidSessionId）。
      // 故断言取两种合法读法的交集：必须 fail-closed 403、不得放行、不得夹带字节。
      const dup = await rawRequest(srv.base,
        '/api/file?cwd=' + enc(cwd) + '&path=' + enc(outsideFile) + '&session=a&session=b');
      assertEqual(dup.status, 403, 'AT-2d 重复 session 参数 → 必须 fail-closed 403（绝不 200/500）');
      assertOk(dup.json && [
        'path escapes the workspace root',
        'session permission is unavailable',
        'session permission does not allow reading outside the workspace',
        'session does not own this workspace',
      ].indexOf(dup.json.error) !== -1,
      'AT-2d 重复 session 参数 → error 必须是契约 §1.2 既有文案之一',
      '§1.2 冻结文案之一', dup.json && dup.json.error);
      assertNoLeak(dup, [outsideDir, 'AT2D-BYTES'], 'AT-2d 重复 session');
      const unregistered = tempDir('q20-at2d-unreg-');
      const noCwd = await rawRequest(srv.base, '/api/file?cwd=' + enc(unregistered) + '&path=' + enc(outsideFile));
      assertEqual(noCwd.status, 403, 'AT-2d 未注册 cwd → status');
      return observed.join('; ') + '; RPC=0';
    } finally {
      await srv.stop();
    }
  });

  await runner.run('AT-2e 客户端自述 permission=danger-full-access 一律被忽略（只信宿主投影）→ 仍 403', async () => {
    const sid = 'session-at2-perm';
    const marker = 'AT2E-SECRET-BYTES';
    const { srv, cwd } = await openHost('at2e', ({ workspacePath }) => projEnv({
      [sid]: { permissions: { currentValue: WRITE }, workingDirectory: workspacePath('ws-at2e') },
    }));
    try {
      const outsideDir = tempDir('q20-at2e-out-');
      const outsideFile = writeFile(outsideDir, 'at2e-secret.md', marker + '\n');
      const forged = await rawRequest(srv.base,
        fileUrlSession(cwd, outsideFile, sid) + '&permission=' + enc(FULL));
      assertEqual(forged.status, 403, 'AT-2e 伪造 permission（有 workspace-write 会话）→ status');
      assertEqual(forged.json && forged.json.code, CODES.permission,
        'AT-2e 伪造 permission 必须被忽略 → 仍按宿主投影 workspace-write 拒绝');
      assertNoLeak(forged, [marker, outsideDir], 'AT-2e 伪造 permission');

      const noSession = await rawRequest(srv.base, fileUrl(cwd, outsideFile) + '&permission=' + enc(FULL));
      assertEqual(noSession.status, 403, 'AT-2e 无 session + 伪造 permission → status');
      assertEqual(noSession.text, LEGACY_ESCAPE_BODY, 'AT-2e 无 session + 伪造 permission → 旧文案逐字节等价');

      const post = await rawRequest(srv.base, '/api/file?cwd=' + enc(cwd) + '&path=' + enc(outsideFile),
        { method: 'POST', body: { session: sid, permission: FULL }, timeoutMs: 10000 });
      assertFalse(post.status === 200, 'AT-2e POST 携带自述权限不得被当作放行依据');
      assertFalse(post.status === 500, 'AT-2e POST /api/file 不得 500');
      assertNoLeak(post, [marker, outsideDir], 'AT-2e POST');
      return '有会话=403 ' + CODES.permission + '; 无会话=403 旧文案; POST=' + post.status;
    } finally {
      await srv.stop();
    }
  });

  // ═══════════════════ AT-3 竞态 → 无策略串味 ═══════════════════

  await runner.run('AT-3 竞态：danger-full-access 与 workspace-write 同实例 barrier 并发 20 轮，策略不得串味', async () => {
    const sidFull = 'session-at3-full';
    const sidWrite = 'session-at3-write';
    const shared = 'AT3-SHARED-TARGET-BYTES\n';
    const { srv, cwd } = await openHost('at3', ({ workspacePath }) => projEnv({
      [sidFull]: { permissions: { currentValue: FULL }, workingDirectory: workspacePath('ws-at3') },
      [sidWrite]: { permissions: { currentValue: WRITE }, workingDirectory: workspacePath('ws-at3') },
    }));
    try {
      const outsideDir = tempDir('q20-at3-out-');
      const outsideFile = writeFile(outsideDir, 'at3-target.md', shared);
      const fullUrl = fileUrlSession(cwd, outsideFile, sidFull);
      const writeUrl = fileUrlSession(cwd, outsideFile, sidWrite);

      const mismatches = [];
      for (let round = 1; round <= 20; round += 1) {
        // 确定性 barrier：同一 tick 内同时发出两条请求（真实并发，无 sleep 竞态）
        const [fullRes, writeRes] = await Promise.all([
          rawRequest(srv.base, fullUrl),
          rawRequest(srv.base, writeUrl),
        ]);
        if (fullRes.status !== 200 || fullRes.text !== shared) {
          mismatches.push('round ' + round + ' sid-full 未按完全权限放行（期望 200 + 目标内容，实际 '
            + fullRes.status + ' ' + JSON.stringify(fullRes.text.slice(0, 120)) + '）');
        }
        if (writeRes.status === 200) {
          mismatches.push('round ' + round + ' sid-write 被放行 → 策略串味/越权（实际 200 + '
            + JSON.stringify(writeRes.text.slice(0, 120)) + '）');
        } else if (writeRes.status !== 403 || !writeRes.json || writeRes.json.code !== CODES.permission) {
          mismatches.push('round ' + round + ' sid-write 策略码不符（期望 403 ' + CODES.permission
            + '，实际 ' + writeRes.status + ' ' + JSON.stringify(writeRes.text.slice(0, 120)) + '）');
        }
        if (writeRes.text.indexOf(shared.trim()) !== -1) {
          mismatches.push('round ' + round + ' sid-write 响应夹带目标文件字节（越权泄漏）');
        }
      }
      if (mismatches.length > 0) {
        fail('AT-3 20 轮 barrier 并发内策略结果不稳定/串味', '每轮 full=200 且 write=403 ' + CODES.permission,
          mismatches.slice(0, 6).join(' | ') + (mismatches.length > 6 ? ' | …共 ' + mismatches.length + ' 处' : ''));
      }
      return '20 轮 barrier 并发：sid-full 恒 200（内容一致）/ sid-write 恒 403 ' + CODES.permission;
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
  console.error('[PREVIEW-AT SUITE FATAL] ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
