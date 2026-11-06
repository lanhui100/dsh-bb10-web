# Contract — Wave 2026-11-06：预览越界读取的会话策略授权（preview-policy）

- 分级：B（命中：安全边界 × 多文件 `server.mjs` + `static/index.html` + `lib/`；外部 IO：宿主 RPC `session/projections`）
- 冻结方：Protocol Agent（task-1，唯一编写方）
- 目标文件（write_scopes）
  - 协议侧（本 Agent，只写两个文件）：`.dev-team/contract-wave-2026-11-06.md`、`lib/preview-policy.mjs`
  - 实施侧（Implementer，非本 Agent 写域）：`server.mjs`、`static/index.html`
  - 测试侧（Test Agent 独占，实现者只读）：`tests/acceptance/suite-preview-policy.mjs`、`tests/acceptance/adversarial/preview-policy-attack.mjs`、`tests/acceptance/run-all.mjs`、`tests/acceptance/RED-PHASE.md`
- 本波次产出契约 + 空桩，**不含任何判定实现**；空桩 `decidePreviewReadAccess` 函数体仅 `throw new Error('NotImplemented')`。

---

## §0 根因（只读取证，可复核）

### 0.1 现象

轮次结束的「📦 交付文件」列表里，**不在当前工作区**的文件点击预览被拒：HTTP 403，界面文案「该文件不在当前工作区内，已拒绝读取」（`static/index.html:9775`，该文案由客户端对 `/api/file` 的**任意** 403 统一映射而来，服务端原始文案在响应 JSON 的 `error` 字段）。

### 0.2 服务端：越权判定只有两把锁，且完全不看会话文件策略

- 路由：`GET /api/file` → `server.mjs:6635-6643`
  - 取 `cwd`、`path` 两个 query 参数，交给 `resolveWorkspacePreviewPath(...)`。
- 解析器：`server.mjs:4195-4222`（`function resolveWorkspacePreviewPath(cwdRaw, filePathRaw)`）
  - `server.mjs:4200-4206`：`cwd` 必须能 `fs.realpathSync` 成功，否则 400 `Invalid "cwd"`。
  - `server.mjs:4207-4215`：`registered = isRegisteredWorkspaceRoot(rootReal)`（`server.mjs:3982`）；未注册 → **403** `workspace is not registered`（`server.mjs:4209`）。
  - `server.mjs:4216-4222`：目标 `realpath` 必须等于工作区根或以 `rootReal + path.sep` 开头，否则 → **403** `path escapes the workspace root`（`server.mjs:4218-4220`）。
- 关键事实：**整条链路上没有任何一处读取会话的 `permissions` / 文件策略**。工作区包含性是唯一的越权闸门，而“越界是否被会话策略授权”这一维度在服务端根本不存在。
- 放行后走 `servePreviewFile`（`server.mjs:4137-4188`）：扩展名白名单经 `previewKindOf`（`server.mjs:4016-4021`），非白名单/非可信图片签名 → **415** `unsupported preview type`（`server.mjs:4174`）；体积上限 `PREVIEW_TEXT_MAX_BYTES=2MB`、`PREVIEW_IMAGE_MAX_BYTES=6MB`（`server.mjs:3945-3946`）→ **413**。这三条不变量本波次**保持不变**。

### 0.3 客户端：无工作区包含性判定、无 session 透传

- 卡片创建：`createDeliverablesElement`（`static/index.html:9859-9918`）用 `fpCanPreview(itemName)`（`static/index.html:9503-9505`，仅扩展名白名单 `fpIsImage || fpIsText`）决定卡片是否可点，**不做任何路径包含性/会话策略判定**；可点卡片挂 `data-fpchip/data-fpname/data-fppath/data-fpkind/data-fpcwd`。
- 请求构造：`fpBuildTarget`（`static/index.html:9696-9725`）只发 `'/api/file?cwd=' + encodeURIComponent(targetCwd) + '&path=' + encodeURIComponent(path) + '&name=' + ...`，**不带 session 标识**，服务端无从得知这是哪个会话的交付文件。
- 403 文案：`static/index.html:9775` 单条 `else if (st === 403) msg = '该文件不在当前工作区内，已拒绝读取';` —— 服务端两种 403 分支被折叠成同一句，用户无法区分「未注册工作区」「路径越界」「会话策略不足」。

### 0.4 宿主权威事实（实测收据，2026-11-06 本机）

原收据（Lead 实测）：

```
POST http://127.0.0.1:3080/api/session/projections {"sessionId":"session-mw47e45cavblex"}
→ values.permissions = {"currentValue":"danger-full-access"}
→ values.workingDirectory = "~/dsh-q20-web"
```

