# Agent Note: 会话运行状态权威化（宿主 $events 镜像 + session/list 抗超时 + 冷启动桥接）

Status: implemented

## Problem

Q20 设备侧出现 5 个可复现缺陷，且互相同源：

1. **会话状态错误**：正在运行的会话在列表与底部状态栏显示 `done`/`stopped`，并在两者间抖动；
2. **`C` 键「全工作区进行中」列表错误**：进行中会话不出现或图标错误；
3. **`U` 键多智能体看板为空**：会话确有子智能体在跑，看板却报「当前会话暂无子智能体」；
4. **运行中插队（steer）失败**：返回 `session not running`；
5. **进行中会话不能及时更新**：状态长期滞后。

根因（物理实测，2026-10-16 本机生产实例）：

- 宿主 `session/list` RPC 全量返回实测 **474435ms / 3891 items**（网关本身健康：`session/modelCatalog` 1.14s、`session/projections` 0.54s），
  而 `server.mjs` 主通道硬超时仅 **6000ms** → `items = null`；
- `items === null` 使 running 集合为 `null`，`isSessionUiRunning` 的 fail-safe 直接返回 `false`，
  `state` 于是退回 `sessionTerminalState()` 的 durable 尾部推断（`done`/`stopped` 抖动）→ 缺陷 1/2；
- `getSessionSubagents` 在 `!Array.isArray(items)` 时直接返回空列表 → 缺陷 3（同刻 `$events` 流中该会话确有 3 个 `origin:"subagent"` 在跑子会话）；
- `/api/session/prompt` 的插队闸门依赖 `getHostRunningSessionIds(true)`，超时后为 `null` → 一律拒绝 → 缺陷 4；
- 失败路径不写缓存（`at = 0`），每次 `/api/sessions` 串行发起 **2 × 6s** RPC（实测 12.5s），前端 5s 轮询叠加 → 永久滞后与重试风暴 → 缺陷 5。

## Decision

1. **以宿主转发的 `$events` 事件流作为 running 权威真源**：新增 `lib/host-live-state.mjs`（冻结签名
   `createHostLiveState(opts)`），进程启动时在 `listen` 回调内建立**唯一常驻** `$events` 订阅
   （`/api/remote.mux`，payload `{args:{}}`），把 `api-session/status|added|removed|activity` 折叠为进程内状态镜像
   （含 `running`/`agentAvailable`/`parentSessionId`/`origin`/`cwd`/`title`/`subagentCatalog`/`agentTeam`）。
   断开按 1s→2s→…→30s 指数退避重连，连接稳定 30s 才归零退避。
2. **`session/list` 彻底退出热路径**：共享主通道单一在飞、超时 600000ms、成功 TTL 1800000ms、失败退避 300000ms，
   失败**绝不清空**已知 running 快照；`/api/sessions`、`/api/session/subagents` 只读已知快照并 fire-and-forget 后台刷新。
   `session/fork`、`queue/remove` 的既有 ad-hoc 调用保持原样（最小闭包）。
3. **新增零外部调用的轻量端点** `GET /api/sessions/status?ids=…` →
   `{ok, at, states:{sid:{isRunning, state, known, source}}}`；`known:false` 表示无权威事实，前端**严禁据此降级**。
4. **冷启动桥接（只提升、不降级）**：`$events` 只转发订阅建立之后的事件，故「Q20 启动前已在跑」的会话无权威事实；
   此时用本地 durable 信号兜底：`sessionTerminalState(zstd) === 'stopped'`（回合未终结）且 mtime 新鲜（≤300s）⇒ 判定运行。
   同一桥接也补进 `/api/session/prompt` 的插队闸门，消除缺陷 4 的冷启动缺口。
5. **前端 ≤5s 轻量收敛**：`static/index.html` 的 5s 轮询改为打 `/api/sessions/status` 就地补丁可见行，
   `/api/sessions` 仅在缓存缺失/过期（≥15s）或有界对账（每周期至多 1 个 cwd）时拉取；插队失败必须呈现服务端真实错误文案。

契约与证据：`.dev-team/contract-wave-2026-10-16.md`（含 C-1…C-20 与实测修正）、红相锚定 `1a12309` / tag `wave-2026-10-16-red`、
独立验收 `tests/acceptance/`（A1–A10）。

## Alternatives considered

- **只把 `session/list` 超时从 6s 调大**：实测该 RPC 需 ≈474s，调大到 60s 仍会失败；且失败期间 running 依然为 `null`，缺陷 1–5 一个都修不掉。否决。
- **用 flock 写租约当作 running 信号**：实测全库 3297 个 `session.lock` 中 443 个被宿主长期持有（宿主对收养过的会话永久持锁），
  与是否在跑无关，会引入全量虚假 running（既有代码注释亦已记录该结论）。否决。
- **轮询 `session/control` 流或 `session/projections` 取 running**：投影不携带 running/agentAvailable（running 仅由宿主
  `ctx.agents.get(id)?.status` 计算并只经 `api-session/status` 事件发布），且 baseline 构建与 `session/list` 同量级。否决。
