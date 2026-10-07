# Agent Note: 运行中追发消息排队灰气泡回显

Status: implemented

## Problem

运行中追发（`sendRunningPrompt`，`static/index.html`）点击发送后直接以正常橙色气泡落位，
与服务端是否真正受理无关：`POST /api/session/prompt` 是异步 XHR，若宿主拒绝
（`ok:false`）、网络闪断或 HTTP 非 200，用户看到的橙色气泡与“已发出”无区别，
排队态不可见。上游 dsh web 对此有显式语义：`session.beginSubmission` 在序列化与
发送之前同步写入 `SessionSnapshot.pendingSubmissions`，运行中 `queue` 模式回显
`placement: 'queued'`（`steer` 为 `steering`，空闲为 `transcript`），回执失败立即
退休、落定（durable `user/message` 或 inbox occurrence）后延迟一帧退休；Q20 尚无对应回显。

关联上下文：追发双模式见
[2026-09-20-running-send-queue-steer-mode.md](2026-09-20-running-send-queue-steer-mode.md)；
上游回显语义见 `session.ts` `beginSubmission` / `scheduleObservedRetirement`。

## Decision

`static/index.html`（ES5，静态 HEX，无 CSS 变量），仅运行中追发链路：

1. 新增 `.msg-user.msg-queued` 灰色排队态（`#555555` 底、`#D0D0D0` 字，与正常橙色
   `#D96B27` 同盒模型），`sendRunningPrompt` 内 `appendMessage('user', prompt)`
   返回气泡后立即追加该类——发出当帧即灰，落位消息流最底部；
2. XHR `readyState === 4` 首行用正则去类转正（成功/失败/HTTP 异常三路统一转正，
   失败由既有 toast + 状态行诚实报错，不保留灰态误导）；
3. 空闲 `doSend` 零改动（`start` 事件即受理，无排队窗口）。

## Alternatives considered

- **等历史快照出现再转正**：更贴近上游“落定退休”，但 Q20 无常驻订阅，
  需轮询 `/api/history` 或等 attach `sync`，慢且多一次 Zstd 解码（双核负担）；
  否决，追发回执 `ok:true` 即转正（与上游 blank 在 ACCEPTANCE 翻转同口径）。
- **灰泡常驻到下一轮回答开始**：排队消息可能等整轮，灰态久留易被误读为失败；
  否决，回执即转正，排队语义由 toast `已排队发送 [queue]` 承载。
- **空闲 doSend 同加**：空闲发送无排队窗口，`start` 事件即受理；多改多测无收益；
  否决，保持最小改动面。

## Consequences

- 运行中追发发出当帧灰泡落底，回执到达转正橙色；失败转正 + toast/状态行报错，
  不再有“发出即成功”的误导。
- 新增门禁：ES5 门禁（既有）+ `test-unit.mjs` 14b 静态接线新增 `msg-queued` /
  `queuedBubble` 断言；README 快捷键表同提交补一行灰泡说明。
