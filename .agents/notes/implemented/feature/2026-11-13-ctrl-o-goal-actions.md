# Agent Note: O 状态面板内 Goal 的修改／删除／继续动作（backlog:B023）

Status: implemented

## Problem

O 状态面板（`O` 键呼起的 Session Status modal）自 [会话目标红圈指示与状态面板目标行](../feature/2026-09-21-goal-ring-shortcut.md) 起只能**只读**展示当前会话 goal，用户要改目标、清除目标、或把暂停/受阻的目标继续，必须切回 dsh web 的 GoalBar 才能操作；Q20 侧既没有写代理端点，也没有面板内动作与快捷键。上游 `goals/edit|clear|resume` Remote 已提供带 CAS（`ref:{id,revision}`）的写能力，本仓尚未消费。用户口语称「Ctrl+O 面板」，但本仓实际入口是**裸 `O` 键**（README.md:19、static/index.html:14369-14370 `code===79`）；DSH Web GUI 的 `Ctrl+O` 是 `workspace.add`（packages/client/ui-workspace/src/client/shortcuts.ts:85），与本任务无关，不得在本仓实现 Ctrl 组合键。

## Decision

- 增量扩展旧条 `implemented/feature/2026-09-21-goal-ring-shortcut.md`（只读目标行 → 可写动作），不取代、不归档旧条；用户措辞「Ctrl+O」按上述事实收敛为裸 `O` 面板。
- 单一新端点 `POST /api/session/goal/action`，不新增 `POST /api/session/goal`（避免破坏既有 GET 的幽灵会话 200 `{goal:null}` 语义，test-unit.mjs:2000-2009 已冻结，端点实现见 server.mjs:7044-7059）。
  - 精确 request body 字段：`cwd`(string)、`sessionId`(string)、`action`(`'edit'|'clear'|'resume'`)、`ref`(object `{id:string,revision:number}`)、`objective`(string，仅 edit 必填)。未知字段一律 400。
  - 精确 response（Q20 **对外** HTTP 契约）：成功 `{ok:true,goal:<GoalView|null>}`；失败 `{ok:false,error:<message string>,code?:string}`。HTTP：本地校验失败 400、宿主业务拒绝 200 + `ok:false`、宿主不可达/超时 502、内部异常 500。状态码语义沿本仓既有 POST 端点风格（缺参 400 见 server.mjs:7048-7050，异常 500 见 :7055-7057，宿主失败透传见 :7470-7474）。
  - 校验：`cwd` 非空；`sessionId` 必须过 `isValidSessionId()`（server.mjs:4622-4625，白名单 `[A-Za-z0-9._:-]+`、长度 1..128、拒 `.`/`..`/含 `..`）；`action` 白名单；`ref.revision` 为正整数（≤0 判 400 校验错，**不是** CAS 冲突）；`ref.id` 非空字符串；`objective` 仅 edit 必填且 `.replace(/^\s+|\s+$/g,'')` 后非空、长度 ≤2000；非法 JSON、缺字段、未知字段一律 400 `{ok:false,error:string}`，**且不向宿主发任何 RPC**。400 只针对写端点，GET 口径不变。
  - 「无 goal」= 当前 GET 折叠为 `null` → 400 `code:'goal/not-found'`；不向宿主发 RPC。「非法 sessionId」→ 400 `code:'session/invalid-id'`（与无 goal 分开，二者不同 code）。
