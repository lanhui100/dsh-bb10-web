# Agent Note: Support Multi-Agent, Agent Team, and Subagents Board

Status: implemented

## Problem

In multi-agent orchestration scenarios (such as `subagent`, `subagent_fork`, `workflow`, `ralph`, or `agent-team`), DeepSeek Harness delegates focused subtasks or team runs to specialized child sessions. On the BlackBerry Q20 mobile client:
1. Users need an intuitive way to discover and inspect background tasks, subagents, and agent teams running under the current conversation or workspace.
2. The user experience must avoid building redundant heavy UI trees; rather, it should reuse the existing high-contrast session message stream (`/api/history` and streaming/attachment) so selecting any child agent seamlessly presents its full thought, tool calls, and output.
3. Users need a dedicated physical keyboard shortcut and a clean modal board (`U` key, styled symmetrically with `C` for Sessions and `W` for Workspaces) with keyboard navigation (`J`/`K`/trackpad + `Enter`) to view and open subagents.

## Decision

1. **Backend Subagent Projection API (`/api/session/subagents`)**:
   - Exposed `GET /api/session/subagents?cwd=<cwd>&id=<sessionId>`.
   - Queries official DSH Web RPC `session/list` for authoritative projection entries (`parentSessionId` and `subagentCatalog`).
   - Maps child metadata into `{ id, parentId, title, label, mode, kind, running, isRunning, state, updatedAt, cwd }`.
   - Distinguishes `kind`: "子Agent" (`continuable`), "后台任务" (`one-shot`), and "Agent Team" (`team` / `agent-team`).
   - Enhanced `findSessionDir` to cross-lookup session folders under all workspace directories in case subagents reside in their parent's or decoupled workspace paths.

2. **Frontend Subagent Board (`#subagent-overlay`) & Shortcut `U`**:
   - Added fullscreen dark modal `#subagent-overlay` matching the existing `#sess-overlay` / `#ws-overlay` design.
   - Bound physical shortcut `U` to toggle the multi-agent board.
   - Bound `R` to refresh the board list.
   - Supported `J`/`K`/trackpad navigation and `Enter` to select and switch to the subagent's conversation.
   - Rendered state indicators using `sessionStateMark(sa)` (blue for running, green for done, red for error, orange for stopped) and badge pills (`.subagent-badge.agent`, `.subagent-badge.team`, `.subagent-badge.task`).
   - Integrated with shortcut help (`?` / `H`) and the welcome screen (`#welcome-ready`).

3. **Detail Inspection via Main Stream Reuse**:
   - Clicking or pressing `Enter` on any subagent calls `selectSession(sa.cwd, sa.id)`, loading its complete message stream, tool calls, and thought bubbles into the main view with full history pagination.

## Alternatives considered

- *Embedding subagent messages as nested expandable rows in the parent chat stream*:
  Rejected due to severe WebKit 537 / 2GB RAM / 720x720 screen constraints; deeply nested expandable DOM structures cause layout thrashing and performance degradation on legacy Qualcomm Snapdragon S4 dual-core CPUs.
- *Creating a separate mini-chat window*:
  Rejected because a 720x720 viewport has no space for side-by-side or picture-in-picture conversation panels. Reusing the unified full-width chat stream provides the cleanest, distraction-free reading experience.

## Consequences

- Users on BlackBerry Q20 can press `U` at any time to inspect running or completed subagents/tasks and jump directly into their full conversation detail.
- Passes Acorn ES5 static parsing, unit test suites (12/12), and fold smoke tests (22/22).
