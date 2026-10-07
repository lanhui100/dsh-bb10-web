# Agent Note: 面板缺失态/加载态优化与快捷键底栏常驻

Status: implemented

## Problem

各全屏面板（会话 / 未分组 / 全工作区聚合 / 多智能体 / 快捷消息 / 常用模型 / 历史消息加载）中「暂无 XXX」与「加载 XXX」状态过于简陋——仅为一两行灰字（`(暂无历史会话)`、`… 加载会话中`、`⏳` emoji），与整体高对比暗色主题不协调，且快捷键提示（`.tree-hint`）以普通流式文本趴在列表末尾，滚动后不可见，违背 720×720 方屏「每一像素都珍贵」的空间利用率铁律。

## Decision

在 `static/index.html`（严守 ES5、静态 HEX、无 CSS 变量、无 Grid、双内核动画前缀）中实施：

1. **面板加载态统一为「中央动效 loading」**：新增纯 CSS 旋转光圈 `.spin-ring`（30px，`border-top` 高亮，复用既有 `welcome-spin` keyframes）＋ 呼吸文字 `.state-text`（复用 `welcome-pulse`），由新 helper `mkStateNode('load', text)` 生成，`.panel-state` 以 `position:absolute; top:42%` 在面板内垂直居中呈现；历史消息加载（`showHistoryLoading`）同步改为该动效并下沉至 38% 高度。
2. **空态极简化**：`mkStateNode('empty', text)` 渲染淡灰 ◇ 图标（`.state-empty-icon`）＋ 弱化文字（`.state-empty-text`），替换全部「(暂无…)」灰字；聚合视图的「其余工作区加载中」等混排行改用紧凑行 `.panel-state-row` ＋ 内联 `.mini-spinner`。
3. **快捷键提示移至屏幕底部常驻**：`.tree-hint` 改为 `position:absolute; left/right/bottom:0` 的底栏（深底 `#141414` + 上边框 `#2C2C2C`，z-index 130），**并作为 overlay 的直接子节点移出可滚动的 `.tree-panel`**（否则 absolute 定位仍会随滚动容器内容一起滚动）；各带提示的面板通过 `padding-bottom: 52px` 预留避让，`#sess-overlay .tree-hint` 额外 `bottom:44px` 上抬避开其 `+ 新建` footer；加载更多条与图片预览等临时态改用 `.mini-spinner`。
4. **覆盖范围**：会话列表、未分组、全工作区聚合（进行中/待处理）、多智能体看板、快捷消息、常用模型空态、历史消息加载/失败、顶部分页加载更多。
5. **会话面板右下角「+ 新建」按钮移除**（后续修订）：`#sess-footer` 与 `#new-chat-btn` 一并删除，会话面板恢复全高（`bottom:44px` 与提示条 `bottom:44px` 上抬规则随之撤销）；新建入口保留 `N` 键（`startNewChat`）与欢迎页 `I` 键，按钮的 onclick 绑定移除但函数本体不动。

本条为纯视觉/布局层决策，不复写既有加载逻辑：聚合视图缺失判定收敛见 [2026-10-02-fix-false-loading-state-in-aggregated-sessions.md](../bug-fix/2026-10-02-fix-false-loading-state-in-aggregated-sessions.md)，历史分页加载机制见 [2026-09-17-history-lazy-loading-and-archive-loading-state.md](../feature/2026-09-17-history-lazy-loading-and-archive-loading-state.md)。

## Alternatives considered

- **沿用文本行仅换措辞**：只改文案不解决「加载/空态简陋、快捷键不可达」两个核心诉求；否决。
- **每个面板独立手写动效节点**：7 处以上重复 DOM/CSS，维护成本高；统一 `mkStateNode` 工厂 + 共享 keyframes；采纳。
- **快捷键提示改放顶栏/标题行**：顶部与面板标题、✕ 按钮争抢空间，且与「标题—内容—操作」的 F 型扫读顺序冲突；底部常驻更适合单手拇指区；采纳。
- **使用 Flexbox/Grid 实现垂直居中**：旧 WebKit 对无前缀 flex/grid 支持不稳，`position:absolute` 锚底与 `top:42%` 居中稳妥且零新特性；采纳。