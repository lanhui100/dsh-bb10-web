# Agent Note: 切换会话保留排队与插队消息分槽与视图恢复

Status: implemented

## Problem

在会话运行中发送追发消息（排队 `queue` 或插队 `steer`）时，消息停靠在底部的 `#queue-dock`。然而当用户切换至其他会话详情后再切回原会话时，底部排队条不再显示，快捷键 `Z` 撤回也提示无排队消息。

根因在于：
1. 客户端使用全局单槽变量 `pendingQueuedItem` 存储当前排队消息，未按 `sessionId` 做多会话隔离映射；
2. 切换会话时 `selectSession` / `startNewChat` / `selectWorkspace` 调用 `clearQueueDock()`，硬性置空了全局 `pendingQueuedItem`；
3. 历史会话加载完成与快照整体替换时无条件调用 `clearQueueDock()`，且切回原会话时无状态恢复分支。

## Decision

对齐提问分槽暂存（`questionDraftStore`）与 DSH Web `QueueDock` 的多会话投影语义：
1. **多会话排队状态分槽（`queuedPromptStore`）**：
   - 增加全局对象 `queuedPromptStore = {}`，以 `sessionId` 为键存储 `{ sid, prompt, itemId, mode }`；
   - 遵从 2GB 内存约束，按 LRU 维持上限 10 个槽位；
   - 撤回成功、发送失败、任务终态（`done` / `error` / `cancelled`）或排队转正时，清除该会话在 `queuedPromptStore` 中的记录。
2. **切会话视觉切换与恢复**：
   - 切换离开或新建会话时，只隐去 `#queue-dock` DOM 展示，不抹除该会话在 `queuedPromptStore` 中的槽位；
   - 切回会话时，同步检查 `queuedPromptStore[sid]`，若存在且会话仍处于运行中，恢复 `pendingQueuedItem` 并调用 `renderQueueDock()`；
   - 加载历史与快照替换时，仅当历史消息已包含最新排队内容或会话已结束时才清理，若会话仍在运行且有待执行排队则维持停靠展示。

## Alternatives considered

- 每次切回会话都向服务端发起 RPC 查询宿主 inbox：增加网络往返延迟，且在弱网或旧 WebKit 上造成界面闪烁；前端分槽缓存已足且能与已有的提问草稿机制保持同构。
- 换工作区时彻底清理所有排队槽：排队是会话生命周期属性，即使切工作区，只要会话后台在跑，排队记录也应随会话恢复。

## Consequences

- 运行中追发的排队/插队消息在切换会话再切回时 100% 保持底部停靠展示，快捷键 `Z` 能够正确撤回；
- 保持 ES5 纯语法兼容与老旧 WebKit 内存保护。
