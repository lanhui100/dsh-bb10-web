# Agent Note: Anchor History View at Last Message Start

Status: implemented

## Problem

在用户通过会话面板进入一个已存在的历史会话时，此前系统默认执行 `scrollBottom()`，强制将屏幕视口直接推至整个对话流的物理最底部（包含最后一条消息的尾部以及底部留白区域）。

由于 BlackBerry Q20 为 720×720 方形小屏幕（3.1 英寸），当模型最后一条回复较长时，视口落在最底部会导致用户只能看到回复的结尾甚至空白尾部，不得不使用触摸或光学触控板吃力地往上滚动寻找最后一条回复的开头，极度影响阅读体验。

## Decision

修改前端历史消息初次加载完成时的视口定位逻辑（`static/index.html`）：

1. 新增 `scrollToLastMessageStart()` 辅助函数：
   - 逆向遍历容器中的消息节点（`.msg-wrap`），精确定位最后一条 agent (assistant) 消息的正文气泡（`.msg-assistant`），跳过其上方的思考卡片（`.thought-card`）及工具调用胶囊（`.tool-pill`）；
   - 通过 `offsetParent` 向上累加精确计算该正文元素相对于容器 `chatContainer` 顶部的累计偏移量，预留 4px 呼吸间距对齐视口顶缘；
   - 调用 `setScrollTopProgrammatic(targetTop)` 定位，并置 `userScrolledUp = true` 建立阅读意图状态保护，防止随后连接建立或 `sync` 快照事件将视口强行拉至底部。
2. 改造 `renderWindowedMessages(preserveScroll, anchorLastMsgStart)`：
   - 增加第二个可选参数 `anchorLastMsgStart`；
   - 当 `preserveScroll` 为 false 且 `anchorLastMsgStart` 为 true 时，优先调用 `scrollToLastMessageStart()`；
   - 保持原有的 `userScrolledUp` 判定和 `scrollBottom()` 默认兜底逻辑。
3. 联动 `loadHistory(cwd, id, callback, silent)`：
   - 在非静默模式（初次点进历史会话）成功获取并填充消息后，调用 `renderWindowedMessages(silent ? userScrolledUp : false, !silent)`；
   - 确保仅在用户主动进入历史会话时锚定在最后一条消息开头，而在用户发送新消息（`doSend`）、追加新气泡（`appendMessage`）或流式吐字输出时仍旧保持既有的自动滚底与触控防冲突逻辑。

## Alternatives considered

1. **始终使用 DOM 原生 `scrollIntoView(true)`**：
   - 老旧 WebKit 537.35 内核中对带有 `overflow-y: scroll` 及绝对定位的父容器，直接使用 `scrollIntoView` 容易引发外层页面 window/document 的不可逆位移或黑莓全屏视口抖动；
   - 基于现有 `setScrollTopProgrammatic` 统筹状态标记与滚动量更安全、精准。
2. **定位到整个历史记录的第一条（顶部）**：
   - 用户打开历史会话大多是为了查看最近的对话进展或最新的回复结果，从第一条开始翻阅会导致长会话用户需要从头向下滑动，违背小屏即时阅读诉求。
3. **保持滚到底部，依靠快捷键 `T`/`B` 或触控板手动翻页**：
   - 强迫用户每次打开历史会话都多按键或大幅度划动，体验割裂。

## Consequences

- 用户打开历史会话后，直接从助手最后一条回复的第一句话开始阅读，视口利用率显著提高。
- 与现有的 `touch-gesture-scroll-bottom-fight` 防抖动状态机协同一致，用户若需滚回底部只需按快捷键 `B` 或向下滑动即可自然解除阅读状态锁定。

> **2026-09-19 部分取代（锚定目标升级为轮次起点）**：随轮级过程折叠与
> 窗口自动补齐落地
> （`.agents/notes/implemented/feature/2026-09-19-turn-level-process-fold-aggregate-counts.md`），
> `scrollToLastMessageStart` 的锚定目标由「最后一条 assistant 正文气泡」改为
> 「最后一条用户消息」（即最近一轮的起始），使进入会话即自上而下呈现
> 「用户消息 → 折叠行 → 最终回答」；「从最后一条回复开头阅读」的原始收益
> （不落底部空白、保留阅读意图锁定）全部保留，仅把阅读起点上移到本轮提问。
