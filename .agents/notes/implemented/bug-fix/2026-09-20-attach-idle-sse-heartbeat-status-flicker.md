# Agent Note: attach空闲SSE加心跳并消除状态灯误报

Status: implemented

## Problem

会话运行中底部状态小组件偶发"网络断连重连"闪跳：`server.mjs` `/api/session/attach`（L3977-4158）live 与 poll 分支均无 SSE 心跳，空闲 tick 线上无字节，中间层掐空闲长连接；前端 `static/index.html` `xhr.onerror` 直接画 error 红卡（L7493-7498），`attachLastDataAt` 在 `onreadystatechange` 无条件刷新（旧 L7125），看门狗与重挂逻辑被误导，5s 轮询拉回 running 后形成"红卡/闪断↔运行中"闪跳。

链入 `.agents/notes/implemented/bug-fix/2026-09-19-send-transport-flash-reconcile-before-error-card.md`（POST 闪断先对账）与 `.agents/notes/implemented/bug-fix/2026-09-18-fix-completed-session-running-state-residue.md`（attach 看门狗）。

## Decision

1. `server.mjs` attach live 分支（L4039-4068）与 poll 分支（L4073-4086）各加 15s `sendEvent('ping')` 心跳，终态 done/error/cancelled、req close、poll 提前退出、静态快照结束、catch 均清理定时器。
2. `static/index.html` attach 解析遇 `event: ping` 直接 `continue`（L7155-7159），`attachLastDataAt` 仅在 ping 或真实事件块到达时更新（L7161），删除旧 L7125 无条件更新。
3. `xhr.onerror`（L7498-）不再直接 `setStatus error` 画红卡，改为代次守卫后仅在 `sessState.running` 且同会话、无本地流时静默 `attachSession` 重挂。

## Alternatives considered

- *方案 A：只加服务端心跳不动前端*：否决。心跳减少掐线，但偶发真断开仍会画红卡闪跳，误报路径未根除。
- *方案 B：只改前端静默重挂不加心跳*：否决。空闲连接仍无字节，代理掐线频繁，重挂风暴增加服务端 `/api/sessions` 轮询与 Zstd 扫描负担。
- *方案 C：心跳周期 5s*：否决。与前端 5s 轮询叠加，在 Q20 双核上开销过大；15s 足以保活且 ping 帧被前端忽略不触 DOM。

## Consequences

- 空闲 attach 连接每 15s 有字节，代理不再掐线；偶发断开静默重挂，状态灯不再闪红。
- 门禁：ES5 PASS、`node --check server.mjs` 通过、`test-decoupling.mjs` 与 `test-suite.mjs`（7/7）通过。
