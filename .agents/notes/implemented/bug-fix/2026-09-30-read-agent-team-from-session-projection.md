# Agent Note: Read Agent Team from Session Projection in Subagents API

Status: implemented

## Problem

在多智能体面板（快捷键 U）中，即使当前会话通过 Agent Teams 工具（如 `spawn_teammate`）启动了团队成员，看板依然将成员识别为普通 `[子Agent]`（而不是 `[Agent Team]`），且无法展示团队任务板（`tasks`）。
根因是 `server.mjs` 中的 `getSessionSubagents` 函数尝试通过调用不存在的私有 RPC `callDshWebRpc('agentTeams/view')` 获取团队信息；而官方 DSH Web 的规范是将 Agent Team 数据直接投影在 Lead 会话的 `projections.values.agentTeam` 中（包含 `members` 与 `tasks`）。

## Decision

修改 `server.mjs` 中的 `getSessionSubagents` 与 `getWorkspaceSubagents`：
1. 移除对不存在的 `agentTeams/view` RPC 依赖。
2. 优先从父会话的权威投影 `parent.projections.values.agentTeam` 中提取 `members` 与 `tasks`。
3. 准确标记成员的 `mode: 'team'` 与 `kind: 'Agent Team'`，并返回完整的 `tasks` 列表。

## Alternatives considered

- 保留 `callDshWebRpc('agentTeams/view')` 作为备选尝试：该 RPC 在 DSH Web 官方后端中根本不存在，只会徒增无意义的 6s 超时等待与 404 错误日志，故彻底废弃。
- 仅通过会话历史反查 `spawn_teammate` 工具调用：由于 DSH Web 会话投影已经严格由状态机回放维护了 `agentTeam` 视图，直接消费 `agentTeam` 投影是最权威且符合 DSH 消费规范的单一真实源。
