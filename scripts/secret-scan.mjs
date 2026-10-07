#!/usr/bin/env node
/**
 * Secret / sensitive-content scan gate for commits and pushes.
 *
 * Usage:
 *   node scripts/secret-scan.mjs                 # scan staged changes + worktree for patterns
 *   node scripts/secret-scan.mjs --all           # scan the entire indexed tree
 *   node scripts/secret-scan.mjs --reachable     # scan everything reachable from HEAD
 *
 * Exit code: 0 = clean, 1 = violation found.
 *
 * Pattern families:
 *   A. Credential tokens (GitHub/OpenAI/AWS/GCP/private keys)
 *   B. Hard-coded absolute home paths + internal hostnames/IPs (decoupling leak)
 *   C. Paths/names of internal-only operational assets that must never be published
 *   D. Local-only files tracked accidentally (via --tracked-internal)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MODE = process.argv.includes('--all') ? 'all' : process.argv.includes('--reachable') ? 'reachable' : 'staged';

const CRED_PATTERNS = [
  // GitHub tokens (both historic gho_/ghp_/ghs_ and new github_pat_)
  /\b(gh[opsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  // OpenAI-style sk- keys
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // AWS access key
  /\bAKIA[0-9A-Z]{16}\b/,
  // GCP service-account private key header
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  // Generic credential assignments with real-looking values
  /(Q20_AUTH_TOKEN|AUTH_TOKEN|API_KEY|APITOKEN|ACCESS_TOKEN|SECRET_KEY)\s*[:=]\s*['"]?[A-Za-z0-9._\-]{16,}/,
];

const INTERNAL_PATTERNS = [
  // Absolute home dirs leaking local topology (decoupling violation)
  /\/home\/[a-zA-Z0-9_.-]+\//,
  // Internal-only hostnames / one-off LAN IPs (example IPs are exempt below)
  /\b(bb\.ponyjob\.top|tokens\.ponyjob\.top|100\.95\.193\.103|192\.168\.101\.\d{1,3})\b/,
  /\btailscale\b/i,
  // Local toolchain-only absolute module paths
  /\/\.npm-global\//,
  // Internal-only project dirs
  /\/q20-sync\//,
  /\/ponyllm\//,
  /\/job_copilot\//,
];

const INTERNAL_TRACKED_PATHS = [
  /^\.redteam\//,
  /^k8s-q20-ingress\.yaml$/,
  /^dsh-q20-web\.service$/,
  /^dsh-q20-watchdog\.service$/,
  /^q20-sync-8888\.service$/,
  /^scripts\/configure-edgeone-q20\.sh$/,
  /^scripts\/sync-cert-to-edgeone\.py$/,
  /^scripts\/repro-status-bug\.mjs$/,
];

function listTargetFiles() {
  if (MODE === 'all') {
    // entire tracked tree (most strict; used by pre-push)
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  if (MODE === 'reachable') {
    return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  // staged: diff against HEAD (or empty tree on first commit)
  try {
    void execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

const files = listTargetFiles();
const violations = [];

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;

  // D. internal-only tracked paths
  if (INTERNAL_TRACKED_PATHS.some((re) => re.test(rel))) {
    violations.push({ file: rel, rule: 'D-internal-path', counterexample: `internal-only asset must not be tracked: ${rel}` });
    continue;
  }

  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue; // binary
  }
  const isBinary = content.includes('\u0000');
  if (isBinary) continue;

  for (const re of CRED_PATTERNS) {
    const m = content.match(re);
    if (m) {
      violations.push({ file: rel, rule: 'A-credential', counterexample: `credential-like pattern: ${mask(m[0])}` });
      break;
    }
  }
  for (const re of INTERNAL_PATTERNS) {
    const m = content.match(re);
    if (m) {
      violations.push({ file: rel, rule: 'B-internal', counterexample: `internal topology/identity leak: ${mask(m[0])}` });
      break;
    }
  }
}

function mask(s) {
  if (s.length <= 12) return s.replace(/\d/g, '·');
  return s.slice(0, 6) + '…' + s.slice(-4);
}

if (violations.length > 0) {
  console.error(`[secret-scan] ${violations.length} violation(s) in mode=${MODE}`);
  for (const v of violations) {
    console.error(`  ${v.file}: [${v.rule}] ${v.counterexample}`);
  }
  process.exit(1);
}
console.log(`[secret-scan] clean: no sensitive content in ${files.length} file(s) (mode=${MODE})`);
process.exit(0);