# Agent Note: 归档当前会话后打开会话面板供选择进入

Status: implemented

## Problem

`static/index.html` 的 `doArchiveCurrentSession()` 在 `/api/session/archive` 成功后调用 `startNewChat()`：自动展开输入框 Composer 并聚焦，语义是"结束上一个任务后立刻开启下一个任务"。但用户归档旧会话的常见意图是"收尾后换一件事做"——直接新建空白对话并不总是期望路径；若想回到某个进行中的历史会话，还需先收起 Composer 再按 `C` 打开会话面板，多两步操作。且该行为与 `selectWorkspace`（W 键切换工作区后自动打开会话面板）的既有接续模式不一致，交互心智分裂。

## Decision

`static/index.html`（ES5）`doArchiveCurrentSession()` 成功回调：

1. 保留 `startNewChat()` 完成全部状态重置（`stopAttach`、`currentSessionId` 清空、`allMessages`/`chatContainer` 清空、`sessState` 复位、欢迎页还原、`saveActiveSession(cwd, '')`）；
2. `startNewChat()` 末尾会 `openComposer()`（自动新建对话语义），归档后随即调用 `closeComposer()` 收起输入框，避免焦点抢占会话面板的键盘导航（`↑/↓(J/K) + Enter`）；
3. `delete sessCache[targetCwd]` 之后调用 `openSess()` 打开会话面板——`openSess` 内部负责 `renderSessTree()`（缓存已删 → 显示"加载会话中"并触发 `loadSessions`）与对当前 `cwd` 的列表重拉（`sessLoading` 去重），已归档会话不会残留在列表中；用户可用 `↑/↓(J/K) + Enter` 选择进入任意已有会话，或点面板底部"+ 新建"按钮；
4. 状态文案由"会话已归档，已开启新对话"改为"会话已归档，请选择要进入的会话"；帮助弹窗（`?`/`H`）`A` 行、`README.md` / `README.zh.md` 同提交更新。

与 [2026-09-18-workspace-switch-opens-session-panel.md](2026-09-18-workspace-switch-opens-session-panel.md) 的"切换后打开会话面板"决策同构，形成统一的"状态落空后交还用户显式选择"交互闭环。

取代 [../../archived/feature/2026-09-17-auto-start-new-chat-on-archive.md](../../archived/feature/2026-09-17-auto-start-new-chat-on-archive.md)（已归档冻结快照）：归档后不再自动开启新对话。

## Alternatives considered

- **维持自动开启新对话（原行为）**：归档即新建最省按键，但强制了"归档 = 立刻开新任务"的意图，且与 W 切换工作区后打开会话面板的模式分裂；想回到历史会话需额外两步。
- **归档后仅重置状态、不弹任何面板**：回到欢迎页，让用户自行按 `C` 或 `N`。省一次渲染，但用户从确认弹窗回到欢迎页没有明确下一步提示，状态不连续（与 workspace 切换修复前的"黑屏停留"同类问题）。
- **自动进入该工作区最近会话**：省掉选择但违背"由用户选择进入"的预期，且自动 attach 历史会话会在方屏上产生一次不可预期的长列表渲染（弱 CPU 负担）。

## Consequences

- 归档流程变为 `A → Enter 确认 → 会话面板`，键序 `A → ↑/↓(J/K) → Enter` 即可进入目标会话；输入框保持收起。
- 会话面板底部"+ 新建"（`newChatBtn`）保留，需要新建时一键可达，未损失任何能力。
