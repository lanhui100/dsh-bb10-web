/**
 * Q20 验收总入口：顺序执行全部套件并聚合退出码。
 * Owner: test-agent（冻结件，Executor 只读）
 *
 *   node tests/acceptance/run-all.mjs
 *     → CORE    (2026-10-16 A1–A7, A10)  契约 §3 主门禁
 *     → HOST    (2026-10-16 A8 真宿主)   环境不具备时显式 SKIP（[RED DEGRADED: ...]）
 *     → BROWSER (2026-10-16 A9 真实页面) 环境不具备时显式 SKIP（[RED DEGRADED: ...]）
 *     → REASONING (2026-10-18 A1–A8 思考强度 + 目录刷新) 契约 .dev-team/contract-wave-2026-10-18.md
 *
 * 退出码语义（绝不伪装成绿）：
 *   0 = 全部 PASS
 *   1 = 存在 FAIL（断言失败 / SEAM-MISSING / 执行异常）
 *   2 = 套件启动失败
 *   3 = 无 FAIL 但存在显式 SKIP(DEGRADED)（真链路不可用）
 * 可选环境变量：Q20_ACCEPT_RUNNING_SID=<sid> 透传给 A8 硬断言模式。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['suite-core.mjs', 'suite-host.mjs', 'suite-browser.mjs', 'suite-reasoning.mjs'];

function runSuite(file) {
  return new Promise((resolve) => {
    console.log('\n════════════ 运行 ' + file + ' ════════════');
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
    child.on('close', (code) => resolve({ file, code: code === null ? 2 : code }));
    child.on('error', (err) => {
      console.error('[' + file + ' 启动失败] ' + err.message);
      resolve({ file, code: 2 });
    });
  });
}

const results = [];
for (const s of SUITES) results.push(await runSuite(s));

console.log('\n════════════ 验收总报告 ════════════');
let failed = 0;
let skipped = 0;
for (const r of results) {
  const tag = r.code === 0 ? '✔ PASS' : (r.code === 3 ? '⏭ SKIP(DEGRADED)' : '✖ FAIL');
  console.log(tag + '  ' + r.file + '  (exit=' + r.code + ')');
  if (r.code === 3) skipped += 1;
  else if (r.code !== 0) failed += 1;
}
const exit = failed > 0 ? 1 : (skipped > 0 ? 3 : 0);
console.log('ACCEPTANCE-ALL SUMMARY: suites=' + results.length + ' failed=' + failed
  + ' skipped=' + skipped + ' exit=' + exit);
process.exit(exit);