- 宿主 RPC 映射（lead 实测 2026-11-13）：`callDshWebRpc('goals/'+action, args, 8000, {rawArgs:true})`，`rawArgs` 分支生成 `payload.args=args`（server.mjs:1077-1081）；`args` 顶层直接放 wire 字段，不套 `{request:{...}}`。
  - `edit`：`{agentId:<sessionId>, ref:{id:<goalId>,revision}, request:{objective}}`（`packages/goal/goal/lib/typert.host.js:366` 起，wire 名 `agentId`/`ref`/`request`）。
  - `clear`：`{agentId, ref}`（无 `request`，否则网关回 `gateway/arguments-invalid`，lead 探针已证）。
  - `resume`：`{agentId, ref}`（同上）。
  - `ref.id` 是 **goal id**（来自 `goalViewOf()` server.mjs:5787-5800，含 `id`/`revision`），不是 sessionId；`agentId` 是 sessionId。
  - 实测信封：`POST http://127.0.0.1:3080/api/goals/get` + `{type:'client-request',rpcId,method,payload:{args:{agentId}}}` → HTTP 200 `{type:'server-response',rpcId,result:{ok:false,error:{code:'session/not-found',message,details}}}`。**该形状只属宿主 wire 层**；Q20 代理层映射为对外 `{ok:false,error:<message>,code:<wire code>}`，不得吞掉。
  - 陈旧 revision：上游 `GOAL_STALE_REVISION`（`packages/goal/goal/src/index.ts:462`）；网关实测投影为 `gateway/internal` + message 含 `stale goal ref`。Q20 代理层统一规范化为对外 HTTP 200 + `{ok:false,error:<message>,code:'GOAL_STALE_REVISION'}`，QA 断言该 code。
  - 成功语义与上游 `commitCurrent` 同构：**每次成功写 revision 必 +1**；`edit` → `goal.objective` 变更、`goal.revision=ref.revision+1`；`clear` → `{ok:true,goal:null}`（tombstone 由宿主落盘，Q20 不物理删文件）；`resume` → `goal.phase='active'`、`goal.revision=ref.revision+1`。`maxGoalRounds` 耗尽或 phase 不可恢复时由宿主拒绝，原样透传，Q20 不前置猜测。
- mock 接缝（`Q20_MOCK_HOST=1`）：新增进程内 `mockGoalState`，仅在环境变量 `Q20_MOCK_HOST_GOAL` **已设置**时由该 JSON 初始化（`{id,revision,objective,phase,maxGoalRounds}` 或 `null`）；**未设置时 `mockGoalState` 为 undefined，GET 完全回退既有 zstd 折叠路径**，保持 test-unit.mjs:2000-2009 幽灵会话 `{goal:null}` 语义零回归。`mockHandleRpc` 为 `goals/edit|clear|resume` 提供可判定行为并更新同一 `mockGoalState`；GET `/api/session/goal` 仅在 mock 且该状态已定义时优先读它，非 mock 生产读路径零改动。QA Arrange 用 `startMockServer({env:{Q20_MOCK_HOST_GOAL:JSON.stringify({...})}})` 构造 `phase='active'|'paused'|'blocked'` 初态，无需写 zstd 日志。陈旧 `ref.revision` 在 mock 下同样返回 `GOAL_STALE_REVISION`。
- 前端（static/index.html，100% ES5）：O 面板「当前目标」行下增加三个按钮，文本精确为 `修改 [E]`、`删除 [D]`、`继续 [G]`，id 精确为 `goal-action-edit` / `goal-action-clear` / `goal-action-resume`；隐藏编辑框 id `goal-edit-input`；删除二次确认模态 id `goal-clear-confirm`。三动作仅在 `isStatusOpen && goalForPanel` 可用，无 goal 时禁用/不消费键。
  - 面板内单键：`E`=修改(keyCode 69)、`D`=删除(68)、`G`=继续(71)。全局已占用 E(69, banner 打开 static/index.html:13833)、D(68, banner 关闭 :13845)、G(71, 快捷消息 :14289)。
  - 键盘分支**两处不同位置**，不得混为一处：① 删除确认模态分支（`isGoalClearConfirmOpen`）必须插在 **Esc chain 之前**（参照 `isPermConfirmOpen` :13648、早于 archive confirm :13783 与 ws-remove confirm :13803），Enter(13) 确认、X(88)/Esc(27)/C(67) 取消，打开期间吞掉其他快捷键；它不得抢 archive/ws-remove 两个确认模态（三者互斥，按 `isXxxOpen` 顺序判定）。② O 面板内 E/D/G 消费分支插在 **modifier guard(:13761) 之后、X 全局分支(:13821) 之前**，即同样早于三个全局 E/D/G 分支；命中时 `e.preventDefault(); return false;`；无 goal 时不消费，全局键行为不变。
  - 编辑模式 INPUT 内沿用既有焦点守卫（`document.onkeydown` 开头 `INPUT`/`TEXTAREA`/`SELECT` 直接 return，static/index.html:13624-13632），保证打字不被拦截；保存用行内 XHR，成功后 `loadSessionStats()` + `refreshGoalRing()` + `renderStatusPanel()` + `setStatus()` 反馈。
  - H 帮助表在 O 行后追加一行「O 面板内 E 修改 / D 删除 / G 继续目标」；状态面板底部 hint 追加相同提示；README.md 第 19 行 O 条目内追加 `Inside: E edit / D delete / G resume goal`。
  - CSS 只用静态 HEX 高对比度、绝对定位/流式块级，无 CSS 变量、无 Grid；720×720 空间内保持单行紧凑，不新增顶栏高度。
