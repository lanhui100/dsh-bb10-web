# Agent Note: 移除会话面板重复的新建会话入口

Status: implemented

## Problem

会话面板打开后存在两个"新建会话"入口：面板底部绿色按钮 `#new-chat-btn`（`+ 新建`）与会话树顶部的 `＋ 新建会话` 节点。二者触发同一行为（`startNewChat()` + 关闭面板），重复入口在 720×720 方屏上浪费树空间并造成交互二义。

## Decision

保留绿色按钮 `#new-chat-btn`（样式高亮 #00897B，语义明确），删除会话树顶部的 `＋ 新建会话` 节点：

- `renderSessTree()` 不再创建/追加 `kind: 'new'` 节点；
- `activateSessNode()` 删除对应的 `n.kind === 'new'` 死分支（已确认唯一消费者）；
- 清理无消费者的 `.tree-new` CSS 类（共享规则保留 `.tree-more`）。

`kbSessIdx` 键盘索引按 `sessNodes`/`sessTree` 同步遍历，删除首节点后两者一致，无需调整。新建会话仍可通过绿色按钮、快捷键 `N`、空状态提示三种途径触发。

## Alternatives considered

1. **保留树顶节点、删除绿色按钮**：树顶节点文案/位置在长列表滚动时不可达，不如固定面板底部按钮；且绿色高亮按钮视觉引导更强——否决。
2. **两者都保留**：维持重复入口与二义性，违背方屏空间利用率铁律——否决。

## Consequences

会话面板树从顶部直接列出会话列表；新建入口唯一化为面板底部绿色按钮与快捷键 `N`。ES5 PASS，回归 7/7。
