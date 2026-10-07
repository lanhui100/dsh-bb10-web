# Agent Note: 快捷键 Z 撤回排队中的消息 (对齐 DSH updateQueue remove)

Status: implemented

## Problem

用户在会话运行中通过追发发送了排队消息后，消息以灰色气泡形式挂在底部等待执行。但在模型尚未开始生成这一轮之前，用户可能发现内容有误或改变主意，需要撤回排队消息并修改，目前没有撤回机制。在官方 DSH 中，支持通过 `session/updateQueue` 接口执行 `{ itemId, action: { kind: 'remove' } }` 移除队列中的待处理消息。

## Decision

1. **服务端接口**：
   - 新增 `POST /api/session/queue/remove` 接口，接收 `{ sessionId, itemId }`。
   - 调用官方 DSH RPC `session/updateQueue`（`action: { kind: 'remove' }`）实现队列项真正删除与退回。
   - 在 `activeTasks` 中记录最新追发成功后返回的 `itemId` / `requestId`，在调用撤回时自动匹配对应项。
2. **前端交互与快捷键**：
   - 在 `static/index.html` 中新增全局快捷键 `Z`（`code === 90`）。
   - 用户按 `Z` 时触发 `revokeQueuedPrompt()`，向后端请求撤回当前排队等待执行的消息。
   - 撤回成功后：
     - 从 DOM 及 `allMessages` 消息流中立即移除该灰色排队气泡；
     - 将原提示词内容自动放回输入框（恢复草稿），方便用户二次编辑；
     - 给出 Toast 与状态栏提示。
   - 同步更新帮助面板及中英文 `README.md` / `README.zh.md`。

## Alternatives considered

- **点击气泡上的小图标撤回**：黑莓 Q20 屏幕较小（720x720）且主要使用实体全键盘操作，触控操作精度受限；实体快捷键 `Z` 符合黑莓 Keyboard-First 原则，同时最便捷。
- **仅前端本地移除而不通知服务端**：会导致服务端队列残留，下一轮依然会被执行；必须严格走官方 `session/updateQueue` 通道同步移除。

## Consequences

- 快捷键 `Z` 实现了小方屏下的排队消息一键撤回与草稿恢复，与 DSH Web 语义高度对齐。
- 单测与 ES5 门禁验证通过。
