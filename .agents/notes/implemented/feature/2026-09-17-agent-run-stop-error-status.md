# Agent Note: Agent 运行/停止/错误三态与细化错误直显

Status: implemented

## Problem

BlackBerry Q20 前端缺少准确的 agent 状态呈现，`static/index.html` 的 `setStatus(text)` 只有灰色纯文本，无状态区分：

1. 运行/停止/完成共用同一灰色样式，用户无法一眼区分 agent 正在运行、已手动停止还是已完成；
2. 错误只有一行小字：`eventType === 'error'` 分支只读 `data.error`，但 `server.mjs` 实际广播的是 `{ message: err.message }`（字段错位），真实 DSH 错误信息被丢弃，只显示“未知错误”；且 `readyState === 4` 收尾无条件覆盖为“就绪”，把错误状态洗掉；
3. 挂载路径 `attachSession` 完全没有 `error` 事件分支，也没有 `xhr.onerror`/非 200 处理，DSH 后台任务出错或本机断网时挂载视图静默无反馈；
4. 用户主动停止（`stopStreaming` abort）后，`readyState === 4` 回调仍会把“已中止生成”覆盖为“就绪”；
5. DSH 后端错误（鉴权/限流/上游异常）与本机网络错误（断网、HTTP 非 200）未做分类，用户无法判断是该重试、检查网络还是换模型。

## Decision

`static/index.html`（ES5，静态 HEX，无 CSS 变量）：

1. 状态机：`setStatus(text, state)` 新增可选 `state`（`running`/`stopped`/`done`/`error`），状态行按状态着色（运行绿 `#4EC9B0`、停止橙 `#D96B27`、错误红 `#F85149`、完成灰），并记录 `agentState`；
2. 错误直显：新增 `showStreamError(shortText, fullText)`，状态行红色短文案 + 对话流内红色 `.msg-error` 错误块（含完整错误信息与“按 R 重试”提示）；
3. 字段错位修复：`error` 事件改读 `data.message || data.error`，并透出服务端 `code` 做短标签映射（鉴权失败/上游限流/上游超时/上游异常/DSH 执行出错）；
4. `streamError` 标记：出错后 `readyState === 4` 不再覆盖为“就绪”；全局 `stopRequested` 标记保证手动停止后终态恢复“已手动停止”而非“就绪”；
5. 挂载路径补齐 `error` 分支、`xhr.onerror` 与非 200 处理；`xhr.onerror` 用 `navigator.onLine` 区分“本机已离线”与“网络连接中断”；
6. `doSend` 补防御性 `cancelled` 分支。

`server.mjs`：`error` 广播富化为 `{ message, code, source: 'dsh' }`，新增 `classifyDshError(msg)`（`auth`/`ratelimit`/`timeout`/`upstream`/`dsh-error`）；挂载轮询异常改为 `{ message, code: 'local', source: 'local' }`。SSE 事件名与字段保持向后兼容（只增字段）。

`README.md` / `README.zh.md` 同提交补一行状态与错误说明。

## Alternatives considered

- **只改文案不做颜色区分**：Q20 老 WebKit 下灰色小字在阳光/暗光下辨识度差（宪法要求高对比），且运行/停止/错误三态仅靠文字易误读；静态 HEX 类名零运行时成本，故采用着色状态行。
- **错误详情用 `alert()` 弹窗**：归档失败处已有 `alert`，但流式错误高频且 BB10 弹窗打断阅读；对话流内红色错误块可随滚动回看，更符合小屏阅读。
- **服务端做错误码枚举表**：DSH 上游错误形态不稳定，穷举不可靠；采用消息正则粗分类 + 透传原文，分类只影响短标签，原文永远直显，不丢失信息。
- **readyState 4 统一 `setStatus('就绪')` 不动**：这正是洗掉错误/停止态的根因；用 `streamError`/`stopRequested` 双标记做终态守卫，改动最小且覆盖两条链路（直连与挂载）。

## Consequences

- 用户可一眼区分运行中（绿）/已停止（橙）/出错（红）/完成（灰）；DSH 后端错误原文直达对话流，不再是“未知错误”；断网与 DSH 错误可区分。
- 新增 mech 命令：ES5 门禁（acorn `ecmaVersion: 5` 解析 `static/index.html` 内联脚本）+ `node test-suite.mjs` 7/7 + `verify-note.sh` 通过。
