# Agent Note: 排队消息认领即清槽 + 等待作答会话的 waiting 状态贯通

Status: implemented

## Problem

BB10 客户端两个状态机缺陷（2026-10-19 用户报告）：

1. **已发出的追发消息仍显示「排队」**：运行中追发（queue 模式）只登记前端内存槽并渲染底部 `#queue-dock`（`static/index.html` sendRunningPrompt / renderQueueDock）。清槽只绑定「回合终态 / 快照 running=false」这类粗粒度事件；上游真正认领该队列项（新一轮 `user/message` 落转录）时没有任何信号，且 running 期间的 sync/history/切回路径反而无条件 `restoreQueuedPrompt`，把已执行消息重新渲染为「排队」，形成僵尸槽。
2. **等待用户作答的会话在会话列表头部显示蓝色 running**：前端 `normalizeSessionState` 已支持 `waiting → 黄 ?`，但服务端状态集只有 `running|done|stopped|error|idle`，宿主 `session/list` 也不带 `pendingInteraction`（该字段在 dsh 中是客户端插件域，非 RPC 事实）。因此除本进程活跃 task 的 SSE `question` 临时改写外，等待作答会话恒被渲染为蓝 `●`，刷新页面后无任何可达等待事实。

## Decision

以「最小闭包 + 单一事实源」补齐两条因果链，不新增对外接口、不改上游协议：

1. **认领信号**：`lib/session-events.mjs` 对**非 steer** 的 `user/message` durable 事件广播 SSE `prompt-claimed { text }`；前端 attach 与 live 两条 SSE 分支收到后按归一化文本（空白折叠 + 前缀匹配，空文本一律不匹配）清除对应会话槽，**不追加气泡**（历史同步负责正式渲染，杜绝重复）。
2. **防僵尸**：新增 `allMessagesSid` 归属标记；`restoreQueuedPrompt` 与追发 ok 回包在恢复/重写槽前，仅当同会话历史中已存在匹配 user 文本时判定「已被历史接管」并清槽。L3 复审后收紧三点：① 槽记录 `baseUserCount`（排队前已有 user 消息数），只比对基线之后的 user 消息，避免重复 prompt（再发「继续」）被旧气泡误判；② attach 分支的 `prompt-claimed` 仅 `replay_end` 之后生效（回放 burst 中的旧帧不得清掉新排的槽），live 分支只用确定 sid；③ 本地历史加载不得把「仍有排队槽或会话列表快照仍 running」的会话降级 done（否则切回/静默轮询会误清槽），`selectWorkspace` 仅真正换工作区才作废排队槽；另设 5s 静默 loadHistory 兜底（仅当前会话有槽且 running），应对 turn/end 关流后认领帧送不到的情形。
3. **waiting 事实下沉服务端**：新增纯函数模块 `lib/session-waiting.mjs`（`hasPendingQuestionFromEvents` 等，零 IO）；
   `server.mjs` 新增 `sessionPendingQuestion(zstdPath, task)`：① `task.pendingQuestion` 内存真源优先；② 否则读转录尾部 ≤30 zstd 帧，判定「存在 `tool/call` name=`ask_user_question` 且其 callId 无 `tool/result` 结算」；结果按 `path:mtime:size` + 2s TTL 缓存。
   `/api/sessions` 四处行构造（含 ungrouped）统一走 `sessionRowState`，running 且等待作答时输出 `state:'waiting'` + `pendingInteraction:'question'`，`isRunning` 保持 `true`（对齐 dsh：running 与 pendingInteraction 正交）；`/api/sessions/status` 同口径。
4. **前端归一化**：`normalizeSessionState` 增加 `pendingInteraction` 优先分支；既有 `applyLightStateToRow`/`resolveEffectiveSessionState` 的 waiting 通道因此生效（黄 `?`，可停止）。

验证：冻结红相 A1-A7（`tests/acceptance/suite-statusqueue-core.mjs` / `suite-statusqueue-browser.mjs`）先红后绿；ES5 acorn PASS；`test-decoupling.mjs`、`tests/acceptance/run-all.mjs`（6 套件）、`test-unit.mjs`（35/35）全绿；浏览器 A5/A6/A7 Console Error=0 + 截图收据。

相关既有决策：停靠区隔离与样式（`implemented/feature/2026-09-22-running-send-bottom-dock-isolation.md`、`2026-09-23-queue-steer-dock-bubble-style.md`）、切会话恢复分槽（`implemented/bug-fix/2026-09-26-restore-queued-prompt-on-session-switch.md`，其「running 即恢复」规则被本文防僵尸守卫部分取代）、跨会话提问隔离（`implemented/bug-fix/2026-09-29-q20-ask-user-question-cross-session-isolation.md`）。

## Alternatives considered

1. **仅前端历史文本比对（不加 SSE 信号）**：改动更小，但认领后需等下一次历史同步才清槽，且无 attach 的静默场景（后台运行、SSE 静默 EOF）仍会滞留——保留为兜底，不作为唯一通道。
2. **向上游扩展 RPC/事件（用 `agent/inbox/claimed` 或 itemId 关联）**：上游 `agent/inbox/claimed` 仅为进程内 emit、不落 durable；`session/prompt` 不返回可用 itemId。擅自扩展协议违反既有「最小闭包 + 上游对齐」约束，且本工程承诺不 vendor 上游。
3. **服务端读取 `session/list` 的 `projections.values.userQuestions.active`**：实测真实宿主 4319 行中该投影 active 恒为空（只记 timed schema），不能作为等待事实；转录尾部判定与既有 `sessionTerminalState` 同窗口，成本与一致性都可控。
4. **只信任内存 `task.pendingQuestion`**：实时准确，但页面刷新、进程重启、非本进程驱动的会话全部丢失等待态——必须叠加转录推断。

## Consequences

- 新增 SSE 事件类型 `prompt-claimed`，旧客户端忽略未知事件不受影响；新客户端不追加气泡，避免与历史重复渲染。
- `sessionPendingQuestion` 与 `sessionTerminalState` 共用 30 帧尾部窗口：更早的未结算提问（理论上会被后续事件覆盖）会漏判，属契约允许的降级，不产生误报。
- `/api/sessions`/`/api/sessions/status` 增加可选字段 `pendingInteraction`，仅在等待时出现，既有消费方字段形状不变。
- BB10 侧新增代码全部 ES5（var/function/正则），未引入新依赖。
