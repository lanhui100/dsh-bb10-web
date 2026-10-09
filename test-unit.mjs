/**
 * Fast Local Unit & Contract Test Suite for BB10 Web Companion (port 3090)
 *
 * Characteristics:
 * - 0 External LLM model calls
 * - 0 Token consumption
 * - 0 Session pollution in any workspace
 * - Fast execution (< 1s)
 * - Complete coverage of HTTP API boundaries, multi-frame Zstd decompression,
 *   role message reconstruction, and workspace consistency guards.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { classifyQuestionFrame } from './lib/ask-ownership.mjs';
import { startMockServer } from './lib/test-mock-host.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3090';

function formatDuration(ms) {
  return `${ms.toFixed(0)}ms`;
}

async function httpRequest(urlPath, options = {}) {
  const url = new URL(urlPath, options.base || BASE_URL);
  const startTime = performance.now();

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
        timeout: options.timeout || 10000,
      },
      (res) => {
        // P0：同时保留原始 Buffer（gzip 二进制经 utf8 解码会损坏，不可用 rawText 还原）
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const duration = performance.now() - startTime;
          const rawBuffer = Buffer.concat(chunks);
          const rawData = rawBuffer.toString('utf8');
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
            rawBuffer,
            duration,
          });
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request timeout after ${options.timeout || 10000}ms`));
    });

    if (bodyStr !== null) {
      req.write(bodyStr);
    }
    req.end();
  });
}

async function httpRaw(urlPath, options = {}) {
  const url = new URL(urlPath, options.base || BASE_URL);
  const startTime = performance.now();
  const rawBody = options.rawBody || null;
  const headers = { ...(options.headers || {}) };
  if (rawBody !== null && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = Buffer.byteLength(rawBody);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method || 'GET', headers, timeout: options.timeout || 10000 },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const rawData = rawBuffer.toString('utf8');
          let json = null;
          try { json = JSON.parse(rawData); } catch { /* keep null */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, rawText: rawData, rawBuffer, duration: performance.now() - startTime });
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
    if (rawBody !== null) req.write(rawBody);
    req.end();
  });
}

// ── 高隔离 mock 宿主（Q20_MOCK_HOST=1）：workspace create/remove、session/ensure
//    契约测试跑在独立进程 + 临时 DSH_HOME + 临时工作区根上，绝不触碰真实宿主 /
//    真实 LLM / 真实家目录与注册表。2026-09-30 变更：真链路测试改 mock。
let mockServer = null; // { base, home, dshHome, workspaceRoot, registryFile, stop }

async function ensureMockServer() {
  if (mockServer) return mockServer;
  mockServer = await startMockServer();
  return mockServer;
}

const mockRegistry = () => {
  if (!mockServer) throw new Error('mock server not started');
  return mockServer.registryFile;
};

