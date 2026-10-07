# Agent Note: 修复实时流step切分漏收中间气泡与attach同步截断导致的轮次折叠失效

Status: implemented

相关旧条：`.agents/notes/implemented/feature/2026-09-19-turn-level-process-fold-aggregate-counts.md`（轮次过程折叠对齐 dsh 聚合计数）；
`.agents/notes/implemented/bug-fix/2026-09-22-stream-seq-ordering-dsh-align.md`（实时流按 step 切分展示）。

## Problem

在升级并引入实时流按工具调用切分 agent 气泡（`6aae7f2`）后，会话信息流中原本应在轮次结束时收纳过程信息的折叠功能失效，所有中间文本气泡与工具胶囊全部平铺暴露：
1. **实时流 step 拆分未收拢中间气泡**：实时终态调用 `finalizeLiveProcess(assistantWrap)` 时，`collectProcessNodes` 只收集了思考卡与工具胶囊，**中间 step 产生的 `msg-assistant` 文本气泡被漏在折叠体之外**。导致折叠行生成后，之前的思考/工具虽然被收纳，但中间所有的中间回答气泡依然平铺展开；
2. **挂接快照（attach sync）切片截断轮次起点**：服务端 `/api/session/attach` 的首轮快照之前硬编码 `slice(-20)` 截取最后 20 条。当长会话或单轮工具调用超过 20 步时，下发的片段没有开头的用户提问，客户端渲染时判定为无起始的“断头轮次”，导致整轮折叠失效、全量平铺。

## Decision

1. **前端 `static/index.html` 过程收集升级**：
   - 改造 `collectProcessNodes(container, trailingOnly)` 在 `trailingOnly=false`（单轮 `assistantWrap` 作用域）下的收集逻辑；
   - 逆序查找最后一个包含非空文本的最终回答气泡（`answerBubble`）；
   - 遍历子节点时，将思考卡、工具胶囊以及**除最终回答外的所有中间 step 正文气泡**一并收集进折叠节点列表（`nodes`），并正确递增 `msgCount`；
   - `foldProcessChildren` 构建折叠行时传入真实的 `got.msgCount`，使聚合标签忠实显示 `N 次工具调用 · N 条消息`，且最终回答原位保留在折叠行之后。
2. **服务端 `server.mjs` 挂接快照轮次切片对齐**：
   - 将 `/api/session/attach` 中的快照截取升级为轮次对齐切片（对齐 `/api/history?turns=5`）；
   - 从会话历史中提取所有用户提问的起点索引，向前截取最近完整的 5 个轮次；
   - 杜绝因硬编码 20 条导致的跨轮截断与断头轮次问题。

## Alternatives considered

- **在实时流期间不切分气泡，仅最后统一替换**：违背与官方 `dsh web` 保持 step 交错实时呈现的一致性准则（用户在等待多步执行时无法直观看到每步的输出阶段）；否决。
- **让客户端每次收到 sync 都重新拉取全量历史**：老旧 WebKit 537.35 内核与双核 CPU 频繁请求和解析数百条消息易引起卡顿假死；否决，按轮次下发尾部切片即可满足轻量与闭环。

## Consequences

- 机械可查：Acorn 解析输出 `ES5 PASS`；`test-fold-smoke.cjs` 41/41 PASS；`test-decoupling.mjs` PASS；`test-unit.mjs` 29/29 PASS；`test-suite.mjs` 7/7 PASS。
- 体验恢复：实时推流结束和加载会话时，无论过程经历多少次工具调用与中间输出，均平滑收敛为「用户消息 → 单行折叠行 → 最终回答」。
