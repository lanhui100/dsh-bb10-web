# Agent Note: O 面板当前模型跨会话串台——会话级模型记忆

Status: implemented

## Problem

单页内多会话切换模型后，`o` 面板的"当前模型"与组合器 M 徽标展示的是**其他会话**留下的模型，而非当前会话实际使用的模型。

复现链路（非推测）：会话 A 经 M 面板选中非默认模型 X 并运行 → 切到会话 B 选中/使用模型 Y（默认）→ 切回会话 A 按 `o`：显示的模型是 Y（B 会话遗留在 `modelSelect` 的全局选择），而 A 会话转录里的真实模型是 X。

根因（`static/index.html`）：`modelSelect` 是**跨会话共享的组合器模型选择**，`renderStatusPanel`（O 面板）与 `getModelBadgeText`（M 徽标）却把它当作当前会话模型的第一事实源读取；切会话时没有按会话恢复模型，导致上一会话的选择残留到当前会话展示。

## Decision

前端（`static/index.html`，纯 ES5）：

- 新增**会话级模型记忆** `sessionModelStore`（内存 Map：`sid -> 'provider:::model'`，封顶 40 会话，2GB 泄漏防护）；
- 写入点三处：① 发送时把本条消息的模型记入目标会话（新会话在推送 `data.sessionId` 落位后补记）；② M 面板手动选取即记为当前会话的模型；③ `/api/session/stats` 归来把服务端转录真值（`request/header` config / `assistant/message` source）写入；
- `selectSession` 切会话时按记忆恢复 `modelSelect`（无记忆的空白/陌生会话沿用组合器当前选择/默认，绝不串台）；
- O 面板与 M 徽标的模型解析顺序统一改为：**stats 会话真值 → 会话模型记忆 → 组合器全局选择**（组合器选择只作空白态兜底）。

不引入服务端改动：`/api/session/stats` 已按会话返回转录真值 `provider/model`，页面重载后显示依旧以服务端为准；内存记忆只为同页切会话提供即时恢复。

## Alternatives considered

- **仅改 O 面板展示、不恢复 modelSelect**：能修好面板显示，但组合器徽标与"下一条续发消息用哪个模型"仍串台，续发消息会悄悄用别的会话的模型，语义未对齐。否决。
- **服务端在会话列表里下发每会话模型，前端冷启即恢复**：会话列表 header 无模型字段，需为每个会话扫转录，3090 侧每会话一次 stats 成本过高，且同页内（本 bug 场景）不需要；页面重载后 O 面板走 stats 真值已足够。否决。
- **localStorage 持久化会话模型**：页面生命周期短、2GB 内存约束下避免额外序列化；转录侧 stats 已是持久真值，内存记忆只管同页即时性。否决。

## Consequences

- 会话 A 的 O 面板/徽标恒显示 A 自己的模型（运行中/终态均正确）；切走再切回模型选择恢复；
- 新会话的首条消息仍用组合器当前选择（默认模型），语义保持：组合器选择 = "下一条新会话用什么模型"，会话记忆 = "该会话用什么模型"；
- 门禁：ES5 PASS；`test-decoupling.mjs` PASS；`test-suite.mjs` 7/7；`test-unit.mjs` 全量 PASS（本次回归实测）。