Protocol Agent 独立复核（同一台机，按 `getDshWebAuthCookie`（`server.mjs:757-782`）的签名口径派生 cookie，`client-request` 信封）：

```
SID=session-mw47e45cavblex status=200 permissions={"currentValue":"danger-full-access"} workingDirectory="~/dsh-q20-web"
keys=inbox|title|goal|tokenUsage|contextPressure|contextBreakdown|sessionStats|turnOutline|agentPreset|userQuestions|permissions|workingDirectory|subagentCatalog|subagentTiming|subagent|agentTeam|todos|plan|modelSelection|sessionListMetadata|imageLimits
```

- 结论：该会话**确实是**「完全权限」（`permissions.currentValue === 'danger-full-access'`），且 `workingDirectory` 与当前工作区一致；403 不是权限配置错误，而是服务端**没有查**策略。
- 取数现成能力：`fetchSessionProjections(sessionId)`（`server.mjs:5059-5093`），超时 `PROJECTIONS_TIMEOUT_MS = 2500`（`server.mjs:5042`），带正缓存 + 负缓存（`PROJECTIONS_TTL_MS = 15000`）+ 单飞（inflight）。非法 sid 直接 `Promise.resolve(null)`，失败/超时/异常一律返回 `null`，**绝不抛错**（复用即可，禁止另起新取数路径）。
- 测试接缝（mock 分支，生产路径绝不读取）：
  - 现有：`mockSeamProjections()`（`server.mjs:278-287`）读 `Q20_MOCK_HOST_PROJECTIONS`（JSON：`{ "<sid>": values }`），`case 'session/projections'`（`server.mjs:401-407`）返回 `{ ok:true, value:{ values } }`。
  - 本波次新增（契约 §1.4）：`Q20_MOCK_HOST_PROJECTIONS_FAIL`、`Q20_MOCK_HOST_PROJECTIONS_DELAY_MS`。

### 0.5 交叉失败点（一句话）

服务端只问「文件在不在工作区根内」，不问「这个会话有没有资格越界读」；客户端不传会话、也不懂策略 → 完全权限会话的交付文件必然 403。

---

## §1 冻结接口（签名 / 字段 / 错误码）

### 1.1 纯函数模块 `lib/preview-policy.mjs`（ESM，零副作用）

```js
export const FULL_ACCESS_POLICY = 'danger-full-access';
export function decidePreviewReadAccess(input) → { ok, status, code, error }
```

- `input` 字段（全部可选，缺字段按拒绝处理）
  | 字段 | 类型 | 语义 |
  |---|---|---|
  | `contained` | boolean | 目标 realpath 是否落在请求 `cwd` 的 realpath 根内（**调用方**已算好） |
  | `registered` | boolean | 请求 `cwd` 是否为已注册工作区根（**调用方**已算好） |
  | `sessionId` | string | 客户端透传的会话 id（已过 `isValidSessionId`，`server.mjs:4326-4330`） |
  | `requestCwd` | string | **请求 `cwd` 的 realpath**（调用方已归一）；步 c 的比较基准。缺失 = 「无法核验归属」（见下 c 步规则） |
  | `sessionCwd` | string | 宿主投影里的会话工作目录（已 realpath 归一） |
  | `permission` | string | 宿主投影 `permissions.currentValue` 原文 |
- 返回值恒为四字段对象：`{ ok: boolean, status: number, code: string, error: string }`；`code`/`error` 在 `ok===true` 时为空串 `''`。
- 硬约束：无 IO、无 `process.env`、无 `Date`、无缓存、无 async；**永不 throw**（畸形/缺字段一律落拒绝分支）。
- **缺字段=拒绝铁律的唯一例外说明**：`requestCwd`/`sessionCwd` 这对字段描述的是「归属可否核验」，不是授权本身——`sessionCwd` 为空（宿主无 `workingDirectory`）时视为**未知**、跳过 c 步，放行与否只由 d/e 决定；`requestCwd` 缺失时视为**无法核验归属**，若 `sessionCwd` 也非空则直接命中 c（`PREVIEW_SESSION_MISMATCH`），`sessionCwd` 为空时不受影响（仍走 d/e）。
- realpath 归一在**调用方**完成；纯函数只做字符串比较（`sessionCwd !== requestCwd` 的相等判定）。

### 1.2 错误码表（冻结；不得增删改字面量）

