# Agent Note: 消息 Markdown 中文件路径/链接卡片边框改用浅色背景

Status: implemented

## Problem

在 BlackBerry Q20 消息流渲染中，Assistant 回复的 Markdown 文件引用（如 `[文件](path/to/file.md)`、`![图片](path/to/image.png)`）通过 `.fp-chip` 渲染为预览卡片。此前样式采用深暗底色（`#1F1F1F`）搭配薄荷绿/青绿色（Teal `#4EC9B0`）1px 实线边框。

在方屏暗色背景（`#121212`）与正文文字中，深底搭配鲜艳高亮的 Teal 边框视觉跳跃感强，造成视觉噪点；且与纯代码块、内联代码的低饱和色块风格不协调。需要去掉 Teal 边框，改为浅色微高亮背景（高对比无框浅底色块），提升阅读沉浸感与舒适度。

## Decision

1. **移除 Assistant 预览卡片 Teal 边框**：
   - 将 `.msg-assistant .fp-chip` 样式中的 `border-color: #4EC9B0;` 移除，声明 `border: none;`。
   - 将 `.msg-assistant .fp-chip-img` 缩略图态的 Teal 边框同步移除（`border: none;`）。
2. **改用浅色背景**：
   - 将 `.msg-assistant .fp-chip` 的背景由深暗底 `#1F1F1F` 改为高对比可读的浅色背景 `#2D2D2D`，搭配白灰色文字 `#E0E0E0`，形成沉浸无框色块。
3. **兼容与安全红线守卫**：
   - 严格遵守 Q20 ES5 与经典 CSS 规范，全静态 HEX 颜色，不引入任何 CSS 变量或现代未受支持属性。
   - 测试套件全量回归（ES5 解析、`test-decoupling.mjs`、`test-suite.mjs` 及 `test-unit.mjs` 均 100% PASS）。

## Alternatives considered

- **改为仅文字下划线链接**：放弃卡片形式改用纯文字+点状下划线。但小屏上触摸点击区域过小（不满足黑莓手指易点要求），且无法良好承载图片缩略图及文件大小 meta 属性。
- **保留边框但改为中灰色边框（如 `#444444`）**：小屏上多重边框导致排版紧绷，去边框 + 浅色色块的层次更清晰、更贴合现代无边框扁平设计。
