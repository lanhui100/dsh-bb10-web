# Agent Note: 修复打开运行中会话未挂接宿主 follow 流导致无法实时同步

Status: implemented

## Problem

在用户切换到正在后台/宿主（DSH Web）运行的会话时，出现"只能加载历史信息，不能同步运行时的状态，保持对话同步"的问题。

深入追踪调用链路后发现：
1. **服务端 `/api/session/attach` 缺失宿主桥接**：
   - 现存的 `activeTasks` 仅在本地发起 `/api/chat/stream` 时存在。如果会话是由其他页面、客户端或者重启前触发且正在 DSH Web 宿主运行，或者用户刷新后重进该会话，`activeTasks.get(sessionId)` 为空。
   - `/api/session/attach` 此时退回到了文件轮询（`poll()`），每秒只检查磁盘 zstd 文件是否变化，完全没有通过 `/api/remote.mux` 打开 DSH 宿主的 `session/follow` 流获取实时的 `delta`（文本分片）、`thought`（思考过程）和 `tool`（工具执行），因此无法实时看到正在吐字的内容。
2. **前端切换会话时竞态清空**：
   - `selectSession` 在切换到会话时，同时调用了异步的 `loadHistory(cwd, sid)` 与 `attachSession(cwd, sid)`。
   - `loadHistory` 发起 XHR，并在成功返回时直接执行 `allMessages = msgs; renderWindowedMessages(false);`，将容器内容全部用历史覆盖；
   - 与此同时，`attachSession` 挂载收到实时的增量 DOM 元素（如 `msg-assistant` 气泡、`thought-card`、`tool-pill`）并直接挂在 `chatContainer` 上，但当稍慢一点的 `loadHistory` XHR 响应回调触发时，会调用 `chatContainer.innerHTML = ''` 将正在生成的流式内容彻底冲掉！
   - 之后只要该轮对话在宿主尚未结束，前端就停留在静态历史中，无法与生成中的 token 和工具调用保持同步。

## Decision

1. **服务端 `/api/session/attach` 引入宿主实时 Follow 桥接**：
   - 当收到 `/api/session/attach` 请求且会话当前没有内存运行任务（或状态非 running）时，判断该会话是否处于运行中（`isSessionUiRunning`）；
   - 若会话在运行中且 DSH 宿主在线，调用 `attachHostFollowTask(sessionId, cwd)`：在服务端通过 `/api/remote.mux` 向宿主建立 `session/follow` WebSocket 逻辑流，将宿主推送的 durable 事件、`thought`、`tool`、`delta` 统一桥接派发到该会话的 task 事件总线并注册进 `activeTasks`；
   - `/api/session/attach` 的 SSE 连接直接挂载该任务，同步实时流式事件，并在宿主完成（`done` 或 `turn/end`）时正常收敛。
2. **前端协调加载历史与实时挂载的时序**：
   - 保证切换到运行中会话时：先完成历史记录加载（或在历史加载就绪后再建立或保留 attach 实时增量输出），避免 `loadHistory` 异步返回后清空 DOM 抹去 attach 正在生成的增量元素。
   - `attachSession` 在有历史消息且收到增量时，将增量安全续接在历史尾部，实时流式更新当前 assistant 气泡，实现无缝连续吐字与工具状态跟踪。

## Alternatives considered

- **仅依靠前端周期性轮询 `/api/history`**：
  - *否决原因*：极度浪费 CPU 与 I/O。对长会话频繁解压 zstd 严重阻塞 Node 线程池，且会有秒级延迟，黑莓 Q20 小屏体验极差，且无法获得细粒度的 token 流式打字机效果。
- **让黑莓前端直接连接宿主 `/api/remote.mux` WebSocket**：
  - *否决原因*：BB10 WebKit 537.35 的 WebSocket 实现与现代隧道协议存在握手与鉴权兼容性风险，且需要暴露内部 mux 通道，违反了"服务端承担繁重适配、前端保持最简轻量"的架构准则。

## Consequences

- 打开任何正在运行中的会话，黑莓客户端都能立即呈现实时思考、工具调用与打字机文本流，状态与 DSH Web 保持严格同构同步。
- 历史记录与实时生成平滑衔接，不再出现内容闪烁或被冲掉的情况。
