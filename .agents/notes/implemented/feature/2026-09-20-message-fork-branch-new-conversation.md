# Agent Note: 每轮 Agent 消息下方增加 Fork 分支（对齐 DSH session/fork）

Status: implemented

## Problem

用户在某一轮对话后想换个方向继续，但保留此前上下文。官方 DSH Web 在每轮已完成转录尾提供 `Branch into a new conversation`：以该轮为锚点 fork 出新会话并打开。新会话继承该点之前的全部历史（`session/fork { sessionId, atSeq }`，`atSeq` 锚定到 `turn/end` 边界）。Q20 前端目前每条气泡只有复制/重试，没有分支能力。

## Decision

1. **服务端消息补 `seq`**（`server.mjs getSessionHistory`）：
   - `user/message` 与每个 assistant step 节点、`error` 节点均携带转录 `seq`（事件 `seq` 字段；assistant step 取该 step 内 last `assistant/message` 的 `seq`，无则取 `step/start`）。
   - 无 `seq` 的老消息：前端不渲染分支按钮（与 dsh `branchUnavailable` 同语义，宁缺不瞎指）。
2. **服务端 fork 代理**（`server.mjs`）：
   - 新增 `POST /api/session/fork`，接收 `{ sessionId, atSeq? }`，缺 `sessionId` → 400。
   - 直调官方 RPC `session/fork`（`callDshWebRpc('session/fork', { sessionId, atSeq })`，非 rawArgs 包络，与 `session/create` 同通道）。
   - 对齐 dsh `increaseTitle`：fork 成功后读宿主 `session/list` 取源标题（`projections.values.title`，无独立 title 字段），
     经 `increasedForkTitle`（尾部 `(N)`/`（N）` 递增，否则追加 ` (1)`，与 dsh 测试用例逐字对齐）调 `session/rename` 命名子会话；
     rename 失败不阻断（子会话已创建）。
   - 成功后失效 `workspaceDomainCache` + `workspacesCache` + `hostTitleCache` + `hostRunningCache`，返回 `{ ok: true, sessionId: <childId> }`；宿主不可达/失败 → `{ ok: false, error }`（200 幂等，不打爆客户端，与 queue/remove 同惯例）。
   - 只用宿主管道：fork 本质是创建会话，宿主持有写租约，无本地兜底（与 prompt 转发后失败不回退同理）。
   - **列表标题叠加**（bug 修复）：Q20 `/api/sessions` 标题来自本地 zstd 头部扫描（只读前 5 帧），读不到 fork 后追加的 rename 事件，
     子会话显示为空回退成 `session-` 短 id。`getSessionsForCwd` 返回前经 `applyHostTitles` 叠加宿主权威标题（10s 缓存 `getHostTitleMap`，
     与 running 缓存并存；宿主不可达静默保持本地标题）。
3. **前端分支按钮**（`static/index.html`，ES5 + XHR）：
   - 每条 assistant 气泡操作栏追加分支图标按钮（`action-btn action-btn-icon`，与复制同行同样式，无背景无边框无文字，右对齐）。
   - 图标为内联 SVG 分支 glyph（`ICON_FORK`，feather git-fork 风格描边路径）；不用 `⑂` 文字符——BB10 WebKit 537 缺该字形，显示为方框。title 提示 `从该轮分支为新会话 [F]`。
   - 任意已落盘 assistant 消息均可为 fork 锚点（宿主 `atSeq` 自动向后吸附到包含该事件的 turn 的 `turn/end`，中间轮即从该轮结束点切出）；
     仅无 `seq` 的占位消息（流式 live 占位、老转录缺 seq）置灰禁用。运行中会话不禁——转录已落盘部分照样可分支（dsh 同理，fork 读的是 durable 历史）。
   - 点击 → `POST /api/session/fork { sessionId, atSeq: seq }` → 成功后 `loadSessions` 刷新列表并 `selectSession(cwd, childId)` 打开新会话；失败 toast + 状态栏提示。
   - 快捷键 `F`：`J/K` 选中态优先，无选中则取尾轮（`F` 在模型面板打开时被面板拦截，主界面空闲）。
   - `chatContainer.onclick` 事件委托已放行 `action-btn`（不收起 composer），分支按钮自动受益。
4. **帮助面板 + README**：帮助表加 `F` 行；`README.md` / `README.zh.md` 消息操作语段追加分支说明（same-commit）。

## Alternatives considered

- **前端直调宿主 `/api/session/fork`**：Q20 前端无宿主认证 Cookie（服务端 `getDshWebAuthCookie` 派生），直调鉴权失败；必须经服务端代理（与 prompt/queue/remove 同架构）。
- **按轮次序号（turn）而非 seq 锚定**：宿主 `session/fork` 只接受 `atSeq`（事件序号，向后吸附到 `turn/end`）；turn 号需二次换算且多 turn 共用序号时有歧义，直接透传 `seq` 最忠实。
- **仅转录尾可 fork**（初版）：曾误读 dsh `branchUnavailable` 为"仅最后一条可分支"。实则 dsh 对每个已完成 turn 的尾部都开放 branch（`atSeq` 吸附到该 turn 的 `turn/end`）；中间轮 fork 正是分支的核心用途（从中途换方向）。已放开：任意已落盘 assistant 消息均可锚定。
- **user 气泡也加分支**：dsh 的 branch 只渲染在 assistant 回答下方（user 泡无）；Q20 跟随，避免小屏操作栏拥挤。
- **带 `⑂ 分支` 文字的 chip 按钮**：`⑂`(U+2442) 在 BB10 WebKit 537 缺字形显示为方框；且小屏操作栏拥挤，文字 chip 带背景边框，视觉噪音大。改与复制一致的 `action-btn-icon` 纯图标按钮（SVG 描边分支 glyph，无背景无边框无文字）。
- **fork 后停留在原会话**：dsh `forkAt` 成功后 `openSession(childId)`；跟随——分支即开新会话，符合"换方向继续"心智。

## Consequences

- `getSessionHistory` 输出每消息新增 `seq` 数字字段；`/api/history` 包络不变，旧客户端忽略新字段。
- 新增端点 `POST /api/session/fork`；门禁 `test-unit.mjs` 追加 400/ghost 契约 + 静态接线断言。
- ES5 门禁：新增前端代码只用 `var` + `function` + 字符串拼接 + XHR。
