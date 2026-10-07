# Agent Note: 修复从会话面板进入历史会话时触发两次拉取历史与 Loading 闪烁

Status: implemented

## Problem

用户反馈在 BlackBerry Q20 Web 界面中，从会话面板（`#sess-panel`）点击并进入一个历史会话时，界面会出现连续两次“正在读取历史记录...”的 loading 页面闪烁。

深入追踪调用链路与状态机后定位到根本原因：
1. **历史会话无需且不应建立实时 attach follow 流**：
   - 用户在会话面板点击历史会话时，`selectSession(cwd, sid)` 先发起 `loadHistory(cwd, sid, callback)`，清空消息容器并展示第一遍全屏 loading 提示（“⏳ 正在读取历史记录...”）；
   - 当 `/api/history` 返回并渲染出历史消息后，其完成回调**无条件**执行了 `attachSession(cwd, sid)`；
   - 但此时会话客观上早已结束（非 running 态），服务端 `/api/session/attach` 退入基于文件锁的 fallback 轮询。
2. **服务端 `/api/session/attach` 对未运行会话误发 `done` 事件**：
   - 在旧逻辑中，服务端轮询判定 `!isRunning` 时直接执行 `idleStreak++`，当 `idleStreak >= 2`（约 1 秒后）误认为“一次运行任务刚刚结束”，向客户端发送 `event: done\ndata: {"sessionId":"...","finished":true}` 并结束连接；
3. **前端 `attachSession` 收到 `done` 盲目触发二次拉取**：
   - 客户端 `attachSession` 监听到 `done` 事件后，无视该连接期间是否曾有实质性运行或吐字（`attachHasRunning`），直接执行 `if (!userScrolledUp) loadHistory(wsSelect.value, sid);`；
   - 随之而来的第二次 `loadHistory` 再次调用 `showHistoryLoading('正在读取历史记录...')`，彻底抹掉已经呈现的消息流并展示第二遍全屏 loading，造成明显的重复加载与视觉闪烁；
   - 同样地，休眠唤醒时的 `checkAndReattach` 原先也未校验 `sessState.running`，在用户切屏或失焦返回时反复对历史会话发起 attach 并诱发历史重拉。

## Decision

对齐 `dsh web` 官方 session-controller 的 follow 与历史按需加载机制，在端云两层实施彻底根治：

1. **会话选择入口按状态按需挂接 attach (`selectSession`)**：
   - `selectSession` 在 `loadHistory` 完成后，检查当前会话是否客观处于 `sessState.running` 运行态；
   - 历史已完成/空闲会话（`done` / `stopped` / `idle`）已拥有完整持久化历史，严禁开启无谓的 `/api/session/attach` SSE 连接，彻底切断源头；
2. **服务端 `/api/session/attach` 杜绝向静态会话发送虚假 `done`**：
   - 引入 `everRunning` 标记：仅当连接期间会话曾处于 `isRunning` 态且后续转为未运行态（真实推理完成）时，才向客户端推送 `done` 事件；
   - 若会话从连接之初即为静态历史会话，在完成首轮快照/状态推送后优雅关闭连接，严禁下发伪造的 `done` 事件；
3. **前端 attach 连接引入运行状态跟踪与静默重载机制**：
   - `attachSession` 内部跟踪 `attachHasRunning`：只有真正收到 `isRunning: true` 或 `delta` / `thought` / `tool` 流式事件后，会话结束时才触发最终快照同步；
   - `loadHistory` 支持 `silent` 模式：在背景同步或实时流结束后的最终对齐中，保持既有 DOM 消息不被清空、不弹出全屏 loading 占位，静默平滑更新；
4. **唤醒防御 (`checkAndReattach`)**：
   - 仅当 `sessState.running && !attachXhr && !isStreaming` 时才在窗口聚焦或重新可见时尝试重连，杜绝历史会话被唤醒事件反复骚扰。

## Alternatives considered

- *方案 A：仅在客户端 `loadHistory` 中取消清空 DOM，永远不展示 loading*：
  - *否决原因*：用户首次点开一个长会话时，适当的 loading 提示（如“⏳ 正在读取历史记录...”）是老旧黑莓双核 CPU 弱网环境下的必要反馈；问题在于“短时间内重复展示两次”，而非首次加载本身。
- *方案 B：仅依靠前端 `currentSessionId === sid` 防抖*：
  - *否决原因*：两次请求虽然会话 ID 相同，但时序上是严格串行的（第 1 次完成才触发 attach，attach 接收到 done 才触发第 2 次），简单的并发防抖无法拦截此链路，必须从状态源头对齐语义。

## Consequences

- 从会话面板进入历史会话时，仅展示一次精准的加载提示，消息加载完毕后立即可见且不再闪烁；
- 运行中会话进入时仍能无缝挂接实时流并在运行结束时平滑过渡；
- 杜绝了休眠唤醒对静态历史会话反复发起无效 SSE 连接与重新拉取；
- 通过 Acorn ES5 静态解析门禁，并通过全链路自动化测试套件 (7/7) 及单元测试套件 (6/6)。
