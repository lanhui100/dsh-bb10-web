# Agent Note: 会话消息流按 dsh web 时序保序（seq + 单 delta 通道）

Status: implemented

## Problem

会话消息流偶发工具与 agent 消息次序错位：工具胶囊出现在回答文本之后、思考卡片插到生成文本中间、或同一文本重复/乱序。dsh web 用单调 `seq`（`assembler.insertionIndex` 二分 + `replace` 全量排序 + `settleAssistant` 原位替换）保证时序，arrival order 永不决定位置；Q20 侧四处偏离：

1. `server.mjs` 主发送路径 follow open 缺 `assistantStream: true`（attach 路径有），双通道语义不一致；
2. `createSessionEventHandler` 把 transient chunk 与 durable `assistant/message` slice-diff 当作两个独立 delta 源，无 seq、无去重，重叠文本重复/乱序；
3. chunk 类型白名单漏掉上游唯一的 `reasoning-delta`（只认 thinking/thought-delta），思考流失配；
4. 前端 attach/send 两条渲染路径纯 arrival-order `appendChild`（注释明示）。

## Decision

对齐 dsh web 时序模型，做五处收敛（行为变更前后端各二 + 测试一级）：

1. 主发送路径 follow open 补 `assistantStream: true`，与 attach 路径一致；transient chunk 为唯一打字机源；
2. 新建 `lib/stream-fold.mjs`（`createStreamFold`）：durable settlement（`assistant/message|attempt`，surfaceOp 必须 append 且 turn/step 均为 number）暂存、frame `end/committed` 释放；transient chunk 按 `frame.index` 连续性校验，断裂只发 `rebaseline` 信号不清现场（与上游同构），`turn/end` 到达时 `flushPending()` 冲刷兜底；`publishedSeqs` 去重重试/重复 settlement；
3. 新建 `lib/session-events.mjs`（`createSessionEventHandler(task, deps)`，无自由依赖）：usage 结算与暂存解耦（durable 到达即结算，rebaseline 永不丢 usage）；`assistant/message` 不再 slice-diff 发 delta，只做终态校准（`done` 用 `finalResponse` 全量替换）与 publish 兜底；`abandonment` 按 attemptId 回滚 transient 文本；
4. chunk 白名单补 `reasoning-delta`；`broadcastTaskEvent` 附 task 内单调 `seq`（`_seq` 随 SSE data 同帧透传，客户端可见、可测），重放按 seq 排序后 burst；
5. `test-unit.mjs` 时序契约直驱真 handler 交织（H1–H5）+ fold 语义（S1–S4），替纯字符串断言。

## Alternatives considered

1. **前端按 seq 重排 DOM**：需服务端先有 seq，且 DOM 重排在 Q20 双核上成本高于源头保序；否决，只做源头保序，前端保持 arrival-order（源头已保序时等价）。
2. **直接透传 durable seq**：Q20 SSE 通道内保序只需全序，durable seq 在 SDK 本地路径缺失/不连续；否决，用 task 本地单调计数器。
3. **保留双 delta 通道 + 前端去重**：重复/乱序在传输层交织，去重窗口难定且治标；否决，单通道是 dsh web 同构（transient 唯一，settlement 只结算）。
4. **不动服务端、只修前端排序**：服务端双通道重复不消除，排序键缺失；否决。

## Consequences

- 同一文本只走 transient 通道一次，durable 结算只做终态全量替换：重复/乱序消除；
- frame 断裂触发 rebaseline 而非静默错位：与 dsh web 一致的 fail-safe；
- `test-unit.mjs` 新增 fold 契约测试（双通道去重、index 断裂、durable seq 存在性），ES5 门禁与全量回归保持绿。

## 已知残留（非本条范围，靠 review）

- ~~跨通道竞态：`tool/call|result` 与 `thought` 直播仍绕 fold 直接广播，工具胶囊 vs 文本的相对次序仍由到达 race 决定；正解是前端按 `_seq` 重排渲染（另立 proposed），本条仅收敛文本单通道 + seq 可见性。~~
  → 已解决（6aae7f2）：真机复现证明 SSE 线序正确（`_seq` 1→10 单调、无重复），病在前端渲染把多 step 文本拼进同一气泡。现工具 `call` 到达即封口当前气泡（`liveTextBubble/attachTextBubble=null` + send 路径 `bubbleText=''`），后续 delta 建新气泡；`done` 仅 transient 全丢时用 finalResponse 兜底。`foldTurnGroupInDom` 天然把中间 step 气泡收进“ N 条消息”过程行、最终回答保持可见，与 dsh web 同构。
- `seq` 是 task 内到达计数器（非 durable seq）：同一 task 内全序成立，跨重连/双 task 不保证；replay 排序仅对 burst 有效，live 路径仍 arrival-order 直发（但源头单通道后等价）。
