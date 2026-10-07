# Agent Note: 彻底对齐消息流底部状态与列表头部状态图标的计算逻辑与即时同步

Status: implemented

## Problem

在会话消息流中，底部状态组件（`renderSessionStatusTail`）与会话面板列表中各会话项头部的状态图标（`sessionStateMark`）存在明显的计算逻辑不一致，主要体现在两个方面：
1. **相态计算分叉与 waiting 降级**：
   - 头部图标基于 `sessionStateMark(s)`，严格遵循 dsh web 的优先原则；然而原 `normalizeSessionState` 中第一行无条件 `if (s && s.isRunning) return 'running';`，导致提问等待用户作答（`waiting` / `pendingInteraction`）被强制截断为普通运行中（蓝点 `●`），底部状态栏也无法渲染黄色的 `? 等待回复…`。
   - `resolveEffectiveSessionState()` 在后台接入流（`attachSession`）活跃时，若本地 `activeXhr === null` 且未拉取到快照，错误将后台会话误判为已完成（`done`），导致发送按钮过早恢复为发送态。
2. **状态更新滞后（Lag）与旧快照回冲**：
   - 本地主动发送流或收到终态（`done`、`error`、`cancelled`、手动停止）时，仅修改本地 `sessState` 变量，未即时乐观写回 `sessCache[cwd]`。
   - 当 stream 结束执行 `readyState 4` 收口时，因 `sessCache` 尚未刷新，`resolveEffectiveSessionState()` 读取旧快照的 `isRunning: true`，将状态错误拉回 `running`，必须等待 5 秒轮询返回后才纠正，导致底部状态组件出现严重的计算错误与滞后。

## Decision

1. **统一相态归一化优先级（`normalizeSessionState`）**：
   将 `waiting` 与 `pendingInteraction` 置于 `s.isRunning` 之前，严格对齐 dsh web 状态机优先级（`pendingInteraction > running > subagents > completed > idle`），确保提问等待态在头部显示黄点 `?`，在底部显示 `? 等待回复…`。
2. **引入统一乐观同步入口（`syncSessionPhase`）**：
   所有状态跃迁（发送开始、接收终态事件、stream/attach `readyState 4` 收口、提问弹出/作答/取消、手动停止）统一收敛至 `syncSessionPhase(sid, phase, customText)`：
   - 立即同步 `sessState.running` 与 `sessState.phase`；
   - 立即乐观写回 `sessCache[cwd]` 中该会话项的 `isRunning` 和 `state`；
   - 联动 `renderSendButton()` 与 `renderSessionStatusTail()`；
   - 若会话面板处于打开状态，同步即时重绘会话树列表（`renderSessTree()`），确保头部与底部毫秒级同源同态。
3. **加固权威状态推导（`resolveEffectiveSessionState`）**：
   - 将 `questionState.visible` 置于最高优先级，确保提问作答态权威锁定为 `waiting`；
   - 网络活动检测涵盖 `(activeXhr !== null || attachXhr !== null)`，根治后台 attach 会话被误报 done 的漏洞；
   - 引入终态粘性保护（Terminal State Stickiness），防止本地确立的明确 `error` 或 `stopped` 终态被服务端的陈旧空快照回冲。

## Alternatives considered

- *方案 A：底部状态组件完全改为纯异步拉取 `/api/sessions` 刷新*：
  否决。网络往返存在数十至数百毫秒延迟，无法满足流式生成与点击停止的即时界面反馈（Instant Feedback）要求。
- *方案 B：仅在 readyState 4 时粗暴延时 500ms 重绘*：
  否决。定时器存在竞态隐患，在弱网或高并发下仍会穿透旧快照，无法从根本上解决滞后与不一致。

## Consequences

- 头部列表图标与底部状态组件 100% 同源同态，彻底消灭两者状态脱节与 5 秒轮询滞后。
- 提问（ask_user_question）在头部与底部同构呈现黄点 `?` 与等待回复文案，保持可中断红色停止按钮。
- 自动化契约测试新增 `syncSessionPhase` 乐观写回与 `normalizeSessionState` 优先级守卫，16 项全绿通过。

## 对抗性审核调优（Red Team Review Hardening）

经 Agent Team 对抗审查员（Red Team Reviewer）深度审计，补齐以下四项生命周期与竞态加固：
1. **停止/切换生命周期闭环**：在 `stopStreaming()`、`startNewChat()`、`selectSession()`、`selectWorkspace()` 中强制调用 `hideQuestionPanel()` 与中断残留的 `activeXhr`，彻底根除提问态停止死锁与幽灵连接；
2. **跨会话推流隔离与代次保护**：在 `doSend()` 闭包中捕获发起时代次与 `sendSid`，在 `xhr.onreadystatechange` 顶部第一行拦截过期代次回调，杜绝跨会话 ABA 串流踩踏；
3. **终态粘性收敛**：`resolveEffectiveSessionState()` 严格尊重服务端的有效终态，仅当服务端快照为 `idle` 且本地存在明确终态时才暂存，消灭已完成会话误报 error；
4. **后台提问防视口劫持**：`showQuestionPanel()` 增加会话归属校验，后台会话提问仅更新缓存并触发通知，严禁遮挡当前前台会话；`syncSessionPhase` 支持新建会话乐观插入，消除双重 DOM 重排。
