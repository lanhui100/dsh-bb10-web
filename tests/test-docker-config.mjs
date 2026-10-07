/**
 * Static syntax & configuration compliance test gate for Docker and decoupling config.
 *
 * Checks:
 * 1. Dockerfile syntax baseline (Node 20+ alpine/slim, EXPOSE 3090, CMD contains server.mjs, etc.)
 * 2. docker-compose.yml port mapping, environment mapping, and volume mounting decoupling (~/.dsh)
 * 3. .env.example presence and coverage of required variables:
 *    DSH_WEB_URL, DSH_HOME, PORT, HOST, ALLOWED_ORIGINS, Q20_AUTH_TOKEN, Q20_COOKIE_SECURE
 * 4. Preserves package.json integrity and scripts.
 *
 * Characteristics: 0 external dependencies (uses native Node.js APIs), fast, non-zero exit on failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const failures = [];

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

console.log('--- 1. Dockerfile Baseline Checks ---');
const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
const dockerfileExists = fs.existsSync(dockerfilePath);
check('Dockerfile exists', dockerfileExists, `Missing file: ${dockerfilePath}`);

if (dockerfileExists) {
  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');

  // Node 20+ base image check (alpine or slim)
  const fromMatch = dockerfileContent.match(/^FROM\s+([^\s\n]+)/im);
  const fromImage = fromMatch ? fromMatch[1] : '';
  const isNode20Plus = /node:(2[0-9]|\d{3,})-(alpine|slim)/i.test(fromImage);
  check(
    'Dockerfile uses Node 20+ (alpine or slim) base image',
    isNode20Plus,
    `Current FROM: ${fromImage || 'none'}`
  );

  // EXPOSE 3090 check
  const hasExpose3090 = /^EXPOSE\s+.*3090/im.test(dockerfileContent);
  check('Dockerfile exposes port 3090', hasExpose3090);

  // WORKDIR check
  const hasWorkdir = /^WORKDIR\s+/im.test(dockerfileContent);
  check('Dockerfile defines WORKDIR', hasWorkdir);

  // CMD runs server.mjs
  const hasCmdServer = /^CMD\s+.*server\.mjs/im.test(dockerfileContent);
  check('Dockerfile CMD executes server.mjs', hasCmdServer);
}

console.log('\n--- 2. docker-compose.yml Checks ---');
const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
const composeExists = fs.existsSync(composePath);
check('docker-compose.yml exists', composeExists, `Missing file: ${composePath}`);

if (composeExists) {
  const composeContent = fs.readFileSync(composePath, 'utf8');

  // Port mapping check (e.g. 3090:3090 or "${PORT:-3090}:3090")
  const mapsPort3090 = /3090:3090|PORT.*:3090/i.test(composeContent);
  check('docker-compose.yml maps port 3090', mapsPort3090);

  // Volume mounting ~/.dsh check
  const mountsDsh = /~?\/?\.dsh|\$\{DSH_HOME.*\}|\.dsh:/i.test(composeContent);
  check('docker-compose.yml decouples and mounts ~/.dsh volume', mountsDsh);

  // Environment variables reference
  const envVarReferences = ['DSH_WEB_URL', 'PORT', 'HOST'];
  for (const envVar of envVarReferences) {
    check(
      `docker-compose.yml references/maps ${envVar}`,
      composeContent.includes(envVar)
    );
  }
}

console.log('\n--- 3. .env.example Checks ---');
const envExamplePath = path.join(ROOT_DIR, '.env.example');
const envExampleExists = fs.existsSync(envExamplePath);
check('.env.example exists', envExampleExists, `Missing file: ${envExamplePath}`);

if (envExampleExists) {
  const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');

  const requiredVars = [
    'DSH_WEB_URL',
    'DSH_HOME',
    'PORT',
    'HOST',
    'ALLOWED_ORIGINS',
    'Q20_AUTH_TOKEN',
    'Q20_COOKIE_SECURE',
  ];

  for (const v of requiredVars) {
    const varPattern = new RegExp(`^\\s*#?\\s*${v}\\s*=`, 'm');
    const isPresent = varPattern.test(envExampleContent);
    check(`.env.example declares ${v}`, isPresent);
  }
}

console.log('\n--- 4. package.json & Original Config Integrity Checks ---');
const pkgPath = path.join(ROOT_DIR, 'package.json');
try {
  const pkgContent = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  check('package.json exists and is valid JSON', true);
  check('package.json scripts.start exists', Boolean(pkgContent.scripts && pkgContent.scripts.start));
  check('package.json scripts.stop exists', Boolean(pkgContent.scripts && pkgContent.scripts.stop));
  check('package.json scripts.test exists', Boolean(pkgContent.scripts && pkgContent.scripts.test));
  check('package.json type is module', pkgContent.type === 'module');
} catch (err) {
  check('package.json integrity', false, err.message);
}

console.log('\n----------------------------------------');
if (failures.length > 0) {
  console.error(`TOTAL FAILURES: ${failures.length}`);
  for (const f of failures) {
    console.error(` - ${f}`);
  }
  process.exit(1);
} else {
  console.log('ALL CONFIG & DOCKER COMPLIANCE CHECKS PASSED');
  process.exit(0);
}
