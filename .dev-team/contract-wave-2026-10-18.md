# 契约冻结 Wave 2026-10-18 — 模型思考强度（reasoningEffort）选择 + 模型目录随 dsh 刷新

- Owner（契约唯一来源）：**Lead**
- 冻结时间：2026-10-18
- 上游事实源：`dsh` 仓库 `packages/api/session-controller/src/types.ts`（`ModelReasoning` / `ModelReasoningEffort` /
  `ModelSelection.reasoningEffort`）、`packages/client/ui-model-selection/src/client/ModelSelect.tsx`
  （effort 语义：`effectiveEffort = current.reasoningEffort ?? model.reasoning.defaultEffort`）；
  `session/selectModel` 请求体 `SessionSelectModelRequest extends ModelSelection`（可带 `reasoningEffort`）。
- 本契约一经冻结，实施者只读。变更须 Lead 一票裁决并重锚红相。

---

## 0. 根因（诊断结论，带证据）

### 0.1 功能缺口：思考强度在 Q20 侧被整体丢弃
| # | 事实 | 证据 |
|:--|:--|:--|
| R1 | 宿主 `session/modelCatalog` 每个模型可带 `reasoning:{efforts[],defaultEffort}`，`default` 可带 `reasoningEffort` | 实测 RPC 回包（probe 2026-10-18，`deepseek-flash` 4 档 + `defaultEffort:"high"`）；types.ts:127-143 |
| R2 | Q20 `readModelCatalogFromHost()` 只映射 `{provider,model,name,contextWindow}`，`reasoning` 被丢弃 | `server.mjs:2864-2870` |
| R3 | Q20 `/api/chat/stream` 发送路径 `session/selectModel` 只传 `{sessionId,provider,model}`，`reasoningEffort` 从未下发 | `server.mjs:1720`、`server.mjs:7287` |
| R4 | Q20 模型面板只有模型行，无 effort 选择；徽标只显示模型名 | `static/index.html:7289-7415`、`3997-4003` |
| R5 | 会话 stats 解析丢弃 `request/header.config.reasoningEffort` | `server.mjs:5364-5367`；上游 `index.ts:217` |

### 0.2 清单陈旧：目录只在启动时快照，面板打开不刷新
| # | 事实 | 证据 |
|:--|:--|:--|
| R6 | 前端模型目录唯一来源是 `/api/bootstrap`，仅在首屏 `renderBootstrap` 与 `R`（`refreshWsList`）时拉取 | `static/index.html:10589-10618`、`6001-6050` |
| R7 | `openModel()`（M 键/模型徽标点击）只 `renderModelTree()` 本地既有 options，不发任何目录请求 | `static/index.html:6159-6174`、`4262-4266` |
| R8 | 服务端目录缓存 30s TTL，且无任何强制刷新入口 | `server.mjs:2899-2921` |
| R9 | 设备端页面长驻不刷新 → dsh 侧模型增删/新 provider 在 Q20 面板永久不出现（同一时刻 `/api/bootstrap` 与宿主目录实测一致，排除服务端取数错误） | 实测：宿主 26 项 = `/api/bootstrap` 26 项 |

**结论**：R1–R5 是功能缺失；R6–R9 是「清单不随 dsh 更新」的根因（快照 + 无刷新触发），
服务端在线取数本身正确。

---

## 1. 冻结接口

### §1.1 服务端 → 前端（`GET /api/bootstrap`）
`models[]` 每项在既有 `{provider, model, name, contextWindow}` 基础上**新增可选字段**：

```
reasoning?: {
  efforts: [{ id: string, name: string, description?: string }],  // 至少 1 项
  defaultEffort?: string
}
```

`current` 新增可选字段 `reasoningEffort?: string`。规则：
- 仅当宿主回包 `m.reasoning.efforts` 为非空数组时下发；逐个 effort 只接受 `id` 为非空 string，
  `name` 非空 string 回退为 `id`，`description` 为 string 才透传；畸形项丢弃，全空则整体省略 `reasoning`。
