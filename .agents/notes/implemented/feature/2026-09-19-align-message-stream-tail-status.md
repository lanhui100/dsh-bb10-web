# ADR: 对齐 DSH 会话消息流底部状态驱动机制

- **日期**: 2026-09-19
- **状态**: implemented

## Context
在 `dsh-q20-web` 会话消息流底部，原状态条 `#sess-status-tail` 仅显示静态纯文本与粗粒度脉冲动画，缺乏精确的运行时长反馈与无障碍属性（A11y），在终态与运行态切换时未严格重置时钟。参考 DeepSeek Harness 官方前端（`RunningStatus.tsx` 与 `TurnProcessNodeView.tsx`）的设计规范，需要优化该组件。

## Decision
1. **独立时钟与秒级格式化**：在进入 `running` 态时记录 `tailStartTime`，通过独立的 1 秒定时器累加并更新 `.tail-duration-text`（例如`，用时 5秒 ···`），退出运行态或会话归档/完成时即时清理时钟 `stopTailClock()`，杜绝内存泄漏与状态粘滞。
2. **文本扫光动效（Shimmer）**：采用官方 `TextShimmer` 类似的渐变扫光效果（`tail-shimmer`），替代旧的透明度闪烁（`tail-pulse`），背景裁切文字呈现平滑的科技蓝流动质感。
3. **无障碍设计（A11y）**：为容器补充 `role="status"`、`aria-live="polite"` 和 `aria-atomic="true"` 属性，对齐屏幕阅读器友好规范。

## Alternatives considered
- **每秒调用全局 `renderSessionStatusTail` 重渲染整条 HTML**：会触发无必要的 DOM 树比对与老旧 WebKit 布局重排；改为定向更新已存在的 `.tail-duration-text` 节点内容。
- **保留脉冲透明度动画**：视觉体验粗糙且易造成视觉疲劳，不如官方的扫光高亮平滑。
