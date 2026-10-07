# Agent Note: 统一工具调用消息（tool-pill）上下垂直边距

Status: implemented

## Problem

在会话过程中，工具调用胶囊（`.tool-pill`）在不同上下文（相邻文本气泡、连续工具调用、思考卡片与折叠行之间）中的上下边距出现不一致。经诊断发现：
1. `.tool-pill` 仅声明了 `margin-bottom: 2px`，缺少顶边距 `margin-top`（默认为 0）。
2. 当工具调用上方紧邻其他块（例如思考卡片 `.thought-card`、连续工具调用等），只有下方的元素享受边距；而当直接紧随或嵌套在其他无 margin 的容器内时，顶部贴紧，导致垂直间距不均匀。

## Decision

在 `static/index.html` 中：
- 将 `.tool-pill` 的 `margin-bottom: 2px;` 统一调整为 `margin: 2px 0;`。
- 确保工具调用胶囊无论上方紧接思考卡片、下方紧邻正文气泡，还是连续多个工具调用，均具备一致对称的 2px 垂直留白，在 720×720 方屏下视觉韵律规整统一。

## Alternatives considered

- *单独微调父级容器 padding*：否决。工具调用既可能位于普通消息 wrap 内，也可能在实时流中直接挂在容器下，调整胶囊本身更为彻底且鲁棒。

## Consequences

- 工具调用的上下垂直间距完全对称统一为 2px。
- 通过 Acorn ES5 静态解析、单元测试 (12/12) 及 Chrome 无头折叠冒烟测试 (22/22)。
