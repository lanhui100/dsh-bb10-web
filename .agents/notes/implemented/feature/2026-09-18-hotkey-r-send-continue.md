# Agent Note: 会话消息流非运行状态快捷键 R 发送继续

Status: implemented

## Problem

在 BlackBerry Q20 实体全键盘交互中，当会话完成一轮交互或处于非运行状态时，用户常需要让模型针对当前任务“继续”生成或执行后续步骤。此前主界面未打开面板时的快捷键 `R` 绑定为“重试上一轮 Prompt”，无法满足直接推进会话的诉求。同时，会话列表面板（`C` 打开）已使用 `R` 作为列表刷新快捷键（参见 [2026-09-18-refresh-via-r-shortcut-remove-buttons.md](../feature/2026-09-18-refresh-via-r-shortcut-remove-buttons.md)），若简单绑定可能引发上下文快捷键冲突。

## Decision

对 `static/index.html` 的物理快捷键 `R` 逻辑进行严格的上下文区分：

1. **会话面板与系统面板优先级最高**：
   - 会话面板打开（`isSessOpen`）：`R` 保持刷新会话列表（`loadBootstrap()`）；
   - 状态面板打开（`isStatusOpen`）：`R` 保持刷新会话状态（`loadSessionStats()`）；
   - 工作区面板打开（`isWsOpen`）：`R` 保持刷新工作区（`refreshWsList()`）。
2. **消息流主界面条件触发**：
   - 仅当处于无模态面板状态（`!isModelOpen && !isPermOpen && !isHelpOpen && !isComposerOpen`）且输入框无焦点时生效；
   - 检查会话状态机：当处于非运行中状态（`!sessState.running && !isStreaming`），直接将用户消息设置为`继续`并通过 `doSend()` 触发发送；
   - 若处于运行中状态（`sessState.running || isStreaming`），拦截并提示`会话运行中 [R]`，杜绝并发冲突；
3. **配套文案与速查更新**：
   - 更新快捷键速查表（`#help-overlay`）中 `R` 键的功能描述；
   - 更新 `README.md` 与 `README.zh.md` 相关描述；
   - 严格遵循 ES5 规范，通过 Acorn 语法校验与回归套件测试。

## Alternatives considered

1. **直接全局覆盖 `R` 键**：会导致在会话列表面板内按 `R` 时不再刷新列表而是向会话发送消息，破坏面板操作闭环，予以否决。
2. **无论运行中与否均直接发送**：若会话仍在流式输出或执行工具，并发调用 `doSend` 会导致请求混乱，必须通过 `sessState.running || isStreaming` 进行状态机保护。
3. **使用新按键（如字母 C 或 G）发送继续**：Q20 上 `C` 已为会话列表（Chat），且 `R` 键在主界面直觉符合 Resume/Run/Retry 的操作习惯，复用上下文隔离最契合小屏键盘操作。

## Consequences

- 用户在会话消息流中可在非运行态下一键按 `R` 发送“继续”，快速接续会话；
- 面板刷新与消息流操作互不冲突，键盘交互边界清晰；
- 保持 100% ES5 兼容性。
