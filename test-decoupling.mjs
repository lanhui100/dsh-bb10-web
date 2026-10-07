/**
 * Decoupling Charter Gate for dsh-bb10-web
 *
 * Machine-checkable promises from the constitution (root AGENTS.md §六 item 0,
 * "消费边界与解耦声明 / Decoupled Consumer"; ADR: .agents/notes/implemented/
 * process/2026-09-19-dsh-consumer-decoupling-charter.md):
 *
 *   1. The charter clause exists structurally in AGENTS.md §六 item 0.
 *   2. No git submodules (`git submodule status` output is empty).
 *   3. No `.gitmodules` file.
 *   4. No vendored `deepseek-harness` directory/file/symlink inside repository.
 *
 * Scopes relying on review / higher-tier tests:
 *   - Exclusive capability pipelines & storage mirror exemptions boundary ("靠 review").
 *   - Upstream alignment semantic correctness ("靠 review + node test-suite.mjs").
 *
 * Characteristics: 0 dependencies, 0 network, no live server required.
 * Non-zero exit = FAIL.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

function skip(name, reason) {
  console.log(`SKIP  ${name} (${reason})`);
}

// 1. Charter clause structural presence in AGENTS.md §六 item 0
const agentsPath = path.join(__dirname, 'AGENTS.md');
let constitution = '';
try {
  constitution = fs.readFileSync(agentsPath, 'utf8');
  check('AGENTS.md readable', true);
} catch (err) {
  check('AGENTS.md readable', false, err.message);
}

if (constitution) {
  const startIdx = constitution.search(/^##\s+六[、\.\s]/m);
  let sectionSix = '';
  if (startIdx !== -1) {
    const rest = constitution.slice(startIdx + 4);
    const nextRel = rest.search(/^##\s+/m);
    sectionSix = nextRel === -1 ? constitution.slice(startIdx) : constitution.slice(startIdx, startIdx + 4 + nextRel);
  }
  check('AGENTS.md section 六 exists', Boolean(sectionSix));

  const hasItemZero = /^0\.\s+\*\*消费边界与解耦声明/m.test(sectionSix);
  check('section 六 item 0 heading present', hasItemZero);

  const clauseMarkers = [
    '完全解耦',
    '两条管道',
    '可达性判定与租约互斥',
    '存储与凭据镜像豁免',
    '上游对齐义务',
    '预发布阶段',
  ];
  for (const marker of clauseMarkers) {
    check(`charter section 六 contains "${marker}"`, sectionSix.includes(marker));
  }
}

// 2. No git submodules
let submoduleOut = '';
let submoduleSkipped = false;
try {
  submoduleOut = execSync('git submodule status', {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
} catch (err) {
  const msg = String(err.message || '');
  if (/not a git repository/i.test(msg) || /git: not found/i.test(msg)) {
    skip('no git submodules', 'environment without git repository metadata');
    submoduleSkipped = true;
  } else {
    submoduleOut = `git submodule status failed: ${msg}`;
  }
}
if (!submoduleSkipped) {
  check('no git submodules', submoduleOut === '', submoduleOut || undefined);
}

// 3. No .gitmodules file
check('no .gitmodules file', !fs.existsSync(path.join(__dirname, '.gitmodules')));

// 4. No vendored deepseek-harness directory, file or symlink inside repository
const bannedItems = [];
function scan(dir, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    failures.push(`read directory failed at ${dir}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    if (/deepseek[-_]?harness/i.test(entry.name)) {
      bannedItems.push(fullPath);
    }

    if (entry.isDirectory()) {
      scan(fullPath, depth + 1);
    }
  }
}

scan(__dirname, 0);
check(
  'no vendored deepseek-harness items',
  bannedItems.length === 0,
  bannedItems.join(', ') || undefined
);

// 5. Plus 上传无第三路径：server.mjs 只许透传宿主 uploadFileBinary / session/prompt，
//    禁止自建 SDK 直存与落盘（saveFile/saveFileStream/admitEncodedFile/workspace 直写）。
//    机器到不了的 prompt 挂载语义正确性靠 review + node test-unit.mjs。
let serverSrc = '';
try {
  serverSrc = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
  check('server.mjs readable for upload-path gate', true);
} catch (err) {
  check('server.mjs readable for upload-path gate', false, err.message);
}
if (serverSrc) {
  const allowedUploadMarkers = ['/api/session/uploadFileBinary', 'proxyUploadToHost', '/api/session/upload'];
  for (const marker of allowedUploadMarkers) {
    check(`upload proxy references "${marker}"`, serverSrc.includes(marker));
  }
  const bannedUploadCalls = ['saveFileStream(', 'admitEncodedFile(', 'admitPromptContent(', '.attachments.', 'ctx.fileUpload'];
  for (const banned of bannedUploadCalls) {
    check(`no third-path upload call "${banned}"`, !serverSrc.includes(banned), banned);
  }
}

// 6. 消息内文件预览（/api/attachment、/api/file）是只读镜像通道：
//    官方附件存储与工作区文件只许读，绝不在服务端写盘/建目录/删除。
//    ADR: .agents/notes/implemented/feature/2026-09-23-message-file-fullscreen-preview.md
if (serverSrc) {
  const previewStart = serverSrc.indexOf("pathname === '/api/attachment'");
  const previewEnd = serverSrc.indexOf("pathname === '/api/session/stats'");
  const previewSlice = (previewStart >= 0 && previewEnd > previewStart)
    ? serverSrc.slice(previewStart, previewEnd)
    : '';
  check('file preview routes slice present', previewSlice.length > 200, `len=${previewSlice.length}`);
  const bannedWrites = ['writeFileSync', 'appendFileSync', 'createWriteStream', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync'];
  for (const banned of bannedWrites) {
    check(`preview mirror is read-only (no ${banned})`, previewSlice.indexOf(banned) === -1, banned);
  }
}

if (failures.length > 0) {
  console.error(`\nDECOUPLING GATE FAIL: ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nDECOUPLING PASS: charter clause structurally present, no submodule, no vendored dsh.');
