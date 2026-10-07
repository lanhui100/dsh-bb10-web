# DSH BlackBerry 10 Lightweight Web Client

English | [简体中文](README.zh.md)

A dedicated, lightweight Web client and companion service tailored for the **BlackBerry 10 (BB10)** built-in browser and legacy mobile browsers, powered by DeepSeek Harness (DSH).

---

## Key Features

1. **Tailored for BlackBerry 10 (BB10) browsers**:
   - **Strict ES5 & Classic CSS**: Zero modern framework overhead, 100% compatible with BlackBerry 10 OS native WebKit browser.
   - **720×720 Square Screen Layout**: Single-row collapsible top bar (height 32px), maximizing vertical reading space.
   - **Physical Full Keyboard Navigation**:
     - `W`: Toggle fullscreen Workspace modal (inside: `A` adds under home, `D` removes with confirm unregister-only; trailing Ungrouped group; switching auto-opens the Session list)
     - `C`: Enter the all-workspaces "running" session list (every in-progress session; a panel you opened with `C` closes again on `C`, while a panel auto-opened after a workspace switch re-enters the running list on `C` instead of closing; inside: `V` cycles 4 views incl. Ungrouped, `A` archives selected)
     - `M`: Toggle fullscreen Model modal (grouped by Favorites and Provider; `F` to toggle favorite)
     - `P`: Toggle fullscreen Permission modal
     - `O`: Toggle fullscreen Session Status modal (Workspace, session, current goal, permission, mode, model, send mode, turns/steps, token speed, and token stats; bottom-right 💬 ring turns red while a goal is active)
     - `Q`: Toggle running-send mode: queue / steer (toast feedback); follow-ups dock at the bottom queue dock before execution, entering the message stream only when actually executed
     - `Z`: Revoke currently queued follow-up message and restore to composer (aligns with dsh queue remove)
     - `R`: Refresh the active panel (Session / Workspace / Status); send "继续" in conversation stream when not running
     - `T`: Scroll to top
     - `B`: Scroll to bottom
     - `Space` / `Shift+Space`: Page down / Page up
     - `I` or `/`: Focus input box
     - `✕` button: Click top-right close button or chat background to collapse composer
     - `Esc`: Blur input / Stop ongoing streaming (PC browser fallback)
     - `X`: Stop the running session with one key (only effective while a session is running)
     - `E`: Open/Enter the first top banner notification session
     - `D`: Dismiss the first top banner notification
     - `N`: Start new session
     - `V`: In Session panel, cycle views: current workspace -> all running -> all pending -> Ungrouped
     - `A`: Archive current/selected session (panel: archives J/K-selected; auto-opens Session list)
     - `H`: Shortcut cheatsheet
     - `Enter`: Send message, `Shift+Enter`: New line
2. **Multi-turn Chat & Smart Session Titles**:
   - Automatically extracts the user's first prompt as session title.
   - Built-in multi-frame concatenated Zstandard decompression for session history.
3. **Legacy WebKit Memory & CPU Protection**:
   - DOM Windowing (defaults to recent 20 messages with a smooth "load earlier" pagination button).
   - 70ms streaming throttle to prevent CPU freeze on old dual-core processors.
4. **Tool Execution & Thinking Visibility (turn-level fold)**:
   - Aligned with dsh web turn-process: after each turn ends, thinking cards, intermediate agent messages and tool calls collapse into a single aggregated disclosure row (`N tool calls · N messages`; thought-only turns read "已思考"), keeping the final answer visible.
   - Single process items (e.g. a lone tool call) are not folded; the lazy-loading window aligns to turn boundaries so fold counts complete as earlier history loads, and expanded state survives re-renders.
   - Opening a long session silently auto-fills the window up to the current turn's user message (no repeated "load more" clicks), and the view anchors at that prompt so the top-down reading order "user message → disclosure row → final answer" is shown at once.
   - Tool calls (bash/read/grep/etc.) and deep thinking still render as individually collapsible capsules (arguments/output collapsed by default).
5. **Agent Status & Error Visibility**:
   - Color-coded status line: running (green) / stopped (orange) / done (blue) / error (red).
   - DSH backend errors shown in full (auth / rate-limit / timeout / upstream), network-offline distinguished from server errors, with one-key retry (`R`) on the main view; `R` inside the Session/Workspace/Status panels refreshes immediately (no refresh buttons).
6. **Interactive Convenience**:
   - One-click stop/cancel during streaming (`■ Stop`).
   - One-click copy (`execCommand('copy')` fallback) and regenerate button per message.
   - Fork from any settled reply into a new conversation (fork icon next to copy under each assistant reply, or `F` key; backed by upstream `session/fork` cutting at that turn).
   - Click-to-preview files in the message stream: uploaded image/txt/md attachments and explicit markdown image / local-file references (`![…](…)`, `[…](…md)`) render as compact chips; tapping one opens a fullscreen preview (decoded image, raw `<pre>` text, or rendered Markdown) closed with the top-right `✕` (Esc only as a PC fallback).
