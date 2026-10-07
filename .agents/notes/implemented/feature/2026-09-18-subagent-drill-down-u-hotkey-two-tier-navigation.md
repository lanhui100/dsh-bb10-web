# Agent Note: Subagent Detail View Two-Tier U-Hotkey Navigation

Status: implemented
Supersedes: None
Related: .agents/notes/implemented/feature/2026-09-18-multi-agent-subagent-team-board.md

## Problem

In multi-agent orchestration, the user can press `U` to open the subagent dashboard and select a subagent to drill down into its conversation stream. However:
1. When viewing a subagent's session details, pressing `U` previously queried `/api/session/subagents` with the subagent's own session ID, producing an empty dashboard (since subagents do not have child subagents).
2. Users were trapped in the subagent's conversation stream with no quick physical key shortcut to navigate back to the main/parent agent's conversation.

## Decision

1. **Two-Tier Navigation State Machine for Shortcut `U`**:
   - Track parent session context (`subagentParentSession = { cwd, sid }`) when entering a subagent session via `selectSubagentSession(sa)`.
   - **First `U` in subagent detail**: Opens the subagent dashboard for the parent session (`getSubagentTargetContext()`), displaying the parent's subagent list and highlighting the currently inspected subagent.
   - **Second `U` in dashboard**: Closes the dashboard and automatically navigates back to the main agent's conversation (`selectSession(parentCwd, parentSid)`), clearing `subagentParentSession`.
2. **Context-Aware Status Hints**:
   - When the dashboard is opened from a subagent detail view, status line displays: `多智能体看板 (按U返回主会话)`.
   - When returning to the parent conversation, status bar confirms: `已返回主会话`.
3. **Graceful State Invalidation**:
   - If the user explicitly switches sessions or workspaces via the session drawer (`C`), workspace drawer (`W`), or starts a new chat (`N`), `subagentParentSession` is automatically reset to `null`.

## Alternatives considered

- *Stay in subagent detail when closing dashboard with second `U`*:
  Rejected. Leaves no fast physical key route back to the main agent's chat, violating the Q20 keyboard-first mental model where subagent views are temporary drill-downs.
- *Query grandchild subagents*:
  Rejected. Subagents do not spawn further subagents; an empty board creates visual confusion.

## Verification

- Acorn ES5 syntax verification: passed (`ecmaVersion: 5`).
- Regression test suite: 7/7 passed.
