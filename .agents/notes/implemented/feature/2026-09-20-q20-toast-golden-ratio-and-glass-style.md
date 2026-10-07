# Agent Note: 全局 Toast 视觉与交互适配（小方屏黄金位置、毛玻璃、尺寸边界与延时调整）

Status: implemented

## Problem

在 BlackBerry Q20（720×720 方屏）移动端设备上，原有的全局 Toast 提示存在以下体验问题：
1. **停留时间过短**：原 1800ms 尚未看清即消失，尤其在小屏移动端阅读不便；
2. **位置与尺寸不合理**：原为顶部通栏固定 `top: 8px; left: 20px; right: 20px` 布局，遮挡顶栏且横向过长；缺乏最大/最小宽高边界；
3. **视觉风格与对比度**：原为深灰背景带细绿边框，不够醒目且缺乏层次感；失败态提示不够直观，需要更鲜明的语义化纯色/毛玻璃背景。

## Decision

对 `static/index.html` 的 Toast 样式与展示逻辑进行重构：

1. **显示时长延长**：
   - 将 `showCopyToast` 的默认消失延时从 1800ms 提高到 3200ms，并支持传入自定义 `duration`。
2. **屏幕黄金位置与尺寸限制**：
   - 位置锚定在屏幕高度黄金分割点（`top: 38.2%; left: 50%; transform: translate(-50%, -50%);`）；
   - 限制尺寸：`min-width: 160px; max-width: 400px; min-height: 48px; max-height: 140px;`；
   - 增加 `padding: 12px 20px`，字号 `14px`，行高 `1.5`，圆角 `8px`。
3. **语义纯色与毛玻璃磨砂效果**：
   - 常规/成功提示采用高对比度绿色 `rgba(0, 137, 123, 0.88)`，保留纯色 `#00897B` 降级；
   - 错误/警示提示（`.warn`）采用鲜艳红色 `rgba(211, 47, 47, 0.90)`，保留 `#D32F2F` 降级；
   - 增加微透高光边框 `1px solid rgba(255, 255, 255, 0.15)` 与 `-webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);`，阴影加深至 `box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5)`；
   - 增加 `pointer-events: none` 防止遮挡底层点击。

## Alternatives considered

- **纯色无边框无透明**：在深暗色聊天背景上容易显得死板突兀；采用轻微透明 + 10px blur 磨砂玻璃质感与高光微边，在现代浏览器和 WebKit 上层次更清晰，同时 HEX 颜色兜底保证老内核不花屏。
- **沿用屏幕居中（top: 50%）**：方屏视觉中心偏上，`top: 38.2%` 黄金分割位既避开对话输入框与顶栏，也最容易被单手握持时视线聚焦。

## Consequences

- 满足黑莓小方屏上的清晰阅读与即时反馈诉求；
- 通过 ES5 语法门禁与端到端回归测试套件。
