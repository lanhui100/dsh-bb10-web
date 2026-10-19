# Contract — Wave 2026-10-19：排队态滞留 + 等待作答状态错标

- 分级：B（命中：状态机 × 多文件 server.mjs + static/index.html + lib/；外部 IO：宿主 RPC / SSE）
- 目标文件（write_scopes）：`server.mjs`、`lib/session-events.mjs`、`lib/session-waiting.mjs`(新增纯函数)、`static/index.html`
- 测试写域：`tests/acceptance/`（Test Agent 独占，Executor 只读）
- 分级说明：本波次无新增对外接口/数据模型，故不设 Protocol 空桩（Lead 一票裁决，记录于 state.json）；契约以本文件 + 冻结测试为唯一真源。

## 1. 缺陷事实

### D-1 已发出的追发消息仍显示「排队」
- 运行中追发（queue 模式）只登记 `pendingQueuedItem` / `queuedPromptStore[sid]` 并渲染底部 `#queue-dock`（static/index.html:12782-12820, 12854-12886）。
- 停靠条清理仅发生在：`steer` SSE 事件（static/index.html:11602, 12590）、sync/history 且 `syncIsRunning === false`（:11461, :11890）、会话切换/刷新。
- queue 模式被上游认领（新一轮 `user/message` 落转录）时**无任何信号**清槽；会话持续 running 时停靠条永久滞留 → 用户看到“已执行但仍排队”。
- 服务端 `lib/session-events.mjs` 的 `user/message` 分支仅对 `next-step`(steer) 广播，普通轮次 user 消息被丢弃（lib/session-events.mjs:98-130）。

### D-2 等待用户作答的会话在会话列表头部显示蓝色 running
- 前端 `normalizeSessionState` 已支持 `state==='waiting'` → 黄 `?`（static/index.html:3145-3168），但仅当 SSE `question` 事件为跨会话时临时改写 sessCache（:4607-4612）。
- 服务端 `/api/sessions`、`/api/sessions/status` 只会产出 `running|done|stopped|error|idle`，全仓无任何 `waiting`/`pendingInteraction` 产出（server.mjs:3638/3682/3761/5376/1532-1552）。
- 上游 dsh 语义：`SessionStatus.running` 与 `pendingInteraction` 正交，会话等待作答时 `running=true` 且 `pendingInteraction.kind='question'`（上游 dsh 检出 packages/client/ui-session/src/client/index.ts:538；ui-workspace/src/client/tree.ts:379-416）。→ 本工程必须自行推断 waiting。

## 2. 契约条款

### C-1（D-1）认领即清槽（queue 与 steer 同口径）
- 服务端在 follow 流收到**非 steer** 的 `user/message` durable 事件时，广播 SSE 事件 `prompt-claimed`，载荷 `{ text }`（文本取该事件 content 文本拼接；无文本不广播）。
- 前端 SSE 处理器（attach 与 live 两条分支，static/index.html:11602/12590 附近）收到 `prompt-claimed`：若当前会话存在排队槽且槽内 prompt 与该 text **归一化后相等或前缀匹配**（空白折叠），调用 `clearQueueDock(sid)`；**不得** append 用户气泡（历史同步负责正式渲染，严禁重复）。
- 前端兜底：`loadHistory`/sync 完成后，若排队槽 prompt 与 `allMessages` 中任一条 `role==='user'` 文本归一化匹配，同样清槽。
- **防僵尸复活（E1 侦察实证）**：`restoreQueuedPrompt`（切回会话/sync/loadHistory 的恢复路径，static/index.html:8066/11461/11890）在恢复前必须比对 `allMessages` 中已存在的 user 文本；已消费则清槽不再渲染。追发 POST 的 ok 响应（:12950-12956）重新写槽时同样需要该守卫，禁止把已执行消息复活为「排队」。
- 归一化规则：`/\s+/g → 单个空格` + trim；上传附带系统提示文本时取用户原文前缀匹配。

