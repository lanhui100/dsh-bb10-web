# Agent Note: 消除纯工具消息间多余边距与间距抖动

Status: implemented

## Problem

在会话消息流中，工具调用的垂直间距在不同场景下出现明显差异（如 2px 对 18px 悬殊），严重影响小屏视觉整洁：
1. **空白气泡残留占位**：历史/同步渲染（`renderAssistantBlocks`）当遇到仅有工具调用的回合时，因 `!lastBubble` 逻辑无条件生成兜底 `.msg-assistant` 气泡；即使 `displayText` 为空，该气泡依然自带 `padding: 2px 0 4px 0`，凭空占据 6px 高度。
2. **消息容器间距叠加**：每个消息 wrap（`.msg-wrap`）默认带有 `margin-bottom: 8px`。实时流中连续工具调用是作为平铺子元素 append 到同一个容器中，相邻工具之间只有 `.tool-pill` 的 `margin: 2px 0`；而历史渲染中每个 step 是独立的 `.msg-wrap`，导致相邻工具之间叠加了 8px 外边距与 6px 空白气泡高度，总间距达 18px。
3. **正文气泡前后无缓冲**：当工具上方或下方紧邻有文字正文的 `.msg-assistant` 气泡时，工具与文本正文之间的间隔和连续工具之间的间隔不协调。

相关旧条：`.agents/notes/implemented/bug-fix/2026-09-18-unify-tool-pill-vertical-margin.md`。

## Decision

在 `static/index.html` 中：
1. **按需创建兜底气泡**：在 `renderAssistantBlocks` 中，只有在 `displayText` 不为空，或者存在最后一个仍在运行（running）的工具需要展示状态文案时，才创建 `.msg-assistant` 兜底气泡。纯完成态工具调用不再注入空气泡。
2. **纯过程容器消除消息边距**：当 assistant 消息仅包含过程元素（思考卡片、工具胶囊）而无可见正文气泡时，为 wrap 添加 `.msg-wrap-process` 类，将 `margin-bottom` 归零，并保持 `.msg-wrap-process .tool-pill` 垂直间距与实时流同构（`1px 0`，相邻两个 wrap 之间间距刚好为 `1px + 1px = 2px`）。
3. **保留文本气泡正常行距**：当出现用户气泡或带有正文文本的 assistant 气泡时，继续维持标准的 `margin-bottom: 8px`，确保对话流层级分明。

## Alternatives considered

- *将历史连续 step 归并在后端合并成单个消息*：否决。会破坏 step 原始时间戳与历史窗口分页截断逻辑。
- *完全改用 CSS :empty 选择器*：否决。BB10 旧 WebKit 537 对 `:empty` 的重排和包含空白字符的处理不可靠。

## Consequences

- 机械可查：通过 Acorn ES5 静态语法门禁；通过 `test-suite.mjs` (7/7)；通过 `test-unit.mjs` (12/12)；通过 `test-fold-smoke.cjs` (22/22)。
- 连续纯工具调用的垂直间距在实时流与历史回放中完全统一为 2px，消除任何抖动与空隙。
