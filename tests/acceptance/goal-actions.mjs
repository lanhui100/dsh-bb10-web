/**
 * B023 验收测试（Owner: test-agent，冻结件，Executor 只读，不得修改）
 * 契约唯一来源：.agents/notes/implemented/feature/2026-11-13-ctrl-o-goal-actions.md §Decision / §32
 * 分级：L2（新增 HTTP 契约 + 正常流 + 异常流 + 对抗畸形 payload + 静态接线断言）
 * 纪律（test-expert）：AAA 结构 / 零假测试律（每例强制 ≥1 真实断言）/ 非零退出 / 无吞异常 /
 *   逐用例 PASS|FAIL / 独立 mock 实例（谁创建谁清理）/ Q20_MOCK_HOST=1 零真实宿主零真实 LLM。
 *
 *   node tests/acceptance/goal-actions.mjs
 *   exit 0 = 全部 PASS；exit 1 = 存在 FAIL（断言失败或执行异常均计入）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from '../../lib/test-mock-host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SID = 'session-b023';                       // 过 isValidSessionId 白名单
const REF = { id: 'goal-1', revision: 1 };         // goal id，非 sessionId（契约 §21）
const BASE_GOAL = { id: 'goal-1', revision: 1, objective: '原目标', phase: 'paused', maxGoalRounds: 8 };

let pass = 0;
let fail = 0;
let caseAsserts = 0;

// 计数式真实断言包装：机器强制「每例至少一条断言」，杜绝纯运行不报错即放行。
function eq(actual, expected, msg) { caseAsserts++; assert.strictEqual(actual, expected, msg); }
function ok(cond, msg) { caseAsserts++; assert.ok(cond, msg); }
function match(str, re, msg) { caseAsserts++; assert.match(str, re, msg); }
function noMatch(str, re, msg) { caseAsserts++; assert.doesNotMatch(str, re, msg); }

async function check(name, fn) {
  caseAsserts = 0;
  try {
    await fn(); // 必须 await：同步 fn() 不会执行 Promise 内断言、且漏掉 rejection（假测试）
    assert.ok(caseAsserts > 0, '零假测试律：用例必须至少一条真实断言 → ' + name);
    console.log('PASS ' + name + ' (asserts=' + caseAsserts + ')');
    pass++;
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) console.log('    ' + err.stack.split('\n').slice(1, 3).join('\n    '));
    fail++;
  }
}

async function req(base, body, raw) {
  const r = await fetch(base + '/api/session/goal/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
    signal: AbortSignal.timeout(12000), // 防未知路径挂起导致红相无输出
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** 契约 §25 冻结接缝：Q20_MOCK_HOST_GOAL 初始化 mockGoalState；每例独立实例，finally 必清理。 */
async function withMock(goalInit, fn) {
  const mock = await startMockServer({ env: { Q20_MOCK_HOST_GOAL: JSON.stringify(goalInit) } });
  try { return await fn(mock); }
  finally { await mock.stop(); }
}

/** 合法基础 body（不含 objective 时由各用例显式补，避免 clear/resume 携带多余字段的契约歧义）。 */
function baseBody(mock, patch) {
  return {
    cwd: mock.workspaceRoot,
    sessionId: SID,
    action: 'edit',
    ref: { ...REF },
    ...(patch || {}),
  };
}

