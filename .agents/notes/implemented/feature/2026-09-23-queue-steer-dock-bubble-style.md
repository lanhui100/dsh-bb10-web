# Agent Note: 排队与插队消息区对齐用户气泡样式与无分割线

Status: implemented

## Problem

此前在运行中追发时，底部停靠区 `#queue-dock`（见 [2026-09-22-running-send-bottom-dock-isolation.md](2026-09-22-running-send-bottom-dock-isolation.md)）使用了带有上分割线（`border-top: 1px solid #333333`）及独立卡片（矩形框、徽标带“待介入/待执行”及“撤回 [Z]”内嵌）的呈现方式。
用户反馈：
1. 排队或插队的消息区不需要分割线（去除 `border-top`，背景透明无界）。
2. 在底部保持用户消息气泡样式（靠右浮动、圆角气泡、字体与间距一致；插队使用 `#A9521A` 深橙，排队使用 `#555555` 灰色）。
3. 前方徽标精简为仅显示“插队”或“排队”（不再带冗余的后缀字样）。
4. “撤回 Z”按钮置于气泡下方（同右对齐动作栏），与普通用户消息的操作条风格保持统一。

## Decision

在 `static/index.html`（严守 ES5、静态 HEX 与无 CSS 变量原则）中做如下样式与结构重构：

1. **移除分割线与背景铺满**：
   - `#queue-dock`：去除 `border-top`，`background: transparent`，设 `pointer-events: none`（内部气泡与按钮启用 `pointer-events: auto`），保留右侧 `padding: 60px` 规避悬浮 💬 按钮；
2. **重构为标准用户气泡样式**：
   - 将内部条目改为 `.queue-dock-wrap` + `.queue-dock-bubble`，沿用 `msg-user` 经典尺寸规格（`float: right; max-width: 88%; padding: 6px 10px; border-radius: 6px; font-size: 14px; line-height: 1.35;`）；
   - 插队样式 `.dock-steer` 采用深橙 `#A9521A`（白字），排队样式 `.dock-queue` 采用灰色 `#555555`（`#D0D0D0` 字）；
3. **精简徽标文案**：
   - 徽标由“插队待介入 / 排队待执行”精简为仅“插队”或“排队”；
4. **撤回按钮置于气泡下方**：
   - 新增 `.queue-dock-actions`（`clear: both; float: right; margin-top: 2px;`），下方渲染 `<span class="queue-dock-revoke-btn" id="dock-revoke-btn">撤回 Z</span>`，保持单手盲操与 Q20 视觉一致性。

## Alternatives considered

- **直接复用 `.msg-user` 全局 CSS 类**：`.msg-user` 带有特定 margin 与全局伪类绑定，且在消息流里与附件/复制重试条强绑定；在 dock 中使用专有类名 `.queue-dock-bubble` 既能 100% 保持视觉参数同构，又避免样式互相污染。
- **保留“撤回 [Z]”方括号**：视觉上较为繁琐，按用户诉求采用紧凑精炼的“撤回 Z”并置于气泡右下方。

## Consequences

- 底部排队/插队停靠区与对话流中的用户气泡视觉语言高度一致，无突兀的分割线与卡片框线。
- 门禁通过：Acorn ES5 静态解析通过，`node test-decoupling.mjs && node test-unit.mjs` 29/29 项全绿。
