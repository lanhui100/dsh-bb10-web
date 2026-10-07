# Agent Note: turn 级重试键归属用户气泡

Status: implemented

## Decision

- `createMessageActions` 中 `↻` 重试只在 `role === 'user'` 时渲染，用本泡 `textToCopy` 回填输入框重发；assistant 气泡只留复制 + 分支。
- 删除 `promptBefore` 查找（紧邻上一条 user）及历史/流式两处 assistant 传参；`promptToRetry` 形参保留占位不再使用。
- 重试保持 `action-btn action-btn-icon` 纯图标 ghost 样式，与复制/分支一致。
- 相关代码：`static/index.html` `createMessageActions`、`renderAssistantBlocks`、`renderWindowedMessages`。

## Alternatives considered

- 保持 assistant 泡重试、向前找最近 user 兜底：可用性与本次一致，但心智错位（在 agent 泡点"重试"却重发用户话），且 dsh 官方无 per-bubble 重试、只有 turn 级重发；否决。
- assistant 泡保留两种重试（紧邻 user + 兜底）：同一 turn 出现多个 `↻`，语义重复，720 方屏拥挤；否决。
- 删 `promptToRetry` 形参：需同步改 8 处调用签名，改动面大且误差无收益，保留占位；采纳保留。

## Consequences

- 有/无规则变简单：每条用户泡必有 `↻`（排队中与 error 卡除外），assistant 泡永无。
- `R` 快捷键语义不变（主界面重发上一轮）。