try {
  // ① edit 正常流：objective 变更 + revision 递增（契约 §24 / §32①）
  await withMock(BASE_GOAL, async (mock) => {
    await check('① edit 正常流：objective 变更 + revision+1', async () => {
      // Arrange
      const body = baseBody(mock, { action: 'edit', objective: '新目标' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 200, 'edit HTTP 状态');
      eq(r.body && r.body.ok, true, 'edit ok===true');
      ok(r.body && r.body.goal && typeof r.body.goal === 'object', 'edit 响应含 goal 对象');
      eq(r.body.goal.objective, '新目标', 'edit objective 变更');
      eq(r.body.goal.revision, 2, 'edit revision = ref.revision + 1');
    });
  });

  // ② clear 正常流：{ok:true, goal:null}（契约 §24 tombstone / §32②）
  await withMock(BASE_GOAL, async (mock) => {
    await check('② clear 正常流：goal===null', async () => {
      // Arrange
      const body = baseBody(mock, { action: 'clear' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 200, 'clear HTTP 状态');
      eq(r.body && r.body.ok, true, 'clear ok===true');
      eq(r.body && r.body.goal, null, 'clear 返回 null（tombstone 由宿主落盘）');
    });
  });

  // ③ resume 正常流：phase 变 active + revision+1（契约 §24 / §32③）
  await withMock(BASE_GOAL, async (mock) => {
    await check('③ resume 正常流：phase=active + revision+1', async () => {
      // Arrange（初态 phase='paused'）
      const body = baseBody(mock, { action: 'resume' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 200, 'resume HTTP 状态');
      eq(r.body && r.body.ok, true, 'resume ok===true');
      ok(r.body && r.body.goal && typeof r.body.goal === 'object', 'resume 响应含 goal 对象');
      eq(r.body.goal.phase, 'active', 'resume phase 变 active');
      eq(r.body.goal.revision, 2, 'resume revision = ref.revision + 1');
    });
  });

  // ④ 无 goal / 非法 sessionId → 400（契约 §15 §16 / §32④）
  await withMock(null, async (mock) => {
    await check('④ 无 goal → 400 goal/not-found', async () => {
      // Arrange
      const body = baseBody(mock, { action: 'edit', objective: '合法目标' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 400, '无 goal 必须 400（不得向宿主发 RPC）');
      eq(r.body && r.body.ok, false, '无 goal ok===false');
      eq(r.body && r.body.code, 'goal/not-found', '无 goal code');
    });
  });
  await withMock(BASE_GOAL, async (mock) => {
    await check('④ 非法 sessionId → 400', async () => {
      // Arrange
      const body = baseBody(mock, { action: 'edit', sessionId: '../etc/passwd', objective: '合法目标' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 400, '非法 sessionId（含 ..）必须 400');
      eq(r.body && r.body.ok, false, '非法 sessionId ok===false');
      eq(r.body && r.body.code, 'session/invalid-id', '非法 sessionId 独立 code（与无 goal 分开）');
    });
  });

  // ⑤ 陈旧 revision → 宿主 CAS 冲突（契约 §23 §14 / §32⑤）
  await withMock(BASE_GOAL, async (mock) => {
    await check('⑤ 陈旧 revision → 200 ok:false + GOAL_STALE_REVISION', async () => {
      // Arrange
      const body = baseBody(mock, { action: 'edit', ref: { id: 'goal-1', revision: 999 }, objective: '合法目标' });
      // Act
      const r = await req(mock.base, body);
      // Assert
      eq(r.status, 200, '宿主业务拒绝走 200 + ok:false');
      eq(r.body && r.body.ok, false, '陈旧 revision ok===false（非 200 成功）');
      eq(r.body && r.body.code, 'GOAL_STALE_REVISION', 'CAS 冲突 code 明确');
      eq(typeof (r.body && r.body.error), 'string', '陈旧 revision error 为 string');
    });
  });

  // ⑥ 畸形 payload 一律 400（契约 §15 / §32⑥）——逐条 check，禁止 for 循环吞异常
  await withMock(BASE_GOAL, async (mock) => {
    await check('⑥a 空/纯空白 objective → 400', async () => {
      const r = await req(mock.base, baseBody(mock, { action: 'edit', objective: '   ' }));
      eq(r.status, 400, '纯空白 objective 必须 400');
      eq(r.body && r.body.ok, false, '纯空白 objective ok===false');
    });
    await check('⑥b 负/零 revision → 400（校验错，非 CAS 冲突）', async () => {
      const r = await req(mock.base, baseBody(mock, { action: 'edit', ref: { id: 'goal-1', revision: 0 }, objective: '合法目标' }));
      eq(r.status, 400, 'revision=0 必须 400');
      eq(r.body && r.body.ok, false, 'revision=0 ok===false');
    });
    await check('⑥c 未知 action → 400', async () => {
      const r = await req(mock.base, baseBody(mock, { action: 'bogus', objective: '合法目标' }));
      eq(r.status, 400, '未知 action 必须 400');
      eq(r.body && r.body.ok, false, '未知 action ok===false');
    });
    await check('⑥d 非法 JSON → 400', async () => {
      const r = await req(mock.base, undefined, '{bad json');
      eq(r.status, 400, '非法 JSON 必须 400');
      eq(r.body && r.body.ok, false, '非法 JSON ok===false');
    });
    await check('⑥e 缺字段（无 ref）→ 400', async () => {
      const body = { cwd: mock.workspaceRoot, sessionId: SID, action: 'edit', objective: '合法目标' };
      const r = await req(mock.base, body);
      eq(r.status, 400, '缺字段必须 400');
      eq(r.body && r.body.ok, false, '缺字段 ok===false');
    });
    await check('⑥f 未知字段 → 400', async () => {
      const r = await req(mock.base, baseBody(mock, { action: 'edit', objective: '合法目标', bogusField: 1 }));
      eq(r.status, 400, '未知字段必须 400');
      eq(r.body && r.body.ok, false, '未知字段 ok===false');
    });
  });

  // ⑦⑧ 静态契约断言：裸 O 面板内三动作快捷键 / H 帮助表 / O 面板目标行 / README（契约 §26 §29 §32⑦⑧）
  await check('⑧ 静态接线：三动作按钮+编辑框+确认模态+H 表+README+裸 O', async () => {
    // Arrange
    const html = fs.readFileSync(path.join(REPO, 'static', 'index.html'), 'utf8');
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    // Assert：三个动作的面板内按钮 id（契约 §26 精确 id）
    match(html, /goal-action-edit/, '按钮 id goal-action-edit');
    match(html, /goal-action-clear/, '按钮 id goal-action-clear');
    match(html, /goal-action-resume/, '按钮 id goal-action-resume');
    // Assert：面板内快捷键文案 E/D/G（契约 §26 精确文本）
    match(html, /修改 \[E\]/, '修改 [E] 文案');
    match(html, /删除 \[D\]/, '删除 [D] 文案');
    match(html, /继续 \[G\]/, '继续 [G] 文案');
    // Assert：编辑框 / 删除二次确认模态（契约 §26 / §32⑦ 前端锚点）
    match(html, /goal-edit-input/, '隐藏编辑框 goal-edit-input');
    match(html, /goal-clear-confirm/, '删除确认模态 goal-clear-confirm');
    // Assert：面板内 E=69 / D=68 / G=71 键码（契约 §27）
    match(html, /code\s*===\s*69/, 'E 键码 69');
    match(html, /code\s*===\s*68/, 'D 键码 68');
    match(html, /code\s*===\s*71/, 'G 键码 71');
    // Assert：H 帮助表条目 + 状态面板 hint（契约 §29）
    match(html, /O 面板内 E 修改/, 'H 帮助表 O 面板内条目');
    match(html, /G 继续目标/, 'H 帮助表 G 继续目标文案');
    // Assert：O 面板目标行渲染存在（用户验收要求）
    match(html, /当前目标/, 'O 面板「当前目标」行渲染');
    // Assert：README 第 19 行 O 条目内追加文案（契约 §29）
    match(readme, /Inside: E edit \/ D delete \/ G resume goal/, 'README O 条目 Inside 文案');
    // Assert：裸 O 键存在，且不得绑定 Ctrl+O 组合（契约 §Problem / §32⑧）
    match(html, /code\s*===\s*79/, '裸 O 键（keyCode 79）');
    noMatch(html, /ctrlKey\s*&&\s*code\s*===\s*79/, '不得存在 Ctrl+O 绑定');
  });
} catch (err) {
  // 逃逸异常同样记为 FAIL（不放行），保证逐用例输出与 exit 1。
  console.log('FAIL [harness 执行异常]: ' + (err && err.message ? err.message : String(err)));
  if (err && err.stack) console.log(err.stack);
  fail++;
}

console.log('\ntotal=' + (pass + fail) + ' pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
