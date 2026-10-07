# 修复：连续对话中用户发出消息瞬间状态栏误显示"会话已完成"

Status: implemented

- 日期：2026-09-29
- 影响面：`static/index.html`（`doSend` 发送前置置位、`resolveEffectiveSessionState` 本地在途判定）
- 类型：bug-fix

## 背景与现象

在已有历史消息的会话中，用户输入内容并点击发送（或按 Enter）的瞬间，下方状态栏立刻出现 `✓会话已完成 (x条)`，约数百毫秒后才转换为 `●深度求索中…`。

## 根因

1. **时序倒置**：`doSend()` 中先调用了 `appendMessage('user', ...)` 和 `appendMessage('assistant', ...)` 回显用户与占位气泡。`appendMessage` 末尾会同步触发 `renderSessionStatusTail()`；而正式将状态置为 `running`（`syncSessionPhase`）的代码原先排在两次 `appendMessage` 之后。
2. **快照裁定覆盖**：在已有会话中，`resolveEffectiveSessionState()` 查阅 `sessCache` 时命中上一轮该会话的旧快照（`state: "done"`, `isRunning: false`），直接裁定为 `done`。

## 修复

1. **时序前置**：在 `doSend()` 参数校验通过后、执行 `appendMessage` 之前，立即将 `isStreaming = true` 并同步调用 `syncSessionPhase(currentSessionId, 'running', ...)`。
2. **在途流保护**：在 `resolveEffectiveSessionState()` 本地在途分支中，将判断条件扩展为 `(activeXhr !== null || isStreaming)` 并前置锁定 `running`，优先级高于服务端旧快照，防止被上一轮的 `done` 状态反向篡改。

## 门禁与验证

- ES5 Acorn 语法门禁：`PASS`
- 解耦契约门禁：`test-decoupling.mjs` PASS
- 全链路回归门禁：`test-suite.mjs` 7/7 PASS
- 单元测试门禁：`test-unit.mjs` 30/30 PASS
- 时序模拟检测：点击发送瞬间状态为 `running`，零 `done` 闪烁。

## Alternatives considered

1. **仅在 `appendMessage` 中抑制 `renderSessionStatusTail`**：会增加隐式参数传递（如 `suppressTail`），破坏单一渲染闭环与后续历史追加语义，放弃。
2. **时序前置 + 在途推流保护（本方案）**：符合状态机同构准则，以最小侵入确保状态推导始终正确。
