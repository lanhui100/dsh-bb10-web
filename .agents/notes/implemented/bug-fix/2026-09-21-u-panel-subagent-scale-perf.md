# Agent Note: U 面板千级子智能体分页渲染与开合防抖

Status: implemented
Related: .agents/notes/implemented/feature/2026-09-18-multi-agent-subagent-team-board.md
Related: .agents/notes/implemented/feature/2026-09-18-subagent-drill-down-u-hotkey-two-tier-navigation.md
Related: .agents/notes/implemented/bug-fix/2026-09-21-u-panel-workspace-fallback.md
Related: .agents/notes/implemented/bug-fix/2026-09-20-subagent-board-click-delegation.md

## Problem

U 键多智能体看板（`static/index.html` `#subagent-tree`）无任何规模防护：`renderSubagentTree()` 全量循环 `mkNode + appendChild`（N 次重排）、`markKbSel()` 全量正则重写类名、`/api/session/subagents`（`server.mjs`）全量返回排序。约 100 条明显顿挫，1000 条在 Q20 双核 + 2GB 上假死。且每次按 U 都删缓存整树重建、进详情即整会话切换（abort + 重拉 history），频繁开合反复支付全量代价。

## Decision

前后端分页窗口化 + 开合防抖（ES5，零新依赖，旧契约向后兼容）：

- 前端（`static/index.html`）：`subagentPageSize = 30` 首屏窗口，`[⬇ 加载更多]` 行按需展开；整树经 `DocumentFragment` 单次插入；`markKbSel` 只动旧选中行与新行（`container.__lastSel` 快路）；`subagentReqSeq` 丢弃过期 XHR 回包；`selectSubagentSession` 400ms 防抖；开 U 命中 15s 内缓存直接渲染、后台静默刷新（取代"每次删缓存"）；`closeSubagent` 清空树 DOM 释放内存。
- 服务端排序改为 running 置顶再按更新时间，分页页内优先看到运行中任务。
- 后端（`server.mjs`）：`/api/session/subagents` 新增可选 `limit`/`offset`（缺省全量，旧调用零影响），响应恒带 `total`；前端首屏 `limit=30`，加载更多用 `offset=已缓存数` 追加合并。
- 回归进 `test-unit.mjs`：分页切片 + total 契约、前端关键标记存在性。

## Alternatives considered

- *纯前端窗口、后端不动*：Rejected。千级下 JSON 传输与 `JSON.parse` 仍一次性全付；后端切片仅十余行，一次做到位。
- *虚拟列表（按 scrollTop 动态复用行）*：Rejected。旧 WebKit 滚动事件抖动大、绝对定位行高估算在双语标题下易错位；分页按钮在 720 方屏 + J/K 导航下更稳。
- *服务端默认限流（如缺省 100 条）*：Rejected。改变缺省契约，旧消费者静默丢数据；缺省全量 + 显式分页最安全。
- *保持每次删缓存强制刷新*：Rejected。正是频繁开合卡顿的根因之一；15s TTL + 后台刷新保证新鲜度（看板数据秒级变化本就依赖重进刷新）。

## Consequences

- 首屏 DOM 常驻 ≤30 行 + 组头；百级千级开合流畅，内存占用有界。
- 空会话回退链（fallback）与容器事件委托保持不变，既有断言继续通过。
- 多一次"加载更多"翻页成本由用户按需触发；running 置顶轻微改变旧排序语义（纯展示层）。
- 门禁：ES5 Acorn 解析通过；`node test-decoupling.mjs && node test-unit.mjs` 全量 PASS（靠机器）；`bash .agents/skills/write-adr/verify-note.sh` 通过（靠机器）。
