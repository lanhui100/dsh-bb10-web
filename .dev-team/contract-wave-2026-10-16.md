# Wave 2026-10-16 冻结契约：会话运行状态权威化（5 缺陷）

> 本文件由 Lead 冻结，是 Executor / Test Agent 的唯一契约来源。冻结后不得就地修改；
> 变更走契约演进门禁（Lead 裁决 → 出新版本 → 测试重锚红相）。

## 0. 缺陷与根因（物理证据）

| # | 现象 | 根因 |
|:--|:--|:--|
| 1 | 运行中的会话在列表/状态栏显示 `done`/`stopped` | 宿主 `session/list` 超时 → running 集合为 `null` → `isSessionUiRunning` 返回 false → `state = sessionTerminalState()` 兜底推断终态 |
| 2 | `C` 键「全工作区进行中」列表错误 | 同 #1（列表 `isRunning` 全 false，`state` 全为兜底终态） |
| 3 | `U` 键多智能体看板为空 | `getSessionSubagents()` 在 `items` 非数组时直接 `return {subagents:[], tasks:[]}` |
| 4 | 运行中插队（steer）被拒 `session not running` | `/api/session/prompt` 的闸门依赖 `getHostRunningSessionIds(true)`，超时后为 `null` |
| 5 | 进行中会话不能及时更新 | 宿主 RPC 失败不写缓存（`at = 0`），每次 `/api/sessions` 串行发起 2 次 6s RPC = 12.5s；前端 5s 轮询 → 永久滞后 + 重试风暴 |

物理收据（2026-10-16，本机生产实例）：

- `GET /api/sessions?...&refresh=1` → `time=12.54s`，返回 `isRunning:false, state:"done"`（该会话正由本 agent 回合运行中）。
- `GET /api/session/subagents?cwd=<ws:ponyllm>&id=session-c5845dbb-…` → `time=6.013s`，`subagents:[]`；同一父会话在 `$events` 流中确有 `origin:"subagent"` 子会话。
- 直连宿主 `session/list`（同 cookie/信封，与 server.mjs 一致）：`elapsed 560107ms` → `timeout`（>9 分钟无响应）。旁证：`session/modelCatalog` 1.14s、`session/projections` 0.54s，网关本身健康。
- `$events`（`/api/remote.mux`，payload `{args:{}}`）实测持续推送：`api-session/status [sid,bool]`、`api-session/added [SessionSummary]`、`api-session/removed [sid]`，跨工作区、含 `origin:"subagent"` / `parentSessionId` / `agentAvailable` / `running` / `projections.values.title`。

**结论**：`session/list` 不可作为热路径的 running 真源；必须以宿主转发的 `$events` 事件流建立进程内权威状态镜像，`session/list` 仅作冷启动/兜底且绝不阻塞、绝不重试风暴。

## 1. 冻结接口（Frozen Interface）

### 1.1 新模块 `lib/host-live-state.mjs`（唯一新增文件，ESM，Node 侧）

```js
export function createHostLiveState(opts) // → liveState
```

`opts`：`{ log?: (msg) => void }`

`liveState` 必须提供（签名冻结，实现细节自由）：

| 成员 | 语义 |
|:--|:--|
| `noteEvent(event, args)` | 应用一条宿主转发事件；`event ∈ {'api-session/status','api-session/added','api-session/removed','api-session/activity'}`，未知事件为幂等 no-op |
| `noteListItems(items)` | 用一次 `session/list` 快照批量播种（不覆盖已有更新的 live 事实） |
| `getSession(sid)` | → `null` 或 `{ sessionId, running, agentAvailable, parentSessionId, origin, cwd, title, updatedAt }` |
| `getRunningIds()` | → `Set<string>`；**永不为 null**（未知即空集，调用方自行决定兜底） |
| `hasRunningTruth()` | → `boolean`：是否已收到过任何权威 running 事实（区分「未知」与「确认不在跑」） |
| `listChildren(parentId)` | → 数组，元素同 `getSession`，按 `running` 降序、`updatedAt` 降序 |
| `start()` / `stop()` | 启停 `$events` 长连订阅（含指数退避重连，上限 30s，`stop()` 后不再重连） |

