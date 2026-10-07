# Agent Note: clear-stopped-session-state-on-send

Status: implemented

## Problem

在 BlackBerry Q20 Web 界面中，当用户按 `X` 快捷键或点击停止按钮中止当前消息流后，`stopStreaming()` 会向 `userStoppedSessions[currentSessionId]` 写入中止时间戳，并通过 `syncSessionPhase` 将状态置为 `stopped`（消息流底部显示“■ 会话已中止”）。
当用户随后输入“继续”或按 `R` 发送继续指令重新激活会话时，`userStoppedSessions` 中的时间戳与 `sessState.phase` 的 `stopped` 残留没有被立即清理。由于 `userStoppedSessions` 设有 15 秒内的防竞态拦截机制（优先级高于服务端快照），导致即使已触发发送，`resolveEffectiveSessionState()` 依然误判为 `stopped` 终态，底部的“■ 会话已中止”信息无法立即切换为“正在思考与生成回复 (点击停止可中断)...”，造成“用户以为会话没有继续”的严重误导与状态迟滞。

## Decision

在 `static/index.html` 的核心消息发送流程 `doSend()` 中：
1. 立即清除用户主动停止标记：`if (currentSessionId && typeof userStoppedSessions !== 'undefined') { delete userStoppedSessions[currentSessionId]; }`；
2. 清空既有的错误或停止标记：`stopRequested = false; sessState.lastError = ''; sessState.promptError = '';`；
3. 将状态机与界面乐观切换为 running 态并立即呈现运行提示：“正在思考与生成回复 (点击停止可中断)...”，确保底部的中止提示瞬间消失、流转至运行态；
4. 保持严格的 ES5 语法规范，不引入现代语法。

## Alternatives considered

- 方案 A：在 `syncSessionPhase(sid, 'running', ...)` 内部自动 `delete userStoppedSessions[sid]`。虽然可行，但 `syncSessionPhase` 会被后台轮询和 attach 流程调用，若在取消瞬间后台快照存在延迟，可能会误删刚刚记录的中止保护，引发已停止的会话闪回运行态。
- 方案 B：缩短 `userStoppedSessions` 的 15 秒窗口。治标不治本，缩短窗口无法解决 1~3 秒内用户快速按继续时的界面残留问题，甚至会引入网络轮询快照竞态。
- 方案 C（采纳）：在用户主动触发 `doSend()` 明确发起新一轮请求时，精准删除当前会话的 `userStoppedSessions` 记录并重置 `stopRequested` 与错误状态。意图权威且闭环，彻底根治残留，同时不影响其他会话的停止保护。