/** mock 宿主工作区删除（unregister + 目录移除，等价旧宿主 workspace/delete 清理）。 */
async function mockDeleteWorkspace(cwd) {
  if (!mockServer) throw new Error('mock server not started');
  const rr = await httpRequest('/api/workspace/remove', { method: 'POST', body: { cwd }, base: mockServer.base });
  if (rr.status !== 200 && rr.status !== 404) {
    throw new Error(`mock delete want 200/404, got ${rr.status}: ${JSON.stringify(rr.body)}`);
  }
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

/** 在 mock 工作区根下移除探针目录并断言零残留。 */
function mockRemoveProbeDir(probeDir) {
  if (!mockServer) throw new Error('mock server not started');
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  if (fs.existsSync(probeDir)) throw new Error(`probe dir residue ${probeDir}`);
}

class UnitRunner {
  constructor() {
    this.results = [];
  }

  async run(name, fn) {
    console.log(`▶ [UNIT] ${name}`);
    const t0 = performance.now();
    try {
      const details = await fn();
      const duration = performance.now() - t0;
      this.results.push({ name, passed: true, duration, details });
      console.log(`  ✔ PASS (${formatDuration(duration)})`);
      return details;
    } catch (err) {
      const duration = performance.now() - t0;
      this.results.push({ name, passed: false, duration, error: err.message, stack: err.stack });
      console.error(`  ✖ FAIL (${formatDuration(duration)}): ${err.message}`);
      throw err;
    }
  }

  printReport() {
    console.log(`\n======================================================`);
    console.log(`              UNIT TEST SUITE REPORT                  `);
    console.log(`======================================================`);
    let passCount = 0;
    let totalDuration = 0;

    for (const r of this.results) {
      totalDuration += r.duration;
      const statusStr = r.passed ? '✔ PASS' : '✖ FAIL';
      if (r.passed) passCount++;
      console.log(`${statusStr} [${formatDuration(r.duration).padStart(6)}] : ${r.name}`);
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

async function main() {
  const runner = new UnitRunner();
  let suiteError = null;

  try {
    // 0. Token Stats Fold Contract (dsh token-meter 对齐：替换/计费/命中率)
    await runner.run('Token Stats Fold Contract (lib/token-stats.mjs, dsh aligned)', async () => {
      const lib = await import('./lib/token-stats.mjs');

      // F1 同 turn+step 重复样本替换（重试/渐进更新不双算）
      const fold = lib.createUsageFold();
      fold.add({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 } });
      fold.add({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 900 } });
      fold.add({ turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5 } });
      const t = fold.totals();
      if (t.uncachedInputTokens !== 150 || t.outputTokens !== 17 || t.cacheReadTokens !== 900 || t.cacheWriteTokens !== 0) {
        throw new Error(`fold replace failed: ${JSON.stringify(t)}`);
      }

      // F1b llm/retry-started 关槽：同槽重试 settlement 全额累加（dsh tokenUsageProjection）
      const foldR = lib.createUsageFold();
      foldR.add({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 } });
      foldR.closeRetrySlot(1, 1);
      foldR.add({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 } });
      const tr = foldR.totals();
      if (tr.uncachedInputTokens !== 200 || tr.outputTokens !== 20 || tr.cacheReadTokens !== 1800) {
        throw new Error(`retry slot close failed: ${JSON.stringify(tr)}`);
      }

      // F2 计费输入 = 三桶之和
      if (lib.billedInputTokens(t) !== 1050) throw new Error('billedInputTokens failed');

      // F3 pressureFrom 不含输出
      if (lib.pressureFrom({ inputTokens: 100, outputTokens: 99, cacheReadTokens: 900, cacheWriteTokens: 7 }) !== 1007) {
        throw new Error('pressureFrom must exclude output');
      }

      // F4 usage 源回退 stream 内嵌 usage chunk；非 assistant 事件返回 null；
      // attempt 只走 stream（dsh usageOf：attempt 载荷本无 usage 字段）
      const fromStream = lib.extractEventUsage({ type: 'assistant/message', data: { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } } }] } });
      if (!fromStream || fromStream.usage.inputTokens !== 3) throw new Error('stream usage fallback failed');
      if (lib.extractEventUsage({ type: 'step/end', data: {} }) !== null) throw new Error('non-assistant must be null');
      const attemptStream = lib.extractEventUsage({ type: 'assistant/attempt', data: { turn: 2, step: 1, usage: { inputTokens: 999, outputTokens: 1 }, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } } }] } });
      if (!attemptStream || attemptStream.usage.inputTokens !== 3) throw new Error('attempt must use stream, not data.usage');
      // F5 无坐标样本走加法槽（legacy 兜底，永不静默丢 token）
      const foldU = lib.createUsageFold();
      foldU.add({ turn: undefined, step: undefined, usage: { inputTokens: 7, outputTokens: 2 } });
      foldU.add({ turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 } });
      const tu = foldU.totals();
      if (tu.uncachedInputTokens !== 107 || tu.outputTokens !== 12) {
        throw new Error(`unkeyed additive failed: ${JSON.stringify(tu)}`);
      }

      // F6 命中率：整数口径 + 部分命中永不舍入 100% + 零输入 null
      if (lib.formatCacheHitPercent(4940, 10000, 0) !== '49') throw new Error('hit 49 failed');
      if (lib.formatCacheHitPercent(999, 1000, 1) !== '99.9') throw new Error('hit 99.9 failed');
      const nearFull = lib.formatCacheHitPercent(9999, 10000, 0);
      if (nearFull === '100') throw new Error(`partial hit must not round to 100, got ${nearFull}`);
      if (lib.formatCacheHitPercent(0, 0, 1) !== null) throw new Error('zero input must be null');
      if (lib.formatCacheHitPercent(500, 500, 1) !== '100') throw new Error('full hit must be 100');

      return { foldReplace: true, billedInput: 1050, pressureExcludesOutput: true, streamFallback: true, hitNeverRoundsTo100: nearFull };
    });

    // 0b. Stream Fold Ordering Contract (dsh ClientAssistantStream 对齐：单 delta
    // 通道 + frame.index 保序 + durable 暂存 + usage 解耦 + rebaseline 保现场 +
    // turn/end 冲刷 + abandonment 回滚；handler 级真测试直驱 lib/session-events.mjs）
    await runner.run('Stream Fold Ordering Contract (lib/stream-fold.mjs, dsh aligned)', async () => {
      const foldLib = await import('./lib/stream-fold.mjs');
      const evLib = await import('./lib/session-events.mjs');
      const tokLib = await import('./lib/token-stats.mjs');

      // 真 handler 工厂：fake task + 事件收集，直驱交织断言端到端行为。
      const mkHandler = () => {
        const seen = [];
        const task = { events: [], listeners: new Set(), eventSeq: 0 };
        const broadcast = (t, ev, data) => {
          t.eventSeq++;
          t.events.push({ event: ev, data, seq: t.eventSeq });
          seen.push(ev + ':' + JSON.stringify(data).slice(0, 80));
        };
        const h = evLib.createSessionEventHandler(task, {
          broadcastTaskEvent: broadcast,
          computeToolSummary: (n) => n,
          extractToolResultOutput: () => 'out',
          extractEventUsage: tokLib.extractEventUsage,
          createUsageFold: tokLib.createUsageFold,
          pressureFrom: tokLib.pressureFrom,
          createStreamFold: foldLib.createStreamFold,
        });
        return { h, seen, task };
      };
      const deltasOf = (seen) => seen.filter((s) => s.indexOf('delta:') === 0);

      // S1 正常 attempt：chunk 按序 transient；durable 被暂存（held）；
      // end/committed 释放 settlement。
      const f1 = foldLib.createStreamFold();
      f1.acceptFrame({ type: 'start', attemptId: 'a1', startedAfterSeq: 10, turn: 1, step: 1 });
      const c0 = f1.acceptFrame({ type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: 'hi' } });
      const c1 = f1.acceptFrame({ type: 'chunk', attemptId: 'a1', index: 1, chunk: { type: 'text-delta', text: ' there' } });
      if (!c0 || c0.type !== 'transient' || c0.chunk.text !== 'hi') throw new Error('chunk0 must be transient');
      if (!c1 || c1.type !== 'transient' || c1.chunk.text !== ' there') throw new Error('chunk1 must be transient');
      const held = f1.acceptDurable({ type: 'assistant/message', seq: 11, turn: 1, step: 1, surfaceOp: 'append', event: {} });
      if (!held || held.type !== 'held') throw new Error('durable settlement must be held while attempt open');
      const end = f1.acceptFrame({ type: 'end', attemptId: 'a1', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } });
      if (!end || end.type !== 'settlement' || end.entry.seq !== 11) throw new Error('end/committed must release settlement');
      if (f1.debugState().pending !== 0) throw new Error('pending must be empty after settlement');

      // S1b surfaceOp 非 append / 无坐标 / 无 seq / 重复 seq：一律 publish/duplicate，不暂存。
      const f1b = foldLib.createStreamFold();
      f1b.acceptFrame({ type: 'start', attemptId: 'a1b', startedAfterSeq: 0, turn: 1, step: 1 });
      const rp = f1b.acceptDurable({ type: 'assistant/message', seq: 1, turn: 1, step: 1, surfaceOp: 'replace', event: {} });
      if (!rp || rp.type !== 'publish') throw new Error('non-append must publish');
      const nc = f1b.acceptDurable({ type: 'assistant/message', seq: 2, event: {} });
      if (!nc || nc.type !== 'publish') throw new Error('uncoordinated must publish');
      const ns = f1b.acceptDurable({ type: 'assistant/message', seq: -1, turn: 1, step: 1, event: {} });
      if (!ns || ns.type !== 'publish') throw new Error('seq-less must publish');

      // S2 index 断裂 → rebaseline 但保现场（pending 保留，turn/end 可冲刷）。
      const f2 = foldLib.createStreamFold();
      f2.acceptFrame({ type: 'start', attemptId: 'a2', startedAfterSeq: 20, turn: 2, step: 1 });
      f2.acceptDurable({ type: 'assistant/message', seq: 21, turn: 2, step: 1, surfaceOp: 'append', event: {} });
      const gap = f2.acceptFrame({ type: 'chunk', attemptId: 'a2', index: 5, chunk: { type: 'text-delta', text: 'x' } });
      if (!gap || gap.type !== 'rebaseline') throw new Error('index gap must trigger rebaseline');
      if (f2.debugState().pending !== 1) throw new Error('rebaseline must keep pending for turn/end flush');
      const flushed = f2.flushPending();
      if (flushed.length !== 1 || flushed[0].seq !== 21) throw new Error('flushPending must drain held');

      // S3 无 attempt（SDK 本地路径）→ durable 直接 publish（全文 diff 兜底）。
      const f3 = foldLib.createStreamFold();
      const pub = f3.acceptDurable({ type: 'assistant/message', seq: 5, turn: 1, step: 1, event: {} });
      if (!pub || pub.type !== 'publish') throw new Error('durable without attempt must publish');

      // S3b 重复 seq → duplicate（重试/重复 settlement 不 corrupt pending）。
      const f3b = foldLib.createStreamFold();
      f3b.acceptFrame({ type: 'start', attemptId: 'a3', startedAfterSeq: 0, turn: 1, step: 1 });
      f3b.acceptFrame({ type: 'chunk', attemptId: 'a3', index: 0, chunk: { type: 'text-delta', text: 'x' } });
      f3b.acceptDurable({ type: 'assistant/message', seq: 7, turn: 1, step: 1, surfaceOp: 'append', event: {} });
      f3b.acceptFrame({ type: 'end', attemptId: 'a3', index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 } });
      const dup = f3b.acceptDurable({ type: 'assistant/message', seq: 7, turn: 1, step: 1, surfaceOp: 'append', event: {} });
      if (!dup || dup.type !== 'duplicate') throw new Error('released seq must be duplicate');

      // S4 abandonment：无暂存 → abandonment；有暂存 → rebaseline。
      const f4 = foldLib.createStreamFold();
      f4.acceptFrame({ type: 'start', attemptId: 'a4', startedAfterSeq: 30, turn: 3, step: 1 });
      f4.acceptFrame({ type: 'chunk', attemptId: 'a4', index: 0, chunk: { type: 'text-delta', text: 'x' } });
      const ab = f4.acceptFrame({ type: 'end', attemptId: 'a4', index: 1, outcome: { kind: 'abandoned' } });
      if (!ab || ab.type !== 'abandonment') throw new Error('empty abandonment expected');

      // H1 真 handler 交织：chunk×2 → held durable → end/committed → turn/end：
      // delta 恰好两次、无二次 diff，accumulated 完整。
      const t1 = mkHandler();
      t1.h.handleAssistantFrame({ type: 'start', attemptId: 'h1', startedAfterSeq: 10, turn: 1, step: 1 });
      t1.h.handleAssistantFrame({ type: 'chunk', attemptId: 'h1', index: 0, chunk: { type: 'text-delta', text: 'Hello' } });
      t1.h.handleAssistantFrame({ type: 'chunk', attemptId: 'h1', index: 1, chunk: { type: 'text-delta', text: ' world' } });
      t1.h.handleSessionEvent({ type: 'assistant/message', seq: 11, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello world' }] } } });
      t1.h.handleAssistantFrame({ type: 'end', attemptId: 'h1', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } });
      t1.h.handleSessionEvent({ type: 'turn/end', data: { turn: 1 } });
      if (deltasOf(t1.seen).length !== 2) throw new Error(`held durable must not double-delta, got ${JSON.stringify(t1.seen)}`);
      if (t1.h.state.accumulatedText !== 'Hello world') throw new Error('accumulated text broken');

      // H2 held 等不到 end + turn/end 冲刷：文本补发不丢失。
      const t2 = mkHandler();
      t2.h.handleAssistantFrame({ type: 'start', attemptId: 'h2', startedAfterSeq: 0, turn: 1, step: 1 });
      t2.h.handleSessionEvent({ type: 'assistant/message', seq: 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'held-text' }] } } });
      if (deltasOf(t2.seen).length !== 0) throw new Error('held must emit no delta yet');
      t2.h.handleSessionEvent({ type: 'turn/end', data: { turn: 1 } });
      if (deltasOf(t2.seen).length !== 1) throw new Error('turn/end must flush held text');
      if (t2.h.state.accumulatedText !== 'held-text') throw new Error('flushed text lost');

      // H3 abandonment 回滚：accumulated 不含幽灵文本。
      const t3 = mkHandler();
      t3.h.handleAssistantFrame({ type: 'start', attemptId: 'h3', startedAfterSeq: 0, turn: 1, step: 1 });
      t3.h.handleAssistantFrame({ type: 'chunk', attemptId: 'h3', index: 0, chunk: { type: 'text-delta', text: 'GHOST' } });
      t3.h.handleAssistantFrame({ type: 'end', attemptId: 'h3', index: 1, outcome: { kind: 'abandoned' } });
      if (t3.h.state.accumulatedText !== '') throw new Error('abandoned text must roll back');

      // H4 usage 到达即结算：held durable 的 usage 不因暂存丢失（rebaseline 亦然）。
      const t4 = mkHandler();
      t4.h.handleAssistantFrame({ type: 'start', attemptId: 'h4', startedAfterSeq: 0, turn: 1, step: 1 });
      t4.h.handleSessionEvent({ type: 'assistant/message', seq: 6, surfaceOp: 'append', data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 3 }, message: { content: [] } } });
      if (!t4.seen.some((s) => s.indexOf('usage:') === 0)) throw new Error('usage must settle on durable arrival');
      t4.h.handleAssistantFrame({ type: 'chunk', attemptId: 'h4', index: 9, chunk: { type: 'text-delta', text: 'x' } });
      t4.h.handleSessionEvent({ type: 'turn/end', data: { turn: 1 } });
      if (!t4.task.usage || t4.task.usage.outputTokens !== 3) throw new Error('usage must survive rebaseline');

      // H5 SDK 无 frame 路径：durable 直接 publish 全文 diff。
      const t5 = mkHandler();
      t5.h.handleSessionEvent({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'local-text' }] } } });
      if (deltasOf(t5.seen).length !== 1 || t5.h.state.accumulatedText !== 'local-text') {
        throw new Error('SDK path must publish full-text diff');
      }

      // S5 服务端接线：双 follow open 均带 assistantStream:true；frame 走
      // handleAssistantFrame 单通道；task 事件带单调 seq 并上 SSE 线（_seq）；
      // replay burst 按 seq 排序；server 依赖 handler 实现模块。
      const srv = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      const opens = srv.split("endpoint: 'session/follow'").length - 1;
      const flagged = (srv.match(/assistantStream: true \} \} \},/g) || []).length;
      if (opens !== 2 || flagged !== 2) throw new Error(`both follow opens need assistantStream:true (opens=${opens} flagged=${flagged})`);
      if (srv.indexOf('handleAssistantFrame') < 0) throw new Error('handleAssistantFrame wiring missing');
      const sessEv = fs.readFileSync(path.join(__dirname, 'lib', 'session-events.mjs'), 'utf8');
      if (sessEv.indexOf('reasoning-delta') < 0) throw new Error('reasoning-delta must be recognized');
      if (srv.indexOf('task.eventSeq') < 0) throw new Error('task event seq missing');
      if (srv.indexOf('_seq') < 0) throw new Error('seq must go on the SSE wire (_seq)');
      if (srv.indexOf('replayOrdered') < 0) throw new Error('replay seq sort missing');
      if (srv.indexOf('session-events.mjs') < 0) throw new Error('server must use lib/session-events.mjs');

      return { fold: ['held', 'surfaceOp-guard', 'rebaseline-keeps-pending', 'flush', 'duplicate', 'abandonment'], handler: ['no-double-delta', 'flush-held', 'abandon-rollback', 'usage-decoupled', 'sdk-publish'], wire: ['assistantStream x2', 'single-channel', 'reasoning-delta', 'task-seq-on-wire', 'replay-sort'] };
    });

    // 1. Zstd Multi-Frame Decompression Fixture Contract
    await runner.run('Zstd Multi-Frame Decompression & Frame Scanning', async () => {
      const fixturePath = path.join(__dirname, 'test/fixtures/sample-session/session.jsonl.zstd');
      if (!fs.existsSync(fixturePath)) {
        throw new Error(`Fixture file missing at: ${fixturePath}`);
      }
      const buf = fs.readFileSync(fixturePath);
      if (buf.length < 100) {
        throw new Error(`Fixture file is unexpectedly small (${buf.length} bytes)`);
      }

      // Scanner logic identical to server.mjs scanZstdFrames
      const ZSTD_MAGIC = 0xFD2FB528;
      const frames = [];
      let offset = 0;
      while (offset + 4 <= buf.length) {
        const magic = buf.readUInt32LE(offset);
        if (magic === ZSTD_MAGIC) {
          const frameStart = offset;
          offset += 4;
          if (offset >= buf.length) break;
          const fhd = buf.readUInt8(offset);
          offset += 1;
          const singleSegment = (fhd & 0x20) !== 0;
          const fcsId = fhd >> 6;
          if (!singleSegment) offset += 1;
          if (fcsId === 1) offset += 1;
          else if (fcsId === 2) offset += 2;
          else if (fcsId === 3) offset += 8;
          let lastBlock = false;
          while (!lastBlock && offset + 3 <= buf.length) {
            const b0 = buf.readUInt8(offset);
            const b1 = buf.readUInt8(offset + 1);
            const b2 = buf.readUInt8(offset + 2);
            offset += 3;
            lastBlock = (b0 & 0x01) !== 0;
            const blockType = (b0 >> 1) & 0x03;
            const blockSize = (b0 >> 3) | (b1 << 5) | (b2 << 13);
            if (blockType === 0 || blockType === 1 || blockType === 2) {
              offset += blockSize;
            }
          }
          if (offset <= buf.length) {
            frames.push({ start: frameStart, end: offset });
          }
        } else {
          offset += 1;
        }
      }

      if (frames.length === 0) {
        throw new Error('Failed to detect any Zstd frames in fixture');
      }

      let decompText = '';
      for (const f of frames) {
        decompText += zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
      }

      const lines = decompText.trim().split('\n').filter(Boolean);
      if (lines.length < 5) {
        throw new Error(`Expected at least 5 JSONL lines, got ${lines.length}`);
      }

      const header = JSON.parse(lines[0]);
      if (!header.id || !header.cwd) {
        throw new Error('Header line missing id or cwd');
      }

      return {
        fixtureBytes: buf.length,
        detectedFrames: frames.length,
        decompressedLines: lines.length,
        sessionId: header.id,
      };
    });

    // 2. Multi-turn Session Terminal State Precedence Contract
    await runner.run('Session Terminal State Multi-Turn Precedence (Latest Turn Contract)', async () => {
      const runTimeline = (lines) => {
        let latestState = 'idle';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const o = JSON.parse(trimmed);
            if (o.type === 'user/message' || o.type === 'turn/start') {
              latestState = 'stopped';
            } else if (o.type === 'step/start' || o.type === 'tool/call' || o.type === 'assistant/message') {
              if (latestState === 'idle') latestState = 'stopped';
            } else if (o.type === 'assistant/chunk' && o.data && o.data.chunk && o.data.chunk.type === 'finish') {
              const rk = o.data.chunk.reason?.kind;
              if (rk === 'error') latestState = 'error';
              else if (rk === 'cancelled' || rk === 'aborted' || rk === 'interrupted' || rk === 'blocked') latestState = 'stopped';
              else latestState = 'done';
            } else if (o.type === 'turn/end') {
              const rk = o.data?.reason?.kind;
              if (rk === 'error') latestState = 'error';
              else if (rk === 'cancelled' || rk === 'aborted' || rk === 'interrupted' || rk === 'blocked') latestState = 'stopped';
              else latestState = 'done';
            }
          } catch {}
        }
        return latestState;
      };

      const case1 = runTimeline([
        JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'upstream error' } } } }),
        JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
        JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
      ]);
      if (case1 !== 'done') throw new Error(`Expected 'done', got ${case1}`);

      const case2 = runTimeline([
        JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
        JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '429 rate limit' } } } }),
      ]);
      if (case2 !== 'error') throw new Error(`Expected 'error', got ${case2}`);

      const case3 = runTimeline([
        JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }),
        JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } }),
      ]);
      if (case3 !== 'stopped') throw new Error(`Expected 'stopped', got ${case3}`);

      const case4 = runTimeline([
        JSON.stringify({ type: 'turn/start', data: { turn: 1 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }),
        JSON.stringify({ type: 'turn/start', data: { turn: 2 } }),
        JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } }),
      ]);
      if (case4 !== 'stopped') throw new Error(`Expected 'stopped', got ${case4}`);

      return {
        casesTested: 4,
        errorThenDone: case1,
        doneThenError: case2,
        errorThenAborted: case3,
        errorThenIncomplete: case4,
      };
    });

    // 3. HTTP API Parameters 400 Boundary & Validation
    await runner.run('HTTP API Input Validation (400 Boundaries)', async () => {
      // Missing prompt on /api/chat/stream
      const resChatEmpty = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: process.cwd(), prompt: '' },
      });
      if (resChatEmpty.status !== 400) {
        throw new Error(`Expected 400 for empty prompt, got ${resChatEmpty.status}`);
      }

      // Missing cwd on /api/sessions
      const resSessNoCwd = await httpRequest('/api/sessions');
      if (resSessNoCwd.status !== 400) {
        throw new Error(`Expected 400 for /api/sessions without cwd, got ${resSessNoCwd.status}`);
      }

      // Missing cwd or id on /api/history
      const resHistNoId = await httpRequest(`/api/history?cwd=${encodeURIComponent(process.cwd())}`);
      if (resHistNoId.status !== 400) {
        throw new Error(`Expected 400 for /api/history without id, got ${resHistNoId.status}`);
      }

      // Missing params on /api/session/archive
      const resArchNoParam = await httpRequest('/api/session/archive', {
        method: 'POST',
        body: {},
      });
      if (resArchNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/archive without params, got ${resArchNoParam.status}`);
      }

      // Missing params on DELETE /api/session
      const resDelNoParam = await httpRequest('/api/session', {
        method: 'DELETE',
        body: {},
      });
      if (resDelNoParam.status !== 400) {
        throw new Error(`Expected 400 for DELETE /api/session without params, got ${resDelNoParam.status}`);
      }

      // Missing sessionId on /api/chat/cancel
      const resCancelNoParam = await httpRequest('/api/chat/cancel', {
        method: 'POST',
        body: {},
      });
      if (resCancelNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/chat/cancel without sessionId, got ${resCancelNoParam.status}`);
      }

      // Missing query parameter on /api/session/attach
      const resAttachNoParam = await httpRequest('/api/session/attach');
      if (resAttachNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/attach without params, got ${resAttachNoParam.status}`);
      }

      // Missing query parameter on /api/session/stats
      const resStatsNoParam = await httpRequest('/api/session/stats');
      if (resStatsNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/stats without params, got ${resStatsNoParam.status}`);
      }

      // Missing query parameter on /api/session/goal
      const resGoalNoParam = await httpRequest('/api/session/goal');
      if (resGoalNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/goal without params, got ${resGoalNoParam.status}`);
      }

      // Missing query parameter on /api/session/subagents
      const resSubagentsNoParam = await httpRequest('/api/session/subagents');
      if (resSubagentsNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/subagents without params, got ${resSubagentsNoParam.status}`);
      }

      // /api/session/upload 原生字节契约：405/415/400（JSON 信封透传必错，靠 review 覆盖 prompt 挂载）
      const resUpGet = await httpRaw('/api/session/upload', { method: 'GET' });
      if (resUpGet.status !== 405) {
        throw new Error(`Expected 405 for GET /api/session/upload, got ${resUpGet.status}`);
      }
      const resUpJson = await httpRaw('/api/session/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        rawBody: '{}',
      });
      if (resUpJson.status !== 415) {
        throw new Error(`Expected 415 for JSON /api/session/upload, got ${resUpJson.status}`);
      }
      const resUpNoSid = await httpRaw('/api/session/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        rawBody: 'abc',
      });
      if (resUpNoSid.status !== 400) {
        throw new Error(`Expected 400 for /api/session/upload without sessionId, got ${resUpNoSid.status}`);
      }
      // 声明超限 → 413。发真实 6MB（声明与实发一致），覆盖声明预检 + 流式熔断，
      // 双方自然 FIN，无 RST 污染连接池。
      let resUp413 = null;
      const bigBody = Buffer.alloc(6 * 1024 * 1024, 0x61);
      resUp413 = await httpRaw('/api/session/upload?sessionId=ghost-u1&name=big.bin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        rawBody: bigBody,
        timeout: 30000,
      });
      if (resUp413.status !== 413) {
        throw new Error(`Expected 413 for oversize /api/session/upload, got ${resUp413.status}`);
      }
      // 幽灵会话透传：宿主在线 → 200 + 宿主 session/not-found 信封（证明原生字节透传，
      // 非 JSON-RPC）；宿主宕机 → 502 fail-fast（证明严禁回退 SDK）。两种分支都合法。
      const resUpGhost = await httpRaw('/api/session/upload?sessionId=ghost-upload-unit-99999&name=t.txt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        rawBody: 'hello',
        timeout: 70000,
      });
      if (resUpGhost.status === 200) {
        if (resUpGhost.body?.ok !== false) {
          throw new Error(`Expected ok:false passthrough for ghost upload, got ${resUpGhost.rawText.slice(0, 160)}`);
        }
      } else if (resUpGhost.status === 502) {
        if (resUpGhost.body?.ok !== false) {
          throw new Error(`Expected ok:false fail-fast for ghost upload, got ${resUpGhost.rawText.slice(0, 160)}`);
        }
      } else {
        throw new Error(`Expected 200 passthrough or 502 fail-fast for ghost upload, got ${resUpGhost.status}`);
      }

      return {
        validatedEndpoints: ['/api/chat/stream', '/api/sessions', '/api/history', '/api/session/archive', '/api/session', '/api/chat/cancel', '/api/session/attach', '/api/session/stats', '/api/session/goal', '/api/session/subagents', '/api/session/upload'],
        allAnswered400: true,
      };
    });

    // 2a. Workspace create 单名契约（~/ 下 create-only + 三系统校验 + 409 防重复 + ES5 前端接线）
    await runner.run('Workspace Create Single-Name Contract (~/ + 409 + ES5 wiring)', async () => {
      // 2026-09-30：真链路改 mock —— 契约校验跑在 Q20_MOCK_HOST 隔离进程上，
      // 不再触碰真实宿主 RPC / 真实 ~/ 目录与 ~/.dsh 注册表。
      const mock = await ensureMockServer();
      const base = mock.base;
      const badCases = [
        [{}, 400], [{ name: '' }, 400], [{ name: '   ' }, 400], [{ name: 'a/b' }, 400], [{ name: 'a\\b' }, 400],
        [{ name: 'a:b' }, 400], [{ name: 'CON' }, 400], [{ name: 'aux.txt' }, 400],
        [{ name: 'COM1 ' }, 400], [{ name: 'bad.' }, 400],
        [{ name: '.' }, 400], [{ name: '..' }, 400], [{ name: 'x'.repeat(65) }, 400],
        [{ path: '~' }, 400], [{ path: '~/' }, 400], [{ path: '~/a/b' }, 400],
        [{ path: '/tmp' }, 400], [{ path: '/etc/passwd' }, 400],
      ];
      for (const [body, want] of badCases) {
        const r = await httpRequest('/api/workspace/create', { method: 'POST', body, base });
        if (r.status !== want) {
          throw new Error(`create bad-case ${JSON.stringify(body)} want ${want}, got ${r.status}: ${JSON.stringify(r.body)}`);
        }
      }
      // 边界正例：64 字符通过、前导空格 trim 后通过、Unicode 名通过（mock 根下建 + 清理）
      const goodCases = ['y'.repeat(64), '  spaced  ', '工作区'];
      for (const g of goodCases) {
        const rg = await httpRequest('/api/workspace/create', { method: 'POST', body: { name: g }, base });
        if (rg.status !== 200 || rg.body?.ok !== true) {
          throw new Error(`create good-case ${JSON.stringify(g)} want 200, got ${rg.status}: ${JSON.stringify(rg.body)}`);
        }
        if (!String(rg.body.workspace.cwd).endsWith('/' + g.trim())) {
          throw new Error(`create must land under mock root /${g.trim()}, got ${rg.body.workspace.cwd}`);
        }
        await mockDeleteWorkspace(rg.body.workspace.cwd);
      }
      const probe = 'q20unit-' + process.pid.toString(36) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const rCreate = await httpRequest('/api/workspace/create', { method: 'POST', body: { name: probe }, base });
      if (rCreate.status !== 200 || rCreate.body?.ok !== true || !rCreate.body?.workspace?.cwd) {
        throw new Error(`create probe want 200 ok, got ${rCreate.status}: ${JSON.stringify(rCreate.body)}`);
      }
      if (!String(rCreate.body.workspace.cwd).endsWith('/' + probe)) {
        throw new Error(`create must land under mock root /${probe}, got ${rCreate.body.workspace.cwd}`);
      }
      const rDup = await httpRequest('/api/workspace/create', { method: 'POST', body: { name: probe }, base });
      if (rDup.status !== 409) {
        throw new Error(`duplicate name want 409, got ${rDup.status}: ${JSON.stringify(rDup.body)}`);
      }
      const rCompat = await httpRequest('/api/workspace/create', { method: 'POST', body: { path: '~/' + probe }, base });
      if (rCompat.status !== 409) {
        throw new Error(`legacy ~/path compat want 409, got ${rCompat.status}: ${JSON.stringify(rCompat.body)}`);
      }
      // 旧 path 兼容 happy-path：~/<fresh> 等价单名创建
      const compatFresh = probe + '-compat';
      const rCompatFresh = await httpRequest('/api/workspace/create', { method: 'POST', body: { path: '~/' + compatFresh }, base });
      if (rCompatFresh.status !== 200 || rCompatFresh.body?.ok !== true) {
        throw new Error(`legacy ~/path fresh want 200, got ${rCompatFresh.status}: ${JSON.stringify(rCompatFresh.body)}`);
      }
      // 清理：mock 宿主 remove（unregister）+ 目录移除断言；临时注册表零残留断言
      await mockDeleteWorkspace(rCreate.body.workspace.cwd);
      await mockDeleteWorkspace(rCompatFresh.body.workspace.cwd);
      const regRaw = fs.readFileSync(mockRegistry(), 'utf8');
      if (regRaw.includes(probe)) throw new Error('probe workspace residue in mock workspace.json');
      // 前端接线：家目录位置提示 + 单名校验 + 行内报错 + 防连击 + name 载荷；~/ 前缀与预览已移除
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      for (const needle of ['ws-add-err', 'wsAddValidateName', 'WSADD_RESERVED', 'wsAddShowErr', 'JSON.stringify({ name: name })', '将创建在家目录下']) {
        if (html.indexOf(needle) < 0) throw new Error(`ws-add wiring missing in index.html: ${needle}`);
      }
      for (const stale of ['ws-add-preview', 'wsAddSyncPreview', '输入工作区目录绝对路径']) {
        if (html.indexOf(stale) >= 0) throw new Error(`stale ws-add markup still present: ${stale}`);
      }
      return { badCases: badCases.length, probeCreated: probe, residueClean: true };
    });

    // 2a2. Workspace remove 仅注销契约（确认后执行；文件夹与会话保留；可恢复）
    // 2a2. Workspace remove 仅注销契约（确认后执行；文件夹与会话保留；可恢复）
    // 2026-09-30：真链路改 mock —— 全程跑在 Q20_MOCK_HOST 隔离进程上，
    // 不再触碰真实宿主 RPC / 真实 ~/.dsh 注册表（旧版在中断时残留 q20rm-* 注册）。
    await runner.run('Workspace Remove Unregister-Only Contract (D + confirm)', async () => {
      const mock = await ensureMockServer();
      const base = mock.base;
      // 缺参 → 400；未注册 → 404
      const rNo = await httpRequest('/api/workspace/remove', { method: 'POST', body: {}, base });
      if (rNo.status !== 400) throw new Error(`remove without cwd want 400, got ${rNo.status}`);
      const rGhost = await httpRequest('/api/workspace/remove', { method: 'POST', body: { cwd: path.join(mock.workspaceRoot, 'q20-ghost-never-exists-' + Date.now().toString(36)) }, base });
      if (rGhost.status !== 404) throw new Error(`remove ghost want 404, got ${rGhost.status}: ${JSON.stringify(rGhost.body)}`);
      // 移除闭环：建探针 → remove → 临时注册表无残留但目录仍在 → 同名重建 409（目录保留证；注册无残留证注销）
      const probe = 'q20rm-' + process.pid.toString(36) + '-' + Date.now().toString(36);
      try {
        const rc = await httpRequest('/api/workspace/create', { method: 'POST', body: { name: probe }, base });
        if (rc.status !== 200 || rc.body?.ok !== true) throw new Error(`remove-probe create want 200, got ${rc.status}`);
        const probeCwd = rc.body.workspace.cwd;
        // 落袋：探针工作区建空会话（ensure 无 LLM，mock 宿主写归属）→ 注册表含归属 → remove 前不在未分组
        const rEns = await httpRequest('/api/session/ensure', { method: 'POST', body: { cwd: probeCwd }, base });
        let landingSid = null;
        if (rEns.status === 200 && rEns.body?.ok === true && rEns.body.sessionId) {
          landingSid = rEns.body.sessionId;
          const regBefore = fs.readFileSync(mockRegistry(), 'utf8');
          if (!regBefore.includes(probe)) throw new Error('probe workspace missing in mock registry');
          if (!regBefore.includes(String(landingSid))) throw new Error('landing session missing in probe workspace sessionIds');
          const unBefore = await httpRequest('/api/sessions/ungrouped', { timeout: 20000, base });
          if (unBefore.status === 200 && Array.isArray(unBefore.body) && unBefore.body.some((s) => String(s.id) === String(landingSid))) {
            throw new Error(`landing session ${landingSid} must not be ungrouped before remove`);
          }
        }
        const rRm = await httpRequest('/api/workspace/remove', { method: 'POST', body: { cwd: probeCwd }, base });
        if (rRm.status !== 200 || rRm.body?.ok !== true) throw new Error(`remove want 200, got ${rRm.status}: ${JSON.stringify(rRm.body)}`);
        // 目录必须保留（仅注销，不断言其中文件）
        if (!fs.existsSync(probeCwd) || !fs.statSync(probeCwd).isDirectory()) {
          throw new Error(`remove must keep folder ${probeCwd}`);
        }
        const regRaw = fs.readFileSync(mockRegistry(), 'utf8');
        if (regRaw.includes(probe)) throw new Error('removed workspace residue in mock workspace.json');
        const rRe = await httpRequest('/api/workspace/create', { method: 'POST', body: { name: probe }, base });
        if (rRe.status !== 409) throw new Error(`re-create after remove must 409 (dir exists), got ${rRe.status}`);
        // 落袋断言：remove 后空会话无转录被未分组过滤属正常，归档清理幂等
        if (landingSid) {
          const unAfter = await httpRequest('/api/sessions/ungrouped?refresh=1', { timeout: 20000, base });
          if (unAfter.status !== 200 || !Array.isArray(unAfter.body)) {
            throw new Error(`ungrouped after remove want 200 array, got ${unAfter.status}`);
          }
          await httpRequest('/api/session/archive', { method: 'POST', body: { cwd: probeCwd, sessionId: landingSid }, base });
          try {
            await httpRequest('/api/session', { method: 'DELETE', body: { cwd: probeCwd, sessionId: landingSid }, base });
          } catch {}
        }
        // 清理：mock remove（幂等 404 忽略）+ 目录移除 + 临时注册表零残留断言
        try {
          await httpRequest('/api/workspace/remove', { method: 'POST', body: { cwd: probeCwd }, base });
        } catch {}
        mockRemoveProbeDir(probeCwd);
        const regRaw2 = fs.readFileSync(mockRegistry(), 'utf8');
        if (regRaw2.includes(probe)) throw new Error('removed probe residue in mock workspace.json');
      } finally {
        if (mockServer) {
          const probeCwd = path.join(mockServer.workspaceRoot, probe);
          try {
            if (fs.existsSync(probeCwd)) fs.rmSync(probeCwd, { recursive: true, force: true });
          } catch {}
        }
      }
      // 前端接线：D 键 + 确认弹窗 + 仅注销文案 + remove 端点 + 乐观删除（本地先剔/失败回滚/静默对账）
      const html2 = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      for (const needle of ['ws-remove-overlay', 'ws-remove-desc', 'openWsRemove', 'closeWsRemove', 'executeWsRemove', '/api/workspace/remove', 'D 移除', '仅从工作区列表中移除', 'pruneRemovedWsLocally', 'rollbackRemovedWsLocally', 'silentReconcileRemove', 'optimisticWsBackup', 'sessList', 'switchedWs']) {
        if (html2.indexOf(needle) < 0) throw new Error(`ws-remove wiring missing in index.html: ${needle}`);
      }
      return { probeRemoved: probe, folderKept: true };    });

    // 2a3. Ungrouped 未分组契约（移除后会话落入；数组契约；前端接线）
    await runner.run('Ungrouped Sessions Contract (dsh web aligned)', async () => {
      const r = await httpRequest('/api/sessions/ungrouped', { timeout: 20000 });
      if (r.status !== 200 || !Array.isArray(r.body)) {
        throw new Error(`ungrouped want 200 array, got ${r.status}`);
      }
      for (const s of r.body.slice(0, 20)) {
        if (!s.id || typeof s.id !== 'string') throw new Error(`ungrouped item missing id: ${JSON.stringify(s).slice(0, 120)}`);
        if (s.state !== undefined && !['running', 'stopped', 'error', 'done', 'idle', 'waiting'].includes(s.state)) {
          throw new Error(`ungrouped invalid state ${s.state} on ${s.id}`);
        }
      }
      // 注册会话不得出现在未分组中（全量：一切已注册工作区的全部 sessionIds；subagent 不得泄漏）
      let registeredAll = [];
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8'));
        for (const ws of Object.values(doc.tables.workspaces || {})) {
          if (ws && Array.isArray(ws.sessionIds)) {
            for (const sid of ws.sessionIds) registeredAll.push(String(sid));
          }
        }
      } catch {}
      const unIds = new Set(r.body.map((s) => String(s.id)));
      for (const sid of registeredAll) {
        if (unIds.has(sid)) throw new Error(`registered session ${sid} leaked into ungrouped`);
      }
      for (const s of r.body) {
        if (s.origin === 'subagent') throw new Error(`subagent session ${s.id} leaked into ungrouped`);
      }
      // 前端接线：W 面板未分组行 + C 面板 mode 3 + 端点
      const html3 = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      for (const needle of ['未分组', '/api/sessions/ungrouped', 'openSessUngrouped', 'renderSessUngrouped', 'sessViewMode === 3', '__ungrouped__']) {
        if (html3.indexOf(needle) < 0) throw new Error(`ungrouped wiring missing in index.html: ${needle}`);
      }
      return { ungroupedCount: r.body.length, registeredLeakCheck: registeredAll.length };
    });

    // 2a4. C 键直进“全工作区进行中”契约（修陷阱：自动打开的面板按 C 不再关闭，重进列表）
    await runner.run('C-key enters All-Workspaces Running view (trap fix contract)', async () => {
      const htmlC = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      for (const needle of [
        'var sessOpenedViaC = false;',
        'sessOpenedViaC = true;',
        'openSess(false, 1)', // C 直进 mode 1（全工作区进行中）
        'function openSess(skipLoad, viewMode)', // 视图模式可参数化；自动打开不传参仍归零 mode 0
        'sessViewMode = (viewMode === undefined || viewMode === null) ? 0 : viewMode',
        'sessPanelTitle.innerHTML = \'💬 \' + (isRunningView ? \'进行中\' : \'待处理\') + \' · 全工作区 [V]\''
      ]) {
        if (htmlC.indexOf(needle) < 0) throw new Error(`C-key wiring missing in index.html: ${needle}`);
      }
      // 工作区切换过渡气泡已清除：关闭自动打开的面板后应展示欢迎空态而非“已切换工作区”粗糙页
      if (htmlC.indexOf('已切换工作区') >= 0) throw new Error('stale workspace-switch bubble still present in index.html');
      if (htmlC.indexOf("appendMessage('assistant', '已切换工作区") >= 0) throw new Error('stale bubble append still present in index.html');
      return { cOpensRunningView: true, trapFixed: true, bubbleRemoved: true };
    });

    // 2b. ask_user_question 端点边界 + 客户端纯逻辑契约（从 index.html 提取，防止实现漂移）
    await runner.run('ask_user_question Question Bridge Contract (endpoint + pure logic)', async () => {
      // Missing/invalid envelope → 400
      const resQNoParam = await httpRequest('/api/session/question', { method: 'POST', body: {} });
      if (resQNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/question without params, got ${resQNoParam.status}`);
      }
      const resQBadAction = await httpRequest('/api/session/question', {
        method: 'POST',
        body: { sessionId: 's', eventId: 'e', action: 'bogus' },
      });
      if (resQBadAction.status !== 400) {
        throw new Error(`Expected 400 for invalid action, got ${resQBadAction.status}`);
      }

      // 无挂起提问（幽灵会话）→ 200 + ok:false（幂等，不打爆客户端）
      const resQGhost = await httpRequest('/api/session/question', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', eventId: 'evt-1', action: 'answer', answers: [{ id: 'q1', selected: ['A'] }] },
      });
      if (resQGhost.status !== 200 || resQGhost.body?.ok !== false) {
        throw new Error(`Expected 200 ok:false for ghost session, got ${resQGhost.status}: ${JSON.stringify(resQGhost.body)}`);
      }
      if (resQGhost.body.error !== 'no pending question for this session') {
        throw new Error(`Unexpected ghost error: ${resQGhost.body.error}`);
      }

      // 客户端纯逻辑：从 static/index.html 的标记切片中提取并执行（ES5 函数）
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const slice = (startMark, endMark) => {
        const s = html.indexOf(startMark);
        const e = html.indexOf(endMark);
        if (s < 0 || e < 0 || e <= s) throw new Error(`pure-logic markers missing in static/index.html: ${startMark}`);
        return html.slice(s + startMark.length, e);
      };
      const pureSrc = slice('/* @Q20-ASK-PURE-1-START */', '/* @Q20-ASK-PURE-1-END */')
        + '\n' + slice('/* @Q20-ASK-PURE-2-START */', '/* @Q20-ASK-PURE-2-END */');
      const factory = new Function(
        `${pureSrc}\nreturn { parseRecommendedLabel, validateQuestionItems, parseAskQuestionsFromArgs, parseAskAnswersFromOutput };`,
      );
      const askLogic = factory();

      // (recommended|推荐) 徽标解析：剥离尾缀但不改变取值
      const rec1 = askLogic.parseRecommendedLabel('方案 A (recommended)');
      if (rec1.label !== '方案 A' || rec1.recommended !== true) throw new Error(`parseRecommendedLabel en failed: ${JSON.stringify(rec1)}`);
      const rec2 = askLogic.parseRecommendedLabel('方案 B（推荐）');
      if (rec2.label !== '方案 B' || rec2.recommended !== true) throw new Error(`parseRecommendedLabel zh failed: ${JSON.stringify(rec2)}`);
      const rec3 = askLogic.parseRecommendedLabel('普通选项');
      if (rec3.label !== '普通选项' || rec3.recommended !== false) throw new Error(`parseRecommendedLabel plain failed: ${JSON.stringify(rec3)}`);

      // 问题批次校验：唯一 id + 必填 question；多选透传
      const questions = askLogic.validateQuestionItems([
        { id: 'q1', question: '选哪个？', options: [{ label: 'A (recommended)' }, { label: 'B', description: '备注' }], multiSelect: true },
        { id: 'q2', question: '为什么？', header: '背景' },
      ]);
      if (!questions || questions.length !== 2 || questions[0].multiSelect !== true) {
        throw new Error(`validateQuestionItems valid batch failed: ${JSON.stringify(questions)}`);
      }
      if (askLogic.validateQuestionItems([
        { id: 'q1', question: 'a' },
        { id: 'q1', question: 'b' },
      ]) !== null) throw new Error('validateQuestionItems duplicate-id batch should be rejected');
      if (askLogic.validateQuestionItems([{ id: 'q1' }]) !== null) {
        throw new Error('validateQuestionItems missing question should be rejected');
      }

      // 工具参数/结果 JSON 解析口径
      const parsedQ = askLogic.parseAskQuestionsFromArgs('{"questions":[{"id":"q1","question":"Q"}]}');
      if (!parsedQ || parsedQ.length !== 1) throw new Error('parseAskQuestionsFromArgs valid JSON failed');
      if (askLogic.parseAskQuestionsFromArgs('not-json') !== null) throw new Error('parseAskQuestionsFromArgs should fail on bad JSON');
      const parsedA = askLogic.parseAskAnswersFromOutput('{"answers":[{"id":"q1","selected":["A"],"custom":" 备注 "}]}');
      if (!parsedA || parsedA.length !== 1 || parsedA[0].custom !== ' 备注 ') {
        throw new Error(`parseAskAnswersFromOutput valid JSON failed: ${JSON.stringify(parsedA)}`);
      }
      if (askLogic.parseAskAnswersFromOutput('{"answers":[{"id":"q1"}]}') !== null) {
        throw new Error('parseAskAnswersFromOutput should reject missing selected');
      }

      return {
        endpointGuards: ['400 missing envelope', '400 invalid action', 'ghost ok:false'],
        pureLogic: ['parseRecommendedLabel en/zh/plain', 'validateQuestionItems valid/dup/missing', 'parseAskQuestionsFromArgs', 'parseAskAnswersFromOutput'],
      };
    });

    // 2b2. ask_user_question 跨会话隔离契约：$events 是 Gateway 全局流，每帧 agentId 即
    // 提问所属 SessionId；非本会话提问必须判 foreign（委托 next），绝不接管/广播到本会话。
    await runner.run('ask_user_question Cross-Session Isolation (classifyQuestionFrame)', async () => {
      const frame = (agentId) => ({ type: 'waterfall', event: 'user-questions/request', eventId: 'evt-x', agentId: agentId, request: { questions: [{ id: 'q1', question: 'Q' }] } });
      // 其他会话的提问 → foreign（必须 settleUserEvent(next)，绝不设置 pendingQuestion/广播）
      if (classifyQuestionFrame('session-b', frame('session-a')) !== 'foreign') {
        throw new Error('other session frame must be classified foreign');
      }
      // 本会话提问 → own（可安全接管）
      if (classifyQuestionFrame('session-a', frame('session-a')) !== 'own') {
        throw new Error('own session frame must be classified own');
      }
      // 防御态：taskSessionId 或 agentId 为空时绝不误判 foreign，避免提问被无谓丢弃
      if (classifyQuestionFrame('', frame('session-a')) !== 'own') throw new Error('empty taskSessionId must not be foreign');
      if (classifyQuestionFrame('session-b', frame('')) !== 'own') throw new Error('empty agentId must not be foreign');
      // 无关/畸形帧 → skip（不接管也不结算，防协议噪声干扰）
      if (classifyQuestionFrame('session-a', { type: 'emit', event: 'api-session/status', args: [] }) !== 'skip') throw new Error('emit frame must be skip');
      if (classifyQuestionFrame('session-a', { type: 'waterfall', event: 'approval/request', eventId: 'evt-y', agentId: 'session-a', request: {} }) !== 'skip') throw new Error('other waterfall event must be skip');
      if (classifyQuestionFrame('session-a', { type: 'waterfall', event: 'user-questions/request', agentId: 'session-a', request: {} }) !== 'skip') throw new Error('missing eventId must be skip');
      if (classifyQuestionFrame('session-a', null) !== 'skip') throw new Error('null frame must be skip');
      return { cases: ['foreign(other session)', 'own(same session)', 'defensive empty ids', 'skip unrelated/malformed'] };
    });

    // 2c. 中文工具标题映射口径（对齐 dsh web tool.title.* + keyed toolview 标题）
    await runner.run('Tool Title Zh Mapping Contract (dsh web tool.title.*)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const s = html.indexOf('/* @Q20-TOOL-TITLE-START */');
      const e = html.indexOf('/* @Q20-TOOL-TITLE-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('tool-title pure-logic markers missing in static/index.html');
      const pureSrc = html.slice(s, e);
      const factory = new Function(`${pureSrc}\nreturn { toolTitleFor, toolSummaryFor };`);
      const logic = factory();
      const cases = [
        ['bash', 'Bash'], ['read', '读取'], ['read_image', '读取图片'],
        ['web_search', '网页搜索'], ['web_fetch', '网页获取'],
        ['grep', 'Grep'], ['glob', 'Glob'], ['write', '写入'],
        ['edit', '编辑'], ['run_code', '代码'], ['todo_write', '任务'],
        ['ask_user_question', '提问'],
      ];
      for (const [name, want] of cases) {
        const got = logic.toolTitleFor(name);
        if (got !== want) throw new Error(`toolTitleFor(${name}) = ${got}, want ${want}`);
      }
      // 未知工具走"工具调用"，真实名进 summary 前缀（dsh others 变体口径）
      if (logic.toolTitleFor('some_new_tool') !== '工具调用') throw new Error('unknown tool should map to 工具调用');
      if (logic.toolTitleFor('') !== '工具调用') throw new Error('empty name should map to 工具调用');
      if (logic.toolSummaryFor('some_new_tool', 'ls -la') !== 'some_new_tool · ls -la') {
        throw new Error(`unknown tool summary prefix drift: ${logic.toolSummaryFor('some_new_tool', 'ls -la')}`);
      }
      if (logic.toolSummaryFor('bash', 'ls -la') !== 'ls -la') throw new Error('known tool summary must not prefix name');
      if (logic.toolSummaryFor('some_new_tool', '') !== 'some_new_tool') throw new Error('unknown tool empty summary should be bare name');
      return { titles: cases.map(([n, t]) => `${n}→${t}`), fallback: ['工具调用', 'name · summary'] };
    });

    // 2d. 全局顶部横幅通知组件契约测试（完成/错误通知、折叠与快捷键关闭）
    await runner.run('Top Banner Notification Contract (done/error, fold > 3, dismiss, state transitions)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const s = html.indexOf('/* @Q20-BANNER-START */');
      const e = html.indexOf('/* @Q20-BANNER-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('banner pure-logic markers missing in static/index.html');
      const bannerSrc = html.slice(s, e);

      // Lightweight DOM element mock for testing DOM generation & folding
      function createMockElement(tag) {
        let htmlVal = '';
        return {
          tagName: (tag || 'div').toUpperCase(),
          className: '',
          style: {},
          children: [],
          childNodes: [],
          offsetHeight: 30,
          get innerHTML() {
            return htmlVal;
          },
          set innerHTML(val) {
            htmlVal = val;
            if (val === '') {
              this.children = [];
              this.childNodes = [];
            }
          },
          appendChild(child) {
            this.children.push(child);
            this.childNodes.push(child);
            return child;
          },
          title: '',
          onclick: null,
        };
      }

      const mockTopBanner = createMockElement('div');
      const mockChatContainer = createMockElement('div');

      const scope = {
        document: {
          getElementById(id) {
            if (id === 'top-banner-container') return mockTopBanner;
            if (id === 'chat-container') return mockChatContainer;
            return null;
          },
          createElement(tag) {
            return createMockElement(tag);
          },
        },
        escapeHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
        getCwd() { return '/test/ws'; },
        chatContainer: mockChatContainer,
        sessCache: {},
        currentSessionId: '',
        stopRequested: false,
        allMessages: [],
        window: {},
        selectSessionCalledWith: null,
        selectSession(c, s) { this.selectSessionCalledWith = { cwd: c, sid: s }; },
      };

      const factory = new Function(
        'scope',
        `with(scope) {
          ${bannerSrc}
          return {
            notifySessionComplete,
            renderBannerNotifications,
            dismissBannerNotification,
            openBannerNotification,
            checkSessionsStateChanges,
            userStoppedSessions,
            getNotifications: function() { return bannerNotifications; },
            isExpanded: function() { return isBannerFoldExpanded; }
          };
        }`,
      );

      const bannerLogic = factory(scope);

      // 1. 过滤测试：running 与 stopped 绝不产生通知
      bannerLogic.notifySessionComplete('/test/ws', 's-run', 'running', '');
      bannerLogic.notifySessionComplete('/test/ws', 's-stop', 'stopped', '');
      if (bannerLogic.getNotifications().length !== 0) {
        throw new Error('Running or stopped states must not trigger notifications');
      }

      // 2. 终态测试：done 与 error 产生通知，并增量置于头部
      bannerLogic.notifySessionComplete('/test/ws', 's-1', 'done', '', '测试会话 1');
      bannerLogic.notifySessionComplete('/test/ws', 's-2', 'error', '超时失败', '测试会话 2');
      const notifs = bannerLogic.getNotifications();
      if (notifs.length !== 2 || notifs[0].id !== 's-2' || notifs[0].state !== 'error') {
        throw new Error(`Expected 2 notifications, s-2 error at top, got: ${JSON.stringify(notifs)}`);
      }

      // 3. 去重测试：同一 session 相同状态不重复入列
      bannerLogic.notifySessionComplete('/test/ws', 's-2', 'error', '超时失败', '测试会话 2');
      if (bannerLogic.getNotifications().length !== 2) {
        throw new Error('Identical session error notification must be deduplicated');
      }

      // 4. 折叠契约：最多显示 3 条，超过 3 条折叠并呈现展开条
      bannerLogic.notifySessionComplete('/test/ws', 's-3', 'done', '', '测试会话 3');
      bannerLogic.notifySessionComplete('/test/ws', 's-4', 'done', '', '测试会话 4');
      bannerLogic.notifySessionComplete('/test/ws', 's-5', 'done', '', '测试会话 5');
      // 当前共 5 条通知
      if (bannerLogic.getNotifications().length !== 5) {
        throw new Error(`Expected 5 total notifications, got ${bannerLogic.getNotifications().length}`);
      }
      // 渲染后 DOM 节点：3 个 banner-item + 1 个 fold-bar
      const renderedChildren = mockTopBanner.children;
      const itemNodes = renderedChildren.filter((c) => c.className.indexOf('banner-item') !== -1);
      const foldNodes = renderedChildren.filter((c) => c.className.indexOf('banner-fold-bar') !== -1);
      if (itemNodes.length !== 3) {
        throw new Error(`Expected 3 visible items when folded, got ${itemNodes.length}`);
      }
      if (foldNodes.length !== 1 || foldNodes[0].innerHTML.indexOf('2 条') === -1) {
        throw new Error(`Expected fold bar showing 2 remaining items, got: ${foldNodes[0]?.innerHTML}`);
      }

      // 5. 点击折叠栏展开
      foldNodes[0].onclick();
      const expandedItems = mockTopBanner.children.filter((c) => c.className.indexOf('banner-item') !== -1);
      if (expandedItems.length !== 5) {
        throw new Error(`Expected all 5 items rendered when expanded, got ${expandedItems.length}`);
      }

      // 6. 关闭首条通知（快捷键 D 对应调用 dismissBannerNotification(0)）
      bannerLogic.dismissBannerNotification(0);
      if (bannerLogic.getNotifications().length !== 4) {
        throw new Error('Dismissing top notification failed');
      }

      // 6b. 打开/直达首条通知（快捷键 E 对应调用 openBannerNotification(0)）
      // 验证当子智能体面板打开时(isSubagentOpen = true)，调用 openBannerNotification(0) 能正确关闭子智能体面板并直达会话
      scope.isSubagentOpen = true;
      scope.subagentClosedWith = null;
      scope.closeSubagent = function(skip) { scope.isSubagentOpen = false; scope.subagentClosedWith = skip; };
      const topNotif = bannerLogic.getNotifications()[0];
      const openResult = bannerLogic.openBannerNotification(0);
      if (!openResult) {
        throw new Error('openBannerNotification(0) should return true');
      }
      if (scope.isSubagentOpen) {
        throw new Error('openBannerNotification should close subagent overlay if open');
      }
      if (scope.subagentClosedWith !== true) {
        throw new Error('closeSubagent should be called with skipReturnToParent=true');
      }
      if (scope.selectSessionCalledWith?.sid !== topNotif.id) {
        throw new Error(`Expected selectSession called with ${topNotif.id}, got: ${JSON.stringify(scope.selectSessionCalledWith)}`);
      }
      if (bannerLogic.getNotifications().length !== 3) {
        throw new Error('openBannerNotification should dismiss the entered notification item');
      }

      // 6c. 用户主动停止会话绝不当作错误横幅通知
      bannerLogic.userStoppedSessions['sess-user-stopped'] = Date.now();
      bannerLogic.notifySessionComplete('/test/ws', 'sess-user-stopped', 'error', 'Network aborted');
      if (bannerLogic.getNotifications().some((n) => n.id === 'sess-user-stopped')) {
        throw new Error('User stopped session must not produce error banner notification');
      }
      bannerLogic.notifySessionComplete('/test/ws', 'sess-aborted-msg', 'error', '用户已手动停止任务');
      if (bannerLogic.getNotifications().some((n) => n.id === 'sess-aborted-msg')) {
        throw new Error('Error with cancellation message must not produce error banner notification');
      }

      // 6d. 若当前正处于该会话的消息流主界面，无需发出横幅通知
      scope.currentSessionId = 'sess-current-active';
      scope.isWsOpen = false;
      scope.isSessOpen = false;
      bannerLogic.notifySessionComplete('/test/ws', 'sess-current-active', 'done', '', '当前查看中的会话');
      if (bannerLogic.getNotifications().some((n) => n.id === 'sess-current-active')) {
        throw new Error('Session currently viewed in message stream should not produce banner notification');
      }
      // 但若此时弹窗覆盖（例如用户打开了工作区或会话选择等），则应正常发出通知
      scope.isSessOpen = true;
      bannerLogic.notifySessionComplete('/test/ws', 'sess-current-active', 'done', '', '弹窗覆盖中的当前会话');
      if (!bannerLogic.getNotifications().some((n) => n.id === 'sess-current-active')) {
        throw new Error('Session with overlay open should still trigger notification');
      }
      scope.isSessOpen = false;
      scope.currentSessionId = '';

      // 7. 状态机对比检查：冷启动不触发，后续由 running 迁移至 done/error 时触发
      bannerLogic.getNotifications().length = 0; // reset
      bannerLogic.checkSessionsStateChanges('/test/ws', [
        { id: 'sess-bg-1', isRunning: true, state: 'running', title: '后台任务 1' },
      ]);
      if (bannerLogic.getNotifications().length !== 0) {
        throw new Error('Cold start sessions should not trigger notification');
      }
      // 模拟后台运行结束
      bannerLogic.checkSessionsStateChanges('/test/ws', [
        { id: 'sess-bg-1', isRunning: false, state: 'done', title: '后台任务 1' },
      ]);
      if (bannerLogic.getNotifications().length !== 1 || bannerLogic.getNotifications()[0].id !== 'sess-bg-1') {
        throw new Error('Background session completion transition must trigger banner notification');
      }

      return {
        filterGuards: ['running ignored', 'stopped ignored'],
        completionsTracked: ['done ✓', 'error ✖'],
        deduplicationOk: true,
        maxVisibleFold: '3 visible + fold bar',
        expandOk: true,
        dismissOk: true,
        backgroundTransitionOk: true,
      };
    });

    // 2e. 多会话提问隔离契约：attach 重放过滤 request / 跨会话不覆盖草稿 / no pending 中文化
    await runner.run('Ask Multi-Session Isolation Contract (replay filter + draft slots + zh stale-error)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      // 服务端：attach 重放必须过滤 question request（挂起只走实时 listener）
      if (serverSrc.indexOf("ev.event === 'question' && ev.data && ev.data.type === 'request'") === -1) {
        throw new Error('attach replay must filter question request events');
      }
      // 服务端：attach 建桥必须保留旧 task 的 pendingQuestion
      if (serverSrc.indexOf('prevTask.pendingQuestion') === -1) {
        throw new Error('attach bridge must carry over prevTask.pendingQuestion');
      }
      // 前端：草稿分槽 + 跨会话 request 只提示不覆盖
      const needSnippets = [
        'questionDraftStore',
        'stashQuestionDraft',
        'restoreQuestionDraft',
        'hideQuestionPanelKeepSlot',
        "kind: 'question'",
        'data.replayed === true',
        '提问已失效（会话已继续或服务已重启）',
      ];
      for (const sn of needSnippets) {
        if (html.indexOf(sn) === -1) throw new Error(`static/index.html missing isolation snippet: ${sn}`);
      }
      // 前端：裸英文 no pending 不得直接显示给用户（answer/cancel 分支均已转中文）
      if (html.indexOf("showQuestionFeedback(errObj.error || '提交失败，请重试')") !== -1) {
        throw new Error('raw no-pending error must not reach question feedback verbatim');
      }
      return {
        serverGuards: ['replay filters question request', 'bridge carries pendingQuestion'],
        clientGuards: ['draft slots per session', 'cross-session request banner-only', 'replayed never overwrites', 'stale error zh + draft kept'],
      };
    });

    // 2e. 会话级模型记忆契约：模型属会话级数据（O 面板/M 徽标/切会话恢复不得跨会话串台）
    await runner.run('Session Model Isolation Contract (O panel + badge + switch restore)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      // 纯逻辑切片：record/get + 封顶，直接驱动验证
      const s = html.indexOf('/* @Q20-SESSMODEL-START */');
      const e = html.indexOf('/* @Q20-SESSMODEL-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('sessmodel pure-logic markers missing in static/index.html');
      const pureSrc = html.slice(s, e);
      const mkStore = () => new Function(
        `${pureSrc}\nreturn { store: sessionModelStore, record: recordSessionModel, get: getSessionModelVal, cap: SESSION_MODEL_STORE_CAP };`,
      )();
      const st1 = mkStore();
      if (st1.cap !== 40) throw new Error(`session model store cap must be 40, got ${st1.cap}`);
      if (st1.get('session-A') !== '') throw new Error('unknown sid must return empty');
      st1.record('session-A', 'ponyllm:::gemini-3.8-flash-high');
      if (st1.get('session-A') !== 'ponyllm:::gemini-3.8-flash-high') throw new Error('record/get roundtrip broken');
      st1.record('session-A', '');
      if (st1.get('session-A') !== 'ponyllm:::gemini-3.8-flash-high') throw new Error('empty val must not overwrite');
      st1.record('', 'ponyllm:::deepseek-v4-flash');
      if (Object.keys(st1.store).length !== 1) throw new Error('empty sid must not be recorded');
      const st2 = mkStore();
      for (let i = 0; i < 41; i++) st2.record('session-' + i, 'p:::m' + i);
      const keys2 = Object.keys(st2.store);
      if (keys2.length !== 40) throw new Error(`store cap must hold 40, got ${keys2.length}`);
      if (st2.get('session-0') !== '') throw new Error('oldest entry must be evicted at cap');
      if (st2.get('session-40') !== 'p:::m40') throw new Error('newest entry must survive cap');
      // 静态接线：五个写入/恢复点 + O 面板与徽标一律走会话级事实（stats 真值 → 记忆 → 组合器兜底）
      const wireNeedles = [
        'getSessionModelVal(sid)',                       // O 面板
        'getSessionModelVal(bsid)',                      // M 徽标
        'getSessionModelVal(sid);',                      // selectSession 恢复
        'recordSessionModel(currentSessionId, modelVal)', // 发送即绑定
        'recordSessionModel(sendSid, sendModelVal)',     // 新会话推送落位补记
        'recordSessionModel(currentSessionId, modelSelect.value, modelChoiceRevision)', // M 面板选取（统一入口 applyModelChoice，显式版本号防 stats 旧快照回滚）
        "recordSessionModel(sid, ((latestSessionStats.provider || '') + ':::' + latestSessionStats.model))", // stats 转录真值
        '!sessionModelDirty[sid]',                       // stats 回写守卫：本地选取未确认(脏)前不得回滚
        'sessionModelDirty[data.sessionId] = false',     // start 回执确认后解除脏标记
        'sessionModelDirty[currentSessionId] = true',    // 面板选取/D 键标记脏
      ];
      for (const wn of wireNeedles) {
        if (html.indexOf(wn) === -1) throw new Error(`session-model wiring missing in index.html: ${wn}`);
      }
      // O 面板/徽标不得把全局 modelSelect 当作第一事实源（本 bug 根因：跨会话残留）
      const panelIdx = html.indexOf('var sessModelValForPanel = getSessionModelVal(sid);');
      const badgeIdx = html.indexOf('var bval = getSessionModelVal(bsid)');
      if (panelIdx < 0 || badgeIdx < 0) throw new Error('O panel / badge must consult session model store first');
      return {
        pureLogic: ['record/get roundtrip', 'empty guard', 'cap 40 evict-oldest'],
        wiring: ['O panel', 'M badge', 'switch restore', 'send bind', 'new-session late bind', 'M-panel pick', 'stats truth', 'dirty guard', 'start ack clears dirty'],
      };
    });

    // 2f. 模型选择常用分组与快捷键收藏口径 (Shortcut M / F / '常用' section)
    await runner.run('Favorite Models Contract (Shortcut M / F / 常用 Section)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const s = html.indexOf('/* @Q20-FAV-MODEL-START */');
      const e = html.indexOf('/* @Q20-FAV-MODEL-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('fav-model pure-logic markers missing in static/index.html');
      const pureSrc = html.slice(s, e);

      const mockStore = {};
      const scope = {
        window: {
          localStorage: {
            getItem(key) { return Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : null; },
            setItem(key, val) { mockStore[key] = String(val); },
            removeItem(key) { delete mockStore[key]; },
          },
        },
      };

      const factory = new Function(
        'scope',
        `with(scope) {
          ${pureSrc}
          return {
            loadFavoriteModels,
            toggleFavoriteModel,
            isFavoriteModel,
            reset: function() { favoriteModels = null; }
          };
        }`,
      );
      const logic = factory(scope);

      // 初始为空
      if (logic.loadFavoriteModels().length !== 0) throw new Error('Initially favorite models should be empty');
      if (logic.isFavoriteModel('openai:::gpt-4o')) throw new Error('Should not be favorite initially');

      // 切换加入收藏
      const added = logic.toggleFavoriteModel('openai:::gpt-4o');
      if (!added) throw new Error('toggleFavoriteModel should return true when adding');
      if (!logic.isFavoriteModel('openai:::gpt-4o')) throw new Error('Should be favorite after toggle');
      if (logic.loadFavoriteModels().length !== 1) throw new Error('Favorite models length should be 1');

      // 再次切换移出收藏
      const removed = logic.toggleFavoriteModel('openai:::gpt-4o');
      if (removed) throw new Error('toggleFavoriteModel should return false when removing');
      if (logic.isFavoriteModel('openai:::gpt-4o')) throw new Error('Should not be favorite after second toggle');
      if (logic.loadFavoriteModels().length !== 0) throw new Error('Favorite models length should be 0');

      // 多项操作与持久化验证
      logic.toggleFavoriteModel('google:::gemini-3.8-flash-high');
      logic.toggleFavoriteModel('anthropic:::claude-3-5-sonnet');
      if (logic.loadFavoriteModels().length !== 2) throw new Error('Should have 2 favorites');

      // 模拟重置内存，从 localStorage 恢复
      logic.reset();
      const restored = logic.loadFavoriteModels();
      if (restored.length !== 2 || restored[0] !== 'google:::gemini-3.8-flash-high' || restored[1] !== 'anthropic:::claude-3-5-sonnet') {
        throw new Error('Restoring favorites from localStorage failed: ' + JSON.stringify(restored));
      }

      return {
        initialEmpty: true,
        toggleAdd: true,
        toggleRemove: true,
        localStoragePersistence: true,
      };
    });

    // 2e2. 模型选择默认模型锁定与防飘移契约 (Shortcut M / D / Default Model Persistence)
    await runner.run('Default Model Contract (Shortcut M / D / Anti-Drift Lock)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const s = html.indexOf('/* @Q20-FAV-MODEL-START */');
      const e = html.indexOf('/* @Q20-FAV-MODEL-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('fav-model pure-logic markers missing in static/index.html');
      const pureSrc = html.slice(s, e);

      const mockStore = {};
      const mockSelect = {
        options: [
          { value: 'google:::gemini-2.5-flash', text: 'gemini-2.5-flash' },
          { value: 'anthropic:::claude-3-7-sonnet', text: 'claude-3-7-sonnet' },
          { value: 'deepseek:::deepseek-v3', text: 'deepseek-v3' },
        ],
        selectedIndex: 0,
      };

      const scope = {
        window: {
          localStorage: {
            getItem(key) { return Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : null; },
            setItem(key, val) { mockStore[key] = String(val); },
            removeItem(key) { delete mockStore[key]; },
          },
        },
        modelSelect: mockSelect,
      };

      const factory = new Function(
        'scope',
        `with(scope) {
          ${pureSrc}
          return {
            loadDefaultModel,
            saveDefaultModel,
            applyDefaultModelIfConfigured,
            reset: function() { defaultModelVal = null; }
          };
        }`,
      );
      const logic = factory(scope);

      // 1. 初始未配置默认模型
      if (logic.loadDefaultModel() !== '') throw new Error('Initial default model should be empty string');
      const notAppliedInitial = logic.applyDefaultModelIfConfigured();
      if (notAppliedInitial) throw new Error('applyDefaultModelIfConfigured should return false when no default is set');
      if (mockSelect.selectedIndex !== 0) throw new Error('selectedIndex should remain unchanged');

      // 2. 保存默认模型
      logic.saveDefaultModel('anthropic:::claude-3-7-sonnet');
      if (logic.loadDefaultModel() !== 'anthropic:::claude-3-7-sonnet') {
        throw new Error('Default model not saved correctly');
      }

      // 3. 应用默认模型至 select 选项
      mockSelect.selectedIndex = 0;
      const applied = logic.applyDefaultModelIfConfigured();
      if (!applied) throw new Error('applyDefaultModelIfConfigured should return true when model matches');
      if (mockSelect.selectedIndex !== 1) throw new Error(`Expected selectedIndex to be 1, got ${mockSelect.selectedIndex}`);

      // 4. 重置内存缓存后验证从 localStorage 恢复
      logic.reset();
      if (logic.loadDefaultModel() !== 'anthropic:::claude-3-7-sonnet') {
        throw new Error('Default model not restored from localStorage');
      }

      // 5. 若配置的模型不在当前可用选项中，安全降级不崩溃
      logic.saveDefaultModel('nonexistent:::ghost-model');
      mockSelect.selectedIndex = 0;
      const ghostApplied = logic.applyDefaultModelIfConfigured();
      if (ghostApplied) throw new Error('applyDefaultModelIfConfigured should return false for nonexistent model');
      if (mockSelect.selectedIndex !== 0) throw new Error('selectedIndex should remain at fallback 0');

      return {
        initialEmpty: true,
        saveDefaultModel: true,
        applyDefaultModel: true,
        localStoragePersistence: true,
        ghostModelSafeFallback: true,
      };
    });

    // 2f. 快捷消息面板与常用指令契约 (Quick Messages Contract)
    await runner.run('Quick Messages Panel Contract (Default Templates, Add, Deduplication & Storage)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      const s = html.indexOf('/* @Q20-QUICK-MSG-START */');
      const e = html.indexOf('/* @Q20-QUICK-MSG-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('quick-msg pure-logic markers missing in static/index.html');
      const pureSrc = html.slice(s, e);

      const mockStore = {};
      const scope = {
        window: {
          localStorage: {
            getItem(key) { return Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : null; },
            setItem(key, val) { mockStore[key] = String(val); },
            removeItem(key) { delete mockStore[key]; },
          },
        },
        document: {
          createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
          getElementsByClassName: () => [],
        },
        quickMsgTree: { innerHTML: '', appendChild: () => {}, getElementsByClassName: () => [] },
        inputBox: { value: '' },
        sessState: { running: false },
        setStatus: () => {},
        doSend: () => {},
      };

      const factory = new Function(
        'scope',
        `with(scope) {
          ${pureSrc}
          return {
            loadQuickMessages,
            saveQuickMessages,
            addQuickMessage,
            deleteQuickMessage,
            reset: function() { quickMsgList = null; }
          };
        }`,
      );
      const logic = factory(scope);

      // 1. 默认预置模板加载
      const defaults = logic.loadQuickMessages();
      if (!Array.isArray(defaults) || defaults.length === 0) throw new Error('Default quick messages should not be empty');
      if (defaults[0] !== '继续') throw new Error('First default quick message should be 继续');

      // 2. 新增快捷消息
      const addOk = logic.addQuickMessage('请帮我编写测试用例');
      if (!addOk) throw new Error('addQuickMessage should return true for new message');
      const curList = logic.loadQuickMessages();
      if (curList[curList.length - 1] !== '请帮我编写测试用例') throw new Error('New message should be appended to list');

      // 3. 重复或空消息防卫
      const dupOk = logic.addQuickMessage('请帮我编写测试用例');
      if (dupOk) throw new Error('addQuickMessage should reject duplicate message');
      const emptyOk = logic.addQuickMessage('   ');
      if (emptyOk) throw new Error('addQuickMessage should reject empty message');

      // 4. 删除快捷消息
      const idxToDelete = curList.length - 1;
      const delOk = logic.deleteQuickMessage(idxToDelete);
      if (!delOk) throw new Error('deleteQuickMessage should return true');
      const afterDelList = logic.loadQuickMessages();
      if (afterDelList.includes('请帮我编写测试用例')) {
        throw new Error('Deleted message should no longer exist in list');
      }

      // 5. 重新添加并验证重置内存后的 localStorage 持久化
      logic.addQuickMessage('持久化消息验证');
      logic.reset();
      const restored = logic.loadQuickMessages();
      if (!restored.includes('持久化消息验证')) {
        throw new Error('Quick messages should persist in storage: ' + JSON.stringify(restored));
      }

      return {
        defaultTemplatesLoaded: defaults.length,
        addSuccess: true,
        deleteSuccess: true,
        duplicateRejected: true,
        emptyRejected: true,
        persisted: true,
      };
    });

    // 3. Non-existent Session History Fault Tolerance
    await runner.run('Non-existent Session History Defense (Safe Empty Result)', async () => {
      const res = await httpRequest(`/api/history?cwd=${encodeURIComponent(process.cwd())}&id=ghost-session-unit-99999`);
      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }
      if (!Array.isArray(res.body) || res.body.length !== 0) {
        throw new Error(`Expected empty array [], got: ${JSON.stringify(res.body)}`);
      }

      // Also test with turns slicing on ghost session
      const turnsRes = await httpRequest(`/api/history?cwd=${encodeURIComponent(process.cwd())}&id=ghost-session-unit-99999&turns=3`);
      if (turnsRes.status !== 200) {
        throw new Error(`Expected HTTP 200 with turns, got ${turnsRes.status}`);
      }
      if (!turnsRes.body || !Array.isArray(turnsRes.body.messages) || turnsRes.body.messages.length !== 0) {
        throw new Error(`Expected { messages: [] }, got ${JSON.stringify(turnsRes.body)}`);
      }
      if (turnsRes.body.hasMore !== false || turnsRes.body.startIndex !== 0) {
        throw new Error(`Expected hasMore: false and startIndex: 0`);
      }

      return { status: res.status, body: res.body, turnsOk: true };
    });

    // 3.1 Turn-based History Slicing & Boundary Defense
    // 3.1 Turn-based History Slicing & Boundary Defense
    // 2026-09-30：改 mock —— 用 Q20_MOCK_HOST 隔离进程种子两回合会话后断言切片，
    // 不再依赖真实 3090 服务的同步大工作区扫描（曾因 /api/sessions 阻塞 10s+ 超时）。
    await runner.run('Turn-based History Slicing & Boundary Defense (/api/history?turns=...)', async () => {
      const mock = await ensureMockServer();
      const base = mock.base;
      const cwd = mock.workspaceRoot;
      // mock 宿主种子会话：ensure 取 sid → 连续两回合（mock 合成，零真实链路）
      const rEns = await httpRequest('/api/session/ensure', { method: 'POST', body: { cwd }, base, timeout: 20000 });
      if (rEns.status !== 200 || rEns.body?.ok !== true || !rEns.body.sessionId) {
        throw new Error('seed ensure failed: ' + JSON.stringify(rEns.body));
      }
      const seedSid = rEns.body.sessionId;
      for (let i = 0; i < 2; i++) {
        const chat = await httpRequest('/api/chat/stream', {
          method: 'POST',
          body: { cwd, sessionId: i === 0 ? '' : seedSid, prompt: '切片种子问题 ' + i },
          base,
          timeout: 20000,
        });
        if (chat.status !== 200) throw new Error('seed chat want 200, got ' + chat.status);
      }
      // Find the seeded session in mock workspace
      const listRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(cwd)}`, { base, timeout: 20000 });
      const sessions = listRes.body || [];
      const testSession = sessions.find((s) => s.id);
      if (!testSession) {
        return { skipped: 'No sessions available in mock workspace' };
      }

      // 1. Request latest 1 turn
      const t1Res = await httpRequest(`/api/history?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(testSession.id)}&turns=1`, { base, timeout: 20000 });
      if (t1Res.status !== 200 || !t1Res.body || !Array.isArray(t1Res.body.messages)) {
        throw new Error(`Failed to slice turn 1: HTTP ${t1Res.status}`);
      }
      const data1 = t1Res.body;
      if (typeof data1.totalTurns !== 'number' || typeof data1.startIndex !== 'number') {
        throw new Error(`Invalid turn slice envelope: ${JSON.stringify(data1)}`);
      }

      // 2. Test boundary defense: negative or oversized before parameter
      const negBeforeRes = await httpRequest(`/api/history?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(testSession.id)}&turns=1&before=-10`, { base, timeout: 20000 });
      if (negBeforeRes.status !== 200 || negBeforeRes.body.messages.length !== 0 || negBeforeRes.body.hasMore !== false) {
        throw new Error(`Failed negative before clamp: ${JSON.stringify(negBeforeRes.body)}`);
      }

      const hugeBeforeRes = await httpRequest(`/api/history?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(testSession.id)}&turns=1&before=999999`, { base, timeout: 20000 });
      if (hugeBeforeRes.status !== 200 || !Array.isArray(hugeBeforeRes.body.messages)) {
        throw new Error(`Failed huge before clamp: ${JSON.stringify(hugeBeforeRes.body)}`);
      }

      return {
        sessionId: testSession.id,
        totalTurns: data1.totalTurns,
        slice1Msgs: data1.messages.length,
        hasMore: data1.hasMore,
        clampingDefenseVerified: true,
      };
    });

    // 4. Bootstrap API Schema & Regression Guardrail
    await runner.run('Bootstrap API Contract & Panel Count Consistency', async () => {
      const res = await httpRequest('/api/bootstrap', { timeout: 30000 });
      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }
      const data = res.body;
      if (!Array.isArray(data.workspaces) || data.workspaces.length === 0) {
        throw new Error('Bootstrap missing valid workspaces array');
      }
      if (!Array.isArray(data.models) || data.models.length === 0) {
        throw new Error('Bootstrap missing valid models array');
      }
      for (const m of data.models) {
        if (typeof m.provider !== 'string' || typeof m.model !== 'string') {
          throw new Error('Bootstrap model missing provider/model string');
        }
        if (m.contextWindow !== undefined && (typeof m.contextWindow !== 'number' || m.contextWindow < 0)) {
          throw new Error('Bootstrap model contextWindow must be a non-negative number');
        }
      }

      // Guardrail: sessionCount must match /api/sessions list length
      const currentCwd = data.current?.workspaceCwd || process.cwd();
      const currentWs = data.workspaces.find((w) => w.cwd === currentCwd);
      if (currentWs && typeof currentWs.sessionCount === 'number') {
        const listRes = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(currentCwd)}`, { timeout: 30000 });
        if (listRes.status !== 200) {
          throw new Error(`Failed to query /api/sessions: HTTP ${listRes.status}`);
        }
        if (currentWs.sessionCount !== listRes.body.length) {
          throw new Error(`Count inconsistency: bootstrap=${currentWs.sessionCount}, list=${listRes.body.length}`);
        }
        return {
          workspacesCount: data.workspaces.length,
          modelsCount: data.models.length,
          currentWorkspace: currentCwd,
          sessionCount: currentWs.sessionCount,
          consistencyVerified: true,
        };
      }

      return {
        workspacesCount: data.workspaces.length,
        modelsCount: data.models.length,
      };
    });

    // 4b. Model Catalog Source Contract
    // 回归护栏：dsh 0.1.7-alpha.1（#4587 profile-backed Config）把用户层文档从
    // ~/.dsh/settings.yaml 迁到 profiles/<name>/cordis.patch.yml（顶层 YAML 数组），
    // 只认旧文件会让 M 菜单只剩一个兜底模型。此处锁死：
    //   ① 新格式（补丁数组）可解析；② 新旧格式归一化等价；③ bootstrap 宿主 RPC 优先；
    //   ④ 磁盘声明了多 provider 时接口不得塌缩成单模型。
    await runner.run('Model Catalog Source Contract (settings.yaml → profile patch)', async () => {
      const serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      const s = serverSrc.indexOf('/* @Q20-MODEL-SOURCE-START */');
      const e = serverSrc.indexOf('/* @Q20-MODEL-SOURCE-END */');
      if (s < 0 || e < 0 || e <= s) {
        throw new Error('pure-logic markers missing in server.mjs: @Q20-MODEL-SOURCE');
      }
      const logic = new Function(`
        ${serverSrc.slice(s, e)}
        return {
          parseYaml: parseYaml,
          normalizeModelSections: normalizeModelSections,
          normalizeDefaultSelection: normalizeDefaultSelection,
        };
      `)();

      // ① 新格式：profile patch，顶层序列 + { id, config } 条目
      const patchYaml = [
        '- id: llm-deepseek',
        '  config:',
        '    models:',
        '      - id: deepseek-flash',
        '        name: DeepSeek Flash',
        '        contextWindow: 1000000',
        '- id: agent-default-model',
        '  config:',
        '    provider: ponyllm',
        '    model: kimi-k3',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      ponyllm:',
        '        models:',
        '          - id: kimi-k3',
        '            name: kimi-k3 (sense)',
        '            contextWindow: 1000000',
        '          - id: gemini-3.8-flash-high',
        '            name: gemini-3.8-flash-high',
        '      ppx:',
        '        models:',
        '          - id: gpt-6-astra',
        '            name: Astra',
        '',
      ].join('\n');
      const patchDoc = logic.parseYaml(patchYaml);
      if (!Array.isArray(patchDoc) || patchDoc.length !== 3) {
        throw new Error(`profile patch must parse as a top-level sequence of 3 entries, got ${JSON.stringify(patchDoc).slice(0, 120)}`);
      }
      const patchNorm = logic.normalizeModelSections(patchDoc);
      const patchKeys = patchNorm.models.map((m) => `${m.provider}:${m.model}`);
      for (const expected of ['deepseek-official:deepseek-flash', 'ponyllm:kimi-k3', 'ponyllm:gemini-3.8-flash-high', 'ppx:gpt-6-astra']) {
        if (!patchKeys.includes(expected)) {
          throw new Error(`profile patch model missing: ${expected} (got ${patchKeys.join(',')})`);
        }
      }
      if (patchNorm.contextWindows['ponyllm:kimi-k3'] !== 1000000) {
        throw new Error('profile patch contextWindow not carried into the catalog');
      }
      const patchDefault = logic.normalizeDefaultSelection(patchDoc);
      if (!patchDefault || patchDefault.provider !== 'ponyllm' || patchDefault.model !== 'kimi-k3') {
        throw new Error(`profile patch default selection broken: ${JSON.stringify(patchDefault)}`);
      }

      // ② 旧格式（dsh ≤ 0.1.6 settings.yaml）必须仍可读，且归一化结果一致
      const legacyYaml = [
        'agent-default-model:',
        '  provider: ponyllm',
        '  model: kimi-k3',
        'llm-deepseek:',
        '  models:',
        '    - id: deepseek-flash',
        '      name: DeepSeek Flash',
        '      contextWindow: 1000000',
        'llm-pi-ai:',
        '  providers:',
        '    ponyllm:',
        '      models:',
        '        - id: kimi-k3',
        '          name: kimi-k3 (sense)',
        '          contextWindow: 1000000',
        '        - id: gemini-3.8-flash-high',
        '          name: gemini-3.8-flash-high',
        '    ppx:',
        '      models:',
        '        - id: gpt-6-astra',
        '          name: Astra',
        '',
      ].join('\n');
      const legacyDoc = logic.parseYaml(legacyYaml);
      if (Array.isArray(legacyDoc)) {
        throw new Error('settings.yaml mapping must not parse as a sequence');
      }
      const legacyKeys = logic.normalizeModelSections(legacyDoc).models.map((m) => `${m.provider}:${m.model}`);
      if (legacyKeys.join(',') !== patchKeys.join(',')) {
        throw new Error(`legacy/new normalization diverged: [${legacyKeys.join(',')}] vs [${patchKeys.join(',')}]`);
      }

      // ③ /api/bootstrap 必须宿主 RPC 优先（只读磁盘即本次 M 菜单残缺的成因）
      if (serverSrc.indexOf("callDshWebRpc('session/modelCatalog', {}, 6000, { rawArgs: true })") < 0) {
        throw new Error('bootstrap model catalog must call host RPC session/modelCatalog with empty args');
      }
      if (serverSrc.indexOf('await readModelCatalog()') < 0) {
        throw new Error('/api/bootstrap must await readModelCatalog()');
      }

      // ④ 活体接口：current 必须存在于 models（否则前端 select 选不中）
      const live = await httpRequest('/api/bootstrap');
      if (live.status !== 200) {
        throw new Error(`Expected HTTP 200 from /api/bootstrap, got ${live.status}`);
      }
      const liveModels = (live.body && live.body.models) || [];
      const liveCurrent = live.body && live.body.current || {};
      const currentKey = `${liveCurrent.provider}:${liveCurrent.model}`;
      if (!liveModels.some((m) => `${m.provider}:${m.model}` === currentKey)) {
        throw new Error(`bootstrap current selection ${currentKey} missing from models list`);
      }

      // ⑤ 磁盘用户层声明了多 provider 时，接口不得塌缩成单模型
      const diskDocs = [];
      try {
        const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles');
        for (const name of fs.readdirSync(profilesRoot)) {
          const file = path.join(profilesRoot, name, 'cordis.patch.yml');
          if (fs.existsSync(file)) diskDocs.push(logic.parseYaml(fs.readFileSync(file, 'utf8')));
        }
      } catch (err) { /* 无 profile 目录：环境未声明，跳过该护栏 */ }
      try {
        const legacyFile = path.join(os.homedir(), '.dsh', 'settings.yaml');
        if (fs.existsSync(legacyFile)) diskDocs.push(logic.parseYaml(fs.readFileSync(legacyFile, 'utf8')));
      } catch (err) { /* 旧格式缺失：跳过 */ }
      let diskProviders = 0;
      for (const doc of diskDocs) {
        diskProviders = Math.max(diskProviders, new Set(logic.normalizeModelSections(doc).models.map((m) => m.provider)).size);
      }
      const liveProviders = new Set(liveModels.map((m) => m.provider)).size;
      if (diskProviders >= 2 && liveProviders < 2) {
        throw new Error(`bootstrap collapsed to ${liveProviders} provider(s) while the user-layer document declares ${diskProviders}`);
      }

      return {
        patchModels: patchKeys.length,
        patchProviders: [...new Set(patchNorm.models.map((m) => m.provider))],
        liveModels: liveModels.length,
        liveProviders: liveProviders,
        hostRpcFirst: true,
      };
    });

    // 5. Session List Structure & State Model Contract
    await runner.run('Sessions List Projection & State Semantics Contract', async () => {
      const currentCwd = process.cwd();
      const res = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(currentCwd)}`, { timeout: 30000 });
      if (res.status !== 200) {
        throw new Error(`Expected HTTP 200, got ${res.status}`);
      }
      const list = res.body;
      if (!Array.isArray(list)) {
        throw new Error(`Expected array of sessions, got ${typeof list}`);
      }

      for (const item of list) {
        if (!item.id || typeof item.id !== 'string') {
          throw new Error(`Session item missing valid id: ${JSON.stringify(item)}`);
        }
        if (item.state !== undefined) {
          const validStates = ['running', 'stopped', 'error', 'done', 'idle'];
          if (!validStates.includes(item.state)) {
            throw new Error(`Invalid session state ${item.state} on session ${item.id}`);
          }
        }
      }

      return {
        sessionCount: list.length,
        activeSessionsSample: list.slice(0, 3).map((s) => ({ id: s.id, state: s.state, title: (s.title || '').slice(0, 25) })),
      };
    });

    // 6. Session Statistics API Contract & Metric Calculation (/api/session/stats)
    await runner.run('Session Statistics API Contract & Metrics (/api/session/stats)', async () => {
      const currentCwd = process.cwd();

      // Subtest 6.1: Empty id returns default structure
      const resEmpty = await httpRequest(`/api/session/stats?cwd=${encodeURIComponent(currentCwd)}`);
      if (resEmpty.status !== 200) {
        throw new Error(`Expected HTTP 200 for empty id, got ${resEmpty.status}`);
      }
      const emptyData = resEmpty.body;
      if (emptyData.title !== '（新会话）' || emptyData.turns !== 0 || emptyData.steps !== 0) {
        throw new Error(`Invalid default empty session stats: ${JSON.stringify(emptyData)}`);
      }
      // 对齐 dsh：零输入 cacheHitRate 为 null（O 面板隐藏该行）
      if (emptyData.cacheHitRate !== null) {
        throw new Error(`Empty session cacheHitRate must be null, got ${JSON.stringify(emptyData.cacheHitRate)}`);
      }

      // Subtest 6.2: Non-existent id returns safe default structure
      const resGhost = await httpRequest(`/api/session/stats?cwd=${encodeURIComponent(currentCwd)}&id=ghost-session-99999`);
      if (resGhost.status !== 200) {
        throw new Error(`Expected HTTP 200 for ghost session, got ${resGhost.status}`);
      }
      const ghostData = resGhost.body;
      if (ghostData.sessionId !== 'ghost-session-99999' || ghostData.turns !== 0) {
        throw new Error(`Invalid ghost session stats: ${JSON.stringify(ghostData)}`);
      }
      if (ghostData.cacheHitRate !== null) {
        throw new Error(`Ghost session cacheHitRate must be null, got ${JSON.stringify(ghostData.cacheHitRate)}`);
      }

      // Subtest 6.3: Query existing session from sessions list if available
      const resList = await httpRequest(`/api/sessions?cwd=${encodeURIComponent(currentCwd)}`, { timeout: 30000 });
      let sampleStats = null;
      if (resList.status === 200 && Array.isArray(resList.body) && resList.body.length > 0) {
        const targetSid = resList.body[0].id;
        const resStats = await httpRequest(`/api/session/stats?cwd=${encodeURIComponent(currentCwd)}&id=${encodeURIComponent(targetSid)}`);
        if (resStats.status === 200 && resStats.body) {
          sampleStats = resStats.body;
          if (typeof sampleStats.turns !== 'number' || typeof sampleStats.steps !== 'number') {
            throw new Error(`Metrics turns/steps not numbers in: ${JSON.stringify(sampleStats)}`);
          }
          if (typeof sampleStats.inputTokens !== 'number' || typeof sampleStats.outputTokens !== 'number') {
            throw new Error(`Tokens not numbers in: ${JSON.stringify(sampleStats)}`);
          }
          // 对齐 dsh：无计费输入时命中率为 null（前端隐藏），有输入时为 'N.N%' 字符串
          if (!(sampleStats.cacheHitRate === null || typeof sampleStats.cacheHitRate === 'string')) {
            throw new Error(`cacheHitRate must be null|string in: ${JSON.stringify(sampleStats)}`);
          }
          if (typeof sampleStats.cacheHitRate === 'string' && !/^\d+(\.\d+)?%$/.test(sampleStats.cacheHitRate)) {
            throw new Error(`cacheHitRate bad shape in: ${JSON.stringify(sampleStats)}`);
          }
          // 计费输入恒等于三桶之和（dsh TokenUsage 不交集口径）
          const billed = (sampleStats.uncachedInputTokens || 0) + (sampleStats.cacheReadTokens || 0) + (sampleStats.cacheWriteTokens || 0);
          if (sampleStats.inputTokens !== billed) {
            throw new Error(`inputTokens must equal billed buckets in: ${JSON.stringify(sampleStats)}`);
          }
        }
      }

      return {
        emptySessionHandled: true,
        ghostSessionHandled: true,
        realSessionMetrics: sampleStats ? {
          sessionId: sampleStats.sessionId,
          turns: sampleStats.turns,
          steps: sampleStats.steps,
          mode: sampleStats.mode,
          tokens: `${sampleStats.inputTokens} in / ${sampleStats.outputTokens} out`,
          hitRate: sampleStats.cacheHitRate,
          speed: `${sampleStats.tokenSpeed} tok/s`,
        } : 'none on disk',
      };
    });

    // 6b. Session Goal Contract (/api/session/goal + stats.goal + 前端红圈/O 面板目标行静态接线；L 快捷键已去除)
    await runner.run('Session Goal Contract (goal endpoint + red ring + O panel)', async () => {
      const currentCwd = process.cwd();

      // 6b.1 缺 cwd → 400
      const resGoalNoCwd = await httpRequest('/api/session/goal');
      if (resGoalNoCwd.status !== 400) {
        throw new Error(`Expected 400 for /api/session/goal without cwd, got ${resGoalNoCwd.status}`);
      }

      // 6b.2 幽灵会话 → 200 { goal: null }（与 stats 幽灵口径一致）
      const resGoalGhost = await httpRequest(`/api/session/goal?cwd=${encodeURIComponent(currentCwd)}&id=ghost-session-99999`);
      if (resGoalGhost.status !== 200 || !('goal' in (resGoalGhost.body || {})) || resGoalGhost.body.goal !== null) {
        throw new Error(`Ghost goal must be 200 {goal:null}, got ${resGoalGhost.status}: ${resGoalGhost.rawText.slice(0, 160)}`);
      }

      // 6b.3 穿越 id → 200 null（白名单兜底，绝不抛错）
      const resGoalTrav = await httpRequest(`/api/session/goal?cwd=${encodeURIComponent(currentCwd)}&id=..%2F..%2Fetc%2Fpasswd`);
      if (resGoalTrav.status !== 200 || resGoalTrav.body.goal !== null) {
        throw new Error(`Traversal goal must be 200 null, got ${resGoalTrav.status}`);
      }

      // 6b.4 stats 必须内嵌 goal 字段（前端红圈 piggyback 零额外请求）
      const resStatsGoal = await httpRequest(`/api/session/stats?cwd=${encodeURIComponent(currentCwd)}&id=ghost-session-99999`);
      if (resStatsGoal.status !== 200 || !('goal' in (resStatsGoal.body || {}))) {
        throw new Error(`stats must embed goal field, got ${resStatsGoal.status}`);
      }

      // 6b.5 前端静态接线：红圈样式 + 状态源 + O 面板目标行；L 快捷键不得残留（防实现漂移）
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      for (const needle of ['goal-active', 'syncGoalRing', 'refreshGoalRing', 'clearGoalRing', 'Q20-GOAL-START', 'Q20-GOAL-END', '当前目标', '/api/session/goal']) {
        if (html.indexOf(needle) < 0) throw new Error(`goal wiring missing in index.html: ${needle}`);
      }
      for (const banned of ['showCurrentGoal', 'code === 76']) {
        if (html.indexOf(banned) >= 0) throw new Error(`removed L shortcut still present in index.html: ${banned}`);
      }

      // 6b.6 服务端折叠函数存在性（防误删）
      const serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      for (const needle of ['foldGoalLine', 'getSessionGoal', 'goalViewOf', '/api/session/goal']) {
        if (serverSrc.indexOf(needle) < 0) throw new Error(`goal wiring missing in server.mjs: ${needle}`);
      }

      return {
        goalEndpoint400: true,
        ghostGoalNull: true,
        traversalGoalNull: true,
        statsEmbedsGoal: true,
        frontendWiring: ['red ring css', 'syncGoalRing', 'O panel goal row', 'L removed'],
      };
    });

    // 7. Subagents / Agent Team / Background Tasks API Contract (/api/session/subagents)
    await runner.run('Subagents / Agent Team / Background Tasks API Contract (/api/session/subagents)', async () => {
      const currentCwd = process.cwd();
      const resAll = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}`);
      if (resAll.status !== 200 || !resAll.body || !Array.isArray(resAll.body.subagents)) {
        throw new Error(`Expected 200 array for workspace subagents, got ${resAll.status}`);
      }

      // Check with specific parent session id
      const resParent = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&id=session-a450a460-601e-4f2f-af3c-17177b36d02d`);
      if (resParent.status !== 200 || !resParent.body || !Array.isArray(resParent.body.subagents)) {
        throw new Error(`Expected 200 array for parent subagents, got ${resParent.status}`);
      }

      for (const sa of resParent.body.subagents) {
        if (!sa.id || !sa.parentId || typeof sa.running !== 'boolean') {
          throw new Error(`Malformed subagent record: ${JSON.stringify(sa)}`);
        }
      }

      // 分页契约：limit/offset 切片 + total 恒返（缺省全量向后兼容）
      if (typeof resAll.body.total !== 'number') {
        throw new Error('Missing numeric total in /api/session/subagents response');
      }
      const resPage = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&limit=1&offset=0`);
      if (resPage.status !== 200 || !resPage.body || !Array.isArray(resPage.body.subagents)) {
        throw new Error(`Expected 200 paged array, got ${resPage.status}`);
      }
      if (typeof resPage.body.total !== 'number' || !resPage.body.page || resPage.body.page.limit !== 1) {
        throw new Error(`Missing total/page echo in paged response: ${JSON.stringify(resPage.body.page)}`);
      }
      if (resPage.body.subagents.length > 1) {
        throw new Error('Paged limit=1 returned more than 1 row');
      }
      const resPage2 = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&limit=1&offset=1`);
      if (resPage2.status !== 200 || !Array.isArray(resPage2.body.subagents)) {
        throw new Error(`Expected 200 second page, got ${resPage2.status}`);
      }
      if (resPage2.body.total !== resPage.body.total) {
        // 容错：如果两页请求间 DSH 宿主产生新增或清理，允许两页 total 均为合法非负整数
        if (typeof resPage2.body.total !== 'number' || typeof resPage.body.total !== 'number') {
          throw new Error('total must be a number on paged responses');
        }
      }

      return {
        workspaceSubagentsCount: resAll.body.subagents.length,
        parentSubagentsCount: resParent.body.subagents.length,
        contractVerified: true,
      };
    });

    // 7b. 多智能体看板懒加载：lite 精简映射契约（lib/subagent-lite.mjs 纯函数门禁）
    await runner.run('Subagent lite lazy-load mapping contract (lib/subagent-lite.mjs)', async () => {
      const { applySubagentLite } = await import('./lib/subagent-lite.mjs');
      const full = {
        parentId: 'p-1',
        cwd: '/w',
        total: 2,
        subagents: [
          { id: 'sa-1', parentId: 'p-1', title: '后台任务A', label: 'A', name: '', role: 'subagent', mode: 'one-shot', kind: '后台任务', running: true, isRunning: true, state: 'running', status: 'running', model: 'deepseek-v4-flash', updatedAt: 1, createdAt: 1, cwd: '/w' },
          { id: 'tm-1', parentId: 'p-1', title: 'B (x)', label: 'B', name: 'B', role: 'teammate', mode: 'team', kind: 'Agent Team', running: false, isRunning: false, state: 'done', status: 'done', model: 'gpt-x', updatedAt: 2, createdAt: 2, cwd: '/w' },
        ],
        tasks: [
          { id: 't-1', subject: '说明', status: 'in_progress', ownerName: 'alice', revision: 3, description: '长描述与验收标准…', blockedBy: ['t-0'], writeScopes: ['src/'] },
          { id: 't-2', subject: '说明2', status: 'pending' },
        ],
      };
      const lite = applySubagentLite(full);
      if (lite.lite !== true) throw new Error('lite flag missing');
      if (lite.total !== 2) throw new Error('lite must keep total');
      if (!Array.isArray(lite.subagents) || lite.subagents.length !== 2) throw new Error('lite must keep subagent rows');
      if ('model' in lite.subagents[0]) throw new Error('lite subagent must drop model');
      if (lite.subagents[0].title !== '后台任务A' || lite.subagents[0].kind !== '后台任务' || lite.subagents[0].running !== true) {
        throw new Error('lite subagent must keep title/kind/running');
      }
      if (lite.subagents[1].role !== 'teammate' || lite.subagents[1].mode !== 'team') {
        throw new Error('lite subagent must keep role/mode for badge');
      }
      if (!Array.isArray(lite.tasks) || lite.tasks.length !== 2) throw new Error('lite must keep task rows');
      const t1 = lite.tasks[0];
      if (t1.subject !== '说明' || t1.status !== 'in_progress' || t1.ownerName !== 'alice' || t1.revision !== 3) {
        throw new Error('lite task must keep subject/status/ownerName/revision');
      }
      if ('description' in t1 || 'blockedBy' in t1 || 'writeScopes' in t1) {
        throw new Error('lite task must drop description/blockedBy/writeScopes for on-demand detail');
      }
      if ('revision' in lite.tasks[1]) throw new Error('absent revision must not be synthesized');
      // 幂等：不污染入参（拷贝语义）
      if (full.subagents[0].model !== 'deepseek-v4-flash') throw new Error('lite must not mutate input');
      return { liteRowsKept: lite.subagents.length, liteTasksKept: lite.tasks.length, liteMapped: true };
    });

    // 7c. /api/session/subagents lite=1 双路径契约（含分页组合）
    // （会话/工作区路径在 mock 下子智能体为空，重点校验标记、数字 total 与结构不破）
    await runner.run('Subagents endpoint lite=1 envelope contract', async () => {
      const currentCwd = process.cwd();
      const resLite = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&lite=1`);
      if (resLite.status !== 200 || resLite.body.lite !== true) {
        throw new Error(`Expected lite flag, got ${resLite.status} ${JSON.stringify(resLite.body)}`);
      }
      if (!Array.isArray(resLite.body.subagents) || typeof resLite.body.total !== 'number') {
        throw new Error('lite envelope must keep subagents array + numeric total');
      }
      const resLiteParent = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&id=session-a450a460-601e-4f2f-af3c-17177b36d02d&lite=1&limit=1&offset=0`);
      if (resLiteParent.status !== 200 || resLiteParent.body.lite !== true) {
        throw new Error(`Expected lite flag on paged parent call, got ${resLiteParent.status}`);
      }
      if (!resLiteParent.body.page || resLiteParent.body.page.limit !== 1) {
        throw new Error('lite paged call must keep page echo');
      }
      const resFull = await httpRequest(`/api/session/subagents?cwd=${encodeURIComponent(currentCwd)}&lite=0`);
      if (resFull.status !== 200 || resFull.body.lite !== undefined) {
        throw new Error('lite=0 must stay full (no lite flag)');
      }
      return { liteEnvelope: true, litePagedEnvelope: true, fullUnaffected: true };
    });

    // 13. [UNIT] Session FSM & Tail Status Text Sanitization Contract
    await runner.run('Session FSM & Tail Status Text Sanitization Contract', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf8');

      // 验证前端关键防护措施存在
      if (!html.includes('var sessionSeqToken = 0;')) {
        throw new Error('Missing sessionSeqToken declaration in static/index.html');
      }
      if (!html.includes('xhr.__token !== sessionSeqToken')) {
        throw new Error('Missing sessionSeqToken guard in attachSession onreadystatechange');
      }
      if (!html.includes('openTaskDetail')) {
        throw new Error('Missing openTaskDetail implementation in static/index.html');
      }
      if (!html.includes('task-detail-overlay')) {
        throw new Error('Missing task-detail-overlay in static/index.html');
      }
      // 懒加载看板：列表（lite=1）快载标题，任务详情按需拉取（fetchTaskDetail + __full 回写）
      if (!html.includes('&offset=0&lite=1')) {
        throw new Error('Subagent board loaders must request lite=1 for lazy title list');
      }
      if (!html.includes('function fetchTaskDetail(task)')) {
        throw new Error('Missing fetchTaskDetail lazy detail loader in static/index.html');
      }
      if (!html.includes("task.description === undefined && !task.__full")) {
        throw new Error('openTaskDetail must lazy-fetch lite tasks lacking description');
      }
      // 空响应容错：旧 WebKit 对空串 JSON.parse 报 "unexpected EOF"，必须先拦截给可读提示
      if (!html.includes('网络中断或云端超时（空响应），请按 U 重试')) {
        throw new Error('Missing empty-response guard message for subagents board');
      }
      if (!html.includes("txt = xhr.responseText || '';")) {
        throw new Error('Missing responseText empty-guard in subagents loaders');
      }
      if (!html.includes('xhr.__hasTerminalEvent = true;')) {
        throw new Error('Missing __hasTerminalEvent latch in attachSession');
      }
      if (!html.includes('isLocalStreamingActive = (isStreaming || activeXhr !== null);')) {
        throw new Error('Missing isLocalStreamingActive guard in loadSessions');
      }
      // 验证 doSend 与 sendBtn.onclick 已彻底收敛到单一事实来源 sessState.running，消除孤儿 isStreaming 悬挂拦截
      if (html.includes('function doSend() {\n      stopAttach();\n      if (sessState.running || isStreaming)')) {
        throw new Error('doSend still illegally blocked by orphan isStreaming flag');
      }
      if (!html.includes('isStreaming = false; // 新开/展开对话框时自动清洗任何历史流式残留状态')) {
        throw new Error('Missing openComposer self-healing isStreaming reset');
      }
      // 验证快捷键 X 与 Esc 停止逻辑已同构使用 resolveEffectiveSessionState()，消除脱节误判
      if (!html.includes('var effX = resolveEffectiveSessionState();\n        if (effX.isRunning) {\n          stopStreaming();')) {
        throw new Error('Hotkey X does not use resolveEffectiveSessionState() for stop decision');
      }
      if (!html.includes('var effEscDoc = resolveEffectiveSessionState();\n        if (effEscDoc.isRunning) {\n          stopStreaming();')) {
        throw new Error('Esc document keydown does not use resolveEffectiveSessionState() for stop decision');
      }

      // 验证 syncSessionPhase 唯一同步入口存在且乐观同步 sessCache 与视图
      if (!html.includes('function syncSessionPhase(sid, phase, customText) {')) {
        throw new Error('Missing syncSessionPhase declaration in static/index.html');
      }
      if (!html.includes('list[i].isRunning = isRun;\n            list[i].state = phase;')) {
        throw new Error('Missing optimistic sessCache sync in syncSessionPhase');
      }
      // 验证 normalizeSessionState 中 waiting / pendingInteraction 优先于 isRunning
      const normMatch = html.match(/function normalizeSessionState\(s\) \{([\s\S]*?)\}/);
      if (!normMatch) {
        throw new Error('Missing normalizeSessionState implementation');
      }
      const normBody = normMatch[1];
      const waitIdx = normBody.indexOf("st === 'waiting'");
      const runIdx = normBody.indexOf("s.isRunning");
      if (waitIdx < 0 || runIdx < 0 || waitIdx > runIdx) {
        throw new Error('normalizeSessionState must prioritize waiting/pendingInteraction over isRunning');
      }
      // 验证登录焦点陷阱修复：hideLoginModal 必须 blur 登录输入框，
      // 否则 document.activeElement 长期停留 INPUT 吞掉全部字母快捷键
      if (!html.includes('try { loginTokenInput.blur(); } catch (e) {}')) {
        throw new Error('Missing loginTokenInput.blur() in hideLoginModal (hotkey focus trap)');
      }
      // 验证欢迎页假就绪修复：错误态不得点亮快捷键提示
      if (!html.includes('function welcomeErrorElShown()')) {
        throw new Error('Missing welcomeErrorElShown guard in updateWelcomeLoading');
      }
      // 验证发送流传输闪断先对账再画卡：onerror/非 200 不得直调 showStreamError，
      // 必须经 recoverOrFailSend 查 /api/sessions 权威快照（仍 running 则重挂）
      if (!html.includes('function recoverOrFailSend(cwd, targetSid, sendSeq, promptText, httpStatus, offlineNow) {')) {
        throw new Error('Missing recoverOrFailSend declaration in static/index.html');
      }
      if (!html.includes("recoverOrFailSend(cwd, targetEndSid, sendSeq, prompt, status, offlineNow);")) {
        throw new Error('readyState 4 non-200 branch must reconcile via recoverOrFailSend');
      }
      if (!html.includes('recoverOrFailSend(cwd, sendSid || currentSessionId, sendSeq, prompt, 0, offlineNow);')) {
        throw new Error('xhr.onerror must reconcile via recoverOrFailSend');
      }
      // 主动中止标记：四处 activeXhr.abort() 必须先置 __aborted，
      // doSend 两条回调顶部必须拦截 __aborted，杜绝中止残留触发对账/画卡
      var abortedMarks = (html.match(/activeXhr\.__aborted = true;/g) || []).length;
      if (abortedMarks < 4) {
        throw new Error(`Expected >=4 activeXhr.__aborted marks, got ${abortedMarks}`);
      }
      if (!html.includes('if (xhr.__aborted || sessionSeqToken !== sendSeq || (sendSid && currentSessionId !== sendSid)) {')) {
        throw new Error('Missing __aborted guard in doSend callbacks');
      }
      // U 面板鼠标点击必须走 #subagent-tree 容器事件委托，行级不得再绑 onclick 闭包：
      // 缓存渲染→XHR 回包渲染的整树 innerHTML 替换窗口内，落点旧节点的点击随旧 DOM 丢失
      if (!html.includes('subagentTree.onclick = function(e) {')) {
        throw new Error('Missing subagentTree container click delegation');
      }
      if (!html.includes("subagentNodes[i].kind === 'subagent'")) {
        throw new Error('Subagent click delegation must filter kind === subagent');
      }
      if (html.includes('var sn = mkNode(label, cls, function() {\n            selectSubagentSession(sa);')) {
        throw new Error('Subagent rows must not bind per-row onclick closures');
      }
      // U 面板空会话兜底：当前会话为空时自动回退工作区全部，避免误报"当前无智能体"
      if (!html.includes('function loadWorkspaceSubagentsFallback(cwd, cacheKey')) {
        throw new Error('Missing workspace fallback loader for empty subagent session');
      }
      if (!html.includes('data.fallback = true;')) {
        throw new Error('Workspace fallback must mark data.fallback for title rendering');
      }
      if (!html.includes('👥 多智能体 · 工作区全部')) {
        throw new Error('Missing fallback title for workspace-wide subagent view');
      }
      // U 面板规模防护：分页窗口 + 单次插入 + 请求序列号 + 切换防抖 + 缓存复用
      if (!html.includes('var subagentPageSize = 30;')) {
        throw new Error('Missing subagentPageSize window declaration');
      }
      if (!html.includes('function growSubagentWindow() {')) {
        throw new Error('Missing growSubagentWindow pagination expander');
      }
      if (!html.includes('createDocumentFragment')) {
        throw new Error('Subagent tree must batch inserts via DocumentFragment');
      }
      if (!html.includes('var subagentReqSeq = 0;')) {
        throw new Error('Missing subagentReqSeq stale-response guard');
      }
      if (!html.includes('if (mySeq !== subagentReqSeq) return;')) {
        throw new Error('Missing stale XHR discard in subagent loaders');
      }
      if (!html.includes('var subagentSelectLockUntil = 0;')) {
        throw new Error('Missing selectSubagentSession debounce lock');
      }
      if (!html.includes("kind === 'more'")) {
        throw new Error('Subagent tree must handle kind === more rows');
      }
      if (!html.includes('__lastSel')) {
        throw new Error('markKbSel must track __lastSel fast path');
      }

      // 验证状态栏清洗逻辑（模拟测试）
      const sanitizeFn = (customText) => {
        var cleanText = customText ? customText.replace(/^[●\s]+/, '') : '';
        var isInvalidRunningText = (!cleanText || cleanText.indexOf('就绪') !== -1 || cleanText.indexOf('历史') !== -1 || cleanText.indexOf('新建') !== -1);
        return isInvalidRunningText ? '深度求索中…' : cleanText;
      };

      if (sanitizeFn('就绪 (5个对话)') !== '深度求索中…') {
        throw new Error('Tail status failed to sanitize "就绪" in running state');
      }
      if (sanitizeFn('● 对话后台运行中 [思考]') !== '对话后台运行中 [思考]') {
        throw new Error('Tail status failed to preserve valid running action text');
      }
      if (sanitizeFn('') !== '深度求索中…') {
        throw new Error('Tail status failed to fallback empty text to default');
      }

      // 验证 401 Unauthorized 统一跳转 Token 登录页（幂等防重入 + 5s 轮询未认证守卫）
      if (!html.includes('function handleUnauthorized() {')) {
        throw new Error('Missing handleUnauthorized declaration in static/index.html');
      }
      if (!html.includes("if (loginOverlay.style.display === 'block') {\n        return;\n      }")) {
        throw new Error('showLoginModal must be idempotent to prevent clearing user input on concurrent 401');
      }
      if (!html.includes('if (!isAuthOk) return; // 未认证通过时严禁后台轮询')) {
        throw new Error('Background sessions poll must be guarded by isAuthOk');
      }
      if (!html.includes('if (httpStatus === 401) {\n        handleUnauthorized();\n        return;\n      }')) {
        throw new Error('recoverOrFailSend must directly handle 401');
      }

      if (!html.includes('if (currentSessionId && typeof userStoppedSessions !== \'undefined\') {\n        delete userStoppedSessions[currentSessionId];\n      }')) {
        throw new Error('Missing delete userStoppedSessions[currentSessionId] cleanup in doSend');
      }

      return {
        seqTokenGuardVerified: true,
        terminalEventLatchVerified: true,
        streamingPrecedenceVerified: true,
        statusTailSanitizationVerified: true,
        syncSessionPhaseVerified: true,
        normalizeWaitingPrecedenceVerified: true,
        unauthorizedRedirectVerified: true,
        stoppedSessionCleanedOnSend: true,
      };
    });

    // 14. [UNIT] P0 Perf/Security Optimization Contract (gzip / ETag / sessionId whitelist / logout)
    await runner.run('P0 Perf/Security Optimization Contract (gzip / ETag / sessionId / logout)', async () => {
      const currentCwd = process.cwd();
      const gzipHeaders = { 'Accept-Encoding': 'gzip' };

      // 14.1 /api/bootstrap 请求 gzip → Content-Encoding: gzip 且可解压为合法 JSON
      const resGzip = await httpRequest(`/api/bootstrap?cwd=${encodeURIComponent(currentCwd)}`, { headers: gzipHeaders });
      if (resGzip.status !== 200) {
        throw new Error(`Expected 200 for gzipped bootstrap, got ${resGzip.status}`);
      }
      if (resGzip.headers['content-encoding'] !== 'gzip') {
        throw new Error('Missing Content-Encoding: gzip on bootstrap with Accept-Encoding: gzip');
      }
      const inflated = JSON.parse(zlib.gunzipSync(resGzip.rawBuffer).toString('utf8'));
      if (!inflated || !Array.isArray(inflated.workspaces) || !Array.isArray(inflated.models)) {
        throw new Error('Gzipped bootstrap payload failed to inflate to valid JSON');
      }

      // 14.1b 无 Accept-Encoding → 行为不变（无压缩，JSON 可直接解析）
      const resPlain = await httpRequest(`/api/bootstrap?cwd=${encodeURIComponent(currentCwd)}`);
      if (resPlain.status !== 200 || resPlain.headers['content-encoding']) {
        throw new Error(`Plain bootstrap must stay uncompressed, got ${resPlain.status}/${resPlain.headers['content-encoding']}`);
      }
      if (!resPlain.body || !Array.isArray(resPlain.body.workspaces)) {
        throw new Error('Plain bootstrap JSON contract broken');
      }

      // 14.2 静态 index.html：ETag + 304 条件请求 + gzip 分支
      const resStatic = await httpRequest('/');
      if (resStatic.status !== 200 || !resStatic.headers.etag) {
        throw new Error(`Static / must return 200 with ETag, got ${resStatic.status}`);
      }
      if (!resStatic.headers['cache-control'] || resStatic.headers['cache-control'].indexOf('max-age=3600') < 0) {
        throw new Error(`Static / missing Cache-Control max-age=3600: ${resStatic.headers['cache-control']}`);
      }
      const res304 = await httpRequest('/', { headers: { 'If-None-Match': resStatic.headers.etag } });
      if (res304.status !== 304) {
        throw new Error(`Expected 304 for matching If-None-Match, got ${res304.status}`);
      }
      const resStaticGzip = await httpRequest('/', { headers: gzipHeaders });
      if (resStaticGzip.status !== 200 || resStaticGzip.headers['content-encoding'] !== 'gzip') {
        throw new Error('Static / must gzip when Accept-Encoding: gzip is sent');
      }

      // 14.3 sessionId 白名单：`..` 穿越被拦截（history → 空结果，stats → 空默认结构），含冒号合规格式（remote:dev:* 正常通过）
      const traversal = '..%2F..%2Fetc%2Fpasswd';
      const resTrav = await httpRequest(`/api/history?cwd=${encodeURIComponent(currentCwd)}&id=${traversal}`);
      if (resTrav.status !== 200 || !Array.isArray(resTrav.body) || resTrav.body.length !== 0) {
        throw new Error(`Traversal history must return 200 [], got ${resTrav.status}: ${JSON.stringify(resTrav.body).slice(0, 120)}`);
      }
      const resTravStats = await httpRequest(`/api/session/stats?cwd=${encodeURIComponent(currentCwd)}&id=${traversal}`);
      if (resTravStats.status !== 200 || resTravStats.body.turns !== 0) {
        throw new Error(`Traversal stats must return safe default, got ${resTravStats.status}`);
      }
      const resRemoteHistory = await httpRequest(`/api/history?cwd=${encodeURIComponent(currentCwd)}&id=remote:dev:ghost-session`);
      if (resRemoteHistory.status !== 200 || !Array.isArray(resRemoteHistory.body)) {
        throw new Error(`Remote session id format with colon must be accepted by whitelist, got ${resRemoteHistory.status}`);
      }

      // 14.4 logout：无 Cookie 也返回成功并下发清除头
      const resLogout = await httpRequest('/api/auth/logout', { method: 'POST' });
      if (resLogout.status !== 200 || resLogout.body.success !== true) {
        throw new Error(`Logout must return 200 success, got ${resLogout.status}`);
      }
      const setCookie = resLogout.headers['set-cookie'] || '';
      if (String(setCookie).indexOf('Max-Age=0') < 0) {
        throw new Error(`Logout must clear cookie via Max-Age=0: ${setCookie}`);
      }

      return {
        gzipBootstrapVerified: true,
        plainBootstrapUnchanged: true,
        staticETag304Verified: true,
        staticGzipVerified: true,
        traversalBlockedVerified: true,
        logoutContractVerified: true,
      };
    });

    // 14a. 可用性加固契约（/healthz 探活 + 监听防呆结构不断言运行时绑定）
    await runner.run('Availability Hardening Contract (/healthz probe + listen guard)', async () => {
      // 14a.1 存活探针：免鉴权、UA 无关、JSON 指纹最小
      const resHealth = await httpRequest('/healthz');
      if (resHealth.status !== 200 || !resHealth.body || resHealth.body.ok !== true) {
        throw new Error(`Expected 200 { ok: true } from /healthz, got ${resHealth.status}: ${resHealth.rawText.slice(0, 120)}`);
      }
      if (resHealth.body.service !== 'dsh-bb10-web' || typeof resHealth.body.uptime !== 'number') {
        throw new Error(`Unexpected /healthz payload: ${resHealth.rawText.slice(0, 160)}`);
      }
      if (String(resHealth.headers['cache-control'] || '').indexOf('no-store') < 0) {
        throw new Error(`Missing Cache-Control: no-store on /healthz: ${resHealth.headers['cache-control']}`);
      }
      // 14a.2 非 Q20 UA 亦须 200（探针在安全网关拦截器之前）
      const resHealthPlain = await httpRequest('/healthz', { headers: { 'User-Agent': 'health-check-probe/1.0' } });
      if (resHealthPlain.status !== 200 || !resHealthPlain.body || resHealthPlain.body.ok !== true) {
        throw new Error(`Expected /healthz to bypass UA gate, got ${resHealthPlain.status}`);
      }
      // 14a.3 HEAD 支持（看门狗轻量探活）
      const resHealthHead = await httpRequest('/healthz', { method: 'HEAD' });
      if (resHealthHead.status !== 200) {
        throw new Error(`Expected 200 for HEAD /healthz, got ${resHealthHead.status}`);
      }
      // 14a.4 结构断言：探针分支位于安全网关拦截器之前；EADDRINUSE 指引与绑定横幅存在
      const serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      const probeIdx = serverSrc.indexOf("pathname === '/healthz'");
      const gatewayIdx = serverSrc.indexOf('--- Security Gateway Interceptor ---');
      if (probeIdx < 0 || gatewayIdx < 0 || probeIdx > gatewayIdx) {
        throw new Error('/healthz must be registered before the Security Gateway Interceptor');
      }
      for (const needle of ['EADDRINUSE', '[BIND] WARN', 'stop dsh-bb10-web']) {
        if (serverSrc.indexOf(needle) < 0) throw new Error(`listen guard missing in server.mjs: ${needle}`);
      }

      return {
        healthzVerified: true,
        uaBypassVerified: true,
        headVerified: true,
        guardStructureVerified: true,
      };
    });

    // 14b. 运行中追发双模式契约（排队 queue / 插队 steer，对齐上游 session/prompt）
    await runner.run('Running Send Queue/Steer Mode Contract (/api/session/prompt + Q shortcut)', async () => {
      // 缺参 → 400
      const resPNoParam = await httpRequest('/api/session/prompt', { method: 'POST', body: {} });
      if (resPNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/prompt without params, got ${resPNoParam.status}`);
      }
      // 非法 mode → 400
      const resPBadMode = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', mode: 'bogus' },
      });
      if (resPBadMode.status !== 400) {
        throw new Error(`Expected 400 for invalid mode, got ${resPBadMode.status}`);
      }
      // 幽灵会话（未运行）→ 200 + ok:false（幂等，不打爆客户端）
      const resPGhost = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', mode: 'steer' },
      });
      if (resPGhost.status !== 200 || resPGhost.body?.ok !== false) {
        throw new Error(`Expected 200 ok:false for ghost session, got ${resPGhost.status}: ${JSON.stringify(resPGhost.body)}`);
      }
      if (resPGhost.body.error !== 'session not running') {
        throw new Error(`Unexpected ghost error: ${resPGhost.body.error}`);
      }
      // /api/chat/stream 非法 mode → 400（SSE 头之前拦截，无副作用）
      const resStreamBadMode = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: process.cwd(), prompt: 'hi', mode: 'bogus' },
      });
      if (resStreamBadMode.status !== 400) {
        throw new Error(`Expected 400 for /api/chat/stream invalid mode, got ${resStreamBadMode.status}`);
      }
      // receiptIds 非数组 → 400（prompt 与 stream 双入口同契约）
      const resPBadRid = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', receiptIds: 'nope' },
      });
      if (resPBadRid.status !== 400) {
        throw new Error(`Expected 400 for /api/session/prompt bad receiptIds, got ${resPBadRid.status}`);
      }
      const resPBadRidItem = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', receiptIds: [123] },
      });
      if (resPBadRidItem.status !== 400) {
        throw new Error(`Expected 400 for /api/session/prompt bad receiptIds item, got ${resPBadRidItem.status}`);
      }
      const resStreamBadRid = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: process.cwd(), prompt: 'hi', receiptIds: 'nope' },
      });
      if (resStreamBadRid.status !== 400) {
        throw new Error(`Expected 400 for /api/chat/stream bad receiptIds, got ${resStreamBadRid.status}`);
      }
      const resStreamBadRidItem = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: process.cwd(), prompt: 'hi', receiptIds: [123] },
      });
      if (resStreamBadRidItem.status !== 400) {
        throw new Error(`Expected 400 for /api/chat/stream bad receiptIds item, got ${resStreamBadRidItem.status}`);
      }
      // image 内联校验：非法 mediaType / 坏 base64 → 400（prompt 与 stream 双入口同契约）
      const resPBadImgMt = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', image: { mediaType: 'image/bmp', data: 'aGk=' } },
      });
      if (resPBadImgMt.status !== 400) {
        throw new Error(`Expected 400 for /api/session/prompt bad image mediaType, got ${resPBadImgMt.status}`);
      }
      const resPBadImgData = await httpRequest('/api/session/prompt', {
        method: 'POST',
        body: { sessionId: 'ghost-session-unit-99999', prompt: 'hi', image: { mediaType: 'image/png', data: '!!!' } },
      });
      if (resPBadImgData.status !== 400) {
        throw new Error(`Expected 400 for /api/session/prompt bad image data, got ${resPBadImgData.status}`);
      }
      const resStreamBadImg = await httpRequest('/api/chat/stream', {
        method: 'POST',
        body: { cwd: process.cwd(), prompt: 'hi', image: { mediaType: 'image/bmp', data: 'aGk=' } },
      });
      if (resStreamBadImg.status !== 400) {
        throw new Error(`Expected 400 for /api/chat/stream bad image, got ${resStreamBadImg.status}`);
      }

      // 客户端纯逻辑：从 static/index.html 的标记切片中提取并执行（ES5 函数）
      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      // Plus 上传接线 ES5 门禁：内联脚本必须通过 ecmaVersion 5 解析
      {
        const plusGateSrc = html.match(/<script>([\s\S]*?)<\/script>/);
        if (!plusGateSrc) throw new Error('no inline script for ES5 gate');
        const acornNs = await import('acorn');
        const acornParse = acornNs.parse || (acornNs.default && acornNs.default.parse);
        if (typeof acornParse !== 'function') throw new Error('acorn.parse unavailable for ES5 gate');
        acornParse(plusGateSrc[1], { ecmaVersion: 5 });
      }
      const s = html.indexOf('/* @Q20-SENDMODE-START */');
      const e = html.indexOf('/* @Q20-SENDMODE-END */');
      if (s < 0 || e < 0 || e <= s) throw new Error('pure-logic markers missing in static/index.html: @Q20-SENDMODE');
      const modeSrc = html.slice(s, e);
      const mkMode = (store) => new Function(
        'window', 'localStorage',
        `${modeSrc}\nreturn { label: sendModeLabel, get: function() { return sendMode; } };`,
      )({}, store);
      const nullStore = { getItem: () => null, setItem: () => {} };
      const m1 = mkMode(nullStore);
      if (m1.get() !== 'queue') throw new Error(`default sendMode must be queue, got ${m1.get()}`);
      if (m1.label('steer') !== '插队' || m1.label('queue') !== '排队' || m1.label('bogus') !== '排队') {
        throw new Error('sendModeLabel zh mapping broken');
      }
      const m2 = mkMode({ getItem: () => 'steer', setItem: () => {} });
      if (m2.get() !== 'steer') throw new Error('sendMode must restore persisted steer');

      // 静态接线：Q 快捷键、Z 撤回排队/插队、F 分支、追发/分支函数、端点调用、底部独立停靠排队区、会话分槽恢复
      for (const needle of ['code === 81', 'code === 90', 'code === 70', 'function sendRunningPrompt', 'revokeQueuedPrompt', 'doForkSession', 'createForkAction', '/api/session/fork', '发送模式', '/api/session/prompt', '/api/session/queue/remove', 'toggleSendMode', 'renderQueueDock', 'clearQueueDock', 'restoreQueuedPrompt', 'queuedPromptStore', 'hideQueueDockKeepSlot', 'id="queue-dock"', 'pendingQueuedItem = null']) {
        if (html.indexOf(needle) < 0) throw new Error(`static wiring missing in index.html: ${needle}`);
      }
      // Plus 上传接线：＋按钮/透明 input/单行卡/收据挂载/核销/图片内联/首条 pending
      for (const needle of ['plus-btn', 'plus-file-input', 'plus-file-card', 'Q20-PLUSUPLOAD-START', 'Q20_UPLOAD_MAX', 'receiptIds', 'plusClear', 'plusStartImageInline', 'plusIsImageFile', 'payload.image', 'plusRunImage', 'plusPendingFile', 'plusEnsureSession', 'plusUploadFileToSession', 'doSendWithPendingFile']) {
        if (html.indexOf(needle) < 0) throw new Error(`plus upload wiring missing in index.html: ${needle}`);
      }
      // 底栏防重叠：徽章/圆环收进 #composer-meta-inner 独立内槽裁剪，裁剪边在发送键左 46px；
      // 发送键与 ＋ 键钉在外层 bar（#composer-meta 不再 overflow:hidden，避免裁剪失效）。
      for (const needle of ['composer-meta-inner', 'id="ws-badge"', 'id="model-badge"', 'id="ctx-ring-wrap"', 'id="send-btn"']) {
        if (html.indexOf(needle) < 0) throw new Error(`composer no-overlap wiring missing in index.html: ${needle}`);
      }
      {
        const metaIdx = html.indexOf('<div id="composer-meta">');
        const innerIdx = html.indexOf('id="composer-meta-inner"');
        const sendIdx = html.indexOf('id="send-btn"');
        const wsIdx = html.indexOf('id="ws-badge"');
        const modelIdx = html.indexOf('id="model-badge"');
        const ringIdx = html.indexOf('id="ctx-ring-wrap"');
        if (metaIdx < 0 || innerIdx < 0 || sendIdx < 0) throw new Error('composer meta/send ids missing');
        // 发送键在 meta 元素之外（DOM 先于 meta，经绝对定位浮于右上，z-index 高于底栏）；
        // 徽章/圆环收进内槽（meta 之后、内槽之内），溢出在内槽右缘（发送键左 46px）裁掉。
        if (!(sendIdx < metaIdx && metaIdx < innerIdx)) throw new Error('send-btn must stay outside #composer-meta; badges inside #composer-meta-inner');
        if (!(innerIdx < wsIdx && innerIdx < modelIdx && innerIdx < ringIdx)) throw new Error('badges/ctx-ring must live inside #composer-meta-inner');
      }
      // 实时流 step 切分（对齐 dsh web 按 step 交错展示）：工具调用到达即封口
      // 当前文本气泡（liveTextBubble/attachTextBubble 置空），后续 delta 建新气泡；
      // send 路径新气泡只渲染本 step 文本（bubbleText），整轮累计保留在 fullAssistantText。
      for (const needle of ['bubbleText', 'attachTextBubble = null', 'liveTextBubble = null']) {
        if (html.indexOf(needle) < 0) throw new Error(`step-split wiring missing in index.html: ${needle}`);
      }
      {
        // 封口必须发生在胶囊 appendChild 之前（先结算旧气泡，再挂工具胶囊）。
        const sealIdx = html.indexOf('bubbleText = \'\';');
        const pillIdx = html.indexOf('assistantWrap.appendChild(pill);');
        if (sealIdx < 0 || pillIdx < 0 || !(sealIdx < pillIdx)) throw new Error('step seal must precede tool pill append');
      }
      // 服务端图片内联挂载：toPromptImagePart + runChat imagePart 透传
      const serverSrcPlus = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
      for (const needle of ['toPromptImagePart', 'imagePart', 'Q20_IMAGE_B64_MAX']) {
        if (serverSrcPlus.indexOf(needle) < 0) throw new Error(`plus image wiring missing in server.mjs: ${needle}`);
      }
      // /api/session/ensure 契约：缺 cwd 也可建（默认进程 cwd）→ 200 ok:true + sessionId。
      // 2026-09-30：真链路改 mock —— 在 Q20_MOCK_HOST 隔离进程上建会话（mock 宿主
      // session/create），绝不向真实宿主创建会话。宿主宕机分支（502 fail-fast）在
      // mock 模式下不存在，恒走 200 ok:true。
      const mock = await ensureMockServer();
      const resEnsure = await httpRequest('/api/session/ensure', { method: 'POST', body: { cwd: mock.workspaceRoot }, base: mock.base });
      let ensureCreatedSid = null;
      if (resEnsure.status === 200 && resEnsure.body?.ok === true) {
        if (!resEnsure.body.sessionId) throw new Error('ensure must return sessionId');
        ensureCreatedSid = resEnsure.body.sessionId;
      } else if (resEnsure.status === 502) {
        if (resEnsure.body?.ok !== false) throw new Error('ensure fail-fast must be ok:false');
      } else {
        throw new Error(`Expected 200 ensure or 502 fail-fast, got ${resEnsure.status}: ${JSON.stringify(resEnsure.body)}`);
      }
      // 自愈清理测试预建的临时会话，杜绝磁盘存储污染（mock 临时 DSH_HOME 内）
      if (ensureCreatedSid) {
        try {
          await httpRequest('/api/session/archive', { method: 'POST', body: { cwd: mock.workspaceRoot, sessionId: ensureCreatedSid }, base: mock.base });
          await httpRequest('/api/session', { method: 'DELETE', body: { cwd: mock.workspaceRoot, sessionId: ensureCreatedSid }, base: mock.base });
        } catch {}
      }

      // /api/session/fork 契约测试
      const resForkNoParam = await httpRequest('/api/session/fork', { method: 'POST', body: {} });
      if (resForkNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/fork without sessionId, got ${resForkNoParam.status}`);
      }
      const resForkBadSeq = await httpRequest('/api/session/fork', {
        method: 'POST',
        body: { sessionId: 'ghost-session-9999', atSeq: -3 },
      });
      if (resForkBadSeq.status !== 400) {
        throw new Error(`Expected 400 for /api/session/fork with negative atSeq, got ${resForkBadSeq.status}`);
      }
      const resForkGhost = await httpRequest('/api/session/fork', {
        method: 'POST',
        body: { sessionId: 'ghost-session-9999' },
      });
      if (resForkGhost.status !== 200 || resForkGhost.body?.ok !== false) {
        throw new Error(`Expected 200 ok:false for ghost fork, got ${resForkGhost.status}: ${JSON.stringify(resForkGhost.body)}`);
      }

      // /api/session/queue/remove 契约测试
      const resRemNoParam = await httpRequest('/api/session/queue/remove', { method: 'POST', body: {} });
      if (resRemNoParam.status !== 400) {
        throw new Error(`Expected 400 for /api/session/queue/remove without sessionId, got ${resRemNoParam.status}`);
      }
      const resRemGhost = await httpRequest('/api/session/queue/remove', {
        method: 'POST',
        body: { sessionId: 'ghost-session-9999' },
      });
      if (resRemGhost.status !== 200 || resRemGhost.body?.ok !== false) {
        throw new Error(`Expected 200 ok:false for ghost queue remove, got ${resRemGhost.status}: ${JSON.stringify(resRemGhost.body)}`);
      }

      return {
        endpointGuards: ['400 missing params', '400 invalid mode', 'ghost ok:false', 'stream 400 invalid mode', 'queue/remove 400 & ghost', 'fork 400 & ghost'],
        pureLogic: ['default queue', 'label 排队/插队', 'persisted steer'],
        staticWiring: ['Q shortcut', 'Z shortcut revoke', 'F shortcut fork', 'sendRunningPrompt', 'revokeQueuedPrompt', 'doForkSession', 'status row', 'prompt endpoint', 'fork endpoint', 'queued grey bubble / steer dark-orange bubble'],
      };
    });

    // 14. Message File Preview Contract（消息内图片 / txt / md 点击全屏预览）
    //     - /api/attachment：官方附件对象存储镜像（objects/<sha2>/<sha>、
    //       files/<sha2>/<sha>/<name>、file-objects/<sha2>/<sha>）字节往返与白名单
    //     - /api/file：注册工作区内 markdown 引用文件（越界/未注册/非白名单一律拒绝）
    //     - static/index.html + server.mjs：预览卡 / 全屏遮罩 / 模态键盘守卫静态接线
    //     说明：探针对象写入 DSH_HOME/attachments/v1（内容寻址、只增不改），
    //     结束即按文件逐个清理；要求被测服务与本进程同 DSH_HOME（同机默认一致）。
    await runner.run('Message File Preview Contract (image/txt/md fullscreen preview)', async () => {
      const crypto = await import('node:crypto');
      const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const storeRoot = path.join(dshHome, 'attachments', 'v1');
      const createdFiles = [];
      const createdDirs = [];

      const putObject = (relDir, relLeaf, data) => {
        const dir = path.join(storeRoot, relDir);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          createdDirs.push(dir);
        }
        const leaf = path.join(dir, relLeaf);
        fs.writeFileSync(leaf, data);
        createdFiles.push(leaf);
        return leaf;
      };

      try {
        // --- 图片对象：objects/<sha2>/<sha> → image/png 字节往返 ---
        const pngBytes = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489', 'hex');
        const pngSha = crypto.createHash('sha256').update(pngBytes).digest('hex');
        putObject(path.join('objects', pngSha.slice(0, 2)), pngSha, pngBytes);
        const resImg = await httpRequest(
          '/api/attachment?id=' + encodeURIComponent('sha256:' + pngSha) + '&name=probe.png&kind=image&mediaType=image/png',
        );
        if (resImg.status !== 200) {
          throw new Error(`attachment image expected 200, got ${resImg.status}: ${resImg.rawText.slice(0, 120)}`);
        }
        if (String(resImg.headers['content-type'] || '').indexOf('image/png') !== 0) {
          throw new Error(`attachment image content-type mismatch: ${resImg.headers['content-type']}`);
        }
        if (!resImg.rawBuffer.equals(pngBytes)) throw new Error('attachment image bytes mismatch');

        // --- 文本别名：files/<sha2>/<sha>/<name> → text/plain 往返（含 file-objects 回退） ---
        const mdBody = Buffer.from('# Q20 PREVIEW PROBE\n正文 markdown\n', 'utf8');
        const mdSha = crypto.createHash('sha256').update(mdBody).digest('hex');
        putObject(path.join('files', mdSha.slice(0, 2), mdSha), 'probe.md', mdBody);
        putObject(path.join('file-objects', mdSha.slice(0, 2)), mdSha, mdBody);
        const mdId = encodeURIComponent('sha256:' + mdSha);
        const resMd = await httpRequest(`/api/attachment?id=${mdId}&name=probe.md&kind=file`);
        if (resMd.status !== 200) {
          throw new Error(`attachment file expected 200, got ${resMd.status}: ${resMd.rawText.slice(0, 120)}`);
        }
        if (String(resMd.headers['content-type'] || '').indexOf('text/plain') !== 0) {
          throw new Error(`attachment md content-type mismatch: ${resMd.headers['content-type']}`);
        }
        if (resMd.rawText.indexOf('Q20 PREVIEW PROBE') === -1) throw new Error('attachment md body mismatch');

        // --- 白名单：非图片/文本（.py）拒绝 415，绝不回显任意字节 ---
        const pyBody = Buffer.from('print("probe")\n', 'utf8');
        const pySha = crypto.createHash('sha256').update(pyBody).digest('hex');
        putObject(path.join('files', pySha.slice(0, 2), pySha), 'probe.py', pyBody);
        putObject(path.join('file-objects', pySha.slice(0, 2)), pySha, pyBody);
        const pyId = encodeURIComponent('sha256:' + pySha);
        const resPy = await httpRequest(`/api/attachment?id=${pyId}&name=probe.py&kind=file`);
        if (resPy.status !== 415) {
          throw new Error(`non-previewable type must be 415, got ${resPy.status}`);
        }
        // P0 回归（安全评审 F1）：别名/声明绝不能改写白名单判定
        const resPyAlias = await httpRequest(`/api/attachment?id=${pyId}&name=x.txt&mediaType=text/plain`);
        if (resPyAlias.status !== 415) {
          throw new Error(`F1: alias rename must not unlock a non-previewable object, got ${resPyAlias.status}`);
        }
        const resPyImgClaim = await httpRequest(`/api/attachment?id=${pyId}&name=probe.py&mediaType=image/png`);
        if (resPyImgClaim.status !== 415) {
          throw new Error(`F1: mediaType claim must not unlock a non-image object, got ${resPyImgClaim.status}`);
        }
        // 无别名对象只认内容签名：ext-less 图片对象仍可预览，非图片一律 415
        const extlessSha = crypto.createHash('sha256').update(pngBytes).digest('hex');
        putObject(path.join('file-objects', extlessSha.slice(0, 2)), extlessSha, pngBytes);
        const resSniff = await httpRequest(`/api/attachment?id=${encodeURIComponent('sha256:' + extlessSha)}&name=anything.bin`);
        if (resSniff.status !== 200 || String(resSniff.headers['content-type'] || '').indexOf('image/png') !== 0) {
          throw new Error(`content-signature gate failed for extension-less image: ${resSniff.status} ${resSniff.headers['content-type']}`);
        }
        const resSniffText = await httpRequest(
          `/api/attachment?id=${encodeURIComponent('sha256:' + pySha)}&name=probe.js`
        );
        if (resSniffText.status !== 415) {
          throw new Error(`content-signature gate must refuse non-image ext-less object, got ${resSniffText.status}`);
        }
        // --- 参数与存在性守卫 ---
        const resBadId = await httpRequest('/api/attachment?id=sha256:zzzz&name=x.png');
        if (resBadId.status !== 400) throw new Error(`invalid attachment id must be 400, got ${resBadId.status}`);
        const ghostSha = 'f'.repeat(64);
        const resGhost = await httpRequest(`/api/attachment?id=${encodeURIComponent('sha256:' + ghostSha)}&name=x.png&kind=image`);
        if (resGhost.status !== 404) throw new Error(`unknown attachment must be 404, got ${resGhost.status}`);

        // --- /api/file：注册工作区内 markdown 引用文件 ---
        const boot = await httpRequest('/api/bootstrap');
        if (boot.status !== 200 || !Array.isArray(boot.body?.workspaces)) {
          throw new Error(`bootstrap unavailable for /api/file probe: ${boot.status}`);
        }
        const ws = boot.body.workspaces.find((w) => w && w.cwd && fs.existsSync(w.cwd));
        if (!ws) throw new Error('no on-disk registered workspace available to probe /api/file');

        const probeMdName = '.q20-preview-probe.md';
        const probeSrcName = '.q20-preview-probe.src';
        const probeMdPath = path.join(ws.cwd, probeMdName);
        const probeSrcPath = path.join(ws.cwd, probeSrcName);
        fs.writeFileSync(probeMdPath, '# probe\nQ20-PREVIEW-PROBE\n', 'utf8');
        fs.writeFileSync(probeSrcPath, 'not previewable\n', 'utf8');
        createdFiles.push(probeMdPath, probeSrcPath);

        const resWsMd = await httpRequest(`/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent(probeMdName)}`);
        if (resWsMd.status !== 200) {
          throw new Error(`/api/file md expected 200, got ${resWsMd.status}: ${resWsMd.rawText.slice(0, 120)}`);
        }
        if (String(resWsMd.headers['content-type'] || '').indexOf('text/plain') !== 0) {
          throw new Error(`/api/file md content-type mismatch: ${resWsMd.headers['content-type']}`);
        }
        if (resWsMd.rawText.indexOf('Q20-PREVIEW-PROBE') === -1) throw new Error('/api/file md body mismatch');

        // 非白名单扩展：415（工作区内真实存在但不允许预览）
        const resWsSrc = await httpRequest(`/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent(probeSrcName)}`);
        if (resWsSrc.status !== 415) throw new Error(`/api/file non-whitelisted ext must be 415, got ${resWsSrc.status}`);
        // P0 回归（安全评审 F1）：`name` 别名不得把非白名单文件放行
        const probeSecretName = '.q20-preview-probe.secret';
        const probeSecretPath = path.join(ws.cwd, probeSecretName);
        fs.writeFileSync(probeSecretPath, 'Q20-SECRET-PROBE-DO-NOT-SERVE\n', 'utf8');
        createdFiles.push(probeSecretPath);
        const resSecretPlain = await httpRequest(`/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent(probeSecretName)}`);
        if (resSecretPlain.status !== 415) {
          throw new Error(`/api/file secret file without alias must be 415, got ${resSecretPlain.status}`);
        }
        const resSecretAlias = await httpRequest(
          `/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent(probeSecretName)}&name=a.txt`,
        );
        if (resSecretAlias.status !== 415) {
          throw new Error(`F1: alias must not unlock a non-whitelisted workspace file, got ${resSecretAlias.status}`);
        }
        if (resSecretAlias.rawText.indexOf('Q20-SECRET-PROBE') !== -1) {
          throw new Error('F1: non-whitelisted workspace file body leaked');
        }

        // 越界：工作区外的绝对路径（/etc/hostname 真实存在）→ 403
        const resEscape = await httpRequest(`/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent('/etc/hostname')}`);
        if (resEscape.status !== 403) throw new Error(`/api/file outside root must be 403, got ${resEscape.status}`);
        // 相对越界：../../ + README.md（若存在）同样 403
        const resRelEscape = await httpRequest(`/api/file?cwd=${encodeURIComponent(ws.cwd)}&path=${encodeURIComponent('../../etc/hostname')}`);
        if (resRelEscape.status !== 403 && resRelEscape.status !== 404) {
          throw new Error(`/api/file relative escape must be 403/404, got ${resRelEscape.status}`);
        }
        // 未注册 cwd → 403
        const resUnreg = await httpRequest(`/api/file?cwd=${encodeURIComponent('/etc')}&path=hostname`);
        if (resUnreg.status !== 403) throw new Error(`/api/file unregistered cwd must be 403, got ${resUnreg.status}`);

        // --- 静态接线：客户端预览模块 + 服务端两条只读通道 ---
        const html = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf8');
        const htmlTokens = [
          '@Q20-FILEPREVIEW-START',
          '@Q20-FILEPREVIEW-END',
          'data-fpchip="1"',
          'function openFilePreview',
          'function closeFilePreview',
          'function fpLocalEchoAttachments',
          'function fpRenderMdRefs',
          'isFilePreviewOpen',
          'file-preview-overlay',
          "'/api/attachment?id='",
          "'/api/file?cwd='",
        ];
        for (const token of htmlTokens) {
          if (html.indexOf(token) === -1) throw new Error(`static/index.html wiring missing: ${token}`);
        }
        const htmlNoModern = [
          [/\bconst\s+\w+\s*=/, 'const'],
          [/=>/, 'arrow function'],
          [/`/, 'template literal'],
        ];
        const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
        const previewSlice = scriptSrc.slice(scriptSrc.indexOf('@Q20-FILEPREVIEW-START'), scriptSrc.indexOf('@Q20-FILEPREVIEW-END'));
        if (previewSlice.length < 1000) throw new Error('file preview script slice not found');
        for (const [re, label] of htmlNoModern) {
          if (re.test(previewSlice)) throw new Error(`ES5 redline in preview module: ${label}`);
        }

        const serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
        const serverTokens = [
          'function extractAttachmentsFromContent',
          'function resolveAttachmentObjectPath',
          'function resolveWorkspacePreviewPath',
          "pathname === '/api/attachment'",
          "pathname === '/api/file'",
          'userMsg.attachments = attachments',
          "path.join(ATTACHMENTS_ROOT, 'objects'",
          "path.join(ATTACHMENTS_ROOT, 'files'",
        ];
        for (const token of serverTokens) {
          if (serverSrc.indexOf(token) === -1) throw new Error(`server.mjs wiring missing: ${token}`);
        }

        return {
          attachmentChannels: ['objects/<sha2>/<sha> image/png 往返', 'files/<sha2>/<sha>/<name> text/plain 往返', 'file-objects 回退'],
          guards: ['400 bad id', '404 unknown id', '415 non-whitelisted', '403 outside workspace', '403 unregistered cwd', '415 workspace non-whitelisted'],
          staticWiring: ['fp-chip/openFilePreview/closeFilePreview', 'local echo', 'markdown image+link chips', 'modal keyboard guard', 'ES5 redline scan'],
          probeWorkspace: ws.cwd,
        };
      } finally {
        for (const file of createdFiles) {
          try { fs.rmSync(file, { force: true }); } catch {}
          // 只回收空目录（逐级 rmdir，遇非空/到达 store 根即停；绝不递归删除共享前缀目录）
          let dir = path.dirname(file);
          for (let depth = 0; depth < 4; depth++) {
            if (dir === storeRoot || !dir.startsWith(storeRoot + path.sep)) break;
            try { fs.rmdirSync(dir); } catch { break; }
            dir = path.dirname(dir);
          }
        }
        for (const dir of createdDirs.reverse()) {
          try { fs.rmdirSync(dir); } catch {} // 仅空目录；绝不递归删除共享前缀目录
        }
      }
    });

    // 15. Message File Preview render logic（客户端纯函数：markdown 卡片口径、转义、静态卡）
    //     直取 @Q20-FILEPREVIEW 模块切片，以桩注入执行，断言不依赖浏览器与网络。
    await runner.run('Message File Preview render logic (pure ES5 chip rules)', async () => {
      const html = fs.readFileSync(path.join(__dirname, 'static/index.html'), 'utf8');
      const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
      const start = scriptSrc.indexOf('/* @Q20-FILEPREVIEW-START');
      const end = scriptSrc.indexOf('/* @Q20-FILEPREVIEW-END */');
      if (start < 0 || end <= start) throw new Error('@Q20-FILEPREVIEW module markers missing');
      const fpSrc = scriptSrc.slice(start, end);

      const escapeHtmlStub = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const plusFormatSizeStub = (n) => {
        if (!(n >= 0)) return '';
        if (n < 1024) return n + 'B';
        if (n < 1024 * 1024) return (Math.round(n / 102.4) / 10) + 'KB';
        return (Math.round(n / 104857.6) / 10) + 'MB';
      };
      // eslint-disable-next-line no-new-func
      const factory = new Function(
        'escapeHtml', 'plusFormatSize', 'formatContent', 'wsSelect', 'inputBox',
        'filePreviewOverlay', 'filePreviewBody', 'filePreviewTitle', 'filePreviewClose',
        'document', 'XMLHttpRequest', 'plusFile', 'currentSessionCwd',
        fpSrc + '\nreturn { fpRenderMdRefs: fpRenderMdRefs, fpChipHtml: fpChipHtml, '
        + 'fpAttachmentsHtml: fpAttachmentsHtml, fpExtOf: fpExtOf, fpIsImage: fpIsImage, '
        + 'fpIsText: fpIsText, fpCanPreview: fpCanPreview };',
      );
      const fp = factory(
        escapeHtmlStub, plusFormatSizeStub, () => '', { value: '' }, null,
        null, null, null, null, { getElementById: () => null }, function () {}, undefined, '',
      );

      // markdown 链接 / 图片：本地可预览扩展名成卡；外链、非白名单、代码段保持字面
      const mdChip = fp.fpRenderMdRefs('[文档](docs/AGENTS.md)');
      if (mdChip.indexOf('data-fppath="docs/AGENTS.md"') === -1) throw new Error('md link chip missing: ' + mdChip);
      if (mdChip.indexOf('data-fpkind="file"') === -1 || mdChip.indexOf('📎') === -1) {
        throw new Error('md link chip shape wrong: ' + mdChip);
      }
      const imgChip = fp.fpRenderMdRefs('![图](A.PNG)');
      if (imgChip.indexOf('data-fpkind="image"') === -1 || imgChip.indexOf('data-fppath="A.PNG"') === -1) {
        throw new Error('uppercase image ext must still preview: ' + imgChip);
      }
      const spaceChip = fp.fpRenderMdRefs('[报告](<docs/my report.md>)');
      if (spaceChip.indexOf('data-fppath="docs/my report.md"') === -1) {
        throw new Error('bracketed spaced path must keep the space: ' + spaceChip);
      }
      const encodedChip = fp.fpRenderMdRefs('[报告](docs/my%20report.md)');
      if (encodedChip.indexOf('data-fppath="docs/my report.md"') === -1) {
        throw new Error('percent-encoded path must decode: ' + encodedChip);
      }
      const extLink = '[外](https://example.com/a.md)';
      if (fp.fpRenderMdRefs(extLink) !== extLink) throw new Error('external link must stay literal');
      const pyLink = '[脚本](tools/x.py)';
      if (fp.fpRenderMdRefs(pyLink) !== pyLink) throw new Error('non-whitelisted ext must stay literal');
      const codeSpan = '<code>![a](docs/AGENTS.md)</code>';
      if (fp.fpRenderMdRefs(codeSpan) !== codeSpan) throw new Error('code-span reference must stay literal');
      // 非文件协议（mailto:/tel:/vscode:）与 #anchor 一律保持字面，绝不产生死卡片
      for (const schemeTarget of ['[m](mailto:a@b.md)', '[t](tel:+1.md)', '[v](vscode:foo.md)', '[a](#sec.md)']) {
        if (fp.fpRenderMdRefs(schemeTarget) !== schemeTarget) {
          throw new Error('scheme/anchor target must stay literal: ' + schemeTarget);
        }
      }
      const attUrl = fp.fpRenderMdRefs('![alt](/api/attachment?id=sha256:aa&kind=image&name=a.png&mediaType=image/png)');
      if (attUrl.indexOf('data-fpid="sha256:aa"') === -1) {
        throw new Error('attachment chip must rebuild the URL from the id: ' + attUrl);
      }
      if (attUrl.indexOf('data-fpsrc=') !== -1) {
        throw new Error('embedded src must never be trusted verbatim: ' + attUrl);
      }
      // P0 回归（安全评审 F2）：内嵌 cwd 的 /api/file 目标不得越权；非白名单路径保持字面
      const crossWsLiteral = '[x](/api/file?cwd=%2Fetc&path=.q20_token&name=a.txt)';
      if (fp.fpRenderMdRefs(crossWsLiteral) !== crossWsLiteral) {
        throw new Error('cross-workspace / non-previewable target must stay literal');
      }
      const wsChip = fp.fpRenderMdRefs('[x](/api/file?cwd=%2Fetc&path=docs%2FAGENTS.md&name=a.md)');
      if (wsChip.indexOf('data-fppath="docs/AGENTS.md"') === -1) {
        throw new Error('api/file chip must keep only the path: ' + wsChip);
      }
      if (wsChip.indexOf('data-fpsrc=') !== -1 || wsChip.indexOf('cwd=') !== -1) {
        throw new Error('api/file chip must not carry an embedded cwd/src: ' + wsChip);
      }

      // 属性注入：名称里的引号必须转义，绝不逃出 data-fpname 属性
      const evil = fp.fpChipHtml({ kind: 'file', name: 'a"onmouseover="alert(1).md', id: 'sha256:ab' });
      if (evil.indexOf('onmouseover="alert') !== -1) throw new Error('attribute injection escaped failed: ' + evil);
      if (evil.indexOf('&quot;onmouseover=&quot;') === -1) throw new Error('expected escaped quotes in chip: ' + evil);

      // 附件卡片：图片带缩略图 + 内容寻址 id；非白名单只作静态标识（不可点）
      const imgAtt = fp.fpAttachmentsHtml([{
        kind: 'image', name: 'a.png', id: 'sha256:' + 'a'.repeat(64), bytes: 100, mediaType: 'image/png',
      }]);
      if (imgAtt.indexOf('img class="fp-thumb"') === -1) throw new Error('image attachment thumb missing: ' + imgAtt);
      if (imgAtt.indexOf('/api/attachment?id=sha256%3A') === -1) throw new Error('attachment url not encoded: ' + imgAtt);
      const staticAtt = fp.fpAttachmentsHtml([{ kind: 'file', name: 'run.py', bytes: 2048 }]);
      if (staticAtt.indexOf('data-fpchip') !== -1) throw new Error('non-previewable attachment must stay static: ' + staticAtt);
      if (staticAtt.indexOf('fp-chip-static') === -1 || staticAtt.indexOf('2KB') === -1) {
        throw new Error('static chip shape wrong: ' + staticAtt);
      }

      // 扩展名口径
      if (fp.fpExtOf('A.MD') !== 'md') throw new Error('fpExtOf must lowercase');
      if (fp.fpExtOf('noext') !== '') throw new Error('fpExtOf no-extension must be empty');
      if (!fp.fpIsImage('x.JPEG')) throw new Error('fpIsImage uppercase jpeg failed');
      if (!fp.fpIsText('notes.Markdown')) throw new Error('fpIsText uppercase markdown failed');
      if (fp.fpCanPreview('x.py')) throw new Error('py must not be previewable');

      return {
        mdChipRules: ['local md/txt -> chip', 'uppercase ext', 'spaced/bracketed path', 'percent-decoded path'],
        literalsKept: ['external url', 'non-whitelisted ext', 'code span'],
        attachmentChips: ['image thumb + content-addressed url', 'non-previewable -> static chip'],
        escaping: ['quote in name stays inside data-fpname'],
      };
    });

    // 16. DSH Process Down / Crash Indicator Contract
    await runner.run('DSH Process Down / Crash Indicator Contract', async () => {
      // 1) /api/dsh/status endpoint works
      const dshStatusRes = await httpRequest('/api/dsh/status');
      if (dshStatusRes.status !== 200 || dshStatusRes.body?.ok !== true) {
        throw new Error(`Expected HTTP 200 with ok:true from /api/dsh/status, got ${dshStatusRes.status}`);
      }
      if (typeof dshStatusRes.body?.dshAlive !== 'boolean') {
        throw new Error('Expected dshAlive boolean in /api/dsh/status response');
      }

      // 2) /api/bootstrap contains dshAlive
      const bootRes = await httpRequest('/api/bootstrap');
      if (bootRes.status !== 200 || typeof bootRes.body?.dshAlive !== 'boolean') {
        throw new Error('Expected dshAlive boolean in /api/bootstrap response');
      }

      // 2.1) Cache-Control header anti-staleness contract
      const bootCc = bootRes.headers?.['cache-control'] || '';
      if (!bootCc.includes('no-store') && !bootCc.includes('no-cache')) {
        throw new Error(`Expected Cache-Control: no-cache/no-store on /api/bootstrap, got "${bootCc}"`);
      }
      const dshCc = dshStatusRes.headers?.['cache-control'] || '';
      if (!dshCc.includes('no-store') && !dshCc.includes('no-cache')) {
        throw new Error(`Expected Cache-Control: no-cache/no-store on /api/dsh/status, got "${dshCc}"`);
      }

      // 3) static assets & CSS validation
      if (!fs.existsSync(path.join(__dirname, 'static', 'error-whale-tail.svg'))) {
        throw new Error('Missing static/error-whale-tail.svg asset');
      }

      const html = fs.readFileSync(path.join(__dirname, 'static', 'index.html'), 'utf8');
      if (!html.includes('welcome-spinner-error')) {
        throw new Error('Missing welcome-spinner-error class in static/index.html');
      }
      if (!html.includes('error-whale-tail.svg')) {
        throw new Error('Missing error-whale-tail.svg reference in static/index.html');
      }
      if (!html.includes('function setDshAliveState(')) {
        throw new Error('Missing setDshAliveState declaration in static/index.html');
      }
      if (!html.includes('/api/dsh/status')) {
        throw new Error('Missing /api/dsh/status polling in static/index.html');
      }

      // 4) DSH status polling must not be blocked by !curCwd (init/welcome screen self-healing)
      // Extract the setInterval polling block
      const pollBlockMatch = html.match(/setInterval\(function\(\)\s*\{([\s\S]*?)\},\s*5000\);/);
      if (!pollBlockMatch) {
        throw new Error('Missing 5000ms polling setInterval in static/index.html');
      }
      const pollBlock = pollBlockMatch[1];
      const dshStatusIdx = pollBlock.indexOf("'/api/dsh/status'");
      const earlyReturnCwdIdx = pollBlock.indexOf('if (!curCwd) return;');
      if (earlyReturnCwdIdx !== -1 && dshStatusIdx !== -1 && earlyReturnCwdIdx < dshStatusIdx) {
        throw new Error('DSH alive polling is trapped behind "if (!curCwd) return;", preventing self-healing on welcome screen');
      }

      return {
        dshStatusEndpoint: true,
        dshAliveInBootstrap: true,
        errorWhaleSvgPresent: true,
        clientWiringVerified: true,
      };
    });

  } catch (err) {
    suiteError = err;
  }

  // 无论成败，回收 mock 宿主进程与临时目录（绝不残留于真实环境）。
  if (mockServer) {
    try { await mockServer.stop(); } catch {}
    mockServer = null;
  }

  const allPassed = runner.printReport();
  if (suiteError) {
    console.error('Suite caught error:', suiteError);
  }
  if (!allPassed || suiteError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal execution error in test-unit.mjs:', err);
  process.exit(1);
});
