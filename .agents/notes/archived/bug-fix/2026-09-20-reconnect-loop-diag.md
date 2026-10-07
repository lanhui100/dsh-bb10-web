# Agent Note: 状态栏"连接闪断/重连"提示反复出现——诊断记录

Status: archived

> 本文是**诊断记录**（非已落地决策）：只分析和定位，不包含任何代码修改。
> 行号依据当前工作树（HEAD 6da239a，运行中的 server.pid 2273447 所服务的同一棵树）。
> 链入既有决策：`.agents/notes/implemented/bug-fix/2026-09-19-send-transport-flash-reconcile-before-error-card.md`
> 与 `.agents/notes/implemented/bug-fix/2026-09-20-attach-idle-sse-heartbeat-status-flicker.md`（本次现象是这两个修复未覆盖的残留路径）。

## Problem

BlackBerry Q20 真机（WebKit 537.35）上，消息流底部状态栏**反复出现**"连接闪断，正在确认会话状态… / 连接闪断已重连，会话仍在运行…"一类的提示，用户反馈：即使网络正常、会话正在跑，提示仍然出现（此前修过一次仍复现）。要求：找出提示反复出现/残留的确切代码路径与根因，不修改任何源码。

## 现象与复现路径

1. 用户每次发送新消息或按 R（"继续"，`static/index.html` L8984-8987 直接 `doSend()`）→ `doSend()` 新建一条 `POST /api/chat/stream` 流（L8080）。
2. 该流与 attach 流不同：**全程没有任何心跳/keepalive 字节**（见下证据）。agent 进入静默期（模型思考、长工具执行、子智能体等待，dsh 运行中常见 30s+ 无事件），Q20 的 WebKit/系统电源管理/中间层（EdgeOne/Traefik，见 `k8s-q20-ingress.yaml`）按空闲超时掐断连接。
3. 客户端 `xhr.onerror` 触发（L8340-8353）或 readyState 4 非 200（L8294-8298）→ 进 `recoverOrFailSend()`（L7876-7943）：
   - L7900 `setStatus('连接闪断，正在确认会话状态...', 'running')`
   - 对账 GET `/api/sessions` 后仍 running → L7925 `syncSessionPhase(checkSid, 'running', '连接闪断已重连，会话仍在运行...')` → L7926-7927 `updateSessionsBackground` + `attachSession` 重挂直播。
4. attach 重挂后回放 burst（replay_end 之前被门控，L7372/7403/7470 不 setStatus），静默期无新文案 → 状态栏**长时间残留**"连接闪断已重连"。
5. 下一轮再发/R → 又一条新 POST 流 → 静默期再断 → 再闪 → **每次发送重复一次**；会话本身在服务端照跑（断线保活），网络无恙，"正常网络下也反复出现"成立。

## 根因分析

### 主根因（Primary）：`/api/chat/stream`（POST 发送流）无 SSE 心跳，与 attach 流不对称

- `server.mjs` L4194-4402 `/api/chat/stream` 全程：`taskListener`（L4266-4273）只做事件转发，**没有任何 `sendEvent('ping')`/setInterval**；全文件 `setInterval` 仅 3 处——L3118（会话/限速清理）、L4059（attach live 心跳）、L4076（attach poll 心跳）。即**心跳只存在于 attach 两端点，POST 流为零**。
- 对照：`/api/session/attach` live 分支 15s ping（L4059-4061）、poll 分支 15s ping（L4076-4078）——上次修复让 attach 存活，**唯独 POST 流仍裸奔**。
- 服务端断线保活（L4277-4281 `req.on('close')` 只摘监听、任务照跑）是**有意设计**（见 2026-09-19 ADR），但它把"连接被掐"的责任全部转嫁给客户端对账；而对账必然弹出闪断文案。
- Q20 侧证据：客户端代码自己承认"WebKit 未在 readyState 3 分块处理"的历史问题（L8301 注释兜底），说明该内核流式接收本就不稳；再叠加 BB10 系统级空闲无线/后台挂起，静默长连接被掐是高概率事件。
- 服务端日志佐证重复重挂：`server.log` 中 `session-mu9b3q8bxraoyg`、`session-144a4f08-...` 各出现 2 次 `[ATTACH] Attaching live SSE stream`，即一次运行内多条 attach 连接（对账重挂 + 轮询/onerror 重挂叠加）。

### 次因 1（Sticky 文案残留）：闪断文案写进 `lastRunningActionText`，静默期不消失

- L7925 的 customText 经 `syncSessionPhase`（L2061：`phase==='running' && customText` → `lastRunningActionText = customText`）持久化；L7900 的 `setStatus(...,'running')` 同样写（L5450）。
- 状态栏渲染 `rawText = customText || lastRunningActionText`（L5489），"连接闪断已重连…"不含 L5491 的无效文案黑名单词 → 直接显示；只有**下一条 running 文案**（如 attach 实时 delta 的 L7474 '● 对话后台生成中...'）或相位变更才会替换。
- attach 重挂后的回放期（replayDone 门控）与 agent 下一次静默期都不触发新文案 → 用户在"会话在跑、网络正常"时也持续看到"闪断已重连"。**残留感由此而来**；"反复"则由主根因（每轮新 POST 流必断）而来。

