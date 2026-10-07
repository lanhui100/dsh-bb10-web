# Agent Note: 提问面板右上关闭仅隐藏面板

Status: implemented

## Problem

`ask_user_question` 作答面板（`#question-panel`）右上角 `✕`（`#question-head-close`）点击直接走 `qCancel()`，经 `POST /api/session/question` action=cancel 向宿主 `$events/result` 发送 `ASK_CANCELLED`。用户本意只是暂时收起面板查看消息流，却被记为"取消本次提问"：模型收到取消语义，问答无法继续，且草稿（已选选项/已填文本）全部丢失。

## Decision

右上 `✕` 改为纯视觉隐藏，不发送任何 answer/cancel，不触碰跳过态：

- 新增 `questionState.dismissed`：`dismissQuestionPanel()` 仅置 `visible=false` + `dismissed=true`，保留 `questions/drafts/index/eventId`，`busy` 复位，不发网请求；`title` 改为"关闭面板（不取消提问）"，并 toast 提示"已收起面板，提问未取消"；
- `hideQuestionPanel()`（提交/应答终态/切会话/停止等真终态）同步清 `dismissed=false`，语义不变；
- 挂起态保持 waiting：`resolveEffectiveSessionState`、`attach/发送流终态`的 waiting 判定由 `visible` 扩展为 `visible || dismissed`；尾部状态条 waiting 文案透传（收起时"有待回答提问（点击重开）"），点击尾部状态条可 `reopenQuestionPanel()`（草稿保留）；
- 同一事件重推（attach 重放/SSE 重复帧）在 dismissed 态下直接重开面板并保留草稿；`answered/cancelled` 终态在 dismissed 态同样收口清挂起；
- 取消仍走 `X` 键/`qCancel()`，跳过仍走 `S`/跳过按钮，语义不变。

## Alternatives considered

- **✕ 保持取消语义、另加最小化按钮**：720×720 方屏顶栏仅 34px，再加按钮挤占标题与进度区，且用户心智里右上 ✕ 即"收起"；否决。
- **收起即视为跳过（selected:[] 提交）**：跳过是需明确回填宿主的作答动作，静默提交会伪造用户意图；否决。
- **收起后挂起清掉、靠服务端重推重建**：重推只在重连/重放时发生，正常收起后无重推即永久丢失作答入口；必须本地保留挂起 + 尾部重开入口。

## Consequences

- 误触 ✕ 不再误杀提问；waiting 黄点/尾部条在收起期间保持，会话不会被误判为 done/就绪；
- 回归门禁：ES5 解析 + `test-decoupling.mjs` + `test-suite.mjs` 全量 PASS（`test-unit.mjs` 纯逻辑切片未动）。
