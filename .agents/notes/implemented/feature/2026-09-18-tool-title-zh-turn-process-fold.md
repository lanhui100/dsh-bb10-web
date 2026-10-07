# Agent Note: 中文工具标题与轮次结束过程折叠（对齐 dsh web）

Status: implemented

## Decision

Q20 对话流中的工具信息改用中文标题，并在轮次结束时把思考卡片与工具胶囊收进单行折叠，正文保持可见。对齐 dsh web 两处实现：`packages/client/ui-conversation/src/client/locales.ts`（zh `tool.title.*`）与 ui-tool 各 keyed toolview 最终标题口径；`TurnProcessNodeView` + `ChatNodeSeat` 的 turnClosed 过程折叠语义（单行披露 `N 次工具调用` / `已思考`、正文答案常驻、仅完整窗口下折叠）。

- `static/index.html` 新增 `TOOL_TITLE_ZH` + `toolTitleFor` / `toolSummaryFor`（`/* @Q20-TOOL-TITLE-START/END */` 纯逻辑标记，可被单测提取）：bash→Bash、read→读取、read_image→读取图片、web_search→网页搜索、web_fetch→网页获取、grep→Grep、glob→Glob、write→写入、edit→编辑、run_code→代码、todo_write→任务（对齐 dsh `todo.rowTitle`）、ask_user_question→提问、cordis_* 按 dsh 专用标题；未知工具标题固定 `工具调用`、真实名进 summary 前缀（对齐 dsh others 变体 `name · summary`）。历史胶囊、send/attach 实时胶囊、`正在调用工具 […]` 回退气泡六处渲染点全部接入。
- 新增 `foldProcessChildren`（全容器折叠：历史/同步渲染 + send 单轮 wrap）与 `foldTrailingProcess`（attach 终态：chatContainer 含多轮节点，只收尾部连续段，跳过状态尾节点）。终态收口 `finalizeLiveProcess` 先把残留 running 胶囊结算为 `[已停止]`（对齐 dsh `ToolRowState interrupted → stopped`），再折叠；running 轮次保持展开、节点零搬移。
- 历史/同步渲染仅在 `!sessState.running && !isStreaming` 时折叠（in-flight 胶囊不结算不折叠）；展开态按 `会话|turn:step` 存 `turnProcessOpenMap`（上限 300 条防内存膨胀），sync / 加载更早历史重渲染后保持。取代 2026-09-17 时序交错条中"turn-process 折叠不引入"的结论（见下文链入）。

相关旧条：`.agents/notes/implemented/bug-fix/2026-09-17-chat-timeline-ordering.md`（当时排除 turn-process 折叠，本次按 Q20 小屏适配形态部分引入）。

## Alternatives considered

- 全量照搬 dsh assembler + keyed toolview 注册机制：需 React/slot 体系，与 ES5 单文件约束冲突，否决；只取标题字典与折叠语义。
- 按 turn 跨节点聚合计数折叠（与 dsh 完全同构）：Q20 懒加载按消息分页 20 条，跨节点聚合会被窗口截断误导计数，否决；折叠单元收敛为单个 assistant 节点内过程。
- 终态强制 `loadHistory` 重渲染统一折叠：用户向上阅读（userScrolledUp）时不重渲染，实时节点会永久展开，否决；attach 终态加就地尾部段折叠分支。
- running 胶囊终态直接隐藏：丢失"哪个工具没返回结果"信息，否决；结算为 `[已停止]` 后再折叠。

> **2026-09-19 部分取代**：本条「按 turn 跨节点聚合计数折叠否决」的结论已被
> `.agents/notes/implemented/feature/2026-09-19-turn-level-process-fold-aggregate-counts.md`
> 取代——以「懒加载窗口轮次对齐扩窗」解决窗口截断计数问题后，折叠单元升级为
> 轮级并引入 `N 次工具调用 · N 条消息` 聚合标签；工具标题字典与 running 结算
> 语义继续有效。

## Consequences

- 机械可查：`node -e '...acorn.parse(script,{ecmaVersion:5})...'` 输出 `ES5 PASS`；`node test-unit.mjs` 8/8（含新增 `Tool Title Zh Mapping Contract` 12 组标题 + 3 组回退口径）；`node test-fold-smoke.cjs` headless Chrome 真实 DOM 22/22（全量折叠/展开态保持/running 免折叠/结算后折叠/纯思考标签/尾部段隔离/空容器/标题映射）。
- 机器到不了的：真机 720×720 折叠行可读性与点击手感，靠 review。
