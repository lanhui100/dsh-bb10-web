# Agent Note: Q20 交互规范指令改后缀拼接

Status: implemented

## Problem

首轮 prompt 将 `[重要交互规范：…]` 前缀拼在用户消息之前，导致宿主侧按消息头部生成的会话摘要被指令污染（显示指令而非用户内容），会话列表无法区分会话。

## Decision

- `server.mjs` 中 `Q20_SYSTEM_DIRECTIVE` 改为后缀形式：`${prompt}${Q20_SYSTEM_DIRECTIVE}`（以 `\n\n` 分隔），用户原文保持在头部，摘要恢复正常。
- `cleanUserPrompt()` 同步支持剥离尾部指令（保留对旧前缀数据的兼容），三处回显/标题提取（Zstd 历史标题、history、会话概览）不受影响。
- 仅首轮（无 `sessionId` 时）拼接，多轮续写不重复注入，语义不变。

## Alternatives considered

- 前缀保留 + 宿主侧改摘要逻辑：宿主为上游，不可改；否决。
- 去掉指令注入：Q20 小屏精炼输出约束丢失；否决。
- 用 `system` role 或独立字段下发：当前 `session/prompt` 仅走 `content: [{type:'text'}]` 单文本通道，无独立 system 位；改契约成本高；否决。

## Consequences

- 新会话首条 `user/message` 尾部带指令块，前端回显依赖 `cleanUserPrompt()` 剥离；旧前缀数据仍兼容。
- 验证：`node --check server.mjs` 通过；前后缀剥离手工用例通过。
