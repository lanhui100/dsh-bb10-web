/**
 * Q20 测试专用：拉起高隔离 mock 宿主服务器（Q20_MOCK_HOST=1）。
 *
 * 目的（2026-09-30 变更：真链路测试改 mock，见 .agents/notes/implemented/testing/…）：
 *   - 不再触碰真实 DSH Web (3080) 宿主 RPC；
 *   - 不发起任何真实 LLM 调用（服务端 mock 分支合成回复 + 本地 zstd 转录）；
 *   - 工作区探针目录落在临时根（Q20_MOCK_HOME），绝不污染真实 ~/；
 *   - 注册表落在临时 DSH_HOME，绝不污染真实 ~/.dsh/storages/workspace.json。
 *
 * 返回 { base, home, workspaceRoot, registryFile, stop() }。
 * 该模块只读外部环境；本仓库消费侧见 test-unit.mjs / test-suite.mjs。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function rawGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

/**
 * 启动一台 mock 宿主 Q20 服务（独立端口 + 临时 DSH_HOME + 临时工作区根）。
 * 轮询 /healthz 就绪后返回句柄；超时抛错并回收。
 */
export async function startMockServer(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'q20-mock-dsh-'));
  const workspaceRoot = path.resolve(opts.workspaceRoot || path.join(home, 'mock-workspace-root'));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const dshHome = path.join(home, 'dsh-home');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DSH_HOME: dshHome,
      DSH_WEB_URL: 'http://127.0.0.1:3080',
      Q20_MOCK_HOST: '1',
      Q20_MOCK_HOME: workspaceRoot,
      ...(opts.env || {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      logs += d.toString();
      if (logs.length > 12000) logs = logs.slice(-12000);
    });
  }

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await rawGet(base + '/healthz', 2000);
      if (r.ok) {
        return {
          base,
          home,
          dshHome,
          workspaceRoot,
          registryFile: path.join(dshHome, 'storages', 'workspace.json'),
          async stop() {
            try { child.kill('SIGTERM'); } catch {}
            await new Promise((r2) => setTimeout(r2, 150));
            try { child.kill('SIGKILL'); } catch {}
            try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
          },
        };
      }
    } catch {
      // keep polling
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  throw new Error('mock host server failed to start: ' + (logs.slice(-1500) || '(no stderr)'));
}
