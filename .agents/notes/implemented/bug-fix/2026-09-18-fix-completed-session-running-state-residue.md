# Agent Note: 修复已完成会话偶发残留运行态/调用工具/就绪并阻断发信的状态机缺陷

Status: implemented

## Problem

在 BlackBerry Q20 客户端与 Web 交互中，已完成的会话偶发在底部状态栏残留显示“● 正在调用工具...”或“● 就绪 (X个对话)”，发送按钮锁定在停止图标（`ICON_STOP`），用户按回车或点击发送因 `if (sessState.running || isStreaming) return;` 遭到拦截，只能按停止按钮（x）强制终止后才能恢复发信。

经深入诊断与 3 路对抗性子智能体深度审核，定位到 5 处状态机与时序缺陷：
1. **attachSession readyState 4 终态收口缺失**：静态历史会话同步完成后服务端直接 `res.end()`（不发 done），或连接断开进入 `readyState === 4` 时，客户端完全没有清理 `sessState.running` 与重置 `renderSendButton()`；
2. **loadSessions 5 秒轮询反向同步缺失与脏文本污染**：轮询检测到 `isRunning === false` 时无反向纠正分支，且无条件调用 `setStatus('就绪 (' + sessions.length + '个对话)')`，由于未传 state 且 `sessState.running` 残留，被状态栏渲染为带有天蓝脉冲圆点的畸形文案 `● 就绪 (X个对话)`；
3. **缺少跨会话代次令牌与 ABA 取消回调防护**：快速切换会话时 `stopAttach()` 触发的 `abort()` 会将旧 XHR 推至 `readyState 4`，可能跨会话误杀新选中的会话；
4. **loadHistory 状态越权篡改**：历史加载完成后不区分会话客观运行状态，强行修改状态机；
5. **服务端 isSessionUiRunning Fail-Open 漏洞**：当宿主 RPC 超时（返回 null）时盲目返回 true，由于宿主对打开过的会话永久持有 flock 写租约，导致历史会话大面积误报 running。

## Decision

通过多智能体对抗审核共识，实施以下端到端闭环加固（严格遵守 ES5 与 BB10 WebKit 约束）：

1. **会话单调递增代次令牌（`sessionSeqToken`）**：
   - 切换会话（`selectSession` / `startNewChat` / `selectWorkspace`）时递增 `sessionSeqToken++`；
   - `stopAttach()` 打上 `attachXhr.__aborted = true` 显式标记；
   - `attachSession` 绑定 `xhr.__token = sessionSeqToken`、`xhr.__sid = sid`，在 `onreadystatechange` 顶部第一行拦截被取消或过期代次的回调，彻底粉碎跨会话 ABA 污染。
2. **应用层终态门闩（`__hasTerminalEvent`）与精确收口**：
   - 在收到 `done` / `cancelled` / `error` / `sync(isRunning:false)` 时置为 true；
   - 在 `readyState === 4` 时，若归属于当前会话且本地未推流（`!isStreaming && activeXhr === null`）：正常 EOF 关闭且未收口时，权威将 `sessState.running` 置为 false，更新 phase 为 done，调用 `foldTrailingProcess` 收口胶囊并重绘发送按钮；
3. **本地流权威保护与轮询静默化（In-Flight Guard & Silent Background Poll）**：
   - `loadSessions` 引入 `isLocalStreamingActive = (isStreaming || activeXhr !== null)` 保护，严禁后台轮询冲刷本地活跃推流；
   - 彻底将 `loadSessions` 后台 5 秒轮询静默化：严禁在已有会话主界面调用 `setStatus('加载会话列表中...')` 或 `setStatus('就绪 (X个对话)')`，仅在未选会话且打开会话面板时才允许提示列表状态，彻底消灭“加载会话列表中...”冲刷完成会话底部的 Bug；
   - 匹配到当前会话且服务端已停止时，权威纠正 `sessState.running = false` 并恢复发送按钮；