7. **New-Chat Entry & Data Warm-up**:
   - Opening the app always lands on the "探索未至之境" (Explore the Unknown) new-chat welcome page with the composer dialog collapsed (only the bottom-right 💬 trigger).
   - A lightweight animated loading indicator (spinner + rotating status phrases) under the title signals that data is being prepared.
   - Workspaces and session lists preload lazily in the background on entry, so the Workspace (`W`) and Session (`C`) panels open instantly with no long waits.

---

## Architecture & Decoupling

The **normative contract** (decoupling declaration, two consumption pipes, reachability & lease mutual exclusion, storage mirroring exemptions, and upstream alignment duty) lives in root `AGENTS.md` §六 "dsh 消费边界与对齐准则"; this section keeps only operational facts:

- **Git-level independence**: This is a sibling standalone Git repository — you can freely `git pull` or `rebase` in `deepseek-harness` without merge conflicts; runtime behavior and interfaces strictly follow the upstream alignment duty.
- **Configurable**: Points to the external DSH checkout via `DSH_ROOT` environment variable (defaults to `../deepseek-harness`).
- **Official conversation attribution & fallback**: When the DSH Web host (port 3080) is reachable, conversations are driven through the host's RPC surface (HTTP RPC and `/api/remote.mux` stream carrier) with official attribution written by the host; only when the host is unreachable (connection refused, timeout, 502/503) does the service fall back to the external base's SDK in-process engine with an atomic `workspace.json` mirror write.
- **Machine gate**: `node test-decoupling.mjs` (wired into `pnpm test` and `test:all`) — verifies the charter clause is present, no submodules, no vendored dsh; non-zero exit means failure.

---

## Quick Start & Testing Strategy

### Docker Compose (One-Click Launch)

```bash
# Copy and configure environment variables
cp .env.example .env

# Build and start container in background
docker compose up -d

# Check service logs
docker compose logs -f
```

> **Copy-paste prompt for an AI agent** (paste into any agent chat to auto-provision this service):
> ```text
> 请在此仓库根目录执行以下操作，一键拉起 dsh-bb10-web 服务：
> 1) 若不存在 .env，执行 `cp .env.example .env`；按需修改 .env 中的
>    DSH_WEB_URL（上游 DeepSeek Harness Web 地址，Docker 内默认
>    http://host.docker.internal:3080）、ALLOWED_ORIGINS（反代域名）、
>    Q20_AUTH_TOKEN（可选鉴权令牌，≥16 字符）等解耦配置项。
> 2) 执行 `docker compose up -d --build` 构建并后台启动；
> 3) 执行 `docker compose ps` 确认容器 healthy/running；
> 4) 执行 `curl -f http://127.0.0.1:3090/healthz` 确认健康检查返回 200；
> 5) 汇报容器状态、健康检查结果与服务访问地址。
> 不要修改 server.mjs、package.json 或既有的 systemd 部署文件。
> ```

### Native / Local Scripts

```bash
# Start the companion service (default port 3090)
./start.sh

# Stop the service
./stop.sh

# 1. Fast local unit & contract tests (0 tokens, 0 session pollution, pure local assertion)
pnpm test          # = node test-decoupling.mjs && node test-unit.mjs

# 2. End-to-end regression suite (default: high-isolation MOCK host — 0 real LLM,
#    0 real host RPC, 0 workspace/session residue; sandbox + local transcripts)
pnpm run test:live # or node test-suite.mjs
#    Real-link (live LLM + real host) requires explicit opt-in and a running
#    real 3090 service: Q20_LIVE=1 node test-suite.mjs

# 3. Browser E2E for message file preview (needs a running service + Playwright:
#    `npm i -D playwright`, or Q20_PLAYWRIGHT=/abs/path/to/playwright/index.mjs)
pnpm run test:preview
```

Open `http://127.0.0.1:3090` in the BlackBerry 10 (BB10) browser to start chatting!

---

## Production & Availability

- **Systemd supervision**: use the generic template in `deploy/dsh-bb10-web.service` (requires `/etc/default/dsh-bb10-web` env file; set `DSH_WEB_URL`, `DSH_ROOT`, etc. there). Enable with `sudo cp deploy/dsh-bb10-web.service /etc/systemd/system/ && sudo systemctl enable --now dsh-bb10-web`.
- **Liveness probe**: `curl --noproxy '*' http://127.0.0.1:3090/healthz` → `{ ok: true }` (unauthenticated, UA-agnostic; must sit before the auth/UA gateway).
- **Triage entry**: `journalctl -u dsh-bb10-web` (`[FATAL]`/`[BIND]` lines); loopback-only bind ⇒ public Ingress 502.