**事件映射（冻结）**：

- `api-session/status` args `[sessionId, running]` → 覆盖该 sid 的 `running`。
- `api-session/added` args `[SessionSummary]` → upsert 全字段（`running`、`agentAvailable`、`parentSessionId`、`origin`、`cwd`、`title = projections.values.title`、`updatedAt`）。
- `api-session/removed` args `[sessionId]` → `running=false, agentAvailable=false`（保留行以便列表继续显示）。
- `api-session/activity` args `[sessionId, updatedAt]` → 更新 `updatedAt`（不改变 running）。

### 1.2 服务端行为契约

| 契约 | 要求 |
|:--|:--|
| **C-1 单一在飞** | 全进程任意时刻最多 1 个 `session/list` RPC 在飞；失败/超时不得清空已知 running 集合 |
| **C-2 长超时** | `session/list` 超时 ≥ 60000ms；成功结果 TTL ≥ 300000ms；失败退避重试间隔 ≥ 60000ms |
| **C-3 热路径不阻塞** | `/api/sessions` 与 `/api/session/subagents` 命中缓存时不得等待宿主 RPC（缓存缺失/过期时先返回已知快照并后台刷新）；两者单次响应 P95 ≤ 1500ms（宿主不可达时亦然） |
| **C-4 running 真源优先级** | live 事件镜像 > `session/list` 快照 > 本地 `activeTasks`；**任何情况下不得因宿主 RPC 失败而把已确认 running 的会话降级为非 running** |
| **C-5 状态口径** | `state` 字段保持既有枚举 `idle/running/waiting/stopped/done/error`，`isRunning` 与 `state==='running'` 同源（对齐 `normalizeSessionState`） |
| **C-6 子智能体** | `/api/session/subagents?id=<sid>` 必须返回 live 镜像中 `parentSessionId===sid` 或宿主 catalog 命中的子会话，即使 `session/list` 不可用；无 `id` 时按工作区聚合 |
| **C-7 插队闸门** | `/api/session/prompt`（`mode:'steer'` 或 `'queue'`）在「live 镜像判定 running」或「本地 activeTask running」时必须放行，不得因 `session/list` 失败拒绝 |
| **C-8 轻量状态端点（新增）** | `GET /api/sessions/status?ids=a,b,c` → `200 {ok:true, at:<ms>, states:{ <sid>:{isRunning:bool, state:string} }}`；**禁止任何宿主 RPC**，纯内存读；未知 sid 返回 `{isRunning:false, state:'idle'}`；`ids` 为空 → `states:{}`；缺失 `ids` → 400 |
| **C-9 事件订阅** | 进程启动即建立 1 条常驻 `$events` 订阅；断开按指数退避重连；不得因单次 RPC 失败而重建 | 
| **C-10 无回归** | 既有 `/api/*` 响应结构（字段名/类型）不得变更；仅允许新增字段或新增端点 |

### 1.3 前端行为契约（`static/index.html`，严格 ES5）

| 契约 | 要求 |
|:--|:--|
| **F-1 状态及时性** | 面板打开期间，可见会话行的运行状态刷新周期 ≤ 5s，且单次刷新不得触发 `/api/sessions` 全量重拉（用 `C-8` 端点） |
| **F-2 C 面板** | 「全工作区进行中」视图必须显示 live 镜像中所有 running 会话；已终态会话不得残留 running 图标 |
| **F-3 U 面板** | 有子智能体时必须非空；空态文案仅在 live 镜像与 catalog 均无子会话时出现 |
| **F-4 插队** | `mode:'steer'` 失败时必须在状态行/toast 呈现服务端真实错误文案，禁止静默或伪造成功 |
| **F-5 ES5** | `acorn.parse(script,{ecmaVersion:5})` 必须 PASS；禁止 `const/let/箭头/模板串/fetch/Promise/class/解构/展开` |

### 1.4 Mock 宿主测试接缝（唯一允许的测试注入点，仅 `Q20_MOCK_HOST=1` 生效）

