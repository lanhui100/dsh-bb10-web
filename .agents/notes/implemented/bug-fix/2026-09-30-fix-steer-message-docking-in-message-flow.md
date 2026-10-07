# Agent Note: 修复插队消息停靠区沉底未入消息流问题

Status: implemented

## Problem

在运行中追发模式下，用户将模式切换为“插队”（`steer`）并成功发送后，虽然消息已成功被上游接受并在 step 边界生效，但在前端会话消息界面中，插队消息仍然停留在底部的 `#queue-dock`（或被误当作排队消息处理），没有在执行时进入正常顺序的消息队列中，后续生成的助理回复也无法按照正常对话顺序呈现。

根本原因在于：
1. 之前的隔离改造将 `steer` 与 `queue` 一同拦截在底部停靠区 `#queue-dock` 中，未能感知到上游会话流中实际执行并认领中途引导（`user/message`）的事件时机；
2. 服务端在解析会话 durable 事件流（`session-events.mjs`）时，没有将上游认领的 `user/message`（即 steering interjection）向客户端派发 `steer` SSE 事件；
3. 前端在收到推流时缺乏对 `steer` 事件的响应，没有及时封口当前 assistant step 并将插队消息作为正式用户气泡插入消息流中。

## Decision

对齐官方 DSH Web 的 Steering 流转行为（`dsh-subagent` / `dsh-ui-chat`）：

1. **服务端事件派发**：
   在 `lib/session-events.mjs` 的 `handleSessionEvent` 中补充对 `user/message`（`source.kind === 'user'`）中途插入消息的识别，向客户端广播 `steer` 事件（带文本、时间戳和单调 seq）。
2. **前端流式接管与 step 封口**：
   在 `static/index.html` 的推流循环（`POST /api/chat/stream` 与 `GET /api/session/attach`）中新增对 `steer` 事件的处理：
   - 收到 `steer` 时立即清空底部停靠槽（`clearQueueDock()`）；
   - 封口结算当前的助理回复气泡（`flushRender()`），清空局部 step 文本；
   - 通过 `appendMessage('user', data.text)` 将插队消息按真实时序插入消息容器；
   - 为后续模型吐字开辟新的助理容器包装层（`assistantWrap`），确保后续生成的回复正常排在插队消息下方。

## Alternatives considered

- **前端发送成功时立即假定插队并直接插入消息流**：不符合上游事件驱动事实，若上游因轮次结束而将 steer 退化或延迟认领，会导致界面呈现与实际模型输入时序脱节；否决。
- **沿用等待轮次结束（done）再通过 /api/history 重载历史**：在长文本或多工具调用的复杂轮次中，用户在生成期间完全看不到插队消息落位，造成插队失败的假象；否决。

## Consequences

- 插队消息在上游真正认领并生效时立即退出底部停靠区，按正常时序插入消息流，后续生成的回复自然在其下方追加。
- 严格遵循 BlackBerry Q20 的 ES5、静态定位与无 CSS 变量规范，通过 Acorn 静态语法门禁与全套自动化回归测试。