| code | status | error（响应体 `error` 原文） | 触发条件 |
|---|---|---|---|
| `''`（空串） | 200 | `''` | 授权通过（快路径 a 或策略放行 e） |
| `PREVIEW_OUT_OF_SCOPE` | 403 | `path escapes the workspace root` | 非快路径且 `!sessionId`（向后兼容：与今天逐字节等价） |
| `PREVIEW_SESSION_MISMATCH` | 403 | `session does not own this workspace` | `sessionCwd` 非空且与请求 `cwd` 的 realpath 不同 |
| `PREVIEW_PERMISSION_REQUIRED` | 403 | `session permission does not allow reading outside the workspace` | `permission !== FULL_ACCESS_POLICY` |
| `PREVIEW_POLICY_UNAVAILABLE` | 403 | `session permission is unavailable` | 服务端侧：宿主不可用/超时/无值（**非**纯函数产出，见 1.3） |

### 1.3 服务端 `/api/file` 契约（Implementer 落地）

- 路由 `GET /api/file`（`server.mjs:6635`）**新增可选 query 参数 `session`**。
- 处理顺序：
  1. 先算 `contained` / `registered`（沿用 `resolveWorkspacePreviewPath` 的 realpath 事实，越界时**不得**先返回 403，而是把 `contained:false` 交给判定；`404 preview file not found` 语义不变）。
  2. 调 `decidePreviewReadAccess({ contained, registered, sessionId, requestCwd, sessionCwd, permission })`，其中 `requestCwd` = 请求 `cwd` 的 `realpathSync` 结果（即 `resolveWorkspacePreviewPath` 里的 `rootReal`；取不到则传缺失，纯函数按「无法核验归属」fail-closed）。
     - **仅当**快路径 a 不成立（即 `contained && registered` 为假）**且** `sessionId` 合法（`isValidSessionId` 为真）时，才向宿主取 projections：`await fetchSessionProjections(sessionId)`（≤ `PROJECTIONS_TIMEOUT_MS = 2500`ms，复用现有正/负缓存与单飞，**禁止同步重试、禁止新建第二条取数路径**）。
     - 取到 `values` 后：`sessionCwd = realpath(values.workingDirectory)`（失败则视为空串→跳过 c 步），`permission = values.permissions && values.permissions.currentValue`（缺失视为非完全权限）。
  3. 宿主不可用 / 无 `values` / 无 `permissions` → 直接 403 `{ ok:false, code:'PREVIEW_POLICY_UNAVAILABLE', error:'session permission is unavailable' }`，并 `console.warn` 一行，**前缀 `[PREVIEW]` 且含 `sid=<sessionId>`**（日志可关联；禁止吞异常静默放行，也禁止把宿主错误细节出网）。
  4. 判定 `ok === true` → 仍走 `servePreviewFile(req, res, absolutePath, path.basename(absolutePath), 'private, no-cache')`（`server.mjs:6642`），即扩展名白名单 415（`server.mjs:4174`）与体积上限 413（`server.mjs:3945-3946`）**保持不变**，完全权限**不得**放宽。
  5. 判定 `ok === false` → `sendJson(res, status, { ok:false, code, error }, req)`（`code` 字段为新增，`error` 文案与旧路径一致）。
- **向后兼容铁律**：不带 `session` 的请求，其响应体与今天**逐字节等价** —— 越界仍为 `{"ok":false,"error":"path escapes the workspace root"}`（403），工作区内仍为 200 文件流；不得因新增 `code` 字段改写既有 200/403/404/413/415 响应形状。
- 快路径 a 成立时**零宿主调用**（不得为“顺手取一下 projections”而增加 RPC）。
- **裁决 R-1（`session` 多值/重复）**：`session=a&session=b` 之类重复参数视为**非法 session**，按「缺失」处理 → b 步 403 `PREVIEW_OUT_OF_SCOPE` + `path escapes the workspace root`，且**零宿主调用、零 RPC 收据**。实现口径：用 `searchParams.getAll('session')` 取全部值，长度 ≠ 1 即判非法（禁止取首值当合法用）；唯一值还须过 `isValidSessionId`。
- **裁决 R-2（`code` 字段出现面）**：仅「无 session（缺失/非法）」分支的 403 响应体保持**逐字节等价**（即 `{"ok":false,"error":"path escapes the workspace root"}`，**不含** `code`）；**带合法 session** 的 403 响应体一律**含** `code` 字段（`{ ok:false, code:'<见 §1.2>', error:'<见 §1.2>' }`）。带合法 session 时 b 步不可能命中，故 `code` 取值为 `PREVIEW_SESSION_MISMATCH` / `PREVIEW_PERMISSION_REQUIRED` / `PREVIEW_POLICY_UNAVAILABLE` 三者之一。
- **裁决 R-3（未注册 cwd + 无 session）**：统一走 b 步文案 `path escapes the workspace root`（**取代**今天的 `workspace is not registered`，`server.mjs:4209`）；向后兼容铁律仅对「cwd 已注册 + 越界」这一经典形态成立。Test A6b 以「接受集合」{`path escapes the workspace root`, `workspace is not registered`} 断言，实施侧无需保留旧文案。