| 环境变量 | 语义 |
|:--|:--|
| `Q20_MOCK_HOST_RUNNING_SESSIONS` | 逗号分隔 sessionId；mock 的 `session/list` 与 live 真源都把它们标为 `running:true` |
| `Q20_MOCK_HOST_LIST_DELAY_MS` | `session/list` 解析前延迟毫秒数（默认 0） |
| `Q20_MOCK_HOST_LIST_FAIL` | `1` → `session/list` 返回 `{ok:false}`（模拟超时/不可达） |
| `Q20_MOCK_HOST_SUBAGENTS` | JSON 数组，元素 `{sessionId,parentSessionId,origin,cwd,title,running}`，并入 `session/list` items |
| `Q20_MOCK_HOST_RPC_LOG` | 文件路径；每次 mock RPC 追加一行 JSON `{"method":...,"at":<ms>}`（物理收据：可数请求次数） |

> 接缝只允许被 mock 分支读取；生产路径不得读取。

## 2. 写域与任务

| 任务 | Owner | write_scopes |
|:--|:--|:--|
| T1 服务端权威状态 | executor-server | `server.mjs`, `lib/host-live-state.mjs` |
| T2 前端状态刷新与看板 | executor-web | `static/index.html` |
| T3 独立验收测试（冻结） | test-agent | `tests/acceptance/` |

写域两两不相交。T1/T2 的公共接缝由本契约冻结，禁止 Executor 改测试。

## 3. 验收矩阵（Test Agent 依此编写，红相先冻结）

| 用例 | 输入 | 断言 |
|:--|:--|:--|
| A1 | mock + `RUNNING_SESSIONS=<sid>` | `/api/sessions` 该 sid `isRunning===true && state==='running'` |
| A2 | mock + `RUNNING_SESSIONS=<sid>` + `LIST_FAIL=1` | 同 A1（证明 running 不依赖 session/list 成功） |
| A3 | mock + `LIST_DELAY_MS=8000` | `/api/sessions` 单次 `time < 1500ms` 且 A1 成立 |
| A4 | mock + `LIST_FAIL=1`，连续 3 次 `/api/sessions` | `RPC_LOG` 中 `session/list` 出现次数 ≤ 1（单一在飞 + 失败退避） |
| A5 | mock + `SUBAGENTS=[{parentSessionId:<sid>}]` + `LIST_FAIL=1` | `/api/session/subagents?id=<sid>` 非空且含该子会话 |
| A6 | mock + `RUNNING_SESSIONS=<sid>` | `POST /api/session/prompt {mode:'steer'}` 返回 `ok:true` |
| A7 | mock + `RUNNING_SESSIONS=<sid>` | `GET /api/sessions/status?ids=<sid>` → `isRunning:true`，且 `time < 300ms` |
| A8 | 生产态（真宿主 3080） | 对真实 running 会话，`/api/sessions/status` 与 `/api/sessions` 一致报 running |
| A9 | 浏览器（playwright，真实页面） | C 面板与 U 面板渲染正确、Console Error = 0、截图落盘 |
| A10 | ES5 门禁 | `acorn {ecmaVersion:5}` Exit 0 |

A8/A9 需在修复后运行；A1–A7、A10 必须在实施前红相失败（失败原因必须是断言失败，非语法/导入错误）。

## 3bis. Addendum v1.1（Lead 仲裁，2026-10-16，随 §0 新增物理证据追加）

新增证据（本机生产实例，Lead 实测）：`$events` 订阅建立后 3 分钟窗口内捕获 31 帧，事件分布
`api-session/status×10 / api-session/added×8 / api-session/activity×6 / api-session/error×1 / api-session/removed×2`；
其中 3 个 `origin:"subagent"` 会话的 `parentSessionId` 正是 `session-mvaial3ckyi60b`，且随后均收到
`api-session/status [sid,true]`（确认在跑），而同一时刻 `/api/session/subagents?id=session-mvaial3ckyi60b`
返回 `subagents:[]`（4.44s）。→ 缺陷 #3 现场复现；`added` 帧的 `projections.values` 实测含
`title / subagentCatalog / agentTeam / subagent / sessionListMetadata / tokenUsage` 等键。
`/api/sessions` 同一时刻对运行中的 `session-mvaial3ckyi60b` 报 `isRunning:false, state:"stopped"`
（前一次调用报 `state:"done"`，终态兜底在 done/stopped 间抖动）→ 缺陷 #1 现场复现。

