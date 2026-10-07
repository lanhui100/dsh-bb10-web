# Agent Note: 运行中会话追发双模式（排队/插队）与 Q 键切换

Status: implemented

## Decision

Q20 客户端支持在会话运行中发送用户消息，模式二选一并持久化（`localStorage dsh_q20_send_mode`，默认 `queue`）：

- 排队（`queue`）：消息进入后续 FIFO 轮次，本轮结束后执行；
- 插队（`steer`）：消息在最近 step 边界介入当前轮（上游 Agent loop best-effort 语义）。

行为（`static/index.html` / `server.mjs`）：

- 全局快捷键 `Q`（code 81，非输入态）切换模式，`showCopyToast` + 状态行双反馈；`O` 状态面板新增「发送模式」行（中文名 + 上游 mode 值 + `Q` 提示）；帮助表与 README 快捷键清单同步。
- 运行中按 `Enter`（或 R/继续场景外的 composer 发送）不再静默丢弃，改走 `POST /api/session/prompt {sessionId, prompt, mode}`；服务端直调宿主 `session/prompt`（与既有 `runChatViaHostRpc` 同一 envelope），本地离线 SDK 引擎在途则诚实返回 `ok:false`（不支持投递），会话未运行返回 `ok:false session not running`（与 `/api/session/question` 幽灵会话口径一致）。
- `/api/chat/stream` 接受可选 `mode` 字段并透传给 `session/prompt`（缺省 `queue`，非法值 400）。
- 空闲态发送链路零改动；`X` 停止、`R` 语义、`resolveEffectiveSessionState` 状态机均不动。

## Alternatives considered

- 运行中发送按钮复用为「停止/发送」双态：与 dsh web「单一状态源驱动发送/停止」冲突，且小方屏上误触代价高；否决，发送仍走 composer `Enter`，停止仍是红色按钮/`X`。
- 用 `S` 做切换键：`S` 在提问面板已被 Skip 占用，且旧 WebKit 保留键风险（既有注释）；`Q` 全局空闲，选用 `Q`。
- 客户端运行中直接 `session/prompt` 到宿主：违反两条管道收敛（浏览器只许走本服务端），且需暴露宿主 Cookie；否决，一律经本服务端中转。
- 本地 SDK 引擎排队缓存后重放：SDK `run()` 单次调用无中途注入语义，缓存重放会造成语义漂移；否决，诚实报错。

## Consequences

- 新增契约：`POST /api/session/prompt`（400：缺参/非法 mode；200 `ok:false`：未运行或离线引擎）。
- `test-unit.mjs` 新增端点边界 + 客户端标记切片用例；ES5 门禁与解耦门禁保持。
- 上游 `session/prompt` mode 语义变更时，本工程同提交对齐（上游对齐义务）。