### 1.4 测试注入接缝（mock-only，生产路径绝不读取；Implementer 在 `case 'session/projections'` 与 `mockSeamProjections` 旁实现）

| env | 语义 |
|---|---|
| `Q20_MOCK_HOST_PROJECTIONS` | 现有：`{ "<sid>": values }` 定向返回值 |
| `Q20_MOCK_HOST_PROJECTIONS_FAIL` | `=1` → 该 RPC 一律失败（`{ ok:false }` 或抛错，两者都测） |
| `Q20_MOCK_HOST_PROJECTIONS_DELAY_MS` | `=<n>` → 该 RPC 延迟 n 毫秒后返回（用于超时/fail-closed 与墙钟断言） |
| `Q20_MOCK_HOST_RPC_LOG` | **既有接缝（`server.mjs:247-255` `mockNoteRpc`，本波次复用不新增语义）**：`Q20_MOCK_HOST=1` 模式下每发生一次 mock RPC，向该文件追加一行 JSON `{"method":"<方法名>","at":<ms>,"args":<请求>}`（如 `session/projections` 一行）；生产路径绝不读取。用途：A6/A7/A8/AT-1b 的「零宿主调用 / ≥1 次调用 / 未发起 RPC」**物理计量**（Test Agent `tests/acceptance/lib/preview-host.mjs` 的 `countRpcMethod` / `readRpcLog` 已依赖此接缝）。实施要求：`case 'session/projections'` 必须同样经 `mockNoteRpc` 记账（禁止旁路），否则 A7「零宿主调用」与 AT-2「未发起 RPC」不可判定。 |

- **实现约束 M-1（mock 与生产同语义执行 `timeoutMs`）**：mock 分支的 RPC 入口（`server.mjs:362-373` `mockHandleRpcAsync`）**必须**与生产同语义执行 `timeoutMs` 超时——到点即 resolve `{ ok:false, error:'timeout', unreachable:true }`（生产分支由 `http.request` 的 `timeout` 生效，`server.mjs:807/900/993` 一带）。理由：mock 若忽略 `timeoutMs`，`Q20_MOCK_HOST_PROJECTIONS_DELAY_MS=6000` 会真阻塞 6s，AT-1b「墙钟 ≤3000ms」将无法验证 2500ms 上限，只能测出「最终返回」而非「按时放弃」。该约束为**纯 mock 侧等价性修正**，不改变生产分支任何行为。

### 1.5 客户端契约（ES5 硬约束，`static/` 一律 ES5）

- 交付卡片（`createDeliverablesElement`，`static/index.html:9859-9918`）可点卡片**追加** `data-fpsid` = 当前会话 id（来自 `currentSessionId` 一类现有真源；无会话时为空串）。
- `fpBuildTarget`（`static/index.html:9696-9725`）path 分支 URL **追加** `&session=<encodeURIComponent(sid)>`；`sid` 为空时**不得**追加该参数（保证与今天 URL 逐字节一致）。
- 403 响应解析：尝试 `JSON.parse(xhr.responseText)` 取 `code`（`try/catch` 保守包裹，`xhr.status` 读取同款保护），映射文案：
  | code | 文案 |
  |---|---|
  | `PREVIEW_PERMISSION_REQUIRED` / `PREVIEW_OUT_OF_SCOPE` | 该文件在当前工作区外，需会话「完全权限」才能预览 |
  | `PREVIEW_SESSION_MISMATCH` | 无法核验该文件的读取授权 |
  | `PREVIEW_POLICY_UNAVAILABLE` | 宿主离线，无法核验会话权限 |
  | 未知 / 解析失败 | 沿用原文案「该文件不在当前工作区内，已拒绝读取」 |
- 客户端**永不上报 `permission`**（服务端只信宿主投影 `session/projections`，客户端声明不可信）。

### 1.6 NFR