**C-11 冷启动播种（新增，必须）**：live 镜像建立前已在运行的会话不会补发 `api-session/status`（事件只在订阅建立后转发）。
因此进程启动后必须**异步、非阻塞**地发起一次 `session/list` 播种（`noteListItems`），并把其 running 事实并入 live 镜像；
播种失败/超时不得影响任何 API 响应，也不得清空 live 镜像。`hasRunningTruth()` 用于区分「未知」与「确认不在跑」：
`hasRunningTruth()===false` 时允许沿用既有 `sessionTerminalState()` 兜底推断（保持既有行为），
一旦收到任一权威事实即以权威事实为准。

**C-12 投影字段映射（新增，必须）**：`api-session/added` 的 `SessionSummary` 无顶层 `title`，
`title = summary.title || summary.projections.values.title`；`projections.values.subagentCatalog` 与
`agentTeam` 必须一并存入 live 镜像，供 `/api/session/subagents` 在 `session/list` 不可用时兜底输出子会话与团队任务。

**验收补充**：C-11/C-12 的机器可验部分由 Lead 在真链路核验（标注 non-machine：依赖本机真实宿主运行态），
用例 A1–A10 不变；Lead 终验必须证明「本会话 3 个在跑子智能体在 `/api/session/subagents` 中可见」与
「运行中会话 `/api/sessions` 报 `isRunning:true, state:'running'`」。

**C-13 ad-hoc 调用豁免（Lead 裁决）**：C-1 的「单一在飞」只约束共享主通道
`fetchHostSessionListFull/fetchHostSessionListData`；既有 ad-hoc `session/list`（`session/fork` 5755 附近、
`queue/remove` 6038 附近）保持原样、不得新增，也不得把主通道的 60s 超时套用其上。

**C-14 订阅可观测（Lead 裁决）**：生产路径必须真正注入连接参数并使 `$events` 订阅在线（禁止静默 no-op）；
连接建立 / 断开 / 每次重连必须各打一行可 grep 日志（`[HOST-LIVE]` 前缀 + 重连次数 + 退避毫秒），
供 Lead 真链路核验。

**C-15 会话行不得伪造（Lead 裁决）**：live 镜像只提供状态事实，**不得**据此在 `/api/sessions` 新增磁盘不存在的会话行。
A1/A2/A5/A6/A7 的 `<sid>` 必须由测试通过 Q20 API（`session/ensure`/`create` + `prompt`）造出真实行。

**C-16 mock 真源就绪（Lead 裁决）**：`Q20_MOCK_HOST=1` 时 `start()` 不得发起真实 WS，但 live 真源必须在进程启动时即按
§1.4 播种就绪（`RUNNING_SESSIONS`→status 事实、`SUBAGENTS`→added 事实），否则 A1/A2/A5 会因真源为空而红。

**C-17 实测修正 C-2（Lead 裁决，物理收据）**：Lead 直连宿主 `session/list`（同 cookie/信封）**最终返回**：
`elapsed_ms=474435`（≈7.9 分钟）、`items=3891`。故主通道超时不得沿用 60000ms：
`session/list` 主通道超时 **≥ 600000ms（10 分钟）**，成功 TTL **≥ 1800000ms（30 分钟）**，
失败退避 **≥ 300000ms（5 分钟）**；仍必须单一在飞、后台化、绝不进入任何请求的热路径。
（A3/A4 用例仍按 mock 注入阈值判定，不受本条影响。）

