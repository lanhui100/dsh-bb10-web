# Agent Note: U 面板空会话回退工作区全部

Status: implemented
Related: .agents/notes/implemented/feature/2026-09-18-multi-agent-subagent-team-board.md
Supersedes: .agents/notes/archived/feature/2026-09-19-u-hotkey-empty-subagent-toast.md（已归档冻结快照，先查后开 toast 逻辑被本次取代）

## Problem

多智能体面板（快捷键 `U`，`static/index.html`）只按当前会话 `sid` 查询 `/api/session/subagents`。当用户切到新会话（无子智能体）时面板显示"当前无智能体"，而该会话实际归属的父会话/工作区下存在子智能体与 Agent Team 队友——查询作用域过窄造成误报。

## Decision

当前会话查询为空时自动回退一次工作区级查询（`static/index.html`，ES5）：

- `loadSubagents()` 按会话查询为空且 `sid` 非空时，调用新增 `loadWorkspaceSubagentsFallback(cwd, cacheKey)`（不带 `id` 参数），结果标记 `data.fallback = true` 后写入同一 `cacheKey`；
- `renderSubagentTree()` 识别 `fallback` 标记：标题显示"👥 多智能体 · 工作区全部"，空态文案切换为"（工作区暂无子智能体/Agent Team/后台任务）"；
- 按 `U` 每次清掉当前 `cacheKey` 后直接进面板拉最新数据，不再做预检 toast（旧"先查后开"逻辑随之移除）；
- 回归断言进 `test-unit.mjs`（Session FSM 契约段）：`loadWorkspaceSubagentsFallback` 存在、`data.fallback = true` 标记、"工作区全部"标题三项。

## Alternatives considered

- *保持按会话查询、空态只 toast*（旧逻辑）：Rejected。正是本次误报的根因；新会话下用户永远看不到已存在的智能体。
- *U 键无 sid 时才查工作区、有 sid 空则直接显示空*：Rejected。与用户心智不符——子智能体挂在父会话名下，切到新会话按 U 应看到工作区全貌而非空。
- *服务端合并两次查询一次返回*：Rejected。需改 `/api/session/subagents` 契约（`server.mjs`），跨文件契约变更成本高于前端一次条件回退；当前两次请求只在空会话时触发一次额外请求。

## Consequences

- 空会话按 U 多一次工作区查询（仅空时触发）；非空会话路径零额外开销。
- 旧 ADR（先查后开 toast）已移入 `archived/feature/` 冻结，原貌不动，本条为现行权威。
- 门禁：ES5 Acorn 解析通过；`node test-decoupling.mjs && node test-unit.mjs` 全量 PASS（靠机器）。