- 策略查询墙钟 ≤ 2500ms（`PROJECTIONS_TIMEOUT_MS`），负缓存 15s 内重复请求不重打宿主。
- **mock 等价性（见 §1.4 M-1）**：mock 分支必须同样执行 `timeoutMs`，超时 resolve `{ ok:false, error:'timeout', unreachable:true }`；否则 AT-1b 的 2500ms 上限不可证。
- fail-closed：任何不确定（缺字段、宿主不可用、解析失败）→ 拒绝，绝不“默认放行”。
- 日志可关联：`[PREVIEW] ... sid=<sessionId> ...`。
- 禁止吞异常：捕获后必须落 warn 并转成 `PREVIEW_POLICY_UNAVAILABLE`。

---

## §2 决策顺序真值表（冻结，逐条执行，先命中先返回）

判定顺序（`decidePreviewReadAccess` 内部严格按 a→e；口径：`requestCwd` 恒为请求 cwd 的 realpath，除非该行另有标注）：

| 步 | 条件 | 结果 |
|---|---|---|
| a | `contained === true` **且** `registered === true` | `{ ok:true, status:200, code:'', error:'' }`（旧快路径：**不查宿主、不要求 session、不看 permission**） |
| b | `!sessionId`（含空串/undefined/null/非字符串） | `{ ok:false, status:403, code:'PREVIEW_OUT_OF_SCOPE', error:'path escapes the workspace root' }` |
| c | `sessionCwd` 非空 **且**（`requestCwd` 缺失 **或** `sessionCwd !== requestCwd`） | `{ ok:false, status:403, code:'PREVIEW_SESSION_MISMATCH', error:'session does not own this workspace' }` |
| d | `permission !== FULL_ACCESS_POLICY` | `{ ok:false, status:403, code:'PREVIEW_PERMISSION_REQUIRED', error:'session permission does not allow reading outside the workspace' }` |
| e | 其余（即 `sessionId` 有、`sessionCwd` 为空 或 `sessionCwd === requestCwd`、`permission === 'danger-full-access'`） | `{ ok:true, status:200, code:'', error:'' }` |

c 步细则（冻结）：
- `sessionCwd === ''`（或缺失）→ **视为未知**，跳过 c，放行与否只看 d/e。
- `requestCwd` 缺失 → **视为无法核验归属**；此时若 `sessionCwd` 非空则 c 命中（`PREVIEW_SESSION_MISMATCH`），若 `sessionCwd` 同时为空则仍跳过 c（走 d/e）。
- 比较为**纯字符串相等**（两侧 realpath 归一由调用方完成，本函数不做路径规范化、不做大小写折叠、不去尾斜杠）。

真值表（`requestCwd = '/ws'` 为默认口径；`—` = 不适用/未走到）：

| # | contained | registered | sessionId | requestCwd | sessionCwd | permission | 命中步 | 结果 |
|---|---|---|---|---|---|---|---|---|
| T1 | true | true | 任意 | 任意 | 任意 | 任意 | a | 200 放行（零宿主调用） |
| T2 | true | false | 任意 | 任意 | 任意 | 任意 | 后续步 | 非 a，继续 b→e |
| T3 | false | true | `''`/缺失 | `/ws` | — | — | b | 403 PREVIEW_OUT_OF_SCOPE |
| T4 | false | false | 缺失 | `/ws` | — | — | b | 403 PREVIEW_OUT_OF_SCOPE |
| T5 | false | true | `s1` | `/ws` | `/other`（≠requestCwd） | 完全权限 | c | 403 PREVIEW_SESSION_MISMATCH |
| T6 | false | true | `s1` | `/ws` | `''`（宿主无 workingDirectory） | 完全权限 | e | 200 放行 |
| T7 | false | true | `s1` | `/ws` | `/ws` | `workspace-write` | d | 403 PREVIEW_PERMISSION_REQUIRED |
| T8 | false | true | `s1` | `/ws` | `/ws` | `undefined`/`''`/`null`/`read-only` | d | 403 PREVIEW_PERMISSION_REQUIRED |
| T9 | false | true | `s1` | `/ws` | `/ws` | `danger-full-access` | e | 200 放行 |
| T10 | 缺失/畸形 input（`{}`、`null`、`undefined`、非对象） | — | — | — | — | — | b（按缺字段=拒绝） | 403 PREVIEW_OUT_OF_SCOPE，**不 throw** |
| T11 | false | true | `s1` | **缺失**（无法核验归属） | `/ws` | 完全权限 | c | 403 PREVIEW_SESSION_MISMATCH（requestCwd 缺失不得默认相等） |
| T12 | false | true | `s1` | **缺失** | `''` | 完全权限 | e | 200 放行（两者皆未知，只看 permission） |