**C-18 `/api/sessions/status` 契约 v1.2（Lead 裁决，覆盖 §1.2 C-8 的响应形状）**：
`GET /api/sessions/status?ids=a,b,c` → `200 {ok:true, at:<ms>, states:{"<sid>":{isRunning:<bool>, state:<string>, known:<bool>}}}`；
- `known:true`：服务端对该 sid 持有权威事实（live 事件或已播种快照）。此时 `isRunning` 可信；
  `isRunning:false` 时 `state` 返回 `'idle'`，表示「已确认不在跑，但无终态判定」，**前端只允许据此收敛 running 标记，
  不得据此改写终态符号**。
- `known:false`：无权威事实（冷启动未播种 / 未知 sid）。**前端严禁据此降级既有状态**（必须原样保留）。
- `ids` 缺失 → 400；`ids` 为空 → `states:{}`；单次最多 60 个 id（超出按顺序截断）。
- 纯内存、零宿主 RPC、零磁盘 IO；P95 ≤ 300ms。

**C-19 既有冻结套件即回归门禁（Lead 裁决，物理收据）**：`test-unit.mjs` 默认 `BASE_URL=http://127.0.0.1:3090`
（真实生产实例），其用例 `Subagents endpoint lite=1 envelope contract` 在修复前**已因本缺陷失败**
（`HTTP request timeout after 10000ms`，全量 28 项 27 通过 1 失败，总耗时 117957ms）。
修复后该套件必须 28/28 全绿——这是本次变更的既有回归证据，**测试文件只读，禁止修改**。

**C-20 冷启动桥接（Lead 裁决，新增，必须实现）**：`$events` 只在订阅建立后转发事件，故「Q20 启动前已在跑」
的会话在 live 镜像中无权威事实（实测：本会话 `session-mvaialk...` 的 `api-session/status` 从未补发）。
为避免冷启动期间状态全错，新增**只允许提升、永不强制降级**的本地启发式桥接：

- 当 `hasRunningTruth(sid) === false`（无权威事实）时：
  `running := (sessionTerminalState(zstdPath) === 'stopped') && (now - mtime(zstdPath) <= 300000)`
  （依据：durable 尾部出现 `user/message`/`turn/start` 而无 `turn/end` ⇒ 回合未终结；mtime 新鲜 ⇒ 该回合仍在推进。
  实测运行中的本会话：`mtime age = 1s`、尾部为未终结回合。）
- 命中 → `/api/sessions` 该行 `isRunning=true, state='running'`；`/api/sessions/status` 返回
  `{isRunning:true, state:'running', known:true, source:'heuristic'}`。
- 未命中 → `/api/sessions/status` 返回 `{isRunning:false, state:'idle', known:false}`（前端不得降级）。
- 权威事实（live 事件或 list 快照）到达后启发式立即失效；`source` 字段取值 `'live'|'list'|'heuristic'`。
- **绝不**因启发式未命中而把已确认 running 的会话降级（C-4 优先）。
- 已知残留风险（显式登记，靠 review）：超过 300s 无 durable 写入的长工具调用回合会被漏判为未运行，
  由 live 事件或后台播种（C-11）最终纠正。

**C-21 子智能体冷启动真源（Lead 裁决，生产实测发现，必须实现）**：C-11 的 `session/list` 播种需 ≈474s，
C-20 只覆盖「会话自身」运行态，**不覆盖父子关系**；因此 Q20 重启后（live 镜像为空、播种未完成）打开 `U` 面板
仍会看到空列表——缺陷 #3 在冷启动窗口未真正闭环。
实测（Lead，本机生产实例）：`session/projections` 信封 `payload.args = { request: { sessionId } }`（**注意与
`session/list` 的 `{_request:{}}` 不同**）返回 **201ms**，其 `values` 含完整 `subagentCatalog`
（`[{id, mode, label, createdAt}]`）与 `agentTeam`（`{members:[{id,name,role,phase}], tasks:[…]}`）。

要求：
- `/api/session/subagents?id=<sid>` 在「live 镜像无该 sid 的子会话」且「已知 list 快照为空/无该 sid 的 catalog」时，
  对该 **单一 sid** 发起一次 `session/projections` 定向 RPC（超时 ≤5000ms），用 `subagentCatalog` + `agentTeam`
  构造子会话/团队任务行；子会话的 `running` 优先取 live 镜像事实，缺失时按 catalog 存在即列出（`running:false`）。
