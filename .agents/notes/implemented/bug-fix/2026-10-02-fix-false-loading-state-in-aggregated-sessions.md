# Agent Note: 修复会话列表聚合视图虚假加载状态

Status: implemented

## Problem
用户按 `C` 键呼出会话列表面板（全工作区进行中/待处理聚合视图）时，列表中已将所有匹配会话展示完毕，但底部长时间常驻显示 `… 其余工作区加载中`。
经诊断根因如下：
1. `static/index.html` 中的 `renderSessAggregated` 聚合逻辑仅根据 `!sessCache[wc]` 判定 `missing`，而未结合从 `/api/bootstrap` 下发的工作区元数据 `sessionCount === 0`。对于无会话的工作区，若未进入或未缓存，`missing` 恒为 `true`。
2. 全局缺少 `var wsPreloadTimer = null;` 声明，导致 `preloadMissingWorkspaceSessions` 内的定时器句柄处理在未显式挂载到 window 时存在异常风险；且预取时未跳过无会话工作区，造成无意义网络与磁盘扫描。
3. 两者叠加导致即使所有有效会话已全部渲染，面板底部仍被注入无实际加载作用的伪 loading 节点 `… 其余工作区加载中`，破坏黑莓 Q20 界面可信度。

## Decision
1. **聚合视图缺失判定智能收敛 (`static/index.html`)**：
   - 在 `renderSessAggregated` 中，当工作区缓存 `!sessCache[wc]` 缺失时，若 `ws.sessionCount === 0` 且当前并无在途加载（`!sessLoading[wc]`），确认其无任何进行中或待处理会话，直接跳过，不标记为 `missing`。
2. **错峰预取过滤与句柄初始化**：
   - 补齐全局 `var wsPreloadTimer = null;` 声明。
   - `preloadMissingWorkspaceSessions` 对 `ws.sessionCount === 0` 且未缓存的空闲工作区跳过后台预取，节约双核 CPU 与网络开销。
3. 严格遵循 ES5 语法规范并通过 acorn 静态解析门禁与自动化回归套件。

## Alternatives considered
- *完全移除底部加载状态提示*：在冷启动大工作区真正需要数秒扫描时，用户会误以为列表已经加载完毕而没有后续，损失可感知性。
- *在进入页面时强制全量并行并发拉取所有工作区*：会打满 Q20 的双核 CPU 并造成事件循环卡死，违反项目宪法。

## Consequences
- `C` 键呼出全工作区会话面板时，当有效会话渲染完毕且空工作区已由 bootstrap 确认时，底部不再残留虚假的 `… 其余工作区加载中`。
- 测试套件全量 32 项 PASS，严格符合 ES5 约束。