顺序不可交换的语义要点：
1. a 优先于 b：旧快路径绝不因缺 session 而回归 403。
2. b 优先于 c/d：无 session 时不得因“恰好 permission 缺失”改报 `PREVIEW_PERMISSION_REQUIRED`（必须保持旧响应逐字节等价）。
3. c 优先于 d：会话不匹配比权限不足更靠前（避免向不相关会话泄露“该会话权限足够”的信息）。
4. `sessionCwd` 为空视为**未知**而非不匹配：放行判断只由 permission 决定（宿主无 `workingDirectory` 时不得一概拒绝）。
5. `requestCwd` 缺失不得被解释成「等于 `sessionCwd`」：归属不可核验时，只要宿主给出了 `sessionCwd` 就必须拒绝（fail-closed）。

---

## §3 验收矩阵 A1–A9（Test Agent 实现，实现者只读）

- **纯函数用例** → `tests/acceptance/suite-preview-policy.mjs`
- **服务端集成用例**（独立 mock 实例，`Q20_MOCK_HOST=1` + 接缝） → `tests/acceptance/suite-preview-policy.mjs`
- **对抗用例** → `tests/acceptance/adversarial/preview-policy-attack.mjs`
- 退出码语义沿用 `tests/acceptance/run-all.mjs` 既有约定（0/1/2/3），禁止伪绿；断言必须非空且断言具体字段。

| ID | 输入 | 期望 | 归属文件 |
|---|---|---|---|
| A1 | 纯函数：`{contained:true, registered:true}`（其余字段全部缺失/为假值） | `{ok:true,status:200,code:'',error:''}`；且再传 `{contained:true,registered:true,sessionId:'',permission:'workspace-write'}` 仍 200（快路径不看 session/permission） | `suite-preview-policy.mjs` |
| A2 | 纯函数：`{contained:false,registered:true}`、`{contained:false,registered:false}`、`{contained:false,registered:true,sessionId:''}` | 三者均 `{ok:false,status:403,code:'PREVIEW_OUT_OF_SCOPE',error:'path escapes the workspace root'}` | `suite-preview-policy.mjs` |
| A3 | 纯函数（`requestCwd:'/ws'` 口径）：① `sessionId:'s1'`、`sessionCwd:'/other'`、`permission:'danger-full-access'` → 403；② 同参但 `sessionCwd:'/ws'` → 200（证明 c 只在不相等时命中）；③ `requestCwd` 缺失 + `sessionCwd:'/ws'` + 完全权限 → 403（T11）；④ `requestCwd` 与 `sessionCwd` 皆缺失/空 + 完全权限 → 200（T12） | ①③ 403 `PREVIEW_SESSION_MISMATCH` + `session does not own this workspace`；②④ 200 | `suite-preview-policy.mjs` |
| A4 | 纯函数（`requestCwd:'/ws'`、`sessionCwd:'/ws'`）：`permission` 依次 `'workspace-write'`、`'read-only'`、`''`、`undefined`、缺失 | 全部 403 `PREVIEW_PERMISSION_REQUIRED` + `session permission does not allow reading outside the workspace` | `suite-preview-policy.mjs` |
| A5 | 纯函数：合法全通参 `{contained:false,registered:true,sessionId:'s1',requestCwd:'/ws',sessionCwd:'/ws',permission:'danger-full-access'}`；畸形输入 `{}`、`null`、`undefined`、`'str'`、`{permission:'danger-full-access'}` | 合法参 200 且 `code===''`、`error===''`；畸形输入**不 throw**、恒返回四字段对象且落拒绝 | `suite-preview-policy.mjs` |
| A6 | 服务端（mock 实例）：`GET /api/file?cwd=<已注册工作区>&path=<工作区外真实文件>`（**不带 `session`**）；同实例再测工作区内白名单文件 | 越界：403 且响应体与基线**逐字节等价** `{"ok":false,"error":"path escapes the workspace root"}`（不含 `code`）；工作区内：200 文件流内容逐字节等于磁盘内容 | `suite-preview-policy.mjs` |
| A7 | 服务端：工作区内白名单文件 + `Q20_MOCK_HOST_PROJECTIONS_FAIL=1`（注入宿主必失败） | 仍 200（证明快路径 a 零宿主调用；若实现误调宿主则会 403 `PREVIEW_POLICY_UNAVAILABLE` 而失败） | `suite-preview-policy.mjs` |
| A8 | 服务端：完全权限会话（接缝 `Q20_MOCK_HOST_PROJECTIONS={"<sid>":{"permissions":{"currentValue":"danger-full-access"},"workingDirectory":"<requestCwd>"}}`）请求工作区外白名单文件 | 200，`Content-Type` 与磁盘内容正确（与工作区内同一文件读取结果逐字节一致） | `suite-preview-policy.mjs` |
| A9 | 服务端分组不变式：<br>A9.1 宿主不可用（`Q20_MOCK_HOST_PROJECTIONS_FAIL=1` 或接缝缺该 sid）→ 403 `PREVIEW_POLICY_UNAVAILABLE` + `session permission is unavailable`，stderr/warn 含 `[PREVIEW]` 与 `sid=<sid>`；<br>A9.2 `permission:'workspace-write'` + 同 cwd 越界 → 403 `PREVIEW_PERMISSION_REQUIRED`；<br>A9.3 `session` 指向另一工作区 cwd → 403 `PREVIEW_SESSION_MISMATCH`；<br>A9.4 完全权限放行后：非白名单扩展名（如 `.bin`/`.exe`）→ 415 `unsupported preview type`；`>2MB` 文本 → 413（体积上限不被完全权限放宽） | 四条子项逐条断言，任一失败即 A9 失败 | `suite-preview-policy.mjs` |

