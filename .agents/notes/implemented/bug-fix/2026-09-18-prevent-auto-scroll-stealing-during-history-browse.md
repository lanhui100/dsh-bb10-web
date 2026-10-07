# Agent Note: 用户上滑浏览历史时禁止自动滚底与争夺控制权

Status: implemented

> 后续修正：本文的 40px 阈值状态机存在触摸盲区与标志位竞态，已由 [2026-09-18-touch-gesture-scroll-bottom-fight.md](2026-09-18-touch-gesture-scroll-bottom-fight.md) 重构细化（手势感知 + 程序化写标记 + 方向化意图判定），以新条为准。

## Problem
在流式对话生成（SSE）或历史会话回显（`/api/session/attach` 的 sync/thought/tool 事件）进行时，前端 `scrollBottom()` 与 `renderWindowedMessages(false)` 每次收到 delta/thought/tool 片段时都会无条件强制执行 `chatContainer.scrollTop = chatContainer.scrollHeight`。
这导致用户在 Q20 小屏上手动上滑查阅上文或历史消息时，画面被高频强制拉回底部，严重剥夺用户的浏览控制权；即使是已完成的历史会话，在后台挂载同步（attach sync）时也会触发频繁滚底。

## Decision
1. **用户滚动意图追踪（`userScrolledUp` 状态机）**：
   - 监听 `chatContainer.onscroll` 事件。
   - 定义距离底部的阈值检测 `isNearBottom()`（距离底端不超过 40px 视为触底）。
   - 用户只要向上滑动离开底端（> 40px），`userScrolledUp` 即置为 `true`。
   - 当用户重新手动滑到底部（<= 40px）时，`userScrolledUp` 自动复位为 `false`。
2. **条件式平滑滚底**：
   - `scrollBottom(force)` 改为受控方法：仅当 `force === true`（如用户发送新消息、按下快捷键 `B` 到底部、加载新会话）或 `!userScrolledUp` 时才执行滚底。
   - 会话同步 `attachSession` 中的 `sync` 事件改用 `renderWindowedMessages(userScrolledUp)`，上滑阅读状态下保留相对滚动位移（`preserveScroll`），不跳动。
   - 完成态与中止态下的 `loadHistory` 在 `userScrolledUp === true` 时静默跳过，避免二次覆写滚动位置。

## Alternatives considered
1. **完全禁用流式过程中的自动滚底**：用户每次生成回复都需要手动下滑查看，在默认正常跟随场景下体验极差。
2. **引入计时器倒计时锁（如用户滑动后锁定 3 秒不滚底）**：时间窗口难以贴合用户真实阅读节奏，超时后突然被强拉到底部依然会造成打扰。
3. **基于 CSS `scroll-behavior: smooth` 或 `overscroll-behavior`**：BB10 WebKit 537 老内核完全不支持此类现代 CSS 特性，且无法解决 JavaScript 层面修改 `scrollTop` 的抢夺问题。

## Consequences
- 用户在 AI 生成流式吐字或历史后台同步阶段可以自如地上滑阅读历史消息，不会再被突兀地弹回底部。
- 当用户阅读完毕手动滑回底部，或在实体键盘上按下 `B` 键时，自动恢复流式跟随滚底。
