# Agent Note: 会话状态面板 Token 速度收敛为运行时平均速度

Status: implemented

## Problem

在 BlackBerry Q20 的会话状态面板（O 键展开）中，Token 速度此前在会话运行状态下优先显示瞬时估算的 `(实时吐字)` 速度。因流式 delta/usage 事件在弱网、长文本或历史回放场景下存在瞬时速率突变，导致速度跳动剧烈且对小屏常驻状态观察价值有限；用户明确要求状态面板中不显示实时吐字速度，仅展示会话运行时的平均速度。

## Decision

修改 `static/index.html` 的 `renderStatusPanel()` 逻辑：
1. 移除 `sessState.running && liveTps > 0` 优先展示实时吐字速度（`liveTps tok/s (实时吐字)`）的分支；
2. 状态面板的 Token 速度统一使用服务端通过已完成步骤统计得出的全局平均解码速度（`latestSessionStats.tokenSpeed tok/s`）；
3. 保持数据缺省时的兜底占位符 `—`，严格保持 ES5 语法规范与小屏紧凑排版。

## Alternatives considered

1. **同时保留实时速度与平均速度（如并排展示）**：黑莓 Q20 物理屏幕为 720×720 方屏，宽度仅 320~360 CSS 像素，并排多指标会导致表格单元格换行拥挤，且不符合用户“只要平均速度、不要实时”的直接需求。
2. **在客户端本地累计所有流式 delta 自行算平均值**：客户端内存与计算资源受限，且页面随时可能刷新或重新 attach，从服务端 `latestSessionStats.tokenSpeed` 获取统一权威口径更稳定且零客户端计算开销。

## Consequences

- 会话状态面板显示更平稳、简洁，消除了实时吐字波动造成的视觉干扰；
- 完全契合 Q20 方屏极简与高性能规范。