- `defaultEffort` 仅 string 透传（不校验是否在 efforts 内，前端负责回退）。
- `current.reasoningEffort` = 宿主 `default.reasoningEffort`，缺失时回退为当前模型 `reasoning.defaultEffort`，
  仍缺失则省略该字段。
- 磁盘兜底路径（`readDshSettings`）**不产出** `reasoning`（配置文档无此数据），保持既有形状不变。

### §1.2 目录强制刷新
`GET /api/bootstrap?refresh=1`：**绕过 30s `MODEL_CATALOG_TTL_MS` 缓存**并照常回写缓存；
同时保留既有「宿主存活探测强制刷新」语义。无 `refresh=1` 时行为不变。

### §1.3 发送透传（`POST /api/chat/stream`）
请求体新增可选字段 `reasoningEffort: string`：
- 缺省 / `''` → 不下发（走供应商默认）；
- 非 string 或长度 > 64 → `400 {"error":"Invalid \"reasoningEffort\": expected string"}`（SSE 头之前拦截）；
- 合法值 → `callDshWebRpc('session/selectModel', { sessionId, provider, model, reasoningEffort }, 10000)`，
  且仅当非空才带该键；
- 离线 SDK 兜底 `new DeepSeekHarness({cwd, provider, model, ...(reasoningEffort ? {reasoningEffort} : {})})`
  （上游 SDK `packages/sdk/client/src/types.ts:64` 已支持）。
- `POST /api/session/prompt`（运行中追发/steer）**不改**：effort 属「下一请求模型选择」，由 selectModel 承担。

### §1.4 会话 stats（`GET /api/session/stats`）
响应新增可选字段 `reasoningEffort: string`：
- 转录 `request/header` 事件 `data.header.config.reasoningEffort`（非空 string）；
- 无转录（in-flight）分支：`task.reasoningEffort || ''`；
- 均缺失 → `''`。

### §1.5 mock 宿主接缝（仅 `Q20_MOCK_HOST=1`，生产路径零影响）
1. `session/modelCatalog` mock：`glm-5.3-flash` 带
   `reasoning:{efforts:[{id:'off',name:'Off'},{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'high'}`，
   `default:{provider:'ponyllm',model:'glm-5.3-flash',reasoningEffort:'high'}`；其余模型不带 reasoning。
2. `mockNoteRpc(method, request)`：收据行由 `{"method","at"}` 扩展为 `{"method","at","args":<request>}`
   （纯增量，既有只读 `method` 的用例不受影响）。
3. `mockPersistTranscript`：header 行补 `config:{provider,model,reasoningEffort?}`，并追加一条
   `request/header` 事件行携带同一 config（供 §1.4 断言；与真实 dsh 事件流同构）。

### §1.6 前端（`static/index.html`，100% ES5）
- 目录元数据：`modelReasoningMap[provider:::model] = { efforts:[{id,name}], defaultEffort:'' }`，
  在 `renderBootstrap` 与 `rebuildModelSelect` 中重建（旧值清空）。
- 选择态：新增 `currentReasoningEffort`（全局组合器）与 `sessionEffortStore[sid]`（会话记忆，
  与 `sessionModelStore` 同生命周期，写入点：面板选取、发送、stats 校真；容量同 `SESSION_MODEL_STORE_CAP`）。
  `modelChoiceRevision` 兼作其版本号。
- 面板 UI（M 键与模型徽标点击共用的唯一 `#model-overlay`）：当前选中模型带 `reasoning` 时，
  在模型分组之后追加可折叠分组 `⚙ 思考强度（…）`（`collapsedProviders['__effort__']`），子项为
  `efforts` 各项（`defaultEffort` 未定义时前置「默认（供应商默认）」项）；当前生效项以 `●` 标记。
  点击 / J·K + Enter 生效：`sessionEffortStore` 落地、徽标刷新、关闭面板、状态栏提示。
- 切模型语义对齐 dsh：同路由保留当前 effort；换模型取新模型 `reasoning.defaultEffort`（无则 `''`）。
- 徽标：`getModelBadgeText()` 返回 `模型名` 或 `模型名 · effort显示名`（effort 显示名 = catalog `name`
  → 回退 id；`''` 且无默认 → 不显示后缀）。
