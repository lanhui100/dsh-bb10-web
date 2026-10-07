# Agent Note: Turn-level process fold with aggregate counts

Status: implemented

相关旧条：`.agents/notes/implemented/feature/2026-09-18-tool-title-zh-turn-process-fold.md`
（其「按 turn 跨节点聚合计数折叠否决」结论由本条取代：窗口轮次对齐扩窗解决
截断计数后折叠单元升级为轮级；工具标题字典与 running 结算语义继续有效）；
`.agents/notes/implemented/bug-fix/2026-09-17-chat-timeline-ordering.md`（时间线
到达序原则，折叠搬移不改到达序）。

## Problem

消息流此前只在**单个 assistant 节点**（live 流的 `assistantWrap` / attach 尾段）
范围内折叠思考卡片与工具胶囊，折叠行标签只计工具数（`N 次工具调用` / `已思考`）。
由此产生两类体验缺陷：

1. **历史/同步渲染路径完全不折叠**：进入历史会话时所有思考卡与工具胶囊平铺，
   一轮几十个调用把 720×720 方屏拉出数十屏；
2. **折叠单元过碎**：单步单工具的轮次产生「1 次工具调用」孤立折叠行，隐藏
   一条胶囊换一行披露行，毫无收益。

dsh web 的权威语义是**轮级**（turn-level）`turn-process` 披露
（`ui-chat/src/client/chat/TurnProcessNodeView.tsx` +
`conversation-nodes/turn-process.ts`）：轮次关闭后，把该轮思考、中间过程
assistant 消息与工具调用整体收进单行，标签以 ` · ` 连接非零计数段
（`{count} 次工具调用` / `{count} 条消息`，全零兜底 `已思考`），最终回答正文
保持可见。

## Decision

- **折叠单元升级为轮次**（用户消息后的全部 assistant step，`turn` 号或相邻
  归组）：组内思考卡片 + 中间过程 agent 消息气泡 + 工具胶囊整体搬入
  `turn-process-body`，最终回答（组内最后一个含非空正文的 step）的文本气泡
  原位保留——呈现「用户消息 → 折叠行 → 最终 Agent 消息」。
- **标签聚合计数对齐 dsh zh locale**：`turnProcessLabel(toolCount, msgCount)`
  产出 `N 次工具调用 · N 条消息`（非零段才出现，全零记 `已思考`）；`msgCount`
  按 dsh 口径计「含可见正文或思考的中间 step」数，而非气泡数。
- **单条过程项不折叠**：`buildProcessFold` 对 `nodes.length <= 1` 直接返回
  false——「1 次工具调用」类孤立折叠行与单张思考卡披露行一并移除。
- **历史/同步路径接入折叠**：`renderWindowedMessages` 按 turn 分组，组渲染完
  成后调 `foldTurnGroupInDom` 折叠并移除已腾空的中间 step wrap；运行中的最后
  一轮不折叠（思考/工具仍在实时追加），终态后由 `loadHistory` 重渲染统一收口。
- **懒加载窗口轮次对齐**：窗口起点落在某轮次中间时向上扩窗至该轮起始用户消息
  （上限 64 条），保证折叠聚合计数为整轮口径；扩窗触顶（服务端还有更早历史或
  轮次超长）时折叠行计数按折叠体内实际内容计，依然真实，点「加载更多历史」
  后自动补全。
- **本轮用户消息自动补齐（懒加载 × 折叠阅读意图的最终闭环）**：
  `maybeFillToTurnStart` 在窗口首条消息为 assistant step（最近一轮被窗口顶部
  截断、本轮提问在窗口外）时，静默自动向上分页拉取，直至已加载范围内能倒找
  到最近一条用户消息（即「用户消息 → 折叠行 → 最终回答」完整呈现）即停止
  （上限 `MAX_TURN_FILL_PAGES = 8` 页 / 160 条，防超长轮次构建压力）；
  - 触发延迟 250ms 合流：等 attach 初始 `sync` 快照落地后再补齐，避免窗口被
    快照重置后再触发；sync 快照替换 `allMessages` 时（`syncSig` 不同）同步
    重臂 `turnFillExhausted`，保证慢同步下补齐收敛不失效；
  - 初次进入会话补齐完成后重新锚定视口到**最近一轮的用户消息**（滚动位置未
    被用户改变时），使本轮提问与最终结果同屏一次可读；
  - 起点截断组（窗口顶的旧轮次尾部）仍按折叠体真实计数折叠。