---

## §3bis L2-AT 对抗矩阵（三类，`tests/acceptance/adversarial/preview-policy-attack.mjs`）

对抗前提：所有用例均在独立 mock 实例（`Q20_MOCK_HOST=1`）内，逐用例清理 env 与缓存（负缓存 TTL 15s，跨用例必须新建实例或换 sid，避免串味）。

### AT-1 失败/超时注入 → fail-closed 且墙钟受限

| 注入 | 期望 |
|---|---|
| `Q20_MOCK_HOST_PROJECTIONS_FAIL=1` + 越界 + 合法 `session` | 403 `PREVIEW_POLICY_UNAVAILABLE`；**无文件字节出网**（响应体不含文件内容、`Content-Length` 为 JSON 长度）；warn 含 `[PREVIEW]` 与 `sid=` |
| `Q20_MOCK_HOST_PROJECTIONS_DELAY_MS=6000`（> 2500ms 超时）+ 越界 + 合法 `session` | 403 `PREVIEW_POLICY_UNAVAILABLE`；单请求墙钟 ≤ **3000ms**（契约上限 2500ms + 允许 500ms 调度抖动）；不得挂死、不得 500、不得退回放行 |
| 同上但请求**工作区内**路径 | 200 且墙钟 ≤ 500ms（快路径不受宿主延迟影响） |
| 接缝返回 `{}`（该 sid 无投影） | 403 `PREVIEW_POLICY_UNAVAILABLE`（缺字段=拒绝） |

### AT-2 畸形负载 → 一律拒绝且不泄字节

| 输入 | 期望 |
|---|---|
| `path` 含 `..%2f` / `%2e%2e%2f` 编码穿越，配合完全权限 session | 不得借策略放行穿越到工作区外任意路径后仍能 200（realpath 事实优先：穿越解析后的目标若真在工作区内则 200 合法；若在区外则必须 403 且**仅当** c+d+e 全通才可能 200 —— 断言重点是：**不得出现未授权 200**，且 404/403 响应体不含路径细节） |
| `path` 含 `%00` NUL、超长 path（≥4096 字节）、相对路径 `../../etc/passwd` | 400/403/404 之一，绝不 200，绝不 500，响应体不泄绝对路径（`/home/`、`/etc/` 不得出现） |
| 伪造 `session` 参数：`..%2f`、`'a'.repeat(200)`（>128）、`session-../../x`、空串、重复参数 `session=a&session=b` | 非法 sid 按 `!sessionId` 处理 → 403 `PREVIEW_OUT_OF_SCOPE`（旧文案，**不含 `code`**，见 R-2）；**`Q20_MOCK_HOST_RPC_LOG` 收据中 `session/projections` 计数必须为 0**（物理证明未发起 RPC，见 §1.4） |
| 客户端试图上报 `permission=danger-full-access`（query 或 body 带该字段） | 服务端**完全忽略**（判定只看宿主投影）→ workspace-write 会话请求越界仍 403 `PREVIEW_PERMISSION_REQUIRED` |

### AT-3 竞态 → 无策略串味

- 场景：同一 mock 实例内，两个 sid 并发（确定性 barrier，`await` 同时放行）：
  - `sid-full` → `permissions.currentValue='danger-full-access'`，`workingDirectory=requestCwd`
  - `sid-write` → `permissions.currentValue='workspace-write'`，`workingDirectory=requestCwd`
