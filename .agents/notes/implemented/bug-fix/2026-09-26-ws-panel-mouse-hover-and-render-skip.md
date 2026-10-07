# Agent Note: 修复 W 面板桌面鼠标不可用感——行 hover 反馈 + 无变化跳过整树重建

Status: implemented

## Problem

在桌面浏览器（DSH Web GUI 预览 / 调试）中打开工作区面板（`W`）时，鼠标表现为“点不动、没反馈”：

1. **无 hover 反馈**：`.tree-node` 行没有任何 `:hover` 样式，鼠标划过列表毫无视觉响应，观感即“鼠标不可用”；
2. **5s 轮询整树重建吞交互**：`static/index.html` 底部 `setInterval(..., 5000)` 轮询 `loadSessions`，其归来分支在 `isWsOpen` 时无条件调用 `renderWsTree(true)`（另有 `refreshRunningWorkspaceSessions` / `preloadMissingWorkspaceSessions` 归来分支同路径），每次都执行 `wsTree.innerHTML = ''` 全量重建 DOM。后果：
   - hover 状态随元素替换即刻清零，无法停留；
   - 若重建发生在 `mousedown`→`mouseup` 之间，`click` 事件落在被摘除的旧节点上，行级 `onclick`（`selectWorkspace` + `closeWs`）直接丢失，点击“失灵”。

BB10 本体靠键盘/触控板（J/K/回车）操作，受此影响较小，但桌面调试与 dsh web 同构预览场景下问题显著。

**关联既有决策**：[implemented/bug-fix/2026-09-20-sess-ws-panel-poll-keepscroll.md](implemented/bug-fix/2026-09-20-sess-ws-panel-poll-keepscroll.md)（build + restore scrollTop 保持视口）。本次对本决策属**局部细化而非推翻**：轮询无变化时直接跳过重建（视口天然保持，运行态圆点聚合在签名中、有变化仍重建，其拒绝“轮询期间跳过重绘”的 stale 顾虑不成立）。

## Decision

1. **新增 hover 轻反馈 CSS**（`.tree-node:hover` 背景 `#2A2A2A` / 边框 `#3D3D3D`；`.tree-ws.active-ws:hover` 背景 `#0F453F` / 边框 `#26A69A`）——纯静态 HEX，旧 WebKit 原生支持 `:hover`，触控/触控板无 hover 不受影响；`.tree-node.kb-sel` 带 `!important`，键盘选中态恒优先于 hover；
2. **内容签名跳过重建**：新增 `wsTreeSignature()`，聚合 `getCwd()`、`ungroupedCount`、每个工作区的 `cwd/name/sessionCount` 与其 `sessCache` 会话状态聚合（R/E/W/S/D 计数，与 `workspaceStateMark` 判据一致）。`renderWsTree` 开头比对 `wsTree.__sig`：内容未变则直接 return，不动 DOM——hover/kb-sel/视口全部保留；数据真变化（新建/移除/计数/状态变动/切换激活）时照常重建；
3. **打开必重建**：`closeWs()` 置 `wsTree.__sig = null`，下次 `openWs()`（`kbWsIdx=-1` 归位）强制整树重建，保证 kb-sel 与数据新鲜；
4. 全程纯 ES5（var/function/字符串拼接），无 CSS 变量、无 Grid。

## Alternatives considered

- 行级 `mousedown`/`pointerup` 兼容兜底：能缓解部分点击丢失，但无法解决 hover 被轮询清零的主诉，且引入额外事件面，弃；
- 仅降频轮询（拉长 interval）：会牺牲运行态横幅与聚合图标的时效性，治标不治本，弃；
- 差分渲染（逐节点对比更新）：收益与签名跳过相同但复杂度高、回归面大，在 wsList 规模（个位数工作区）下签名跳过已足够，弃。

## Consequences

- 桌面鼠标在 W 面板获得明确行反馈；5s 轮询无变化时不再重建 DOM，hover 停留、点击稳定；
- 数据变化（会话计数/状态/新增/移除/激活切换）时仍即时重建，聚合图标时效性不降；
- BB10 真机（触控/触控板）路径行为不变；`test-decoupling.mjs`、`test-unit.mjs`、ES5 acorn 门禁全量 PASS；README 交互契约（W/A/D/JK/回车）未改，无需文档联动。