- 写域分权：Protocol/Lead 只写本决策记录；Test Agent 独占 `tests/acceptance/goal-actions.mjs` 与 `tests/acceptance/RED-PHASE.md`，冻结后只读，**不得修改业务代码**；Executor 独占 `server.mjs` / `static/index.html` / `README.md`，**不得修改验收测试**，不得改 backlog、不得 git 写操作；Lead 统一执行门禁与收口。
- 验收用例清单（写进 Decision，供 Test Agent 逐字断言，零假测试、非零退出、无吞异常）：① edit 正常流 objective 变更 + revision+1；② clear 正常流 `goal:null`；③ resume 正常流 `phase:'active'` + revision+1；④ 无 goal → 400 `code:'goal/not-found'`（另一条：非法 sessionId → 400 `code:'session/invalid-id'`，二者分开断言）；⑤ 陈旧 revision → 200 `ok:false` + `code:'GOAL_STALE_REVISION'` + `error` 为 string；⑥ 畸形 payload（空/纯空白 objective、≤0 revision、未知 action、非法 JSON、缺字段、未知字段）一律 400，且不进宿主 RPC；⑦ 删除确认取消不写（前端静态锚点 + 无 RPC）；⑧ 静态接线断言（三个按钮 id/文案、`goal-edit-input`、`goal-clear-confirm`、H 表与 README 文案、裸 O 而非 Ctrl+O）。红相必须在 Executor 实现前真实 FAIL（exit≠0）并落 `tests/acceptance/artifacts/red-goal-actions.log`。
- `[UNVERIFIED]`：宿主未可达时的 502 与内部异常 500 未做真实断网探针（仅有 `callDshWebRpc` 的 `{unreachable:true}` 返回值可判定，server.mjs:1056 起）；这两条由 QA 以 mock 注入断言，靠 review 复核真实网络路径。

## Alternatives considered

- 三个独立写端点（`/api/session/goal/edit|clear|resume`）或复用 `POST /api/session/goal`：前者把同一套校验/CAS/错误透传复制三遍，后者与既有 GET 同路径易误伤幽灵会话 200 `{goal:null}` 冻结语义（`test-unit.mjs:2000-2009`）。单一 `POST /api/session/goal/action` + `action` 白名单把校验收敛到一处，且不改 GET。
- 前端直连宿主 `goals/*` RPC（浏览器侧签名 Cookie）：违反本仓「仅两条管道、宿主 RPC 经 server 代理」的解耦契约（AGENTS.md §六 item 0），且会把认证 Cookie 暴露到客户端；服务端代理可统一做字段校验、错误规范化与超时。
- 面板内另分配未占用字母（如 `Y`/`L`/`S`）避开 E/D/G 冲突：`L` 曾被旧 ADR 明确去除、`S` 是浏览器保留键、`Y` 无语义关联；E=Edit / D=Delete / G=Go-on 与动作语义直连，靠「`isStatusOpen` 分支前置」解决键位冲突，比换键更可维护。
- 删除做成物理删除本地 zstd 转录：上游 `goals/clear` 是 durable tombstone，物理删文件会破坏 `foldGoalLine` 的 revision 连续性与历史回放，故选代理 `goals/clear` 而非本地文件操作。

## Consequences

- `server.mjs` 新增一个 POST 端点 + `mockHandleRpc` 三个 method 分支；既有 `GET /api/session/goal` / `getSessionStats` / `goalViewOf` 非 mock 路径零改动，`Q20_MOCK_HOST_GOAL` 未设置时 GET 行为逐字节不变。
- `static/index.html` 新增面板内动作 DOM、确认模态与两处前置键盘分支；全局 E/D/G/R/O 键在面板外的既有语义不变。
- 门禁：ES5 acorn 静态解析、`node test-decoupling.mjs`、`node test-unit.mjs`、`node test-suite.mjs`、`bash .meta/gates/backlog-gate.sh`、`bash .agents/skills/write-adr/verify-note.sh` 全部 exit 0；`backlog:B023` 由 `resolve` 闭环并附机器证据。
