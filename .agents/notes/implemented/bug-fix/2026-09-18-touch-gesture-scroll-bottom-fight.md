# Agent Note: 触摸/触控板拖拽期间禁止脚本抢写 scrollTop（修复触摸瞬间跳底抖动）

Status: implemented

## Problem
前一条 [2026-09-18-prevent-auto-scroll-stealing-during-history-browse.md](../2026-09-18-prevent-auto-scroll-stealing-during-history-browse.md) 引入的 `userScrolledUp` 状态机存在两个残留盲区，导致 Q20 用户在对话流上**触摸瞬间即发生跳底/抖动、滑动不跟手**（手指与光学触控板同样中招，BB10 浏览器把触控板滑动合成为同一触摸滚动事件流）：

1. **40px 盲区争夺**：从底部起手的上拖在前 40px 内 `isNearBottom()` 仍为真，`userScrolledUp` 保持 false，流式期间每 70ms 的 `flushRender()` / thought / tool 事件持续调用 `scrollBottom()` 把视口拽回底部——用户刚一触摸上拉就被弹回。
2. **程序化写入反噬（标志位竞态）**：`scrollBottom()` 的 `scrollTop = scrollHeight` 赋值自身会同步触发 `onscroll`，`isNearBottom()` 为真又把 `userScrolledUp` 复位为 false，重新武装下一轮抢夺；且在 `-webkit-overflow-scrolling: touch` 容器内，手势进行中的脚本 `scrollTop` 写入会打断 WebKit 原生 pan 锚定，表现为内容瞬移。

## Decision
重构 `static/index.html` 滚动状态机（`chatContainer.onscroll` / `scrollBottom()`），新增三重防护：

1. **手势感知（`gestureActive`）**：`touchstart` 置位、`touchend`/`touchcancel` 后经 260ms 动量宽限窗复位；`scrollBottom()` 在手势期间绝不写 `scrollTop`，仅挂起 `pendingPinBottom`，手势结束后一次性重估。
2. **程序化写标记（`programmaticScroll`）**：所有脚本写入统一走 `setScrollTopProgrammatic()`（含 `renderWindowedMessages` 的 preserveScroll 补偿与 `scrollToSelectedWrap`）；`onscroll` 忽略自身写入引发的事件，杜绝滚底动作反向清除用户意图。
3. **方向化意图判定**：手势内任意上移（`dist > lastDistFromBottom`）立即置 `userScrolledUp = true`（消除 40px 盲区）；仅当用户**向下**移动回 40px 内才复位并恢复跟随；手势外用 +2px 增量阈值防流式内容增长误判。`scrollBottom` 挂起路径同时重基线 `lastDistFromBottom`，抵消内容增长导致的位移误读。

实体键盘 `T`/`Space` 翻页刻意不走程序化标记——键盘翻页语义等同用户滚动（上翻即停止跟随、回到底部自动恢复），行为保持不变。

## Alternatives considered
1. **仅在 `touchstart` 时置 `userScrolledUp = true`**：一次轻触（无滚动）也会永久解除跟随，用户必须手动滑回底部或按 B，过度矫正。
2. **完全移除 40px 阈值、仅以 `scrollTop === maxScroll` 判触底**：流式吐字时用户停在"距底 35px"处会被误判为离开底部，跟随体验劣化。
3. **CSS `touch-action` / `overscroll-behavior` / `scroll-anchor`**：BB10 WebKit 537 全不支持，无法阻止 JS 层 `scrollTop` 抢写。
4. **在 `touchmove` 里 `preventDefault()` 接管自绘滚动**：重造滚动物理，老双核 CPU 上必然掉帧，且违反"原生滚动 + `-webkit-overflow-scrolling: touch`"的宪法约定。

## Consequences
- 流式生成/后台挂载期间，用户从底部起手的触摸上拉不再被弹回；触控板滑动同样平滑跟手。
- 手势期间到达的流式片段挂起至手势结束（260ms 宽限后）一次性落位，期间不丢内容只延后跟随。
- 键盘 T/Space 语义不变；B 键 `scrollBottom(true)` 强制路径不受手势拦阻。
