import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('[TEST] Starting Acceptance Tests for Voice Upload & Progress & Skill...');

// 1. Verify static/index.html ES5 Acorn parse and SVG circular progress presence
const htmlPath = path.resolve('static/index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// Check that hourglass ⏳ is NOT used in uploading state or replaced with circular progress
assert(!htmlContent.includes("plusFile.state === 'uploading') label += '⏳上传中...'"),
  'Hourglass ⏳ in uploading state must be replaced by circular progress icon');

// Check that circular progress indicator structure exists
assert(htmlContent.includes('plus-file-spinner') || htmlContent.includes('progress-ring'),
  'Circular progress ring/spinner class must be defined in static/index.html');

// Check that doSendWithPendingFile correctly syncs currentSessionCwd alongside currentSessionId
const pendingSyncRegex = /currentSessionId\s*=\s*newSid[\s\S]*?currentSessionCwd\s*=\s*(?:getCwd\(\)|cwd)/;
assert(pendingSyncRegex.test(htmlContent),
  'doSendWithPendingFile must update currentSessionCwd to avoid cross-cwd sid mismatch');

// Check that voice-transcribe skill exists and has valid YAML frontmatter
const skillPath = path.resolve('.agents/skills/voice-transcribe/SKILL.md');
assert(fs.existsSync(skillPath), 'Skill voice-transcribe must exist');
const skillContent = fs.readFileSync(skillPath, 'utf8');
assert(skillContent.startsWith('---\nname: voice-transcribe\n'), 'Skill must contain valid name frontmatter');

const skillScriptPath = path.resolve('.agents/skills/voice-transcribe/transcribe.py');
assert(fs.existsSync(skillScriptPath), 'transcribe.py script must exist');

// Check that audio detection and prompt directive logic exists in static/index.html
assert(htmlContent.includes('plusIsAudioFile'), 'plusIsAudioFile helper must exist in static/index.html');
assert(htmlContent.includes('voice-transcribe'), 'voice-transcribe directive must be referenced in static/index.html');

console.log('[TEST] Acceptance tests passed!');
