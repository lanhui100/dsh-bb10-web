# Agent Note: 切换会话弹窗快捷键为 C 避免与浏览器冲突

Status: implemented

## Problem

在 BlackBerry 10 WebKit 浏览器及部分主流移动/桌面浏览器中，按键 `S`（以及 Ctrl+S / 浏览器快捷键）存在系统级行为冲突或浏览器保留键拦截，导致用户按下 `S` 键时经常无法可靠呼出当前工作区的会话弹窗（Session modal），影响会话切换体验。

本条决策更新并部分取代了 [.agents/notes/implemented/feature/2026-09-17-split-session-modals-and-fullscreen-hotkeys.md](2026-09-17-split-session-modals-and-fullscreen-hotkeys.md) 中关于会话列表快捷键分配为 `S` 的设定。

## Decision

将全屏展开/收起当前工作区会话列表（Session modal）的物理全键盘快捷键从 `S` 改为 `C`（代表 Chat / Conversation，Key code: 67）：

1. 在 `static/index.html` 的全局 `keydown` 监听器中，将触发 `openSess()` / `closeSess()` 的 `code === 83`（'S'）调整为 `code === 67`（'C'）；
2. 同步更新 `static/index.html` 中的黑莓 Q20 物理快捷键速查表（Help modal），标明 `C` 键为全屏展开/收起当前工作区会话列表 (Chat)；
3. 同步更新中英文 `README.zh.md` 与 `README.md` 的实体键盘快捷键说明。

## Alternatives considered

- **方案 A：采用 `O`（Open Session）**：虽然语义贴近打开会话，但 `O` 位于黑莓键盘右上侧，相比位于中下部的按键操作手势不够顺手，且在部分平台常与“打开文件”快捷键混淆。
- **方案 B：采用 `L`（List Sessions）**：语义同样清晰，但 `C`（Chat / Conversation）直接对应聊天/会话，认知负荷最低且位于全键盘左下部，单手或双手大拇指操作非常便捷。
- **方案 C：采用修饰键组合（如 Alt+S / Shift+S）**：黑莓 Q20 实体键盘打字状态下，修饰键容易与字符输入状态混淆，且在 BB10 浏览器中 Alt / Shift 事件捕获不稳定，违反了实体键单键直达的极简原则。
