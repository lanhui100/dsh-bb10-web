import assert from 'node:assert';
import http from 'node:http';
import { startMockServer } from '../lib/test-mock-host.mjs';

function httpRequest(urlPath, options = {}) {
  const base = options.base || 'http://127.0.0.1:3090';
  const url = new URL(urlPath, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || { 'Content-Type': 'application/json' },
      timeout: options.timeout || 15000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, data: json });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

export async function runArchiveFilterSuite() {
  console.log('--- Running Archive Filter Suite (Red-Phase) ---');
  const mock = await startMockServer();
  const base = mock.base;
  const cwd = mock.workspaceRoot;

  try {
    // 1. 种子两个有效会话（含对话轮次，防止作为 blank 会话被过滤）
    console.log('  1) Seeding two active sessions in mock workspace...');
    const r1 = await httpRequest('/api/session/ensure', { method: 'POST', body: { cwd }, base });
    assert.strictEqual(r1.status, 200);
    const sid1 = r1.data.sessionId;

    const r2 = await httpRequest('/api/session/ensure', { method: 'POST', body: { cwd }, base });
    assert.strictEqual(r2.status, 200);
    const sid2 = r2.data.sessionId;

    await httpRequest('/api/chat/stream', {
      method: 'POST',
      body: { cwd, sessionId: sid1, prompt: 'Session 1 turn' },
      base,
      timeout: 20000,
    });
    await httpRequest('/api/chat/stream', {
      method: 'POST',
      body: { cwd, sessionId: sid2, prompt: 'Session 2 turn' },
      base,
      timeout: 20000,
    });

    // 验证初始状态两会话都在列表中
    const preRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}`, { base });
    assert.strictEqual(preRes.status, 200);
    assert.ok(Array.isArray(preRes.data));
    const preIds = preRes.data.map(s => s.id);
    assert.ok(preIds.includes(sid1), 'sid1 should be present initially');
    assert.ok(preIds.includes(sid2), 'sid2 should be present initially');

    // 2. 将 sid2 归档
    console.log(`  2) Archiving session ${sid2}...`);
    const rArch = await httpRequest('/api/session/archive', {
      method: 'POST',
      body: { cwd, sessionId: sid2 },
      base,
    });
    assert.strictEqual(rArch.status, 200);
    assert.strictEqual(rArch.data?.ok, true);

    // 3. 默认 (无 filter) 与 filter=hide-archived
    console.log('  3) Testing default & filter=hide-archived...');
    const defRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}&refresh=1`, { base });
    assert.strictEqual(defRes.status, 200);
    const defIds = (defRes.data || []).map(s => s.id);
    assert.ok(defIds.includes(sid1), 'Default must include unarchived sid1');
    assert.ok(!defIds.includes(sid2), 'Default must NOT include archived sid2');

    const hideRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}&filter=hide-archived&refresh=1`, { base });
    assert.strictEqual(hideRes.status, 200);
    const hideIds = (hideRes.data || []).map(s => s.id);
    assert.ok(hideIds.includes(sid1), 'hide-archived must include unarchived sid1');
    assert.ok(!hideIds.includes(sid2), 'hide-archived must NOT include archived sid2');

    // 4. filter=all (红相断言：必须包含 sid1 与 sid2，且 sid2 需带 isArchived: true)
    console.log('  4) Testing filter=all (RED ASSERTION)...');
    const allRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}&filter=all&refresh=1`, { base });
    assert.strictEqual(allRes.status, 200);
    const allList = allRes.data || [];
    const allIds = allList.map(s => s.id);
    assert.ok(allIds.includes(sid1), 'filter=all must include unarchived sid1');
    assert.ok(allIds.includes(sid2), `filter=all must include archived sid2 (${sid2}), got: ${JSON.stringify(allIds)}`);
    const s2All = allList.find(s => s.id === sid2);
    assert.strictEqual(s2All?.isArchived, true, 'sid2 in filter=all must have isArchived: true');

    // 5. filter=only-archived (红相断言：必须仅包含 sid2，且带 isArchived: true，绝不含 sid1)
    console.log('  5) Testing filter=only-archived (RED ASSERTION)...');
    const onlyRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}&filter=only-archived&refresh=1`, { base });
    assert.strictEqual(onlyRes.status, 200);
    const onlyList = onlyRes.data || [];
    const onlyIds = onlyList.map(s => s.id);
    assert.ok(!onlyIds.includes(sid1), 'filter=only-archived must NOT include unarchived sid1');
    assert.ok(onlyIds.includes(sid2), `filter=only-archived must include archived sid2 (${sid2}), got: ${JSON.stringify(onlyIds)}`);
    const s2Only = onlyList.find(s => s.id === sid2);
    assert.strictEqual(s2Only?.isArchived, true, 'sid2 in filter=only-archived must have isArchived: true');

    // 6. 测试 /api/session/unarchive 取消归档能力
    console.log(`  6) Unarchiving session ${sid2}...`);
    const rUnarch = await httpRequest('/api/session/unarchive', {
      method: 'POST',
      body: { cwd, sessionId: sid2 },
      base,
    });
    assert.strictEqual(rUnarch.status, 200);
    assert.strictEqual(rUnarch.data?.ok, true);

    const postUnarchRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}&refresh=1`, { base });
    assert.strictEqual(postUnarchRes.status, 200);
    const postUnarchIds = (postUnarchRes.data || []).map(s => s.id);
    assert.ok(postUnarchIds.includes(sid2), 'After unarchive, default list must include sid2 again');

    console.log('--- Archive Filter Suite Verified ---');
  } finally {
    await mock.stop();
  }
}

if (process.argv[1].endsWith('test-archive-filter.mjs')) {
  runArchiveFilterSuite().catch(err => {
    console.error('Test failed (EXPECTED RED FAILURE):', err.message);
    process.exit(1);
  });
}