- 必须**单飞 + 短缓存**（每 sid TTL ≥15000ms，避免面板 5s 重拉打爆宿主）；失败/超时/异常一律回落 live 镜像与 list 快照，
  **绝不抛错、绝不让该端点失败**（保持既有响应形状与字段名，C-10）。
- 仅用于带 `id` 的会话级查询；工作区级（无 `id`）保持 live 镜像 + list 快照口径，不得逐会话放大 RPC。
- mock 模式：`Q20_MOCK_HOST=1` 时不得发起真实 RPC（mock 分支返回 `{ok:true,value:{}}` 即可，A5 仍由 §1.4 接缝判定）。

**C-22 C-3 阈值补充（Lead 裁决）**：`/api/session/subagents?id=…` 允许因 C-21 定向 RPC 增加 ≤1 次宿主调用，
单次响应 P95 上限放宽到 **≤2500ms**；`/api/sessions` 与 `/api/sessions/status` 阈值不变（分别 ≤1500ms / ≤300ms）。

**C-23 常驻 `$events` 订阅必须委托回瀑布（Lead 裁决，L3-B 致命项，必须实现）**：
网关把每条 waterfall（`user-questions/request`、`approval/request`）投递给**所有**已注册的 remote event client，
且仅在 `pending.deliveries.size === 0` 时 settle（`packages/api/gateway/src/index.ts` 的 `startRemoteEvent` /
`receiveRemoteEventResult`）。Q20 既有 per-task 流在关闭时会自动移除 delivery，而**常驻 live 流永不关闭**——
若不回应，宿主侧提问/审批将**永久挂起**（会打断 dsh web GUI 的提问与审批链路）。
要求：live 流必须对**每一条** waterfall 帧立即回 `$events/result`
（`payload.args = { clientId, eventId, outcome: { kind: 'next' } }`，`clientId` 取自 `ready` 帧，信封与既有
`settleUserEvent` 一致），语义为「本 client 不认领，委托回瀑布」；`cancel` 帧仅清理本地挂起，无需回应。
失败重试不得阻塞、不得抛错，日志带 C-14 关联 token。**`waterfall` 帧的 `request.args` 绝不得喂给状态镜像**
（上游 `RemoteEventInvocationFrame` 无 `args` 字段，误喂会伪造 `running` 权威事实）。

**C-24 `source` 枚举补充（Lead 裁决）**：`/api/sessions/status` 的 `source` 允许取值
`'live' | 'list' | 'heuristic' | 'task'`（`'task'` = 本地 `activeTasks` 判定），前端不参与判定。

**C-25 C-20 精度要求（Lead 裁决，L3-B 反例）**：`sessionTerminalState()` 把
`cancelled/aborted/interrupted/blocked` 的 `turn/end` 也映射为 `'stopped'`，与「回合未终结」不可区分，
会把已取消的会话在 300s 窗口内误报为 running。C-20 桥接必须**自带更精确的尾部判定**：
只有「尾部最后一条终结性事件为 `user/message`/`turn/start`/`step/start`/`tool/call`/`assistant/message`
且其后无 `turn/end`/`assistant/chunk(finish)`」才视为未终结；出现任何 `turn/end` 或 `finish` 一律不判 running。

## 4. NFR 增量（叠加 `.dev-team/nfr-baseline.json`）

- 外部调用硬超时：`session/list` 主通道 600000ms（C-17 豁免，仅后台播种）；`session/prompt`/`session/cancel` 保持 ≤10000ms；`/api/sessions/status` 零外部调用。
- 重连退避：`$events` 订阅 1s → 2s → 4s → … 上限 30s。
- 资源释放：`stop()` 必须关闭 WebSocket、清理定时器。
- 结构化日志：重连/降级必须带 `trace_id`（沿用既有日志风格，不引入 JSON 强约束以免破坏现有 stdout 契约）。
