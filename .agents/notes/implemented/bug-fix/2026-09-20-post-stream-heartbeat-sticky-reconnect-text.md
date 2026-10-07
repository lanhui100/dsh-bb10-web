# Agent Note: POST 发送流补心跳并消除闪断文案残留与看门狗误杀

Status: implemented

## Problem

Q20 真机消息流底部状态栏反复出现"连接闪断，正在确认会话状态…/连接闪断已重连，会话仍在运行…"，网络正常、会话在跑也必现。此前两次修复（2026-09-19 POST 闪断先对账、2026-09-20 attach 加 15s 心跳）均未覆盖本路径。根因定位见诊断记录 `.agents/notes/archived/bug-fix/2026-09-20-reconnect-loop-diag.md`（已归档，冻结快照）：`/api/chat/stream`（每次发送/R 新建的 POST 流）全程无 SSE 心跳，与有 15s ping 的 attach 不对称；agent 静默期（思考/长工具 30s+ 无事件）连接被掐 → `onerror` → `recoverOrFailSend` 对账 → 每次必弹闪断文案并重挂。server.log 同会话重复 `[ATTACH]` 佐证。

链入：`implemented/bug-fix/2026-09-19-send-transport-flash-reconcile-before-error-card.md`、`implemented/bug-fix/2026-09-20-attach-idle-sse-heartbeat-status-flicker.md`。

## Decision

1. `server.mjs` `/api/chat/stream` 补 15s `sendEvent('ping')` 心跳（与 attach 同构；客户端 POST 解析器对 ping 天然忽略、零 DOM 开销）；终态 `done/error/cancelled` 转发处与 `req.on('close')` 中 `clearInterval`。
2. `static/index.html` `recoverOrFailSend` 对账命中 stillRunning 时：不再写闪断 customText（`syncSessionPhase(checkSid,'running')`），先清 `lastRunningActionText` 并 `renderSessionStatusTail()` 回落"深度求索中…"，再重挂 attach——闪断文案只做瞬时反馈，不再粘住状态尾。
3. 看门狗阈值 `>15000` → `>30000`（服务端 15s 心跳的 2 倍裕量，防抖动误杀）；`stopAttach()` 内补 `attachLastDataAt = 0`，清心跳残留。
4. premature done 防抖（轮询 2 次 miss 才收口）本次不做：窗口小（需截断 chunked + Q20 阶段 3 不吐数据），留待复现再议。

## Alternatives considered

- *方案 A：前端彻底不显示闪断文案（静默对账）*：否决。掩盖真实传输故障信号，且 POST 流照样死。
- *方案 B：POST 改短请求 + 展示全走 attach*：根治但需服务端首帧路由与 ack 语义改造，属中长期项。
- *方案 C：只调大看门狗阈值*：修不了主因（POST 无心跳照样被掐），仅作组合项 ③。
- *方案 D（采纳）：POST 加 15s ping + 文案去粘性 + 看门狗留余量*：改动最小、与既有 attach 心跳机制同构、ES5 安全。

## Consequences

- POST 流静默期有字节保活，空闲被掐概率大幅下降；偶发真断对账照旧但不再残留"闪断已重连"；看门狗不再误杀健康 attach。
- 门禁：ES5 PASS、`node --check server.mjs` 通过、`test-decoupling.mjs` 与 `test-suite.mjs`（7/7）通过。
- 机械验证：`node -e 'require("acorn").parse(fs.readFileSync("static/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1],{ecmaVersion:5})'` 零退出；`node test-suite.mjs` 全 PASS。
