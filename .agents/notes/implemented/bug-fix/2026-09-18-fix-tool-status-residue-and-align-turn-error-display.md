# Agent Note: Fix tool status residue and align turn error display

Status: implemented

## Problem

在黑莓 Q20 客户端会话生命周期中存在两处与 `dsh web` 状态脱节的问题：
1. 正常会话自然结束（或多工具调用结束）后，若模型在最后阶段未输出独立的后续正文，历史消息末尾气泡的回退逻辑会误判定最后一条工具依然处于 `running` 状态，并在底部状态条滞留“正在调用工具 [xxx]...”。
2. 当会话遇到上游异常（如 429 限流、鉴权失败、网络断开等）导致本轮运行被 `turn/end`（`reason.kind === 'error'`）打断时，服务端原先在消费 follow 帧时仅统一作 `done` 收尾，导致客户端状态条误显示为“会话已完成”，最下方缺失错误状态条和具体错误卡片。

## Decision

1. **服务端终态与错误事件对齐**：
   - 在 `server.mjs` 中消费 WebSocket `session/follow` 帧时，拦截 `turn/end` 事件；当 `reason.kind === 'error'` 时，将错误原因提炼为标准 `error` 任务事件广播，并设置 `task.status = 'error'`。
   - 在历史转录文件解析 `getSessionHistory` 中，提取 `turn/end` 错误记录，向历史数组追加标准 `{ role: 'error', text, code }` 节点。
2. **客户端渲染与状态条状态机闭环**：
   - 在 `static/index.html` 中，`renderWindowedMessages` 增加对 `msg.role === 'error'` 的渲染支持，展现红底错误卡片及重试提示。
   - `loadHistory` 读取完毕后，若最后一条消息是错误记录，同步将全局会话状态机设置为 `error` 态，并在最下方状态条明确显示 `✖ [错误代码/标题]: 详细原因`。
   - 修复工具气泡与最后助手消息的文本回退逻辑，当工具已完成时坚决不再显示 `(执行中...)` 或 `● 正在调用工具`。

## Alternatives considered

- *方案 A：仅在客户端定时轮询或根据当前 `turn/end` 强制设置全局文本*。被否决，因为没有持久化进入 `getSessionHistory` 历史消息流，在刷新、切换会话后错误信息依然会丢失。
- *方案 B：遇到错误时直接弹窗 alert*。被否决，违反 Q20 小方屏交互体验且脱离 `dsh web` 语义规范。

## Consequences

- 状态条在会话正常结束后准确显示为完成态或就绪态，彻底消除了“正在调用工具”的幽灵状态。
- 当发生异常打断时，最下方状态条精准显示错误红点、错误代码和详细原因，对话流末尾附带标准错误卡片，完全与 `dsh web` 同构对齐。
