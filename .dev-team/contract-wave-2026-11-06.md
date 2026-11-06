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
→ values.workingDirectory = "<HOME>/dsh-q20-web"   （实测绝对路径，脱敏）
```

Protocol Agent 独立复核（同一台机，按 `getDshWebAuthCookie`（`server.mjs:757-782`）的签名口径派生 cookie，`client-request` 信封）：

```
SID=session-mw47e45cavblex status=200 permissions={"currentValue":"danger-full-access"} workingDirectory="<HOME>/dsh-q20-web"
keys=inbox|title|goal|tokenUsage|contextPressure|contextBreakdown|sessionStats|turnOutline|agentPreset|userQuestions|permissions|workingDirectory|subagentCatalog|subagentTiming|subagent|agentTeam|todos|plan|modelSelection|sessionListMetadata|imageLimits
```

- 结论：该会话**确实是**「完全权限」（`permissions.currentValue === 'danger-full-access'`），且 `workingDirectory` 与当前工作区一致；403 不是权限配置错误，而是服务端**没有查**策略。
- **路径形态事实（裁决 R-5 附注）**：宿主实机返回的是**绝对路径**（`<HOME>/dsh-q20-web`），文档一律脱敏为 `<HOME>/...`，不写 `~/...` 形态；实现不得依赖 `~` 展开——宿主若返回 `~/ws-x` 或 realpath 失败，按 R-5 视为「策略不可用」。
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
| `PREVIEW_POLICY_UNAVAILABLE` | 403 | `session permission is unavailable` | 服务端侧：宿主不可用/超时/无值/`workingDirectory` 无法核验（**非**纯函数产出，见 1.3 与 R-5） |
| `PREVIEW_SENSITIVE_PATH` | 403 | `preview of sensitive files is not allowed` | 服务端侧：非快路径上命中敏感路径 denylist（**非**纯函数产出，见 1.3 R-4；**叠加防御，非主闸门**） |
| `PREVIEW_NOT_IN_DELIVERABLES` | 403 | `file is not part of this session deliverables` | 服务端侧：非快路径上 `targetReal` 不属于该会话交付物清单（**非**纯函数产出，见 1.3 R-8；**主闸门**） |

### 1.3 服务端 `/api/file` 契约（Implementer 落地）

- 路由 `GET /api/file`（`server.mjs:6635`）**新增可选 query 参数 `session`**。
- 处理顺序（**冻结，按序执行**；R-3/R-4/R-5/R-6/R-8/R-9 已并入本序列）。非快路径的闸门顺序**写死为**：
  **G0 事实 → G1 敏感 denylist → G2 归属(c 步) → G3 权限(d 步) → G4 交付物成员 → G5 serve**
  1. **G0-a** `cwd` realpath（失败 → 400 `Invalid "cwd"`，与今天一致）。
  2. **G0-b** `registered = isRegisteredWorkspaceRoot(rootReal)`（`server.mjs:3982`）。
     - **R-9（存在性 oracle）**：若 `!registered` → **目标 realpath 失败时也一律先 403**（`PREVIEW_OUT_OF_SCOPE`；无合法 session 时不含 `code`，见 R-2），**不得** 404；只有 `registered === true` 分支才允许 404 `preview file not found`。
     - 若 `!registered` 且**无合法 session** → **立即** 403 `PREVIEW_OUT_OF_SCOPE` + `path escapes the workspace root`（**在目标 realpath 之前返回**，R-6 原语义保留）。
  3. **G0-c** 目标 `realpath` 与 `contained` 计算（`registered` 分支失败 → 404 `preview file not found`；`!registered` 分支失败 → 按 R-9 走 403）。
  4. **G1 敏感路径检查（R-4，仅非快路径）**：**仅当** `!(contained && registered)` 时，对目标 realpath 归一后的 basename / 路径前缀做敏感判定，命中 → 403 `PREVIEW_SENSITIVE_PATH` + `preview of sensitive files is not allowed`（判据见 R-4；**工作区内快路径不做该检查，行为与今天完全一致**）。**叠加防御，不承担主闸门职责**。
  5. **G2/G3 调 `decidePreviewReadAccess({ contained, registered, sessionId, requestCwd, sessionCwd, permission })`**，`requestCwd` = `rootReal`（取不到则传缺失，纯函数 fail-closed）。
     - **仅当**快路径 a 不成立（`contained && registered` 为假）**且** `sessionId` 合法（`isValidSessionId` 为真）时，才向宿主取 projections：`await fetchSessionProjections(sessionId)`（≤ `PROJECTIONS_TIMEOUT_MS = 2500`ms，复用现有正/负缓存与单飞，**禁止同步重试、禁止新建第二条取数路径**）。
     - 取到 `values` 后（**R-5**）：`wd = values.workingDirectory`；
       - `wd` 缺失或空串 → `sessionCwd = ''`（视为「未知」→ 跳过 c 步，按契约 §1.1）；
       - `wd` 非空但**非绝对路径**（如 `~/ws-x`）**或** `realpathSync(wd)` 失败 → **策略不可用** → 403 `PREVIEW_POLICY_UNAVAILABLE` + `console.warn('[PREVIEW] policy unavailable sid=<sid> reason=cwd-unresolvable')`（**不得**静默降级为空串）；
       - 否则 `sessionCwd = realpathSync(wd)`。
       - `permission = values.permissions && values.permissions.currentValue`（**R-7**：缺 `permissions` 或 `currentValue` 非字符串 → 403 `PREVIEW_POLICY_UNAVAILABLE`「缺数据=不可用」；只有「有值且 ≠ `danger-full-access`」才是 `PREVIEW_PERMISSION_REQUIRED`）。
     - 判定顺序即纯函数 a–e：命中 `PREVIEW_OUT_OF_SCOPE` / `PREVIEW_SESSION_MISMATCH` / `PREVIEW_PERMISSION_REQUIRED` 一律立即返回（不再继续 G4）。
  6. **G2/G3 宿主侧失败**：宿主不可用 / 无 `values` / 超时 → 403 `{ ok:false, code:'PREVIEW_POLICY_UNAVAILABLE', error:'session permission is unavailable' }`，并 `console.warn` 一行，**前缀 `[PREVIEW]` 且含 `sid=<sessionId>`**（禁止吞异常静默放行，也禁止把宿主错误细节出网）。
  7. **G4 交付物成员校验（R-8，主闸门，仅非快路径）**：判定 `ok === true` 之后、`servePreviewFile` **之前**，**必须**校验 `targetReal ∈ deliverables(sessionId)`；不命中 → 403 `{ ok:false, code:'PREVIEW_NOT_IN_DELIVERABLES', error:'file is not part of this session deliverables' }`（无合法 session 时不含 `code`，沿用 R-2）。
  8. **G5 serve**：全部通过 → `servePreviewFile(req, res, absolutePath, path.basename(absolutePath), 'private, no-cache')`（`server.mjs:6642`）；扩展名白名单 415（`server.mjs:4174`）与体积上限 413（`server.mjs:3945-3946`）**保持不变**，完全权限**不得**放宽。
  9. **拒绝出口**：`sendJson(res, status, { ok:false, code, error }, req)`（`code` 为新增字段；无合法 session 时不含 `code`，见 R-2）。
- **向后兼容铁律（范围已收窄，见 R-4 例外）**：不带 `session` 的请求——
  - **逐字节等价仅覆盖「越界且非敏感」**：越界非敏感目标仍为 `{"ok":false,"error":"path escapes the workspace root"}`（403），工作区内仍为 200 文件流；不得因新增 `code` 字段改写既有 200/403/404/413/415 响应形状（A6 / AT-2a 断言不变）。
  - **唯一显式例外（R-4）**：无 session 且目标命中敏感 denylist → 响应体为 **64B 敏感文案** `{"ok":false,"error":"preview of sensitive files is not allowed"}`（**不含 `code`**）。这是 R-4 的**明文例外**，不违反兼容承诺：该路径在旧版同样是 403，仅 `error` 文案不同；客户端只按 `code`/状态码映射文案，故行为等价面收敛在「状态码 403 + 无 `code`」。
  - 工作区内（快路径）响应形状不变（denylist 不作用于快路径，见 R-4 范围收窄）。
- 快路径 a 成立时**零宿主调用**（不得为“顺手取一下 projections”而增加 RPC）。
- **裁决 R-1（`session` 多值/重复）**：`session=a&session=b` 之类重复参数视为**非法 session**，按「缺失」处理 → b 步 403 `PREVIEW_OUT_OF_SCOPE` + `path escapes the workspace root`，且**零宿主调用、零 RPC 收据**。实现口径：用 `searchParams.getAll('session')` 取全部值，长度 ≠ 1 即判非法（禁止取首值当合法用）；唯一值还须过 `isValidSessionId`。
- **裁决 R-2（`code` 字段出现面）**：仅「无 session（缺失/非法）」分支的 403 响应体保持**逐字节等价**（即 `{"ok":false,"error":"path escapes the workspace root"}`，**不含** `code`）；**带合法 session** 的 403 响应体一律**含** `code` 字段（`{ ok:false, code:'<见 §1.2>', error:'<见 §1.2>' }`）。带合法 session 时 b 步不可能命中，故 `code` 取值为 `PREVIEW_SESSION_MISMATCH` / `PREVIEW_PERMISSION_REQUIRED` / `PREVIEW_POLICY_UNAVAILABLE` / `PREVIEW_NOT_IN_DELIVERABLES` 之一（`PREVIEW_SENSITIVE_PATH` 亦可能，它发生在 b 步之前、与 session 合法性无关，故无 session 时按本裁决去掉 `code` 而保留 `error` 文案）。
- **裁决 R-3（未注册 cwd + 无 session）**：统一走 b 步文案 `path escapes the workspace root`（**取代**今天的 `workspace is not registered`，`server.mjs:4209`）；向后兼容铁律仅对「cwd 已注册 + 越界 + **非敏感**」这一经典形态成立（敏感目标见 R-4 明文例外）。Test A6b 以「接受集合」{`path escapes the workspace root`, `workspace is not registered`} 断言，实施侧无需保留旧文案。
- **裁决 R-4（敏感路径 denylist；安全 BLOCKING）**：阻断「完全权限经 `/api/file` 读出 `~/.dsh/.credentials.yaml`（397B，yaml 在白名单内）」。
  - **作用域（范围收窄，机器证据 `test-unit.mjs:2994-3013`）**：denylist **仅作用于非快路径** —— 仅当 `!(contained && registered)`（即需要会话策略授权的越界/未注册分支）时执行；**工作区内快路径（`contained && registered`）不做敏感检查，行为与今天完全一致**（既有门禁断言工作区内非白名单/点前缀文件必须 **415**，带/不带 `name` 别名均不得放行；若 denylist 覆盖快路径会变 403，直接打破该门禁）。
  - **位置**：取得 `contained`/`registered` facts 之后、授权判定（决定顺序 a–e）**之前**，命中即返回，**不得**再向宿主发起 RPC（零 RPC 收据）。
  - **命中结果**：403 `{ ok:false, code:'PREVIEW_SENSITIVE_PATH', error:'preview of sensitive files is not allowed' }`；**无合法 session 时响应体不含 `code`**（沿用 R-2，仅 `{ ok:false, error:'preview of sensitive files is not allowed' }`）。
  - **判据**（对 realpath 归一后的 basename / 路径前缀，**大小写不敏感**）：
    a) basename ∈ {`.credentials`, `.credentials.yaml`, `.credentials.yml`, `.q20_token`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `.pgpass`, `cordis.patch.yml`, `settings.yaml`, `settings.yml`}；
    b) basename 匹配 `^\.env(\.|$)`；
    c) 扩展名 ∈ {`pem`, `key`, `p12`, `pfx`, `keystore`, `jks`}；
    d) realpath 落在 `~/.ssh/`、`~/.aws/`、`~/.gnupg/`、`<DSH_HOME>/.credentials*` 前缀之内（`DSH_HOME` 取 `server.mjs:111` 同源常量）。
  - **不得影响 A6**：「无 session + 已注册 cwd + 越界到非敏感文件」的 403 响应体仍逐字节等价于今天（敏感检查只拦 denylist 命中的目标，不改变其他越界路径的形状）。
- **裁决 R-5（归属无法核验必须 fail-closed）**：见处理顺序第 5 步。核心：只有 `workingDirectory` **缺失/空串**才视为「未知→跳过 c 步」；**非空但非绝对路径（如 `~/ws-x`）或 realpath 失败 → 一律 `PREVIEW_POLICY_UNAVAILABLE` + `[PREVIEW] policy unavailable sid=<sid> reason=cwd-unresolvable`**，禁止静默降级为空串而让 c 步整体跳过（否则跨工作区越界读会被放过）。
- **裁决 R-6（恢复未注册 cwd 的状态语义）**：见处理顺序第 1–3 步。`!registered` 且无合法 session → 403（**先于**目标 realpath），避免「目标不存在 404 vs 存在 403」构成的存在性 oracle；`registered` 为真时目标不存在仍 404。A6b 已接受该集合。
- **裁决 R-7（`values` 存在但缺 `permissions`）**：`values.permissions` 缺失、或其 `currentValue` 非字符串 → 保持 `PREVIEW_POLICY_UNAVAILABLE`（**缺数据 = 不可用**）；只有「有字符串值且 ≠ `danger-full-access`」才是 `PREVIEW_PERMISSION_REQUIRED`。二者口径分界：**不可用**（拿不到事实）vs **权限不足**（拿到事实且不足）。Test A9.1b 已按此冻结。

- **裁决 R-8（越界读取必须命中「本会话交付物清单」；主闸门，安全 BLOCKING）**：名单式 denylist 被复审实测绕过（`~/.config/gh/hosts.yml` 200/242B、`~/.aliyun/config.json` 200/294B、`~/.docker/config.json` 200/119B、`~/.claude.json` 200/38816B），根因是「完全权限 ⇒ 全机任意白名单扩展名文件」这一授权语义本身过宽；名单永远追不上。改为**语义收窄**：
  - **位置**：非快路径（`!(contained && registered)`）上，在 G1 敏感 denylist 之后、**任何放行之前**（即 G2/G3 通过后的 G4）执行；快路径不执行（工作区内行为不变）。
  - **数据来源（禁止新写转录解析器）**：复用现有冻结逻辑 `getSessionHistory(sessionCwd, sessionId)`（`server.mjs:4837`）返回消息里的 `deliverables[].path`（对齐 dsh web `deliverablesDefinition`：present 显式交付，否则 write/edit 产生文件；聚合见 `server.mjs:5125-5142`）。
  - **归一**：每条 `deliverables[].path` 按会话 cwd 归一（相对路径 `path.resolve(sessionCwd, p)`；绝对路径原样），再 `fs.realpathSync`；**realpath 失败的条目跳过**（不存在/已删的文件不可能成为预览目标）。
  - **`sessionCwd` 未知口径（冻结）**：当 `sessionCwd` 为空/缺失（宿主投影无 `workingDirectory`，按 §1.1 视为「未知」→ c 步被跳过）时，**相对路径条目不得以请求 cwd 为基归一**（那等于用调用方输入自证）；此时 G4 **必须 fail-closed** → 403 `PREVIEW_NOT_IN_DELIVERABLES`。仅「绝对路径条目经 realpath 命中 `targetReal`」这一条路径可以在 `sessionCwd` 未知时放行。用例：**A14f**（Test Agent 正在补）。
  - **缓存**：按 `(sessionId, 转录文件 mtimeMs+size)` 缓存路径集合，TTL ≤ 60s；转录变更（mtime/size 变）即失效。转录文件路径复用 `findSessionDir`（`server.mjs:4612`）+ `findSessionZstdPath`（`server.mjs:4823`）+ `fs.statSync`，**禁止**为缓存另建解压/解析通道。
  - **不命中** → 403 `{ ok:false, code:'PREVIEW_NOT_IN_DELIVERABLES', error:'file is not part of this session deliverables' }`（无合法 session 时不含 `code`，沿用 R-2）。
  - **命中后**仍须已通过 c 步（归属）与 d 步（完全权限）才放行（见处理顺序 G2→G3→G4）。
  - **语义后果**：完全权限**不等于**可读全机任意文件；只有「本会话产生/显式交付过的文件」可越界预览；markdown 中引用但本会话未产生的外部文件将被拒绝（fail-closed，**属预期**）。
- **裁决 R-9（修存在性 oracle）**：`!registered` 分支上目标 `realpath` 失败**一律先返回 403**（`PREVIEW_OUT_OF_SCOPE`），**不得** 404；只有 `registered === true` 分支才允许 404 `preview file not found`。即「未注册工作区」下，存在/不存在/敏感/非敏感一律同等 403，不泄露任何目标侧事实。

### 1.4 测试注入接缝（mock-only，生产路径绝不读取；Implementer 在 `case 'session/projections'` 与 `mockSeamProjections` 旁实现）

| env | 语义 |
|---|---|
| `Q20_MOCK_HOST_PROJECTIONS` | 现有：`{ "<sid>": values }` 定向返回值 |
| `Q20_MOCK_HOST_PROJECTIONS_FAIL` | `=1` → 该 RPC 一律失败（`{ ok:false }` 或抛错，两者都测） |
| `Q20_MOCK_HOST_PROJECTIONS_DELAY_MS` | `=<n>` → 该 RPC 延迟 n 毫秒后返回（用于超时/fail-closed 与墙钟断言） |
| `Q20_MOCK_HOST_RPC_LOG` | **既有接缝（`server.mjs:247-255` `mockNoteRpc`，本波次复用不新增语义）**：`Q20_MOCK_HOST=1` 模式下每发生一次 mock RPC，向该文件追加一行 JSON `{"method":"<方法名>","at":<ms>,"args":<请求>}`（如 `session/projections` 一行）；生产路径绝不读取。用途：A6/A7/A8/AT-1b 的「零宿主调用 / ≥1 次调用 / 未发起 RPC」**物理计量**（Test Agent `tests/acceptance/lib/preview-host.mjs` 的 `countRpcMethod` / `readRpcLog` 已依赖此接缝）。实施要求：`case 'session/projections'` 必须同样经 `mockNoteRpc` 记账（禁止旁路），否则 A7「零宿主调用」与 AT-2「未发起 RPC」不可判定。 |
| `Q20_MOCK_HOST_SESSION_DELIVERABLES` | **R-8 专用接缝（已在 `server.mjs:4357-4370` 实现与测试中落地）**：`Q20_MOCK_HOST=1` 时以 `{"<sid>":["<abs>","<relative-to-sessionCwd>"]}` 直接提供该会话交付物清单，**跳过转录解压/解析**；未提供时回退真实 `getSessionHistory`。生产路径绝不读取。用途：A14a–e / AT-5a–c 的可控清单注入（含「清单缺失/为空必须 fail-closed」）。 |

- **实现约束 M-1（mock 与生产同语义执行 `timeoutMs`）**：mock 分支的 RPC 入口（`server.mjs:362-373` `mockHandleRpcAsync`）**必须**与生产同语义执行 `timeoutMs` 超时——到点即 resolve `{ ok:false, error:'timeout', unreachable:true }`（生产分支由 `http.request` 的 `timeout` 生效，`server.mjs:807/900/993` 一带）。理由：mock 若忽略 `timeoutMs`，`Q20_MOCK_HOST_PROJECTIONS_DELAY_MS=6000` 会真阻塞 6s，AT-1b「墙钟 ≤3000ms」将无法验证 2500ms 上限，只能测出「最终返回」而非「按时放弃」。该约束为**纯 mock 侧等价性修正**，不改变生产分支任何行为。
- **实现约束 M-2（mock-only 资源卫生）**：mock 注入延迟的 `setTimeout` **必须** `unref()`，且在超时分支被 `clear` 掉——即超时包装（`mockApplyRpcTimeout` 一类）必须把 `cancel` 句柄交回调用方，超时胜出时取消底层延迟定时器。审查实测：未清理时「超时后延迟定时器残留，进程 6003ms 才退出」，会让 AT-1b 的墙钟断言与进程退出计时被污染（假失败）。约束仅作用于 mock 分支，生产路径无 `setTimeout` 注入。

### 1.5 客户端契约（ES5 硬约束，`static/` 一律 ES5）

- 交付卡片（`createDeliverablesElement`，`static/index.html:9859-9918`）可点卡片**追加** `data-fpsid` = 当前会话 id（来自 `currentSessionId` 一类现有真源；无会话时为空串）。
- `fpBuildTarget`（`static/index.html:9696-9725`）path 分支 URL **追加** `&session=<encodeURIComponent(sid)>`；`sid` 为空时**不得**追加该参数（保证与今天 URL 逐字节一致）。
- 403 响应解析：尝试 `JSON.parse(xhr.responseText)` 取 `code`（`try/catch` 保守包裹，`xhr.status` 读取同款保护），映射文案：
  | code | 文案 |
  |---|---|
  | `PREVIEW_PERMISSION_REQUIRED` / `PREVIEW_OUT_OF_SCOPE` | 该文件在当前工作区外，需会话「完全权限」才能预览 |
  | `PREVIEW_SESSION_MISMATCH` | 无法核验该文件的读取授权 |
  | `PREVIEW_POLICY_UNAVAILABLE` | 宿主离线，无法核验会话权限 |
  | `PREVIEW_NOT_IN_DELIVERABLES` | 该文件不属于本会话交付物，不可预览 |
  | `PREVIEW_SENSITIVE_PATH` | 该文件属敏感路径，不可预览 |
  | 未知 / 解析失败 | 沿用原文案「该文件不在当前工作区内，已拒绝读取」 |
- 客户端**永不上报 `permission`**（服务端只信宿主投影 `session/projections`，客户端声明不可信）。

### 1.6 NFR

- 策略查询墙钟 ≤ 2500ms（`PROJECTIONS_TIMEOUT_MS`），负缓存 15s 内重复请求不重打宿主。
- **mock 等价性（见 §1.4 M-1）**：mock 分支必须同样执行 `timeoutMs`，超时 resolve `{ ok:false, error:'timeout', unreachable:true }`；否则 AT-1b 的 2500ms 上限不可证。
- **mock 资源卫生（见 §1.4 M-2）**：注入延迟的定时器必须 `unref()` 且超时时被 `clear`，否则进程退出（~6003ms）与墙钟断言被污染。
- fail-closed：任何不确定（缺字段、宿主不可用、解析失败）→ 拒绝，绝不“默认放行”。
- 日志可关联：`[PREVIEW] ... sid=<sessionId> ...`。
- 禁止吞异常：捕获后必须落 warn 并转成 `PREVIEW_POLICY_UNAVAILABLE`。

---

## §2 决策顺序真值表（冻结，逐条执行，先命中先返回）

**本表只覆盖纯函数 `decidePreviewReadAccess`（a→e）。服务端还有三个「表外闸门」（P1/P2 先于 a–e，P3 在 a–e 通过之后、serve 之前），顺序见下：**

| 前置闸门 | 位置（§1.3 处理顺序） | 触发 | 结果 |
|---|---|---|---|
| P1 敏感路径 denylist（R-4） | 第 4 步（取得 facts 后、判定前），**仅当 `!(contained && registered)`** | 目标命中 §1.3 R-4 判据 | 403 `PREVIEW_SENSITIVE_PATH`（无合法 session 时响应体不含 `code`），**零 RPC** |
| P2 策略不可用（R-5 / R-7） | 第 5–6 步（取数后） | 宿主不可用/超时/无 `values`；或 `workingDirectory` 非空但非绝对路径/realpath 失败；或 `permissions` 缺失/`currentValue` 非字符串 | 403 `PREVIEW_POLICY_UNAVAILABLE`（含合法 session 故必带 `code`）+ `[PREVIEW]` warn |
| P3 交付物成员（R-8，主闸门） | 第 7 步（G2/G3 通过后、serve 前），**仅当 `!(contained && registered)`** | `targetReal ∉ deliverables(sessionId)` | 403 `PREVIEW_NOT_IN_DELIVERABLES`（无合法 session 时不含 `code`） |

三者都不属于纯函数输出（纯函数无 IO，无法感知宿主、文件系统与转录），故不得写进 `decidePreviewReadAccess` 的分支；P3 也**不得**提前到 a–e 之前（否则会让「归属不符/权限不足」被成员校验的 403 掩盖，改变错误码语义）。

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
- **第 3/4 轮裁决（R-4~R-9 / M-1 / M-2）的用例归属**：A1–A9 为第 1 轮冻结矩阵；下述映射说明各裁决在**已冻结**用例中的落点（A10–A15、AT-4/AT-5 均由 Test Agent 落地并登记 `tests/acceptance/run-all.mjs:33-34`），供 Implementer 对齐（本 Agent 不得改 `tests/**`）：

| 裁决 | 已冻结用例落点 | 说明 |
|---|---|---|
| R-4 denylist（非快路径，叠加防御） | **已冻结：A10a / A10b / A10c / A10d**（`suite-preview-policy.mjs:444/483/507/529`） | A10a 6 类凭据 403 `PREVIEW_SENSITIVE_PATH` 且无字节出网；A10b 对照（普通 `notes.md` 仍 200）；A10c 快路径不受影响（区内 `.credentials.yaml` 200、`.q20_token` 415）；A10d 无 session 时不含 `code` |
| R-5 cwd 不可核验 | **已冻结：A11**（`suite-preview-policy.mjs:550`） | `workingDirectory:"~/ws-x"` 等非绝对/不可 realpath → 403 `PREVIEW_POLICY_UNAVAILABLE` + `reason=cwd-unresolvable` |
| R-6 未注册先 403 | **已冻结：A6b + A12**（`suite-preview-policy.mjs:244/574`） | A6b 接受集合文案（无 session）；A12 未注册 + 目标不存在 → 403（不得 404），已注册 + 不存在 → 404 不变 |
| R-7 缺 permissions | **已冻结：A9.1a / A9.1b**（`suite-preview-policy.mjs:315/341`） | `POLICY_UNAVAILABLE`，非 `PERMISSION_REQUIRED` |
| M-1 / M-2 | **已冻结：AT-1b / AT-4**（`preview-policy-attack.mjs:116/385`） | AT-1b 墙钟 ≤3000ms；AT-4 定时器 unref/clear 与子进程退出墙钟 |
| R-8 交付物成员（主闸门） | **已冻结：A14a / A14b / A14c / A14d / A14e + AT-5a / AT-5b / AT-5c**（`suite-preview-policy.mjs:604/624/651/677/699`；`preview-policy-attack.mjs:443/493/531`） | A14a 清单内越界 200 且内容逐字节一致；A14b 清单外同扩展名 → 403 `PREVIEW_NOT_IN_DELIVERABLES` 且无字节出网；A14c 相对路径归一命中；A14d 区内文件不在清单仍 200（快路径不受成员闸门影响）；A14e 无 session 时不含 `code`；**A14f** `sessionCwd` 未知 + 相对路径清单条目 → 403 `PREVIEW_NOT_IN_DELIVERABLES`（fail-closed，Test Agent 正在补）；AT-5a 清单缺失/为空 → 越界一律 403 fail-closed；AT-5b 同进程缓存不串味；AT-5c 20 轮 barrier 并发稳定 |
| R-9 未注册分支 403 先于 404 | **已冻结：A12 / A15**（`suite-preview-policy.mjs:574/721`） | A12 无 session 侧、A15 带合法 session 侧，两侧均「目标不存在 → 403 而非 404」 |
| 客户端会话接线（原「无覆盖」残留） | **已冻结：A13**（`suite-preview-policy.mjs:751`） | `data-fpsid` ×2 + `&session=` 拼接 + 403 code→文案映射（含 `SENSITIVE` / `NOT_IN_DELIVERABLES`） |
| 套件登记 | `tests/acceptance/run-all.mjs:33-34` | `suite-preview-policy.mjs` 与 `adversarial/preview-policy-attack.mjs` 均已登记 |

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
9. **信任边界（供 ADR same-commit 引用，裁决 R-4 附带）**：q20 是**单用户 LAN 伴生服务**；`session` 参数**不是认证凭据**，它与 `/api/sessions` 一样属**调用方输入**（同一局域网内任何人都可同时取到 sid 与 cwd，故「c 步归属核验」只用于**防误用/防串味**，不构成抗恶意调用方的授权）。本波安全边界 = ① 宿主策略投影（`session/projections.permissions`）② **敏感路径 denylist（R-4）** ③ 扩展名白名单 ④ 体积上限。**部署在不可信网络时必须启用 `Q20_AUTH_TOKEN`（`server.mjs:6111-6132`）或前置反向代理鉴权**；未启用时本服务不承诺抵御同网段恶意调用方。
10. 不做「按调用方身份分级」的授权模型（无多租户、无 ACL），理由见 §4.9 信任边界。
11. **完全权限 ≠ 全机读取（R-8 语义收窄）**：越界预览仅限「本会话产生/显式交付过的文件」（交付物清单）。markdown 中引用但本会话**未产生**的外部文件（如 `~/.config/gh/hosts.yml`、`/etc/passwd`）**一律拒绝**，这是 fail-closed 的**预期行为**，不是缺陷；不得为「方便预览」而重新放宽到「任意白名单扩展名」。
12. 不为 denylist 补充更多名单条目来替代 R-8：名单是**叠加防御**，主闸门是交付物成员校验；新增名单条目可选、非必需。

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
| 敏感路径 denylist 仅非快路径（R-4） | `node test-unit.mjs`（工作区内 `.q20-preview-probe.secret` 仍 415，`test-unit.mjs:2994-3013`）+ `node test-suite.mjs` | Implementer 提交时（靠机器） |
| 越界读取 = 交付物成员（R-8） | 复审 4 个凭据样本（`~/.config/gh/hosts.yml`、`~/.aliyun/config.json`、`~/.docker/config.json`、`~/.claude.json`）+ 完全权限 session 必须全 403 `PREVIEW_NOT_IN_DELIVERABLES`；本会话交付物越界预览必须 200 | Implementer 提交时（靠机器） |
| 未注册分支不泄存在性（R-9） | `cwd=/tmp` 下存在/不存在目标状态码必须相同（均 403） | Implementer 提交时（靠机器） |
| 不新增类型/不做目录浏览（§4 Non-Goals 1–4） | — | **靠 review** |

---

## §6 审查裁决记录（R-4 ~ R-7 + 信任边界）

本节记录第 3 轮（R-4~R-7 + M-2 + 信任边界）与第 4 轮（R-8/R-9，语义收窄）的裁决，逐条附**触发证据**（证据文件：`.dev-team/review-plan.json`、`.dev-team/review-l3b-preview.json`，均 verdict=`FAIL`）。行号为 finding 的 `line` 字段（被指代码位置），括号内为 `findings[i]` 索引。

### R-4 敏感路径 denylist（安全 BLOCKING）

- **触发证据**：`review-l3b-preview.json` findings[0]｜`server.mjs:6781`｜`SECURITY / BLOCKING`。
  反例原文要点：`/api/file?cwd=<HOME>/dsh-q20-web&path=<HOME>/.dsh/.credentials.yaml&session=session-mw47e45cavblex` → **actual 200、397 字节**（`~/.dsh/.credentials.yaml` 经 `/api/file` 出网，因为 `yaml` 在白名单内）；期望 403/415。
- **根因**：契约 §2 原真值表对「越界路径」无任何内容维度排除 —— 完全权限一旦放行，任意白名单类型文件（含凭据）都可读。
- **裁决**：非快路径上增加 `PREVIEW_SENSITIVE_PATH` denylist（判据见 §1.3 R-4）。
- **范围收窄（Lead 更正）**：denylist **只作用于非快路径**（`!(contained && registered)`）。
  - **机器证据**：`test-unit.mjs:2994-3013` 冻结断言——工作区内非白名单/点前缀文件（`.q20-preview-probe.secret`）带/不带 `name` 别名**必须 415**；若 denylist 覆盖快路径，该用例将变 403 → 既有门禁直接打破。
  - **承诺**：**工作区内读行为本次完全不变**（`contained && registered` 分支零改动，无新增检查、无新增 RPC）。越权面来自新增的「越界读」，故 denylist 只需守在越界入口。

### R-5 归属无法核验必须 fail-closed（跨工作区 200）

- **触发证据**：`review-l3b-preview.json` findings[3]｜`server.mjs:4309`｜`SECURITY / ADVISORY`（`review-plan.json` findings[3]｜`server.mjs:4309`｜`CORRECTNESS` 同址）。
  反例：接缝 `{s1:{permissions:{currentValue:"danger-full-access"},workingDirectory:"~/ws-x"}}` → 请求 `ws-x` 的越界 `/etc/passwd` 形态路径 → **actual 200**（`realpath('~/ws-x')` 失败 → `sessionCwd=''` → c 步被整体跳过 → 仅凭 permission 放行）；期望 403。
- **裁决**：`workingDirectory` **非空但非绝对路径** 或 realpath 失败 → `PREVIEW_POLICY_UNAVAILABLE` + `[PREVIEW] policy unavailable sid=<sid> reason=cwd-unresolvable`；只有缺失/空串才视为「未知→跳过 c」。同时把 §0.4 收据的 `~/dsh-q20-web` 更正为实测绝对路径（`<HOME>/dsh-q20-web` 脱敏形态），并注明宿主实机返回绝对路径。

### R-6 恢复未注册 cwd 的状态语义（403→404 存在性 oracle）

- **触发证据**：`review-plan.json` findings[1]｜`server.mjs:4269`｜`LEAK / ADVISORY`；`review-l3b-preview.json` findings[1]｜`server.mjs:6739`｜`LEAK / ADVISORY`。
  反例：未注册 `cwd=/tmp` 下 `/etc/passwd`（存在）与 `/etc/l3b-nonexistent.md`（不存在）**状态码不同**（旧版两者恒 403 `workspace is not registered`）→ 无鉴权存在性探针。
- **裁决**：`!registered` 且无合法 session → **先于**目标 realpath 返回 403 `PREVIEW_OUT_OF_SCOPE` + `path escapes the workspace root`；`registered` 为真时目标不存在仍 404。A6b 接受集合已含该文案。

### R-7 `values` 缺 `permissions` 的口径分工（契约澄清，不改行为）

- **触发证据**：`review-l3b-preview.json` findings[2]｜`server.mjs:4303`｜`CONTRACT_BREAK / ADVISORY`。
  反例：接缝 `{s1:{permissions:{},workingDirectory:<abs>}}` → **actual 403 `PREVIEW_POLICY_UNAVAILABLE`**，契约 §1.3 原文写「`currentValue` 缺失视为非完全权限」→ 读者会期望 `PREVIEW_PERMISSION_REQUIRED`。
- **裁决**：冻结为「**缺数据 = 不可用**（`PREVIEW_POLICY_UNAVAILABLE`）」，与「**有数据但不足 = `PREVIEW_PERMISSION_REQUIRED`**」分界；两者都是 fail-closed，仅 code/文案不同。Test A9.1b 已冻结此口径，§1.2 已补口径说明。

### M-2 mock-only 资源卫生（定时器泄漏）

- **触发证据**：Lead 审查实测——超时分支后延迟定时器残留，**进程 6003ms 才退出**（`Q20_MOCK_HOST_PROJECTIONS_DELAY_MS=6000`）。
- **裁决**：注入延迟 `setTimeout` 必须 `unref()`，且超时分支必须 `clear`（超时包装交回 `cancel` 句柄）。属 mock 侧资源卫生，生产路径无注入定时器。

### R-8 语义收窄（越界读取必须命中会话交付物清单；安全 BLOCKING）

- **触发证据**：`review-l3b-preview-r4.json` findings[0]｜`server.mjs:4356`｜`SECURITY / BLOCKING`（`review-plan-r4.json` findings[0]｜`server.mjs:4356` 同址）。
  反例（名单式 denylist 被绕过）：`/api/file?cwd=<HOME>/dsh-q20-web&path=<HOME>/.config/gh/hosts.yml&session=<sid>` → **200 / 242B**；同批复审另有 `~/.aliyun/config.json` **200 / 294B**、`~/.docker/config.json` **200 / 119B**、`~/.claude.json` **200 / 38816B**。期望均为 403。
- **根因**：授权语义是「完全权限 ⇒ 全机任意白名单扩展名文件」；名单式枚举永远追不上（凭据文件位置无穷）。
- **裁决**：新增主闸门 G4 —— `targetReal` 必须 ∈ `deliverables(sessionId)`（见 §1.3 R-8 细则：复用 `getSessionHistory`、`(sid, mtimeMs+size)` 缓存 ≤60s、realpath 失败条目跳过）。
- **denylist 定位变更**：R-4 保留为**叠加防御**（已知名单不足，不再是主闸门）。
- **命名/位置证据**：`review-plan-r4.json` findings[2]｜`tests/acceptance/suite-preview-policy.mjs:445`｜`CORRECTNESS` —— 指出 A10a 只固化与实现完全同名的 6 个样本，名单外凭据永不被门禁发现；这正是改用语义闸门的直接动因。

### R-9 未注册分支不得泄露存在性（ADVISORY 修复）

- **触发证据**：`review-plan-r4.json` findings[1]｜`server.mjs:6854`｜`SECURITY / ADVISORY`（`review-l3b-preview-r4.json` findings[2]｜`server.mjs:6859`｜`LEAK`）。
  反例：`cwd=/tmp`（未注册）下 `/etc/passwd`（存在）与 `/etc/q20-nope.md`（不存在）状态码不同。
- **裁决**：`!registered` 分支目标 realpath 失败**一律先 403**（`PREVIEW_OUT_OF_SCOPE`），不 404；只有 `registered` 分支允许 404。

### 信任边界（§4.9 条款正文，此处仅记录出处）

- **触发证据**：`review-plan.json` findings[0]｜`server.mjs:6750`｜`SECURITY / BLOCKING`。反例要点：`session` 与 `cwd` 都是调用方输入，`/api/sessions` 无鉴权即可同时给出 sid 与其 cwd，故「c 步归属核验」是**用调用方给的 cwd 自证**，对恶意同网段调用方无抗性（旧版同请求恒 403 —— 旧版更严格，因为根本不看策略）。
- **裁决**：显式声明信任边界（单用户 LAN 伴生服务；`session` 非凭据；安全边界 = 宿主投影 + denylist + 白名单 + 体积上限；不可信网络必须 `Q20_AUTH_TOKEN` 或反代鉴权），并写入 §4 Non-Goals 第 9/10 条供 ADR same-commit 引用。

### 已知残留（非本波修复，转后续波次候选）

| 残留 | 证据 | 处置 |
|---|---|---|
| 授权判决复用 15s 正/负缓存 → 撤权/授予滞后 ≤15s | `review-plan.json` findings[2]｜`server.mjs:5132`｜`CONCURRENCY` | 明示接受（见 §3bis AT-3 二段说明），转下一波次（策略缓存 TTL 分级） |
| 快路径判据两份（`server.mjs:6753` vs `lib/preview-policy.mjs:28`），漂移会静默改变是否发起 RPC | `review-plan.json` findings[4]｜`lib/preview-policy.mjs:28`｜`NFR_VIOLATION` | 靠 review + A7（FAIL 接缝下快路径仍 200）机器兜底 |
| 客户端会话接线（`data-fpsid` → `&session=`）无测试覆盖 | `review-plan.json` findings[5]｜`tests/acceptance/suite-preview-policy.mjs:275`｜`CORRECTNESS` | **已收口**：A13 冻结客户端接线静态断言（`data-fpsid` ×2 + `&session=` 拼接 + 403 code→文案映射），见 §3 归属表 |
| stat→read TOCTOU 窗口 | `review-l3b-preview.json` findings[5]｜`server.mjs:4215`｜`CORRECTNESS`（non-machine） | 既有模式，本波不新增提权面；靠 review |
| 拒绝体 ≥1024B 时 gzip 头体不一致（潜伏） | `review-l3b-preview.json` findings[6]｜`server.mjs:6736`｜`CORRECTNESS`（non-machine） | 当前全部拒绝体 <1024B 不可触发；新增 `code` 字段后需复核体积，靠 review |