- 发送：`/api/chat/stream` 载荷新增 `reasoningEffort`（仅非空时带），并记录会话 effort 记忆。
- stats 校真：`reasoningEffort` 字段非空且无更新本地选择（`requestRevision >= sessionModelRevision[sid]`
  且 `!sessionModelDirty[sid]`）时同步全局/会话 effort。
- 会话切换：模型落到 selector 时同步该会话 effort 记忆；无记忆则回落所选模型 `defaultEffort`。
- 目录刷新（修 R6–R9）：`openModel()` 触发一次异步 `GET /api/bootstrap?refresh=1`
  （`modelCatalogRefreshInFlight` 防重入），成功后 `rebuildModelSelect(data.models, data.current)`，
  保留用户当前 `provider:::model` 与 effort；若面板仍开则 `renderModelTree()`。失败静默（面板照常可用）。
- 约束：新增代码不得使用 CSS 变量 / Grid / 现代 JS（模板串、箭头函数、let/const、Promise 等）。

---

## 2. 非目标（Non-Goals）
- 不改 `dsh` 上游任何代码；不新增依赖。
- 不把 `/api/session/prompt`（运行中追发）纳入 effort 透传。
- 不实现 dsh 的 drilled-pane 键盘焦点链（Q20 用小屏树面板 + J/K 等价交互）。
- 不改权限、工作区、会话归属、上传等既有契约。
- 不做「每 N 秒轮询目录」：仅在面板打开与既有 `R` 刷新时取数。

---

## 3. 验收矩阵（Test Agent 冻结，Executor 只读）
| ID | 断言 | 物理证据 |
|:--|:--|:--|
| A1 | mock `/api/bootstrap`：`glm-5.3-flash` 含 `reasoning.efforts` 3 项且 `defaultEffort='high'`；`current.reasoningEffort` 非空 | HTTP 200 JSON 断言 |
| A2 | 30s TTL 内连续两次普通 `/api/bootstrap` → `modelCatalog` RPC 收据 ≤1；随后 `?refresh=1` → 收据 +1 | `Q20_MOCK_HOST_RPC_LOG` 收据 |
| A3 | `POST /api/chat/stream` 带 `reasoningEffort:'low'` → `selectModel` 收据 `args.reasoningEffort==='low'` 且 provider/model 正确；不带该键时收据无 `reasoningEffort` | RPC 收据 |
| A4 | `reasoningEffort:123` → 400 且错误文案含 `reasoningEffort` | HTTP 响应 |
| A5 | mock seed 回合带 `reasoningEffort:'low'` → `/api/session/stats` 返回 `reasoningEffort==='low'` | HTTP 200 JSON |
| A6 | `static/index.html` 全部内联 script 经 acorn `{ecmaVersion:5}` 解析通过 | `ES5 PASS` |
| A7 | 真实浏览器：点模型徽标开面板 → 出现思考强度分组/档位；点击 `Low` 后徽标含 `·` 与 `Low`；Console Error = 0；落盘截图 | playwright-core 截图 + console 采集 |
| A8 | 静态接线：`openModel` 路径发 `/api/bootstrap?refresh=1`；`/api/chat/stream` 载荷含 `reasoningEffort` | 源码/契约断言（允许以浏览器网络或源码双检） |

红相要求：A1–A8 必须先在实施前运行失败（真实断言失败，禁止语法/导入错误），由 Lead 锚定 commit。

---

## 4. 写域（write scopes）与并行
| 任务 | 写域 | 说明 |
|:--|:--|:--|
| T-RED（test-agent） | `tests/acceptance/` | 冻结验收用例 + RED 日志 + 截图产物 |
| T-SRV（executor-server） | `server.mjs` | §1.1–§1.5 |
| T-WEB（executor-web） | `static/index.html` | §1.6 |
| T-DOC（Lead） | `.agents/notes/`、`README.md`、`README.zh.md`、`.dev-team/` | ADR + 文档 + 账本 |

依赖：T-SRV / T-WEB `blocked_by` T-RED（红相 commit 后方可写业务代码）。
