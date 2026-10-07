# Agent Note: 依据会话列表图标权威状态对齐消息流底部状态并动态区分运行中动作

Status: implemented

## Problem
在 BlackBerry Q20 客户端中，会话列表前图标由服务端快照（`sessCache[cwd]` 中的 `isRunning` / `state`）渲染为完成态（绿勾 `✓`）、停止态（`■`）或错误态（`✖`）。然而在消息流底部，偶发在会话已经完成后依然残留“运行中”或“会话中”的现象，与列表前的图标状态不一致。

根本原因分析：
1. `resolveEffectiveSessionState()` 在查验到服务端快照 `serverObj && !serverObj.isRunning` 时，虽返回了非 running 态，但在特定情况下如果快照的 `state` 字段为空或异常未及时覆盖 `sessState.phase`，导致 `phase` 仍滞留；
2. `loadSessions` 轮询反向同步时，当 `!matchedCurSess.isRunning` 时原先带有条件 `&& !attachXhr`，若后台还有残留的挂载连接未释放，会短路跳过状态收口逻辑，导致前端状态机没有被强行收敛；
3. 底部状态指示器 `renderSessionStatusTail` 在会话处于 `running`（未完成）时，之前缺乏对最新具体运行动作（如“正在调用工具...”、“正在思考...”）的可靠持久化透传，而在会话已完成（!isRunning）时未能严格以图标状态权威闭环。

## Decision
1. **列表图标作为终态权威判据**：
   在 `resolveEffectiveSessionState()` 中，当服务端会话快照判定 `!serverObj.isRunning` 且本地无在途发送流（`activeXhr === null`）时，强制将 `sessState.running` 置为 `false`，将 `sessState.phase` 权威结算为 `serverObj.state || 'done'`（若为 'running' 则校正为 'done'），确保与会话面板列表前的状态图标 100% 相同口径；
2. **解除轮询反向同步阻断**：
   在 `loadSessions` 中，一旦服务端快照判定会话已结束（`!matchedCurSess.isRunning`），无论本地是否存在 `attachXhr`，立即调用 `stopAttach()` 终止悬挂连接，并权威收口状态为完成态/中止态/错误态；
3. **未完成态动态区分运行中动作**：
   引入 `lastRunningActionText` 记录运行中的具体动作（调用工具、思考、生成中等）。在未完成（`phase === 'running'`）时精准呈现实际状况；一旦权威裁定完成，立即彻底切换为完成态图标与文案（`✓ 会话已完成`），杜绝任何运行中文案残留。

## Alternatives considered
- *仅修改 `renderSessionStatusTail` 中的文案*：治标不治本，若状态机底层 `sessState.running` 仍为 true，发送按钮会保持红色停止图标，快捷键也会被拦截。
- *完全废弃本地状态推导，每次纯读服务端 API*：增加网络延迟，破坏打字机和流式输出的即时响应。

## Verification
1. ES5 语法门禁：通过 Acorn 静态语法检查（`ES5 PASS`）；
2. 解耦与单元测试：`node test-decoupling.mjs && node test-unit.mjs` 15/15 全部 PASS。