- **在 `/api/sessions` 里为 live running 的会话补「幻影行」**：会让磁盘不存在的会话出现在列表，回归面大且语义不诚实。否决（契约 C-15）。
- **让 `/api/sessions/status` 对未知 sid 一律返回 `isRunning:false`**：会把「无权威事实」误报为「确认不在跑」，前端据此降级正好复现本次缺陷。改为 `known` 显式三态。否决原方案。
- **冷启动什么都不做、只等 474s 播种**：A8 与真实体验在重启后数分钟内仍然全错。否决，改用 C-20 桥接 + 后台播种双保险。

## Consequences

- 运行状态从「重型全量轮询」变为「事件推送 + 内存读」，`/api/sessions` 实测 12.5s → 0.68s，`/api/sessions/status` 24ms（60 id 批量 36ms）。
- 冷启动后 ≤300s 内的「已在跑」会话由启发式兜底；**残留风险（显式登记，靠 review）**：超过 300s 无 durable 写入的长工具调用回合会被漏判为未运行，
  由 live 事件或后台播种最终纠正。
- `/api/sessions/status` 在「无任何权威事实」的桥接路径上做一次**有界且可缓存**的 durable 目录定位（读 workspace 镜像 + ≤19 个目录 statSync），
  这是对 C-18「零磁盘 IO」字面的一处显式取舍；其余路径严格零磁盘 IO（未命中缓存 TTL 30s）。
- 宿主 `$events` 长连存在被宿主心跳终止后的重连间隙（重连期间的事件会丢），已按 C-14 打 `[HOST-LIVE]` 可 grep 日志；
  影响窗口为秒级，最终由下一次事件或播种纠正。
- 相关前案：[chat-tail-session-status-indicator](.agents/notes/implemented/feature/2026-09-18-chat-tail-session-status-indicator.md)、
  [strict-session-isolation-for-subagent-panel](.agents/notes/implemented/bug-fix/2026-10-12-strict-session-isolation-for-subagent-panel.md)、
  [queue-steer-dock-bubble-style](.agents/notes/implemented/feature/2026-09-23-queue-steer-dock-bubble-style.md)（插队交互与状态口径延续）。

### 对抗审查发现与补齐（L3-A/L3-B/L3-P + 增量复审）

三路对抗审查共 14 条 finding，全部修复并留物理收据（`.dev-team/review-l3{a,b,p}.json`）。其中三条改变了方案本身：

1. **常驻 `$events` 流必须委托回瀑布（L3-B 致命项）**：网关把 waterfall 投递给**所有** remote event client 且仅在
   `deliveries.size === 0` 时 settle；per-task 流关闭时自动摘除 delivery，而常驻流永不关闭 ⇒ 不回应会让宿主
   `user-questions/request` / `approval/request` 永久挂起（打断 dsh web GUI 提问/审批）。修复：live 流对每条 waterfall
   立即回 `$events/result{kind:'next'}`，且 `waterfall` 帧的 `request.args` 绝不喂状态镜像。
   期间 Lead 曾临时下线生产服务（17:04–17:48）以保护宿主结算链路。
2. **C-20 精度（L3-B）**：`sessionTerminalState()` 把 `cancelled/aborted/interrupted/blocked` 也映射为 `stopped`，
   与「未终结」不可区分 ⇒ 新增自带尾部判定（最后一条终结性事件后无 `turn/end`/`finish` 才算未终结）。
3. **口径唯一化（L3-A）**：`hostRunningCache.ids` 一旦成功即永久非 null，使 C-20 桥接在三处中的两处成死代码，
   造成 `/api/sessions` 与 `/api/sessions/status` 结论相反、steer 被拒 ⇒ 抽出唯一判定函数
   `resolveSessionRunning`（task → live → 快照命中 → 桥接），「快照未命中该 sid / 快照过期」一律继续走桥接。

其余修复：WS 建连 `handshakeTimeout` + open 看门狗（否则订阅可静默死亡）、`locateSessionDirForStatus` 过
`isValidSessionId`（路径穿越）、`states` 用 `Object.create(null)`（`__proto__` 键丢失）、`source` 枚举纳入 `'task'`、
live 空 cwd 行不得跨工作区串台、前端轻量刷新 XHR 补 `timeout`/`abort`（任意时刻 ≤1 在飞）。
另新增 **C-21**：`/api/session/subagents?id=` 在冷启动无父子事实时对该单会话做一次 `session/projections` 定向 RPC
（实测 201ms，单飞 + 15s 缓存）——这是缺陷 #3 在 Q20 重启后真正闭环的关键（`session/list` 播种需 ≈474s）。

**NFR 基准演进（Lead 仲裁）**：`.dev-team/nfr-baseline.json` 的 `logging` 由 `format=json` + `trace_id` 改为
`format=text-prefix` + `correlation_token`（`[HOST-LIVE] conn=<streamId>` / `[HOST-LIST] attempt=<n>`）。
理由：本仓库既有 stdout 是冻结的文本契约，全树 `trace_id` 计数为 0，改造成 JSON 属契约外重构；意图（每条重连/降级
日志可关联）以 token 兑现。

