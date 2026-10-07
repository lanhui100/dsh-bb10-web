# Agent Note: 会话目标红圈指示与状态面板目标行

Status: implemented

## Decision

- 服务端从会话 zstd 日志折叠 `goal/change` 事件得出当前目标（`{ id, revision, objective, phase, maxGoalRounds, roundsStarted }`，无目标/已清除为 `null`），经由两处暴露：
  - `GET /api/session/goal?cwd=&id=` 新端点（缺 `cwd` → 400；非法 id → 200 `{ goal: null }`，与 stats 幽灵会话口径一致）；
  - `GET /api/session/stats` 响应内嵌 `goal` 字段，前端零额外请求即可拿到；
  - 上游 `goals/*` RPC 不直调：宿主离线时 Q20 仍可从本地日志读 durable 目标（activation 为进程态，本机小屏只关心 durable）。
- 前端右下悬浮对话按钮（`#composer-trigger-btn`）有目标时加 `.goal-active` 类：外圈改红色（`border #E53935` + 红色辉光），无目标恢复橙色；状态由 `syncGoalRing()` 单点驱动。
- 目标查看沿用既有 `O` 状态面板：内新增“当前目标”行展示 objective/phase/revision；不另设快捷键（`L` 曾短暂存在，已去除）。
- 刷新时机：切会话、流式终态（done/cancelled/error）、attach 终态、`loadSessionStats` 成功时 piggyback 同步；不另起轮询 timer（2GB/Q20 省电）。

## Alternatives considered

- 直调宿主 `goals/get` RPC：需 `agentId` lookup（即 sessionId），Q20 的 `callDshWebRpc` 信封可装；但宿主离线即不可用，且 activation 进程态对小屏无意义。本地日志折叠零依赖、离线可用，故选本地折叠为主链路。
- 曾设 `L` 快捷键呼出目标：目标本就落在 O 状态面板内，另设一键属冗余占用键位；用户明确后去除，目标查看收敛到 `O` 单一入口。
- 用绿色/蓝色外圈：绿点已被会话 running 态占用语义，红色在暗色主题下对比最强且与“有待办目标”告警语义一致，故选红色（`#E53935`）。

## Consequences

- `getSessionStats` 三个返回分支均带 `goal` 字段；stats 缓存键已含 mtime+size，目标随缓存自然失效。
- 前端新增 `goalState` 单一状态源，`renderStatusPanel` 目标行优先读 `latestSessionStats.goal`，回退 `goalState`。
- 回归：`test-unit.mjs` 新增 goal 端点契约与静态接线断言；ES5 门禁覆盖新增前端代码。
