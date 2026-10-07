# Agent Note: workspace-tree-status-bullets

Status: implemented

## Problem

工作区（W）面板的项目符号原本仅表示"是否为当前选中工作区"（选中显示 `●`，其余显示 `·`），完全不反映各工作区旗下会话的运行状态。用户在多工作区并行 Agent 任务时，必须逐个进入会话面板才能发现某个工作区有运行中/出错会话，关注度成本高。

## Decision

`static/index.html` 中新增 `workspaceStateMark(ws)`：读取 `sessCache[ws.cwd]` 聚合旗下会话状态，按用户关注度优先级取最高一级符号——错误红 `✖` > 等待黄 `?` > 运行蓝 `●` > 中断橙 `■` > 完成绿 `✓` > 空闲灰 `·`，与会话树行（`sessionStateMark`）和全局状态符号完全一致。`renderWsTree()` 的行首前缀改用该聚合符号而不再表示选中态；选中区分改由 CSS 高亮承担（`.tree-ws.active-ws` 增补 `#0E3A36` 底色，与 `.tree-sess.active-sess` 同构，原有边框保留）。空闲灰新增 `.idle-dot` 规则避免复用橙色 `stop-dot` 造成误读。

`loadSessions()` 成功回调与 `renderSessions()` 末尾各加 `if (isWsOpen) renderWsTree();`，令后台预取/5s 轮询到达后工作区符号实时刷新；未加载到会话列表前显示空闲灰 `·`。

## Alternatives considered

- **保留"选中=蓝点"的旧语义，仅在非选中行加状态符号**：同一列符号混用两种语义（选中 vs 状态），符号含义不再与全局状态一致，落选。
- **符号只显示"有无运行中"二值**：丢失错误最高优先级信号，用户核心诉求正是错误优先提醒，落选。
- **工作区符号挂 `ws.sessionCount` 计数刷新同时更新**：计数来自 `/api/bootstrap`，状态来自 `/api/sessions`，两源一致已由单测保证；额外联动徒增耦合，落选。靠 review：聚合口径（`sessCache` 即显示中的会话）与计数口径一致性。

## Consequences

- ES5 门禁：新增代码仅用 `var`、`function` 与字符串拼接，`node -e acorn ecmaVersion:5` 通过（靠命令验证）。
- `node test-unit.mjs` 全绿（11/11），未触及服务端契约。