### 次因 2（看门狗 15s==15s 竞态）：`checkAndReattach` 阈值与服务端心跳周期相等，Q20 事件循环抖动下误杀健康 attach

- attachLastDataAt 更新点：L7208（挂载）、L7285（ping）、L7290（数据块）；看门狗 L9118 阈值 `> 15000`，服务端心跳周期 15000ms（L4059-4061）——**差 0 余量**。
- 看门狗仅在 focus/pageshow/visibilitychange 触发（L9130-9137），BB10 灭屏/后台挂起期间计时器停摆，唤醒瞬间 attachLastDataAt 必然过期 → L9119 `stopAttach()` 强杀健康连接 + L9126 重挂。静默（无文案），但造成重复 attach 挂载与回放重渲染闪烁，与日志中的重复 ATTACH 相符。
- 附带缺陷：`stopAttach()`（L7192-7200）不清 `attachLastDataAt`（幸存值在重挂前的一瞬仍被 L9118 误读）。

### 次因 3（边缘）：POST 流以 200 截断收口时客户端可能"提前 done"，再被 5s 轮询拉回 running，文案跳变

- POST 流若在 done 帧不完整时 EOF（截断的 chunked），readyState 4 status 200 → L8299-8333 else 分支直接 `syncSessionPhase(...,'done','会话已完成')`（L8329）。
- 随后 5s 轮询 `loadSessions`（L9143-9162）带回 running 快照 → L7081-7085 又置 running 并 re-attach → 状态在"已完成↔深度求索中"间跳变。窗口小（需 Q20 在 3 阶段不吐数据 + 截断），列作次要。

## 修复建议（不实施，仅供实施方参考）

1. **[server，主修] 给 `/api/chat/stream` 补 15s 心跳**，与 attach 完全对称：
   - `server.mjs` L4274 附近（`task.listeners.add(taskListener)` 之后）加 `const postHb = setInterval(() => sendEvent('ping', { sessionId: effectiveSessionId, t: Date.now() }), 15000); if (postHb.unref) postHb.unref();`
   - 在终态转发处（L4268-4272，`done/error/cancelled`）与 L4277-4281 `req.on('close')` 中 `clearInterval(postHb)`。
   - 语义：客户端 POST 解析器（L8103-8285）对 `event: ping` 无匹配分支、`data` 仅 `{sessionId,t}` 无副作用 → 自动忽略，零 DOM 开销；与 attach 心跳同机制，真机已验证可行。
2. **[client，修残留] 闪断文案不粘 `lastRunningActionText`**：
   - L7925 改为 `syncSessionPhase(checkSid, 'running');`（不带 customText），并在 L7927 `attachSession` 后补一次 `renderSessionStatusTail()`；文案交给 attach 实时事件接管，静默期回落"深度求索中…"。
   - L7900 的 `setStatus('连接闪断，正在确认会话状态...', 'running')` 同样避免写 `lastRunningActionText`（改走瞬时渲染或加 sticky 开关参数）。
3. **[client，减抖动] 看门狗阈值留余量 + 清残留**：
   - L9118 `nowTs - attachLastDataAt > 15000` → `> 30000`（心跳 15s 的 2 倍裕量）；
   - L7192-7200 `stopAttach()` 内补 `attachLastDataAt = 0`；L7631-7633 attach onerror 置空 `attachXhr` 时同清。
4. **[client，可选] premature done 防抖**：L7086-7103 的"快照 !isRunning → done 收口"改为连续 2 次轮询 miss 才收口，避免与宿主 10s 快照缓存竞态跳变。

## Alternatives considered

- **方案 A：前端彻底不显示闪断文案（静默对账）**：已由 attach onerror 的静默重挂（L7634-7636）部分实现；但 POST 流照样死、日志照样抖，且会掩盖真实传输故障信号。否决（仅作 ②的辅助）。
- **方案 B：POST 发送改短请求 + 展示全量走 attach（对齐 dsh web 语义）**：根治且符合 AGENTS.md 管道收口（POST 只承载 start/ack，展示由带心跳的 attach 承担）；但需服务端新会话首帧路由与 ack 语义改造，属中长期项，不在本次最小修复内。
- **方案 C：只调大看门狗阈值**：修不了主因（POST 无心跳，静默期照样被掐），仅减抖动。组合使用（即 ③），单独不成立。
- **方案 D（采纳）：服务端给 POST 流加 15s ping（①）+ 前端文案去粘性（②③）**：改动最小、与既有 attach 心跳机制完全同构、真机已验证该机制可行。主根因（不对称心跳）与残留感（sticky 文案）同时消除。

## Consequences

- 若按建议实施：POST 流静默期有字节保活，空闲被掐概率大幅下降；偶发真断时对账照旧、但不再残留"闪断已重连"文案；看门狗不再误杀健康 attach，重复挂载抖动收敛。
- 服务端需配合 ①（本质是 3 行 heartbeat 代码），前端 ②③④ 需同步发版；改动均 ES5 安全、不触碰状态机契约。
- 说明：若确认观察到的只是"每轮发送后的短暂闪断文案 + 残留"，则属**设计缺陷（不对称心跳导致的可预期传输中断）而非正常设计**；"断线保活 + attach 重挂"本身是正确设计，错在 POST 通道未获得与 attach 同等的保活待遇。