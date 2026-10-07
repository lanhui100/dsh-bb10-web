# Agent Note: 用户消息复制按钮移出气泡外并去除气泡内分割线

Status: implemented

关联上下文：行为基线见 [bb10-message-copy-fallback](../bug-fix/2026-09-17-bb10-message-copy-fallback.md)（复制反馈与长按辅助逻辑本次不变）；同日 agent 气泡对齐先例见 [8ae7d33 消息复制按钮图标化]。

## Problem

用户消息气泡（`static/index.html` 的 `.msg-user`）此前把复制按钮与白色分割线一并渲染在橙色气泡内部：气泡底部出现一条 `rgba` 分割线与内嵌按钮行，视觉上像气泡内容的一部分；用户要求"消息气泡仅包裹消息主体内容，去除分割线，复制按钮在气泡外的下方"。

## Decision

`static/index.html`（纯前端，ES5）：

1. **DOM 归属拆分**：用户气泡 `.msg-user` 仅保留正文；`createMessageActions(text, retry, role)` 新增 `role` 参数，`role === 'user'` 时动作栏 class 改为 `.msg-user-actions`，作为 `.msg-wrap` 的兄弟节点追加在气泡之后（历史渲染 `renderWindowedMessages` 与实时 `appendMessage` 两条路径同步修改）。
2. **样式**：`.msg-user-actions` 右对齐浮动于气泡外下方（`float: right; clear: both;`，无分割线、无背景），复制图标沿用 `ICON_COPY` 灰色 ghost 态；删除 `.msg-user .msg-actions`、`.msg-user .action-btn` 及其 icon 变体的全部旧覆盖规则（白底分割线/黑色半透明胶囊不再存在）。
3. **Agent 侧不受影响**：助手消息动作栏仍为 `.msg-actions`（带 `#333` 上分割线），复用同一工厂函数。

## Alternatives considered

1. **保留气泡内分割线、仅弱化颜色**：未满足"气泡只包裹消息主体"的诉求，分割线仍占用气泡内空间，否决。
2. **复制按钮放进气泡下方左侧并加文字"复制"**：与 8ae7d33 已确立的图标化 ghost 语言不一致，且小方屏横向空间珍贵，维持纯图标右对齐。
3. **气泡内绝对定位悬挂按钮**：旧 WebKit 对 float 气泡内 `position:absolute` 溢出裁剪行为不可靠（`.msg-wrap` 有 `overflow: hidden`），存在按钮被裁切风险，否决。

## Consequences

- 用户气泡视觉上只包含文本主体，复制入口位于气泡外下方，触控热区不变；
- ES5/Acorn 静态解析与全量回归（test-suite 7/7、test-unit 12/12、fold smoke 22/22）在含本次变更的工作树全部通过。
