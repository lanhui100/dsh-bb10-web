# Agent Note: 修复由于缺失 renderQueueDock 声明导致的历史会话加载异常

Status: implemented

## Problem

在 commit `d6424e1` 中，为了支持跨会话切换时恢复排队/插队消息（关联 [.agents/notes/implemented/bug-fix/2026-09-26-restore-queued-prompt-on-session-switch.md](.agents/notes/implemented/bug-fix/2026-09-26-restore-queued-prompt-on-session-switch.md)），重构了 `queuedPromptStore` 与恢复逻辑，但误将 `function renderQueueDock() { ... }` 原函数定义覆盖删除，只保留了对其的调用。
由于 JavaScript 在执行 `clearQueueDock` / `restoreQueuedPrompt`（由 `loadHistory` 或切换历史会话回调触发）时找不到全局函数 `renderQueueDock`，导致抛出 `ReferenceError: Can't find variable: renderQueueDock`，使得客户端直接弹窗提示“解析历史失败：Can't find variable: renderQueueDock”。

## Decision

1. 在 `static/index.html` 的排队停靠区模块中，将 `function renderQueueDock()` 声明完整复原至 `pendingQueuedItem` / `queuedPromptStore` 变量声明之后、`stashQueuedPrompt` 之前；
2. 保持纯 ES5 语法规范，继续兼容 BlackBerry Q20 (WebKit 537.35+)；
3. 保留此前单行文本截断、高对比度样式、气泡渲染以及 `updateChatContainerBottom()` 联动；
4. 运行 `acorn` 语法门禁与 `test-unit.mjs` 测试套件，确保 100% PASS。

## Alternatives considered

- 在 `clearQueueDock` / `restoreQueuedPrompt` 中通过 `typeof renderQueueDock === 'function'` 降级防崩：治标不治本，会导致排队消息在 UI 上无法正确渲染显示，破坏核心功能；必须完整补齐 `renderQueueDock` 的定义。

## Consequences

- 点击历史会话与切换会话时，不再触发 `ReferenceError: Can't find variable: renderQueueDock`，历史消息正常平滑加载；
- 运行中追发的排队/插队停靠栏正常渲染与恢复，快捷键 `Z` 撤回正常工作。
