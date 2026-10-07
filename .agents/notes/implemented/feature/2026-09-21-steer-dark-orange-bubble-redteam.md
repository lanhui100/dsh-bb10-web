# Agent Note: 插队深橙气泡与红队副作用收口

Status: implemented

## Problem

运行中追发双模式（`queue`/`steer`，见
[2026-09-20-running-send-queue-steer-mode.md](2026-09-20-running-send-queue-steer-mode.md)）
此前共用灰色排队泡（见
[2026-09-20-running-send-queued-grey-bubble.md](2026-09-20-running-send-queued-grey-bubble.md)）：
插队消息实时进入消息流却渲染为“排队等待”灰态，语义错误；且非运行时
即使切到插队档，发出消息也不应带排队/插队态（两模式只针对运行态）。

## Decision

`static/index.html`（ES5，静态 HEX，无 CSS 变量），仅追发链路：

1. 拆分两态：排队=灰泡（`#555555`/`#D0D0D0`，沿用），插队=深橙泡
   `.msg-user.msg-queued.msg-steer`（`#A9521A` 白字，比正常暖橙 `#D96B27`
   暗一度；三类选择器特异度+声明顺序双保险必胜）；
2. `appendMessage(role, text, queueKind)` 第三参数仅运行中追发传入 `mode`，
   `isSteer = isQueued && queueKind === 'steer'`；老二参调用与空闲 `doSend`
   零改动（`isRunning=false` 时 `isSteer` 恒假，非运行一律正常态）；
3. 红队对抗采纳（B/C 重叠 must-fix）：失败转正经 `normalizeQueuedBubble`
   同步剥 DOM 双类+清 `allMessages` 旗标+补操作条；追发用 `myItem` 局部对象
   + `pendingQueuedItem === myItem` 守卫防单槽竞态；快照替换/历史替换/
   done/cancelled/error/新建/切会话/换工作区清槽；无槽时按气泡
   `msg-steer` 类名推导撤回模式。
4. 同提交同步：`test-unit.mjs` 14b 静态接线新增 `msg-steer` /
   `normalizeQueuedBubble` / `pendingQueuedItem = null` 断言；
   README 中英文快捷键表更新为“排队=灰泡，插队=深橙泡”。

## Alternatives considered

- **插队沿用灰泡**：实现零改动，但灰=排队等待语义与“已进入消息流”矛盾；
  否决，拆深橙。
- **插队用正常暖橙**：与普通消息无区分，用户无法感知已介入；
  否决，暗一度深橙。
- **nit 全修（C-D 单槽改数组、N1 按身份匹配撤回、F 轮次计数剔除排队）**：
  改动面超出本次语义修复，且 Z 撤回成功路径已有 fallback 覆盖；
  否决，留待后续专项。
- **idle `mode` 透传服务端（B-N2）**：`server.mjs` `/api/chat/stream`
  缺省 `queue` 且 `runChatViaHostRpc` 归一化；空闲发送本就新建轮次，
  mode 无实质影响；否决，保持现状。

## Consequences

- 运行中排队=灰、插队=深橙，非运行一律正常暖橙；失败转正不再被窗口重渲染复活。
- 门禁：ES5 PASS、`test-decoupling.mjs` + `test-suite.mjs` 7/7、
  `test-unit.mjs` 19/19。
