# Agent Note: 修复欢迎页假就绪导致的快捷键 perceived 无响应

Status: implemented

## Problem

关联前案：`implemented/feature/2026-09-18-welcome-entry-preload-and-loading-indicator.md`（进入即欢迎页 + 后台预热 + loading 指示器）。

线上症状：初始化页面显示"初始化完成"（状态栏`就绪`）后立即按快捷键（W/C 等）无响应，等一段时间自然恢复。诊断结论是**实际初始化没完成**，而非按键丢失：

1. `renderBootstrap`（`static/index.html`）在 `/api/bootstrap` 返回后立即 `setStatus('就绪')`，随后才发起当前工作区 `preloadSessions` + 其余工作区 `preloadAllWorkspaceSessions`（300ms 错峰）。状态栏"就绪"与后台预热脱节——**假就绪**。
2. `/api/sessions` 实测单工作区 0.1s~2.6s（Zstd 目录扫描，服务端单线程阻塞），5 个工作区全量预热期间任何依赖服务端的面板操作都要排队；`openSess` 在缓存未到时只显示"…加载会话中"占位，看起来像按键没反应。
3. `loadSessions` 早退路径（`sessLoading[cwd]` 为真时 `return`）不调用 `done` 回调，若未来有带 `done` 的调用撞上在途请求，`preloadPending` 计数器泄漏，欢迎页 spinner 会卡到 20s 硬兜底才收。

## Decision

在 `static/index.html` 前端（纯 ES5，无服务端改动）做四处联动修复：

1. 首屏诚实状态：`renderBootstrap` 尾部不再先报`就绪`，有当前工作区时报`正在加载会话列表…`并只预取当前工作区；无工作区时才报`就绪`。`loadBootstrap` 成功分支删除多余的 `setStatus('就绪')` 覆盖。
2. 收敛预热策略：删除 `preloadAllWorkspaceSessions` 定义及其在 `renderBootstrap` / `refreshWsList` 中的调用；其余工作区改为 W/C 面板打开时按需拉取（`renderSessTree` / `openSess` 原有逻辑）。当前面板秒开，快捷键立即可用。
3. `loadSessions` 早退补 `done`：`if (sessLoading[cwd]) { if (done) done(); return; }`，计数器永不泄漏。
4. 预热失败给真相：`loadSessions` 非 200 分支在欢迎页空白态报`会话列表加载失败，按 C 重试`，不再静默停留。

## Alternatives considered

- **方案 A：保留全量预热，仅把"就绪"延后到全部工作区归零**：欢迎页 spinner 要转 5×(0.1~2.6s)，首屏长时间不可用；一次只看一个工作区，全量等待得不偿失。
- **方案 B：服务端加速 /api/sessions（缓存、并发 Zstd）**：动服务端扫描链路，风险大；前端收敛已能解决 perceived 卡死，服务端优化留待后续专项。
- **方案 C：快捷键加队列/重试**：掩盖假就绪，用户仍不知系统在忙；诚实状态 + 按需加载更直接。
- **方案 D：保留 preloadAllWorkspaceSessions 作备用**：无消费者即死代码，违反"拒绝怀旧"；删除，决策留档本条。

## Consequences

- 初始化后状态栏诚实显示"正在加载会话列表…"，当前工作区 XHR 回来自动转为"就绪 (N个对话)"（`loadSessions` 成功分支原有逻辑）；W 面板秒开，C 面板最多一次短占位后填实。
- 每次初始化后台开销从 5 个工作区全扫降为 1 个；切非常用工作区后首次开 C 面板有一次现场拉取（实测 0.05~1.3s，job_copilot 级大工作区约 1~2.5s），面板内有"…加载会话中"占位明示。
- 服务端无改动，`/api/bootstrap` 与 `/api/sessions` 协议保持与 `dsh web` 对齐。
- 验证：ES5 门禁（acorn ecmaVersion 5）+ `node test-unit.mjs` 通过；`verify-note.sh` 通过。
