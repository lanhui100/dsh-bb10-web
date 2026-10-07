# Agent Note: 归档当前会话后自动开启新对话

Status: implemented

## Problem

在 BlackBerry Q20 客户端中，用户点击“📦 归档当前会话”或按下物理快捷键 `A` 归档当前会话后，虽然界面清空了会话内容并提示“会话已成功归档并移出会话列表”，但并没有自动进入新建对话流程（未调用 `startNewChat()`，没有激活输入框 Composer，状态停留在“会话归档完成”）。

这导致用户在归档后若想继续与 AI 交流，必须额外按 `N` 键或通过弹窗点击“+ 新建”才能唤起输入框，增加了物理键盘/方屏设备上的操作链路与心智负担。

## Decision

修改 `static/index.html` 中的 `doArchiveCurrentSession` 逻辑：在 `/api/session/archive` 请求成功回调中，直接调用 `startNewChat()`：
1. 立即停止当前流式附着并清空活跃 session 状态；
2. 自动唤起输入框 Composer 并聚焦输入框，呈现“新对话已就绪，请输入”；
3. 更新状态提示为“会话已归档，已开启新对话”；
4. 关闭可能打开的会话弹窗，并在后台静默刷新工作区会话列表缓存。

该修改符合 ES5 约束并与已有 `startNewChat` 行为完全一致。

## Alternatives considered

- **仅重置状态但不展开输入框**：保持输入框关闭状态，让用户手动点 `I` 或 `/`。但用户归档旧会话的意图通常是“结束上一个任务并立刻开启下一个任务”，自动开启新对话并展开 Composer 减少了二次按键摩擦。
- **由后端接口直接返回新会话 ID**：在 `/api/session/archive` 返回时隐式生成新会话。但这破坏了 DSH 的会话生命周期设计（首条消息发送时才惰性创建 session），并且增加了后端负担。客户端 `startNewChat()` 统一处理更轻量一致。