### C-2（D-2）服务端产出 waiting 事实
- 新增纯函数模块 `lib/session-waiting.mjs`（空桩已冻结，T1）：
  - `normalizeEventText(event)` / `eventUserText(event)` → 用户事件文本（两者同义，取 content 文本分片拼接）。
  - `normalizeUserText(text)` → 空白折叠 + trim（§C-1 归一化规则）。
  - `hasPendingQuestionFromEvents(lines)`：从转录事件行（对象或 JSON 字符串）判定「存在 `tool/call` name=ask_user_question 且其 callId 无对应 `tool/result` 结算」。
  - 上述 4 个签名为冻结契约（不得改名/删除）；A1 只依赖 `hasPendingQuestionFromEvents`。
- 判定优先级：① `task.pendingQuestion`（内存真源，实时且最准）→ waiting；② 转录尾部推断 → waiting。
- `/api/sessions` 行（三处构造点）与 `/api/sessions/status`：当 `isRunning===true` 且判定为等待作答时，输出 `state:'waiting'`、`pendingInteraction:'question'`；`isRunning` 仍为 `true`（对齐 dsh 语义）。非等待时字段形状不变（`pendingInteraction` 缺省不输出）。
- 性能：沿用 `sessionStateCache` 同款 (path:mtime:size) + 2s TTL 缓存，禁止新增每请求全量解压。

### C-3（D-2）前端展示
- `normalizeSessionState` 优先识别 `s.pendingInteraction`（非空）→ `'waiting'`；再按现有优先级。
- 会话列表头部（`sessionStateMark`）与底部状态条（`resolveEffectiveSessionState`）口径必须同源：等待作答渲染黄 `?`，不得为蓝 `●`。
- 等待态下 `sessState.running` 保持 true（可停止），`phase='waiting'`。

### C-4 兼容与红线
- 前端改动必须 100% ES5（`var`/`function`/无模板字符串/无 `?.`/无 `fetch`）；`acorn {ecmaVersion:5}` Exit 0。
- 不得改变既有 `/api/sessions` 其它字段、不引入新依赖、不改测试文件。
- 最小闭包：仅上述缺陷因果链文件；严禁顺手重构。

## 3. 验收矩阵（Test Agent 冻结）

| ID | 类型 | 断言 |
| --- | --- | --- |
| A1 | 功能 | `hasPendingQuestionFromEvents`：未结算 ask_user_question → true；已结算 → false；无提问 → false（合成事件行，纯函数） |
| A2 | 功能 | mock 宿主 + 含未结算 ask_user_question 转录的会话：`/api/sessions` 行 `state==='waiting'` && `pendingInteraction==='question'` && `isRunning===true` |
| A3 | 功能 | 同一会话提问结算后：行状态回到 `running`（若仍运行）或终态，不得残留 waiting |
| A4 | 功能 | `/api/sessions/status?ids=` 与 A2 同口径返回 `state:'waiting'` |
| A5 | 前端/浏览器 | 列表快照含 `pendingInteraction:'question'` 时，头部渲染黄 `?`（wait-dot），非蓝 `●`；Console Error=0 + 截图落盘 |
| A6 | 前端/浏览器 | 排队槽存在时收到 `prompt-claimed` 匹配文本 → `#queue-dock` 隐藏且槽清除；不追加重复用户气泡；未匹配的 claimed 不得误清其它会话槽 |
| A7 | 对抗 | `prompt-claimed` 畸形/空文本/跨会话文本：不抛异常、不清错槽（Console Error=0） |
| A8 | 回归 | ES5 门禁 + `node test-decoupling.mjs` + `node tests/acceptance/run-all.mjs` 全绿 |

红相要求：A1-A7 在实现前必须真实失败（断言失败，非语法错误）；A5/A6 使用真实浏览器（mock 宿主）。