4. **彻底收敛发送阻断判据与 openComposer 自愈（消灭 isStreaming 孤儿双轨制）**：
   - 彻底修复 `doSend()` 与 `sendBtn.onclick` 依赖已脱节的 `isStreaming` 局部变量的 Bug：判定统一收敛至单一事实来源 `sessState.running`。只要按钮画为发送箭头，点击 100% 触发发送，按 Enter 100% 触发发送，彻底消灭“按 Enter 被阻断、点两次按钮才发出”的假死缺陷；
   - `openComposer()`（展开对话框准备输入）、`selectSession` 与 `selectWorkspace` 增加状态自愈：当处于非运行态时，自动将 `isStreaming` 彻底复位并同步按钮，消除任何历史遗留的悬挂流式标记；
5. **attach 历史回放门控（replay gating，消灭“列表状态正确但底部残留调用工具”）**：
   - 引入 `replayDone` 门控：服务端 liveTask 分支 attach 时会先 burst 重放整段历史缓冲事件（thought/tool/delta）再发 `replay_end`；已结束会话重放的 tool 事件此前无条件执行 `sessState.running=true` 与 `setStatus('● 对话后台运行中 [工具]')`，一旦 done 事件在服务端 listener 注册竞态中丢失，底部即永久残留“调用工具”，而会话列表（读服务端权威 sessCache）却显示正确；
   - 修复后仅 `replay_end` 之后的实时事件才可点亮运行态，回放事件只记 `attachHasRunning`；
6. **以服务端真源驱动全链路状态推导（resolveEffectiveSessionState）**：
   - 彻底打破“会话列表读服务端快照，底部状态读本地碎片变量”的脱节根因：新增 `resolveEffectiveSessionState()`；
   - 任何涉及底部状态条（`renderSessionStatusTail`）、消息气泡工具兜底文案（`renderAssistantBlocks`）、残留胶囊结算、发送按钮（`renderSendButton`）以及发信拦截（`doSend`），**一律先查阅会话列表相同的服务端真源（sessCache）**；
   - 一旦服务端真源裁定非 running，权威压制并自动治愈本地内存中滞留的 running 假象，确保头部列表图表、底部状态栏、气泡工具状态与发送按钮 100% 同源同态。
7. **readyState 4 收口判据与假死看门狗（双保险兜底）**：
   - attach EOF 收口判据由 `!isStreaming && activeXhr === null` 收敛为 `activeXhr === null`（isStreaming 孤儿不再阻断收口）；
   - 新增 `attachLastDataAt` 数据心跳 + `checkAndReattach` 假死看门狗：连接挂着但 15s 无任何数据即强制收割重连，消除半开 TCP 下 `!attachXhr` 短路死锁与 loadSessions 反向纠正被 `!attachXhr` 跳过的逃生口；
8. **尾部状态栏文案净化与老旧 WebKit 节流（Dirty Check）**：
   - `renderSessionStatusTail` 增加文案白名单校验，在 running 态下自动过滤“就绪”等静态脏文本；
   - 引入 `lastTailHtml` 对比，文本未变时零 DOM 操作，杜绝 5s 轮询导致的 CPU 假死与视口微跳；
5. **服务端 Fail-Safe 保守策略**：
   - `server.mjs` 中 `isSessionUiRunning` 当宿主不可达（`hostRunning === null`）时，结合 `sessionTerminalState(zstdPath, null)` 判断尾部快照，已完结会话权威返回 false，杜绝 flock 虚假判 running。

## Alternatives considered

- *方案 A：仅在 readyState 4 时粗暴将 sessState.running 设为 false*：否决（被 3 路对抗审核一票否决）。若不校验会话归属和代次，切换会话时旧 XHR 的 abort 会直接误杀新会话；且在本地推流初期会被误收口。
- *方案 B：完全依靠 loadSessions 5秒轮询更新状态*：否决。5秒延迟过长，且轮询快照存在时序反转，会导致刚点发送的按钮闪烁回发送态。
- *方案 C：服务端在每次静态 attach 结束前补发虚拟 done 事件*：否决。静态历史会话下发虚拟 done 会诱发前端误触发二次拉取历史与界面抖动，违反 DSH 协议语义规范。

## Consequences

- 彻底根治已完成会话偶发显示“正在调用工具”或“● 就绪”且无法发送的 Bug；
- 发送按钮与回车发送逻辑状态机完全闭环，无任何死锁或孤儿运行态；
- 严格符合 Acorn `{ ecmaVersion: 5 }` 解析门禁；
- 自动化测试用例从 12 项扩充至 13 项，新增状态机与文案净化专项守卫合约，全绿通过（13/13 PASS）。
