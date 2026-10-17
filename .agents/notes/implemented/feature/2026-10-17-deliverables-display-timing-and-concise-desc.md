# Agent Note: 优化交付文件列表展示时机与精简描述

Status: implemented

## Problem

在用户与 Agent 对话交互过程中，交付文件（deliverables）列表存在以下体验问题：
1. **进行中闪烁占地**：会话进行中（实时 streaming 吐字或 tool 调用过程中），前端每收到 `present` 工具调用便立刻动态渲染 `.deliverables-wrap` 卡片，破坏了沉浸式阅读与专注感，且会话未完成时的产物可能仍处于生成或变动中；
2. **次行弱化信息无意义**：交付文件卡片第二行展示了类似"编辑修改"、"写入文件"等弱化标签或纯冗余的短文案（如 `description === '编辑修改'` 或与文件名重复的信息），在黑莓 Q20 720×720 方屏宝贵的垂直视口下浪费纵向空间且无实际信息增益。

治理契约与前序决策：
- 关联 [.agents/notes/implemented/feature/2026-09-23-message-file-fullscreen-preview.md](.agents/notes/implemented/feature/2026-09-23-message-file-fullscreen-preview.md) 中的交付物聚合与全屏预览规范。

## Decision

1. **时机收口（会话结束时展示）**：
   - 彻底移除 `static/index.html` 流式交互期间对交付文件列表的实时 DOM 渲染逻辑（`liveDeliverables` 与 `attachDeliverables` 中途向 `chatContainer` / `assistantWrap` 挂载 DOM 的逻辑）；
   - 仅在会话终态或会话历史重放时（`done` 终态刷新、`loadHistory` 同步渲染历史消息）呈现交付文件卡片列表；
2. **精简次行弱化文案**：
   - 在 `server.mjs` 中移除 write/edit 自动生成的"写入文件" / "编辑修改"无意义 description，保持为空；
   - 在前端 `static/index.html` 的 `createDeliverablesElement` 中，如果没有实际意义的模型自定义描述文案，或描述内容与文件名一致 / 为空 / 命中"编辑修改"/"写入文件"等套话，则不再输出 `<div class="deliverable-desc">`，卡片高度收敛至单行紧凑模式，并保持预览与点击交互能力。

## Alternatives considered

- **进行中只显示折叠行，点击再展开**：仍会在用户阅读时制造动态 DOM 插入跳动，增加老旧 WebKit 重绘压力；会话未结束前交付文件并不是终态交付，直接延后至终态才是最清晰的心智模型。
- **保留第二行但显示文件大小或行数**：当前客户端与服务端通信未为每个交付文件增加 stat RPC 往返，增加额外网络与性能开销，且在小屏上单行文件名已足够直观。

## Consequences

- 会话进行中聊天界面保持纯粹干净，老旧双核 CPU 避免中间多次 DOM 树插入与高度重排；
- 交付文件列表仅在会话完成（`done` 或历史回溯）时出现在回答末尾；
- 交付文件卡片去除无意义弱化文案，节省 Q20 方屏纵向空间。
