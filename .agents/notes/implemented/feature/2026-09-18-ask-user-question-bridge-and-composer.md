# Agent Note: Bridge ask_user_question Waterfall to a Minimal Q20 Answer Composer

Status: implemented

## Problem

Q20 Web 客户端此前把 `ask_user_question` 当作普通工具渲染：一次性胶囊 `[⚙️ 调用: ask_user_question]`，既无法在提问到达时作答，也无法在回执中看到问答内容。宿主侧 `ask_user_question` 的 waterfall（`user-questions/request`）只有官方 dsh web 客户端能应答，Q20 终端上的会话会无限期停在工具执行中。

对齐参照（dsh web 源码）：

- `packages/client/ui-user-questions/src/client/QuestionComposer.tsx` —— 待答态交互（单题视图 / 单选自动推进 / 多选勾选 / 自由文本变体 / 跳过 / 翻页 / 未答校验 / `(recommended|推荐)` 徽标解析 / 提交载荷形状）；
- `packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx` + `AskQuestionCard.tsx` —— 已结算态回执（按 id 配对问答、`已回答 X/Y` 计数、ASK_CANCELLED / ASK_ABORTED 判定、配对失败回退计数摘要）；
- `packages/api/gateway/src/stream-protocol.ts` + `client/remote-events.ts` —— `$events` 逻辑流协议（`ready` 帧 clientId、`waterfall`/`cancel` 下行帧、`$events/result` HTTP 结算 RPC）。

## Decision

分三层落地，业务协议与 dsh web 完全同构，展现层按 720×720 小屏极简化：

1. **服务端 waterfall 桥（`server.mjs`）**：
   - 两处宿主引擎路径（`runChatViaHostRpc` / `attachHostFollowToSession`）在已建立的 remote.mux WebSocket 上额外打开 `$events` 逻辑流（`payload: {args:{}}`，网关强制空参）；
   - `handleUserEventsItem` 处理 `ready`（记 `clientId`）/ `waterfall`（`user-questions/request` → `task.pendingQuestion` + SSE `question` 事件）/ `cancel`（→ SSE `question` cancelled）；无法呈现的批次按 dsh 语义回 `next` 委托，绝不吞请求；
   - `$events` 流故障降级为非致命（仅丧失应答能力，会话事件流不受影响）；
   - 新端点 `POST /api/session/question`（`answer` → `$events/result` result；`cancel` → `UserQuestionError/ASK_CANCELLED` rejected），答案批次校验与 dsh `answerEntries` 同口径；
   - `computeToolSummary` 为 `ask_user_question` 生成「N 个问题」摘要。
2. **待答态极简组件（`static/index.html`）**：
   - `#question-panel` 锚定悬浮卡（`bottom: 64px`，composer 展开时按其高度数学联动上移），内部独立滚动，静态 HEX 高对比度（#1E1E1E 底 / #E0E0E0 正文 / #00897B 高亮）；
   - 单题视图 + `‹ i/n ›` 翻页：单选点选即答即进、多选勾选保留、自由文本行（单选自定义清空选中、多选并存）、跳过、`★推荐` 徽标、Enter 提交 / Shift+Enter 换行（keyCode 229 IME 防护）、未答校验与反馈行；
   - 提交载荷与 dsh `submitDrafts` 一致（跳过题 `selected: []`；单选自定义答案清空 selected、多选保留 selected + custom）。
3. **已结算态回执卡**：
   - 工具胶囊遇 `ask_user_question` 改用 `❓ 提问:` 前缀 + 摘要（成功「已回答 X/Y」、取消「已取消提问」、中断「提问已中断」），并内嵌默认展开的问答清单卡（`.ask-card`）；严格配对失败回退为仅计数摘要；原始参数/输出仍折叠在胶囊点击里；
   - 历史重放（`createToolPillElement`）、attach 实时流、chat 实时流三条渲染路径同构接入；
   - 回合终态（done/cancelled/error）强制收起待答面板。

## Verification（机器可查）

- `node -e '...acorn.parse(script, { ecmaVersion: 5 })...'` → `ES5 PASS`；
- `node test-unit.mjs` → 7/7 PASS（新增 `ask_user_question Question Bridge Contract`：端点 400 边界、幽灵会话 `ok:false`、从 `static/index.html` 标记切片提取纯函数验证 `parseRecommendedLabel` / `validateQuestionItems` / `parseAskQuestionsFromArgs` / `parseAskAnswersFromOutput`）；
- `node test-suite.mjs` → 7/7 PASS；
- 真机闭环探针（临时脚本）：mux 直连 `$events` 拿到 `ready` 帧（clientId）；真实会话触发 `ask_user_question` → SSE `question` request → `POST /api/session/question` answer `{ok:true}` → `answered` 回声 → `tool/result ok:true`（output `{answers:[...]}`）→ 回合正常完成（模型读到答案）。回执卡构建器以该真实数据形状验证 4 类呈现（成功 / 取消 / 配对回退 / 多题跳过+自定义）。

## Alternatives considered

- **把应答走 `session/prompt` 伪装成普通回复**：会污染对话轮次、产生真实模型调用，且宿主 waterfall 仍悬空直到超时——协议语义错误，否决。
- **在 Q20 服务器常驻一条全局 `$events` 连接**（类似官方 web 的常驻订阅）：可覆盖「无活动任务时到达的提问」，但 Q20 的任务模型是按会话按需开流（内存与连接数最小化），离线兜底引擎也无 waterfall 概念；改为任务期挂载 + `$events` 挂起请求由网关排队补投递，覆盖真实场景（提问只存在于运行中的回合内）。
- **待答面板常驻 DOM 复用 + 草稿持久化到 localStorage**：官方 web 用 Session 级 store 恢复草稿；Q20 页面生命周期短、2GB 内存约束下避免常驻节点与额外序列化，刷新后草稿重建为空（问题批次本身会经 attach 缓冲重放，不丢失提问）。
- **选项用原生 `<select>`**：省 DOM 但需要系统磨砂蒙层（文字发虚）、无法承载推荐徽标与描述副行，且多选无法表达；自绘块级按钮与全站胶囊风格一致。
- **回执卡默认折叠**：与「工具调用紧凑单行胶囊」默认折叠原则相反，但问答结论是用户决策的直接回执、行数极少（每题两行）；折叠会导致「答了什么」不可见。折衷：卡片展开、原始 JSON 仍折叠。

## Consequences

- Q20 终端具备与官方 dsh web 等价的 `ask_user_question` 应答能力（含多客户端 first-result-wins 语义：官方 web 与 Q20 同时在线时先答者胜）；
- 转发事件（`emit` 类）被有意忽略，Q20 不订阅 `approval/request` 等其余 waterfall——后续若需权限审批面板，可复用本桥（`handleUserEventsItem` 分支 + `$events/result` 结算）；
- 用户点 ✕ 取消提问会让宿主收到 `ASK_CANCELLED`，模型可感知「用户拒绝回答」；停止任务则由宿主 abort 产生 `ASK_ABORTED`，两种终态在回执卡中有区分呈现。
