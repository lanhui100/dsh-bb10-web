# Agent Note: Subagent Board Mouse Click via Container Event Delegation

Status: implemented

Related: .agents/notes/implemented/feature/2026-09-18-multi-agent-subagent-team-board.md
Related: .agents/notes/implemented/feature/2026-09-18-subagent-drill-down-u-hotkey-two-tier-navigation.md

## Problem

U 面板的子 agent 行把 `onclick → selectSubagentSession(sa)` 直接绑在每行 DOM 节点上
（`static/index.html` 的 `renderSubagentTree`）。而面板打开瞬间渲染两次：先按缓存
`renderSubagentTree()` 一次，XHR 返回后又整树 `innerHTML` 替换一次。在替换窗口内落下
的鼠标点击命中已被摘除的旧节点，事件随旧节点一起丢弃；Enter 路径走
`subagentNodes[kbSubagentIdx].item` 数据索引，不受 DOM 替换影响。表现为"只能 Enter
进入，鼠标点不进"（稳态下点击实际有效，已用 Chromium + 真实后端数据实测确认：
点击行可正常切进子会话、面板收起）。

## Decision

1. 子 agent 行不再绑定行级 `onclick`（改 `mkNode(label, cls, null)`），点击统一由
   `#subagent-tree` 容器单次委托：冒泡到容器时按事件目标向上回溯，匹配当前
   `subagentNodes` 中 `kind === 'subagent'` 的行，命中即调
   `selectSubagentSession(item)`。
2. 委托与 overlay/close 绑定安装在同一处、只安装一次；容器本身永不被替换，
   渲染替换不再丢点击。
3. Enter / JK 路径不动（仍走数据索引），与鼠标行为一致。

## Alternatives considered

- *行级绑定 + 渲染时重绑*：拒绝。竞态窗口仍在，且每次渲染产生 O(n) 闭包，
  在双核 S4 上是额外 GC 负担。
- *加载中禁用点击*：拒绝。误伤稳态可用性，治标不治本。
- *防抖合并两次渲染（缓存渲染与 XHR 渲染二合一）*：拒绝。改动渲染时序风险大，
  且缓存/XHR 到达顺序本就不可控。

## Consequences

- U 面板鼠标点击与 Enter 行为一致；ES5 门禁与现有回归保持通过。
- `test-unit.mjs` 增加机械断言：容器委托存在、子 agent 行级闭包绑定消除。
- Playwright 真实数据点击验证：点行后 `currentSessionId` 切到子会话且面板收起（靠 review，
  非门禁命令）。
