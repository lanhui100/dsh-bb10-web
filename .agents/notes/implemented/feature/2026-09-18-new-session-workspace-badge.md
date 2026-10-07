# Agent Note: 新建会话界面输入框底部工作区徽标

Status: implemented

> 摆放与结构已部分取代：徽标行现改为对话框顶部"左 W 徽标 + 右 M 模型徽标"布局，见 [2026-09-18-composer-badge-row-w-left-m-right](2026-09-18-composer-badge-row-w-left-m-right.md)；本文的显示条件与生命周期逻辑仍为现行权威。

## Problem

在 BlackBerry Q20 的 720×720 方屏上通过 `N` 快捷键新建会话时，用户直接进入输入对话框，但界面上缺少对当前所处工作区（Workspace）的直观感知。如果此前在不同工作区间切换过，容易在未确认当前工作区的情况下误发新会话。用户需要在打开新建会话输入框时，在输入框底部居中清晰获知当前工作区名称，且在首条消息发送并进入正式会话流后自动隐退，不占据方屏宝贵阅读空间。

## Decision

在 `static/index.html` 的悬浮对话框（`#composer-panel`）中增加工作区徽标 `#ws-badge`：

1. **结构与样式**：
   - 徽标由 `#ws-badge` 及其内联文本节点 `#ws-badge-text` 构成；
   - 样式严格遵守 Q20 宪法：纯灰色底色（`#3A3A3A`）、无边框（`border: none`）、浅灰色文字（`#D0D0D0`）、圆角小胶囊状（`border-radius: 8px`）；
   - 定位采用 `position: absolute; bottom: 9px; left: 45px; right: 45px; text-align: center;`，锚定于输入框底部正中央，左右各避让 45px 与右下角发送按钮互不干扰，且与发送按钮垂直对齐；
   - 默认隐藏（`display: none`），`pointer-events: none` 避免影响输入框打字触控。

2. **状态与生命周期**：
   - `startNewChat()`（`N` 快捷键或新建对话按钮）激活 `isNewChatBadgeActive = true`，并在打开输入框时调用 `updateWsBadge()` 渲染并显示工作区名称；
   - 工作区名称优先从当前选中的 `wsSelect.options[selectedIndex].text` 获取，支持从 `wsList` 与 `wsSelect.value` 保守回退；
   - 当用户在新建会话中发送首条消息（`doSend()`）时，置 `isNewChatBadgeActive = false` 并隐退徽标；
   - 切换会话（`selectSession()`）或切换工作区（`selectWorkspace()`）时自动复位/刷新该状态；
   - 在既有会话阅读过程中通过 `I` 键或 `💬` 按钮唤起输入框时，因非空白新会话且已有消息，徽标保持隐藏。

## Alternatives considered

- **在对话框上方浮动显示**：初版置于对话框上方，但在 720×720 方屏且输入框处于屏幕底部时，置于输入框底部居中与右侧发送按钮平齐更为紧凑收敛，不挤占上方聊天消息流。
- **在顶栏常驻显示工作区**：顶栏在 720×720 屏受 34px 严格高度限制（宪法 §三.1），已被折叠按钮和状态占据，再塞入工作区全名会导致严重拥挤和截断。
- **在输入框内部占位符（Placeholder）中显示工作区**：占位符文字偏长，输入打字时光标会被挤占或覆盖，视觉层级不够明确。

## Consequences

- 用户按 `N` 新建对话时可在输入框底部居中一眼确认当前工作区，首条消息发送后自动消失，无视口留白与冗余残留。
- 全套静态与动态门禁通过：Acorn ES5 静态解析 `ES5 PASS`，单元测试套件 9/9 PASS，烟雾测试 22/22 PASS，无现代 JS/CSS 特性泄漏。