- **初始视口锚定为轮次起点**：`scrollToLastMessageStart` 由「最后一条
  assistant 正文气泡」改为「最后一条用户消息」（无用户消息时回退原逻辑），
  配合轮次折叠呈现自上而下的「用户消息 → 折叠行 → 最终回答」阅读结构。
- **attach 尾段跨过最终回答**：`collectProcessNodes` trailing 模式允许跨过
  一个含 assistant 正文气泡的 `msg-wrap`（attach 最终回答），其前后过程节点
  一并折叠，回答 wrap 原位保留。
- **展开态持久化键从 `会话|turn:step` 收敛为 `会话|turn`**（`turnProcessKey`），
  与折叠单元粒度一致；sync / 加载更早历史重渲染后展开态保持。

## Alternatives considered

1. **对齐 dsh 的 `historyIncomplete` 全局门控**（放弃）：dsh 在还有更早历史
   未加载时完全不折叠。Q20 默认窗口仅 20 条消息，长会话（本次实测 588 条）
   将几乎永远不折叠，平铺胶囊把小屏拖垮，违背内存窗口化与空间利用率铁律；
   改取「轮次对齐扩窗 + 折叠体真实计数」，截断只在超长轮次下残留。
2. **窗口起点截断组不折叠（组级 historyIncomplete）**（放弃）：初始视图恰好
   是用户最关心的最后一轮，不折叠意味着首轮打开长会话就看到 19 个胶囊平铺，
   折叠收益全失；折叠行计数始终等于折叠体内容数，不产生虚假信息。
3. **引入服务端聚合接口（按轮返回计数）**（放弃，违宪）：新增第三条私有协议
   路径违反 AGENTS.md §六消费边界；折叠是纯展示层行为，现有 `/api/history`
   的 `turn`/`step`/`blocks` 数据足以支撑，客户端聚合即可。
4. **保留单工具折叠、仅追加消息计数**（放弃）：用户明确指出「1 次工具调用」
   类折叠没有意义；折叠行存在的条件是隐藏内容量 >1，单条过程项直接平铺。
5. **补齐目标定为「窗口顶部对齐轮次起点」（首版实现，回退）**：首版自动补齐
   以「最旧一条是用户消息」为停止条件，对长轮次会话（588 条 / 单轮 77~164 步）
   需倒走整段历史才命中，撞 6 页上限后 `turnFillExhausted` 永久挡住重补；
   且 attach 初始 sync 快照在补齐完成后重置窗口（`allMessages = tail`）致
   20 条回退。改为「已加载范围含最近一条用户消息即停」（1 页即达）+
   延迟 250ms 合流 + sync 重置时重臂 exhausted，三者共同保证收敛。
6. **不自动补齐、依赖用户点「加载更多」**（放弃）：正是用户反馈的核心痛点
   （“多次点击懒加载才能找到本轮提问”），自动补齐 + 轮次锚定是本次便捷阅读
   设计意图的闭环。

## Verification

- `node -e` Acorn ES5 门禁 → `ES5 PASS`（非零退出即失败）；
- `node test-fold-smoke.cjs` → 41/41 PASS（含新增 G 组轮次折叠、G2 单调用
  不折叠、G3 无回答整组折叠、G4 running 不折叠、D2 attach 跨回答用例）；
- `node test-decoupling.mjs && node test-unit.mjs && node test-suite.mjs` →
  全量 PASS（15/15 + 7/7）；
- 真实数据 CDP 驱动验证（headless chrome 直连 3090，588 条消息真实会话）：
  初始渲染序列 `loadmore → FOLD → assistant → tail`、展开体 19 胶囊、
  加载更早后 `3 次工具调用` / `34 次工具调用` 两行且零孤儿过程节点、
  强制重渲染后展开态保持；
- 自动补齐 CDP 验证（同一真实会话，两次运行稳定）：打开会话即静默补至
  `40 / 588`（20 + 1 页），结构 `loadmore → FOLD(3次·turn7 尾) → assistant
  (turn7 回答) → USER(turn8 提问) → FOLD(34次·turn8 完整) → assistant
  (最终回答) → tail`，视口锚定最近一轮用户消息；手动加载更早历史后各轮保持
  「折叠 + 回答 + 用户消息」结构。
