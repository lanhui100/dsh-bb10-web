/**
 * Automated End-to-End Test Suite for BB10 Web Server (port 3090)
 *
 * 2026-09-30 变更（真链路测试改 mock，见 .agents/notes/implemented/testing/…）：
 *   默认以 Q20_MOCK_HOST=1 高隔离 mock 宿主运行 —— 不触碰真实 DSH Web (3080)、
 *   不发起任何真实 LLM 调用（服务端合成回复 + 本地 zstd 转录），不产生任何
 *   真实会话/工作区残留。显式设置 Q20_LIVE=1 才恢复真实链路（须自备运行中的
 *   真实 3090 服务，且 TEST_BASE_URL 可覆盖地址）。
 *
 * Scenarios covered:
 * 1. Cold start & first round dialogue with empty sessionId: ""
 *    - Verify empty string normalization, full SSE lifecycle (start -> delta -> done), sessionId extraction, non-empty response.
 * 2. Session continuation
 *    - Use sessionId from scenario 1, send second query, verify continuation on same sessionId with SSE stream.
 * 3. History loading
 *    - Call GET /api/history?cwd=...&id=<sessionId>, verify at least 4 messages (2 user, 2 assistant) with complete content.
 * 4. Model switching
 *    - Dynamically select an alternative model from /api/bootstrap (e.g. glm-5.3-flash, deepseek-v4-flash, or kimi-k3).
 *    - Send ping prompt and verify successful response.
 * 5. Workspace switching
 *    - Pick a non-main workspace from /api/bootstrap, get /api/sessions for that workspace.
 *    - Send a request targeted to that workspace, verify session creation & execution.
 * 6. Edge cases & boundary testing
 *    - Very short query, special characters, newlines / emojis / markdown.
 *    - Defense & fault tolerance for invalid/non-existent sessionId.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startMockServer } from './lib/test-mock-host.mjs';

const Q20_LIVE = process.env.Q20_LIVE === '1';
let BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3090';

/**
 * 识别测试自动创建的会话标题特征，防止测试中断或异常时未追踪到 ID 导致残留在工作区
 */
const TEST_TITLE_PATTERNS = [
  '什么是量子计算',
  '量子计算',
  '请简述它的两个具体应用场景',
  '请只回复一个单词：PONG',
  'WS_SWITCH_OK',
  'PASS-SPECIAL-123',
];

/**
 * 抓取指定工作区的当前活跃会话 ID 集合作为比对基线
 */
async function snapshotSessionIds(cwd) {
  try {
    const res = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
    if (res.status === 200 && Array.isArray(res.body)) {
      return new Set(res.body.map((s) => s.id));
    }
  } catch {
    // 允许网络抖动，降级为空集合
  }
  return new Set();
}

/**
 * Format milliseconds to readable string
 */
function formatDuration(ms) {
  return `${ms.toFixed(0)}ms`;
}

/**
 * Helper to make standard JSON HTTP requests
 */