- 断言：`sid-full` 请求越界 → 200；`sid-write` 同时请求同一越界路径 → 403 `PREVIEW_PERMISSION_REQUIRED`；重复 20 轮顺序结果稳定（不得因单飞/缓存把 `sid-full` 的投影串给 `sid-write`）。
- 二段：同一 sid 先 `workspace-write` 请求（负缓存不适用，正缓存命中）后立刻改接缝为 `danger-full-access`——**允许**在 15s TTL 内沿用旧投影（缓存语义，非缺陷），用例必须显式接受这一行为并在注释中说明，不得据此判实现失败；反向（先 full 后 write）同理。真正要防的是**跨 sid 串味**。

---

## §4 Non-Goals（明确不做，越界即视为违反契约）

1. **不放宽扩展名白名单**：`previewKindOf`（`server.mjs:4016-4021`）与客户端 `fpCanPreview`（`static/index.html:9503-9505`）口径不变；完全权限**不等于**可预览任意类型。
2. **不新增文档/媒体类型**：不新增 `pdf`/`docx`/`mp4`/`svg` 等类型支持。
3. **不做目录浏览**：不引入目录 listing / 通配 / 递归读取；`/api/file` 仍只服务单文件。
4. **不信任客户端 `permission`**：客户端永不上报，服务端忽略任何客户端自述权限。
5. 不改 `servePreviewFile` 的 413/415/404 语义与 `Cache-Control`（工作区文件仍 `private, no-cache`）。
6. 不新增第二条宿主取数通道；不改造 `fetchSessionProjections` 的超时/TTL/缓存策略。
7. 不改工作区注册表语义（`isRegisteredWorkspaceRoot` 行为不变）。
8. 不在本波次引入目录级策略、审批流、UI 设置项。

---

## §5 回滚与阻塞条件

### 5.1 回滚

- 回滚单元 = 三个独立提交点：① `lib/preview-policy.mjs`（新模块，纯增量）② `server.mjs`（/api/file 判定接线）③ `static/index.html`（`data-fpsid` + `&session=` + 403 文案映射）。
- 只需回滚 ②③ 即可恢复今天行为（`lib/` 新模块无人引用，零影响）；纯函数模块可独立保留供后续波次复用。
- 回滚判据（任一命中即回滚 ②③）：向后兼容字节等价用例（A6）失败／工作区内快路径出现宿主调用（A7 失败）／墙钟超 3000ms 或出现 5xx／`node test-decoupling.mjs && node test-suite.mjs` 非全量 PASS／ES5 门禁失败。
- 回滚命令面：`git revert <②③ 提交>`（禁止直接 `git reset --hard` 破坏他人在途改动）。

### 5.2 阻塞条件（出现即停手上报 Lead，不得自行降级契约）

1. 宿主 `session/projections` 在本机不可达或认证失效（`unauthorized`），且 `fetchSessionProjections` 无法在 2500ms 内返回 —— 新能力无法验证 A8/A9.1，只能做纯函数与向后兼容部分。
2. 冻结语义与实际可用字段冲突：宿主 `values` 里没有 `permissions.currentValue` 或字段形状与 §0.4 收据不一致。
3. 客户端无可靠「当前会话 id」真源可写入 `data-fpsid`（会导致 A8 无法触发）。
4. 契约与测试裁决冲突（Test Agent 认为某条断言与冻结语义矛盾）→ 由 Lead 一票裁决，任何人不得私自改契约或改测试。
5. 发现需要触碰 `server.mjs` / `static/index.html` / `tests/**` 的契约外改动（本 Agent 写域仅两个文件，越界即阻塞）。

### 5.3 机器可查承诺（配合非零退出命令）

| 承诺 | 命令 | 到点 |
|---|---|---|
| 空桩语法合法 | `node --check lib/preview-policy.mjs` | 本 Agent 交付时（exit 0） |
| 空桩未实现（红相） | `node -e "import('./lib/preview-policy.mjs').then(m=>{try{m.decidePreviewReadAccess({})}catch(e){console.log('RED-OK', e.message)}})"` | 本 Agent 交付时输出 `RED-OK NotImplemented` |
| 客户端 ES5 | `node -e '...acorn ecmaVersion:5...'`（AGENTS.md 关卡一） | Implementer 提交时（靠机器） |
| 全链路回归 | `node test-decoupling.mjs && node test-suite.mjs` | Implementer 提交时（靠机器） |
| 判定顺序语义 | A1–A5（`suite-preview-policy.mjs`） | Test Agent 冻结后（靠机器） |
| 「不信任客户端 permission」 | AT-2 末条 | 靠机器 |
| 不新增类型/不做目录浏览（§4 Non-Goals 1–4） | — | **靠 review** |
