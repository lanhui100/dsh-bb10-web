# Agent Note: 运行中会话模型真值同步

Status: implemented

## Problem

会话在同一轮生命周期内切换模型，或 Q20 页面挂接由其他 lane 运行的会话时，组合器徽标、`M` 模型面板与 `O` 状态面板可能继续显示旧的全局选择或旧 stats 快照。运行中的 stats 分支还未携带 task 的 provider/model，导致首轮转录尚未落盘时无法提供运行真值。

本条扩展并修正 [2026-09-26-o-panel-session-model-isolation.md](2026-09-26-o-panel-session-model-isolation.md) 的会话级模型记忆方案。

## Decision

- 服务端 `activeTasks` 明确保存请求解析出的 `provider` 与 `model`，无转录文件的运行中 stats 直接返回该 task 真值。
- 服务端 SSE `start` 帧携带有效的 provider/model；客户端收到后立即写入当前会话模型记忆。
- 客户端 stats 请求记录发起时间；若回包对应的是发送前的旧快照，不得覆盖发送后已经确认的会话模型。
- 组合器徽标、`M` 面板和 `O` 面板均通过当前会话模型解析器读取会话级模型；`modelSelect` 仅作为无会话/未知会话的下一条消息选择回退。
- stats 回包完成后立即重绘徽标与模型面板，终态完成后主动刷新当前会话 stats。

## Alternatives considered

- **只在 `openComposer` 时重新拉 stats**：无法覆盖异步回包晚于发送、后台挂接和 M 面板完全不读会话真值的路径，否决。
- **仅依赖 transcript 扫描**：首轮运行期间 transcript 可能尚未有完整模型记录，且无法为无文件的 active task 提供实时值，否决。
- **每次展示都直接使用全局 `modelSelect`**：会重新引入跨会话串台，且无法表达外部 lane 正在运行的模型，否决。

## Consequences

- 运行中的首轮会话也能从 active task 得到 provider/model；外部会话 attach 仍以 transcript stats 为真值。
- 发送后的旧 stats 回包不会把新模型改回旧值；新一轮 stats poll 会继续校正服务端真值。
- 模型选择仍是下一条消息的候选值；会话模型记忆负责当前会话展示与切换恢复。
- 门禁：ES5 静态解析、解耦契约、单元/服务端回归必须通过；真机行为需 review。
