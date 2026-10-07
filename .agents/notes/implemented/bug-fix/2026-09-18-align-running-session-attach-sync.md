# Agent Note: 严格对齐 dsh web 进入运行中会话并同步实时状态

Status: implemented

## Problem

在用户从会话面板（或刷新/重进）选择一个正在后台或 DSH Web 宿主中运行的会话时，存在“只能静态加载历史消息，不能同步运行时状态”的问题。

对比官方 `dsh web`（`packages/api/session-controller` 中 `ClientSessions`、`SessionManager`、`SessionEventStream`）的实现机制，发现官方进入运行中会话的核心逻辑如下：
1. **统一的舞台关注机制（Staging / followCurrent）**：
   - 在 `dsh web` 中，只要会话被选为当前舞台会话（`list.current`），无论该会话处于 `idle` 还是 `running`，立即对其调用 `session.open()`。
   - `session.open()` 会向宿主打开 `session/follow`（携带 `assistantStream: true`），获取 opening 快照，并无缝消费后续的 durable 事件与瞬态 assistant-stream 帧（`delta` / `thought` / `tool`），同时接收宿主广播的 `api-session/status` 或 control 帧更新 `running` 状态。
2. **dsh-q20-web 的偏离点**：
   - **偏离 1（前端拦截导致不建连接）**：
     前端 `selectSession(cwd, sid)` 在加载完历史之后，加入了条件判断：
     ```javascript
     loadHistory(cwd, sid, function() {
       if (currentSessionId === sid) {
         if (sessState.running) {
           attachSession(cwd, sid);
         }
       }
     });
     ```
     如果用户进入会话时，本地缓存的 `sessState.running` 尚未就绪（如初次打开或缓存未标记为 isRunning），该条件直接为 false，导致**完全不会调用 `attachSession`**！即便会话在宿主正在疯狂吐字，前端也只会停留在静态历史中，彻底失去与后端的连接。
   - **偏离 2（服务端 /api/session/attach 判定不及时）**：
     服务端收到 `/api/session/attach` 时，如果本地没有 activeTask 或其状态非 running，需要判定 `isSessionUiRunning`。但在宿主在线时，`getHostRunningSessionIds()` 有长达 10s 的缓存，且仅检查 `session.lock`，若会话在其他工作区或锁判定微有延迟，可能错过 `attachHostFollowToSession`。并且一旦未匹配到 running，直接退回 1s 一次的静态文件轮询，而不主动连入宿主 follow。
   - **偏离 3（运行状态与控制按钮脱节）**：
     进入运行中会话时，前端的发送/中止按钮（`renderSendButton`）和状态标记（`sessState.running`）没有由 attach 的首包及后续事件可靠驱动；在收到实时内容前，界面仍显示为就绪或完成态，无法实时中断（Stop）或实时追加。

## Decision

1. **前端无条件对当前选中会话建立 attach 监听（对齐 dsh web staging open 规范）**：
   - 在 `selectSession(cwd, sid)` 加载历史完成后，只要仍停留在该 `sid`，**无条件调用 `attachSession(cwd, sid)`**（正如 dsh web 中每次舞台切换必定 `session.open()` 挂接 follow 流）。
   - 服务端若会话未在运行，attach 连接会立即发送当前真实状态（`sync` 事件告知 `isRunning: false` 及最新状态）并平滑结束，不会造成任何额外重载负担；
   - 若会话在运行中，attach 连接会立即建立并开始实时派发 `thought`、`tool`、`delta`，并将 `sessState.running` 置为 true，更新按钮为红色停止态，实现与宿主的零延迟同构同步。
2. **服务端 /api/session/attach 主动对齐宿主实时状态**：
   - 当接收到 `/api/session/attach` 时，强制绕过（或微缩）`hostRunningCache` 缓存，实时复核宿主 `session/list` 中该会话的 `running` 状态。
   - 若宿主 `session/list` 指明该会话处于 `running: true`，立即启动 `attachHostFollowToSession(sessionId, cwd)` 连接宿主 `/api/remote.mux` 的 `session/follow` 流；
   - 在 SSE 建立时，首先下发包含最新 `isRunning` 与会话状态的 `sync` 帧，使客户端在第一帧即可校准运行时状态。
3. **前端状态与实时增量追加生命周期闭环**：
   - 在收到 `attach` 的 `start`/`sync` 事件时，根据服务端的客观 `isRunning` 标志同步 `sessState.running` 与 UI 发送/停止按钮；
   - 当收到流式 `delta`、`thought`、`tool` 时，将内容安全追加在已加载的当前历史视口尾部（`msg-assistant` 气泡），防止与历史记录互相覆盖，保持打字机流式体验。

## Alternatives considered

- **前端仅依靠定时轮询 `/api/sessions`**：
  - *否决原因*：轮询存在秒级延迟，且无法获取细粒度的打字机 token、思考过程与工具调用事件，严重破坏黑莓设备的小屏即时体验。
- **让黑莓前端直接向宿主建立 WebSocket**：
  - *否决原因*：BB10 WebKit 537.35 的 WebSocket 与 DSH Mux 通道存在握手与鉴权兼容性风险，违反"服务端承接繁重适配、前端轻量化"原则。

## Consequences

- 任何从会话面板进入的会话，无论是空闲历史还是正在后台生成中的会话，都能在进入时即时同步运行中状态（按钮切换为中断停止态、状态栏显示运行中）；
- 正在生成的文本、思考过程与工具调用紧随历史消息尾部流式呈现，完全对齐官方 `dsh web` 的行为与状态语义。
