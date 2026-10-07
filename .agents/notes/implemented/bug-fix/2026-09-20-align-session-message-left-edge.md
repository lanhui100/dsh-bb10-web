# Agent Note: 会话消息区直挂过程节点与轮次折叠行左对齐

Status: implemented

## Decision

`static/index.html` 中 `#chat-container` 直挂的 `thought-card` / `tool-pill` 与顶层 `turn-process` 折叠行，补上与 `.msg-wrap` 一致的左缩进（`border-left: 2px solid transparent; padding-left: 4px`），三类消息左缘对齐；`msg-wrap` 内的嵌套折叠行清零避免双缩进。

## Alternatives considered

- 逐个直挂节点包 `msg-wrap` 重构 DOM 结构 —— 改动面大（send/attach/历史三条渲染路径），仅为对齐不值得，拒绝。
- 用 `margin-left` 而非 `border+padding` 对齐 —— 与 `.msg-wrap` 既有缩进机制不一致（选中态 `border-left` 变色依赖该结构），拒绝；沿用同一机制零分歧。