async function httpRequest(urlPath, options = {}) {
  const url = new URL(urlPath, BASE_URL);
  const startTime = performance.now();

  // Node 不会对 DELETE 自动加 Content-Length/chunked framing，body 会丢失；
  // 有 body 时必须显式声明长度，否则服务端解析到空体。
  const bodyStr = options.body
    ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (bodyStr !== null) {
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let rawData = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          const duration = performance.now() - startTime;
          let json = null;
          try {
            json = JSON.parse(rawData);
          } catch {
            // keep json as null if not JSON
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            rawText: rawData,
            duration,
          });
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyStr !== null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Helper to send SSE chat stream and collect parsed events
 */
async function sseChatStream(payload, { timeoutMs = 120000 } = {}) {
  const url = new URL('/api/chat/stream', BASE_URL);
  const startTime = performance.now();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
      },
      (res) => {
        const events = [];
        let buffer = '';
        let currentEvent = null;
        let currentData = '';

        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop(); // keep partial line in buffer

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData += (currentData ? '\n' : '') + line.slice(5).trim();
            } else if (line.trim() === '') {
              if (currentEvent || currentData) {
                let parsed = currentData;
                try {
                  parsed = JSON.parse(currentData);
                } catch {
                  // Keep as string if not JSON
                }
                events.push({
                  event: currentEvent || 'message',
                  data: parsed,
                  timestamp: performance.now() - startTime,
                });
                currentEvent = null;
                currentData = '';
              }
            }
          }
        });

        res.on('end', () => {
          clearTimeout(timer);
          const duration = performance.now() - startTime;
          resolve({
            status: res.statusCode,
            events,
            duration,
          });
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

/**
 * Summary reporter
 */
class TestRunner {
  constructor() {
    this.results = [];
  }

  async runTest(name, fn) {
    console.log(`\n======================================================`);
    console.log(`▶ RUNNING: ${name}`);
    console.log(`------------------------------------------------------`);
    const t0 = performance.now();
    try {
      const details = await fn();
      const duration = performance.now() - t0;
      this.results.push({ name, passed: true, duration, details });
      console.log(`✔ PASSED: ${name} (${formatDuration(duration)})`);
      return details;
    } catch (err) {
      const duration = performance.now() - t0;
      this.results.push({ name, passed: false, duration, error: err.message, stack: err.stack });
      console.error(`✖ FAILED: ${name} (${formatDuration(duration)})`);
      console.error(`  Error: ${err.message}`);
      throw err;
    }
  }

  printReport() {
    console.log(`\n======================================================`);
    console.log(`                  TEST SUITE REPORT                   `);
    console.log(`======================================================`);
    let passCount = 0;
    let totalDuration = 0;

    for (const r of this.results) {
      totalDuration += r.duration;
      const statusStr = r.passed ? '✔ PASS' : '✖ FAIL';
      if (r.passed) passCount++;
      console.log(`${statusStr} [${formatDuration(r.duration).padStart(8)}] : ${r.name}`);
      if (r.details) {
        for (const [k, v] of Object.entries(r.details)) {
          console.log(`    - ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
        }
      }
      if (!r.passed && r.error) {
        console.log(`    - ERROR: ${r.error}`);
      }
    }

    console.log(`------------------------------------------------------`);
    console.log(`Total: ${this.results.length} | Passed: ${passCount} | Failed: ${this.results.length - passCount}`);
    console.log(`Total Elapsed Time: ${formatDuration(totalDuration)}`);
    console.log(`======================================================\n`);

    return passCount === this.results.length;
  }
}

/**
 * 完整归档与清理测试过程中创建的所有会话：
 * 1. 结合显式追踪列表(createdSessions)与基线差分自动探测(Diff Reconciliation)，定位所有测试会话；
 * 2. 依次调用 POST /api/session/archive（通知 DSH Web 官方 RPC 归档会话并使 Web 实时 Feed/工作区列表立刻隐藏）；
 * 3. 随后调用 DELETE /api/session（彻底删除本地转录文件并移除工作区引用，实现存储零垃圾残留）；
 * 4. 执行复检门禁：再次调用 /api/sessions，严格校验所有被触达的工作区中不再有任何测试会话残留！
 */
async function cleanupTestSessions(createdSessions, baselineByCwd) {
  console.log('\n======================================================');
  console.log('🧹 [CLEANUP] 开始归档与清理测试会话 (对齐 DSH Web 官方归档)...');
  console.log('------------------------------------------------------');

  const targets = new Map(); // key: `${cwd}::${sessionId}` -> { cwd, sessionId, reason }

  // 1. 加入显式追踪的会话
  for (const item of createdSessions) {
    if (item && item.sessionId) {
      targets.set(`${item.cwd}::${item.sessionId}`, {
        cwd: item.cwd,
        sessionId: item.sessionId,
        reason: 'tracked',
      });
    }
  }

  // 2. 基于基线差分与标题特征进行自动对账补漏
  for (const [cwd, baselineSet] of baselineByCwd.entries()) {
    try {
      const res = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
      if (res.status === 200 && Array.isArray(res.body)) {
        for (const s of res.body) {
          if (!s || !s.id) continue;
          if (baselineSet.has(s.id)) continue; // 属于启动前的基线会话，保留
          const title = String(s.title || '');
          const isTestTitle = TEST_TITLE_PATTERNS.some((p) => title.includes(p));
          if (isTestTitle) {
            targets.set(`${cwd}::${s.id}`, {
              cwd,
              sessionId: s.id,
              reason: `detected by pattern (${title.slice(0, 20)})`,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`  ⚠ 差分扫描工作区 ${cwd} 异常: ${err.message}`);
    }
  }

  console.log(`  共定位到 ${targets.size} 个测试会话待归档与清理:`);
  let archivedCount = 0;
  let deletedCount = 0;

  for (const item of targets.values()) {
    // 步骤一：归档（对齐 DSH Web 官方 RPC，实时通知前端工作区隐藏）
    try {
      const archiveRes = await httpRequest('/api/session/archive', {
        method: 'POST',
        body: { cwd: item.cwd, sessionId: item.sessionId },
      });
      if (archiveRes.status === 200 || archiveRes.status === 404) {
        archivedCount++;
      } else {
        console.warn(`  ⚠ 归档会话 ${item.sessionId} 响应 HTTP ${archiveRes.status}`);
      }
    } catch (err) {
      console.warn(`  ⚠ 归档会话 ${item.sessionId} 出错: ${err.message}`);
    }

    // 步骤二：物理删除本地存储并清理关联
    try {
      const delRes = await httpRequest('/api/session', {
        method: 'DELETE',
        body: { cwd: item.cwd, sessionId: item.sessionId },
      });
      if (delRes.status === 200 || delRes.status === 404) {
        deletedCount++;
        console.log(`  ✔ 已归档并清理: ${item.sessionId} [${item.reason}] (${item.cwd})`);
      } else {
        console.warn(`  ✖ 清理会话 ${item.sessionId} 失败: HTTP ${delRes.status}`);
      }
    } catch (err) {
      console.warn(`  ✖ 清理会话 ${item.sessionId} 出错: ${err.message}`);
    }
  }

  // 步骤三：门禁复检（保证工作区无任何本次测试会话残留，支持等待与重试）
  let leakDetected = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    leakDetected = false;
    for (const [cwd, baselineSet] of baselineByCwd.entries()) {
      try {
        const checkRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
        if (checkRes.status === 200 && Array.isArray(checkRes.body)) {
          const remainingTestSessions = checkRes.body.filter((s) => {
            if (baselineSet.has(s.id)) return false;
            const title = String(s.title || '');
            return TEST_TITLE_PATTERNS.some((p) => title.includes(p));
          });
          if (remainingTestSessions.length > 0) {
            leakDetected = true;
            if (attempt === 2) {
              console.error(`  ✖ [GATE FAILURE] 工作区 ${cwd} 仍残留 ${remainingTestSessions.length} 个测试会话:`, remainingTestSessions.map((s) => s.id));
            }
          }
        }
      } catch (err) {
        console.warn(`  ⚠ 校验复查工作区 ${cwd} 失败: ${err.message}`);
      }
    }
    if (!leakDetected) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (leakDetected) {
    console.error('✖ 会话清理复检未通过，工作区存在测试会话残留！');
    return false;
  }

  console.log(`✔ 会话清理完毕并通过复查：共归档 ${archivedCount}，彻底清理 ${deletedCount}，工作区 0 残留。`);
  console.log('======================================================\n');
  return true;
}

async function main() {
  const runner = new TestRunner();
  const createdSessions = [];
  const baselineByCwd = new Map();
  let sharedBootstrap = null;
  let scenarioSessionId = null;
  let suiteError = null;
  let cleanupSuccess = true;

  // 2026-09-30：默认以 Q20_MOCK_HOST 高隔离 mock 宿主运行（Q20_LIVE=1 才真实链路）。
  let mockHandle = null;
  if (!Q20_LIVE) {
    mockHandle = await startMockServer();
    BASE_URL = mockHandle.base;
    console.log(`\n🧪 [MOCK] 高隔离 mock 宿主已启动: ${BASE_URL}（真实链路已关闭，Q20_LIVE=1 可恢复）`);
  }

  // 创建测试专用隔离沙箱工作区，与日常开发工作区进行彻底的物理隔离
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'q20-test-sandbox-'));
  const scenarioCwd = path.join(sandboxRoot, 'main-ws');
  const altSandboxCwd = path.join(sandboxRoot, 'alt-ws');
  fs.mkdirSync(scenarioCwd, { recursive: true });
  fs.mkdirSync(altSandboxCwd, { recursive: true });
  fs.writeFileSync(path.join(scenarioCwd, 'package.json'), JSON.stringify({ name: 'test-sandbox-main' }));
  fs.writeFileSync(path.join(altSandboxCwd, 'package.json'), JSON.stringify({ name: 'test-sandbox-alt' }));

  console.log(`\n📦 [SANDBOX] 测试会话物理隔离沙箱已建立: ${sandboxRoot}`);

  try {
    // 记录沙箱基线（初始为空）
    baselineByCwd.set(scenarioCwd, await snapshotSessionIds(scenarioCwd));
    baselineByCwd.set(altSandboxCwd, await snapshotSessionIds(altSandboxCwd));

    // Pre-check: bootstrap inspection
    await runner.runTest('Pre-check: Bootstrap API Verification', async () => {
      const res = await httpRequest('/api/bootstrap');
      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200 from /api/bootstrap, got ${res.status}`);
      }
      const data = res.body;
      if (!data.workspaces || !Array.isArray(data.workspaces)) {
        throw new Error('Bootstrap missing workspaces array');
      }
      if (!data.models || !Array.isArray(data.models) || data.models.length === 0) {
        throw new Error('Bootstrap missing models array or models empty');
      }
      sharedBootstrap = data;

      // 回归护栏：权限默认值与中文目录（2026-09-19 变更：默认工作区内修改，
      // P 面板完全权限确认组件，文案对齐 dsh 官方中文翻译）。
      if (data.current?.permission !== 'workspace-write') {
        throw new Error(
          `Permission default regression: expected current.permission "workspace-write", got "${data.current?.permission}"`
        );
      }
      const permExpect = [
        ['workspace-write', '工作区内修改', false],
        ['danger-full-access', '完全权限', true],
        ['read-only', '仅可查看', false],
      ];
      const permList = Array.isArray(data.permissions) ? data.permissions : [];
      if (permList.length !== permExpect.length) {
        throw new Error(`Permission catalog regression: expected ${permExpect.length} presets, got ${permList.length}`);
      }
      for (let pi = 0; pi < permExpect.length; pi++) {
        const want = permExpect[pi];
        const got = permList[pi] || {};
        if (got.id !== want[0] || got.name !== want[1] || !!got.requiresConfirm !== want[2]) {
          throw new Error(
            `Permission catalog regression at index ${pi}: expected {id:"${want[0]}", name:"${want[1]}", requiresConfirm:${want[2]}}, got ${JSON.stringify(got)}`
          );
        }
      }

      const hostCurrentCwd = data.current?.workspaceCwd || process.cwd();

      // 回归护栏：工作区面板计数(sessionCount)不得高于 /api/sessions 实际列表长度。
      // 2026-09-18 修复前官方工作区直接取 workspace.json 注册数减归档数，残留 id 使计数虚高
      // （dsh-bb10-web 显示 33 实际 3）。修复后两者恒一致；并发建会话只会造成 count < list，
      // 重试几次吸收；count > list 即回归。
      const currentWs = data.workspaces.find((w) => w.cwd === hostCurrentCwd);
      if (currentWs && typeof currentWs.sessionCount === 'number') {
        let listLen = -1;
        let warning = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const listRes = await httpRequest(
            `/api/sessions?cwd=${encodeURIComponent(hostCurrentCwd)}`
          );
          if (listRes.status !== 200) throw new Error(`Expected HTTP 200 from /api/sessions, got ${listRes.status}`);
          listLen = listRes.body.length;
          if (currentWs.sessionCount === listLen) break;
          if (currentWs.sessionCount > listLen) {
            throw new Error(
              `sessionCount regression: workspace "${currentWs.name}" panel reports ${currentWs.sessionCount} sessions but /api/sessions resolves only ${listLen}`
            );
          }
          warning = `workspace "${currentWs.name}" sessionCount ${currentWs.sessionCount} < list ${listLen} (transient, retried)`;
          await new Promise((r) => setTimeout(r, 2000));
        }
        return {
          workspacesCount: data.workspaces.length,
          modelsCount: data.models.length,
          sandboxWorkspace: scenarioCwd,
          defaultModel: `${data.current?.provider}:${data.current?.model}`,
          sessionCountConsistency: currentWs.sessionCount === listLen ? 'ok' : warning,
        };
      }
      return {
        workspacesCount: data.workspaces.length,
        modelsCount: data.models.length,
        sandboxWorkspace: scenarioCwd,
        defaultModel: `${data.current?.provider}:${data.current?.model}`,
      };
    });

    // Scenario 1: New session cold start & first round dialogue
    await runner.runTest('场景一：新会话冷启动与首轮对话 (Empty sessionId Normalization & Full SSE Stream)', async () => {
      const res = await sseChatStream({
        cwd: scenarioCwd,
        sessionId: '', // Explicit empty sessionId
        prompt: '请用一句话回答：什么是量子计算？',
      });

      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }

      const eventNames = res.events.map((e) => e.event);
      const hasStart = eventNames.includes('start');
      const hasDelta = eventNames.includes('delta');
      const hasDone = eventNames.includes('done');

      if (!hasStart) throw new Error('Missing "start" SSE event');
      if (!hasDelta) throw new Error('Missing "delta" SSE event');
      if (!hasDone) throw new Error('Missing "done" SSE event');

      const doneEvent = res.events.find((e) => e.event === 'done')?.data;
      if (!doneEvent || !doneEvent.sessionId) {
        throw new Error('Done event missing generated sessionId');
      }

      const startEvent = res.events.find((e) => e.event === 'start')?.data;
      if (startEvent?.permission !== 'workspace-write') {
        throw new Error(
          `Scenario 1 start permission regression: expected "workspace-write" (default when omitted), got "${startEvent?.permission}"`
        );
      }

      scenarioSessionId = doneEvent.sessionId;
      createdSessions.push({ cwd: scenarioCwd, sessionId: scenarioSessionId });
      const finalResponse = doneEvent.finalResponse || '';
      if (!finalResponse.trim()) {
        throw new Error('Assistant output is empty');
      }

      return {
        sessionId: scenarioSessionId,
        firstRoundLength: finalResponse.length,
        deltaEventsCount: res.events.filter((e) => e.event === 'delta').length,
        deltaSample: finalResponse.slice(0, 60) + '...',
        sseEventsCount: res.events.length,
        confirmedPermissionInStartEvent: startEvent?.permission,
      };
    });

    // Scenario 2: Continuous multi-round dialogue (Session Continuation)
    await runner.runTest('场景二：连续多轮对话 (Session Continuation on Same Session)', async () => {
      if (!scenarioSessionId) {
        throw new Error('No sessionId available from Scenario 1');
      }

      const res = await sseChatStream({
        cwd: scenarioCwd,
        sessionId: scenarioSessionId,
        prompt: '请简述它的两个具体应用场景。',
      });

      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }

      const doneEvent = res.events.find((e) => e.event === 'done')?.data;
      if (!doneEvent) {
        throw new Error('Done event missing in round 2');
      }

      if (doneEvent.sessionId !== scenarioSessionId) {
        throw new Error(`Session ID mismatch! Expected ${scenarioSessionId}, got ${doneEvent.sessionId}`);
      }

      const finalResponse = doneEvent.finalResponse || '';
      if (!finalResponse.trim()) {
        throw new Error('Round 2 assistant output is empty');
      }

      return {
        continuedSessionId: doneEvent.sessionId,
        round2ResponseLength: finalResponse.length,
        round2Sample: finalResponse.slice(0, 60) + '...',
        deltaCount: res.events.filter((e) => e.event === 'delta').length,
      };
    });

    // Scenario 3: History decompression and loading
    await runner.runTest('场景三：历史记录解压与读取 (History Loading via /api/history)', async () => {
      if (!scenarioSessionId) {
        throw new Error('No sessionId available');
      }

      const query = new URLSearchParams({
        cwd: scenarioCwd,
        id: scenarioSessionId,
      });

      let messages = [];
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await httpRequest(`/api/history?${query.toString()}`);
        if (res.status !== 200) {
          throw new Error(`Expected HTTP 200 from /api/history, got ${res.status}: ${res.rawText}`);
        }
        messages = res.body;
        if (Array.isArray(messages) && messages.length >= 4) {
          break;
        }
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      if (!Array.isArray(messages)) {
        throw new Error(`Expected array of messages, got ${typeof messages}`);
      }

      if (messages.length < 4) {
        throw new Error(`Expected at least 4 history messages, but got ${messages.length}: ${JSON.stringify(messages)}`);
      }

      const roles = messages.map((m) => m.role);
      const userMsgs = messages.filter((m) => m.role === 'user');
      const assistantMsgs = messages.filter((m) => m.role === 'assistant');

      if (userMsgs.length < 2 || assistantMsgs.length < 2) {
        throw new Error(`Incomplete role distribution: ${userMsgs.length} users, ${assistantMsgs.length} assistants`);
      }

      return {
        totalMessages: messages.length,
        rolesSequence: roles.join(' -> '),
        round1User: userMsgs[0]?.text?.slice(0, 30),
        round1AssistantLen: assistantMsgs[0]?.text?.length,
        round2User: userMsgs[1]?.text?.slice(0, 30),
        round2AssistantLen: assistantMsgs[1]?.text?.length,
      };
    });

    // Scenario 4: Model switching
    await runner.runTest('场景四：模型切换测试 (Model Switching via /api/bootstrap dynamic list)', async () => {
      const models = sharedBootstrap?.models || [];
      const currentModelId = sharedBootstrap?.current?.model;

      const candidate = models.find((m) => {
        const id = m.model || m.id;
        return m.provider === 'ponyllm' && id !== currentModelId && (id.includes('flash') || id.includes('kimi')) && id !== 'glm-5.3-flash';
      }) || models.find((m) => {
        const id = m.model || m.id;
        return id !== currentModelId && id !== 'glm-5.3-flash';
      }) || models[0];

      const targetProvider = candidate.provider;
      const targetModel = candidate.model || candidate.id;

      console.log(`    Selected alternative model: ${targetProvider} -> ${targetModel}`);

      const res = await sseChatStream({
        cwd: scenarioCwd,
        sessionId: '', // fresh session
        provider: targetProvider,
        model: targetModel,
        prompt: '请只回复一个单词：PONG',
      }, { timeoutMs: 90000 });

      if (res.status !== 200) {
        throw new Error(`Model switch request returned HTTP ${res.status}`);
      }

      const startEvent = res.events.find((e) => e.event === 'start')?.data;
      const doneEvent = res.events.find((e) => e.event === 'done')?.data;

      if (!doneEvent) {
        const errEvent = res.events.find((e) => e.event === 'error')?.data;
        throw new Error(`Model ${targetModel} chat stream did not complete done: ${JSON.stringify(errEvent || res.events)}`);
      }

      if (!doneEvent.finalResponse || !doneEvent.finalResponse.trim()) {
        throw new Error(`Model ${targetModel} returned empty finalResponse`);
      }

      if (doneEvent.sessionId) {
        createdSessions.push({ cwd: scenarioCwd, sessionId: doneEvent.sessionId });
      }

      if (startEvent?.permission !== 'workspace-write') {
        throw new Error(
          `Stream start permission regression: expected "workspace-write" (default when omitted), got "${startEvent?.permission}"`
        );
      }

      return {
        testedProvider: targetProvider,
        testedModel: targetModel,
        confirmedModelInStartEvent: startEvent?.model,
        confirmedPermissionInStartEvent: startEvent?.permission,
        newSessionId: doneEvent.sessionId,
        responseLength: doneEvent.finalResponse?.length || 0,
        responsePreview: (doneEvent.finalResponse || '').trim().slice(0, 50),
      };
    });

    // Scenario 5: Workspace switching
    await runner.runTest('场景五：工作区切换测试 (Workspace Switching & Session Listing)', async () => {
      const workspaces = sharedBootstrap?.workspaces || [];
      const altWorkspace = workspaces.find((w) => w.cwd && w.cwd !== scenarioCwd);
      const targetWsCwd = altWorkspace ? altWorkspace.cwd : '/tmp';

      console.log(`    Selected alternative workspace: ${targetWsCwd}`);

      // Step 5.1: List sessions in target real workspace to verify listing capability
      const listRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(targetWsCwd)}`);
      if (listRes.status !== 200) {
        throw new Error(`Failed to list sessions for cwd ${targetWsCwd}: HTTP ${listRes.status}`);
      }
      const sessionList = listRes.body;
      if (!Array.isArray(sessionList)) {
        throw new Error(`Expected array of sessions, got ${typeof sessionList}`);
      }

      // Step 5.2: Create and run a session in isolated alternative sandbox workspace
      const streamRes = await sseChatStream({
        cwd: altSandboxCwd,
        sessionId: '',
        prompt: '请输出当前测试标识：WS_SWITCH_OK',
      });

      if (streamRes.status !== 200) {
        throw new Error(`Execution in alternative workspace failed: HTTP ${streamRes.status}`);
      }

      const doneEvent = streamRes.events.find((e) => e.event === 'done')?.data;
      if (!doneEvent || !doneEvent.sessionId) {
        throw new Error('Workspace switch chat stream missing done event or sessionId');
      }

      if (doneEvent.sessionId) {
        createdSessions.push({ cwd: altSandboxCwd, sessionId: doneEvent.sessionId });
      }

      return {
        inspectedRealWorkspace: targetWsCwd,
        existingSessionsInRealWorkspace: sessionList.length,
        sandboxAltWorkspace: altSandboxCwd,
        createdSessionId: doneEvent.sessionId,
        responseSample: doneEvent.finalResponse?.slice(0, 50),
      };
    });

    // Scenario 6: Edge cases and error tolerance
    await runner.runTest('场景六：极值与异常边界测试 (Edge Cases, Special Characters & Invalid Session Fault Tolerance)', async () => {
      const results = {};

      // 6.1 Short prompt with special characters, newlines, markdown
      console.log('    -> Subtest 6.1: Special characters and multiline prompt');
      const complexPrompt = `请输出：PASS-SPECIAL-123\nLine 2: 🚀\n\`\`\`json\n{"test": 1}\n\`\`\``;
      const specialRes = await sseChatStream({
        cwd: scenarioCwd,
        sessionId: '',
        prompt: complexPrompt,
      }, { timeoutMs: 120000 });

      if (specialRes.status !== 200) {
        throw new Error(`Special characters request failed with status ${specialRes.status}`);
      }
      const specialDone = specialRes.events.find((e) => e.event === 'done')?.data;
      if (!specialDone || !specialDone.sessionId) {
        throw new Error('Special characters request failed to complete');
      }
      results.specialPromptOk = true;
      results.specialSessionId = specialDone.sessionId;
      createdSessions.push({ cwd: scenarioCwd, sessionId: specialDone.sessionId });

      // 6.2 Missing required prompt
      console.log('    -> Subtest 6.2: Missing prompt parameter validation');
      const emptyPromptRes = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: scenarioCwd, prompt: '' },
      });
      if (emptyPromptRes.status !== 400) {
        throw new Error(`Expected HTTP 400 for empty prompt, got ${emptyPromptRes.status}`);
      }
      results.emptyPromptValidated = true;

      // 6.3 Missing required params in GET /api/sessions and /api/history
      console.log('    -> Subtest 6.3: Query validation on /api/sessions and /api/history');
      const noCwdSessions = await httpRequest('/api/sessions');
      if (noCwdSessions.status !== 400) {
        throw new Error(`Expected HTTP 400 for missing cwd in /api/sessions, got ${noCwdSessions.status}`);
      }

      const noIdHistory = await httpRequest(`/api/history?cwd=${encodeURIComponent(scenarioCwd)}`);
      if (noIdHistory.status !== 400) {
        throw new Error(`Expected HTTP 400 for missing id in /api/history, got ${noIdHistory.status}`);
      }
      results.queryValidationOk = true;

      // 6.4 Non-existent session id defense in history
      console.log('    -> Subtest 6.4: Query history with non-existent sessionId');
      const fakeHistory = await httpRequest(`/api/history?cwd=${encodeURIComponent(scenarioCwd)}&id=non-existent-session-xyz-99999`);
      if (fakeHistory.status !== 200 || !Array.isArray(fakeHistory.body) || fakeHistory.body.length !== 0) {
        throw new Error(`Expected empty array [] for non-existent session history, got status ${fakeHistory.status} and body ${JSON.stringify(fakeHistory.body)}`);
      }
      results.nonExistentSessionHandled = true;

      // 6.5 Fault tolerance when sending non-existent sessionId in chat/stream (Should create or handle cleanly)
      console.log('    -> Subtest 6.5: Chat stream with non-existent / arbitrary sessionId');
      const nonExistentStream = await sseChatStream({
        cwd: scenarioCwd,
        sessionId: 'arbitrary-ghost-session-id-00000',
        prompt: '请只回复一个单词：PONG',
      }, { timeoutMs: 120000 });
      const ghostDone = nonExistentStream.events.find((e) => e.event === 'done');
      const ghostErr = nonExistentStream.events.find((e) => e.event === 'error');
      if (ghostDone?.data?.sessionId) {
        createdSessions.push({ cwd: scenarioCwd, sessionId: ghostDone.data.sessionId });
      }
      results.ghostSessionStreamStatus = nonExistentStream.status;
      results.ghostSessionHandled = Boolean(ghostDone || ghostErr);

      return results;
    });
  } catch (err) {
    suiteError = err;
    console.error(`\n[FAIL-FAST] 测试步骤中断异常: ${err.message}`);
  } finally {
    // 无论测试成功还是失败中断，确保必执行会话归档与清理
    try {
      cleanupSuccess = await cleanupTestSessions(createdSessions, baselineByCwd);
    } finally {
      try {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
        console.log(`🧹 [SANDBOX] 物理隔离沙箱目录已彻底回收: ${sandboxRoot}\n`);
      } catch (e) {
        console.warn(`⚠ 沙箱目录回收异常: ${e.message}`);
      }
    }
    // mock 宿主进程与临时目录一并回收
    if (mockHandle) {
      try { await mockHandle.stop(); } catch {}
      mockHandle = null;
    }
  }

  const allPassed = runner.printReport();
  if (!allPassed || suiteError || !cleanupSuccess) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
