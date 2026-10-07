# Agent Note: 对齐快捷键 X 与停止按钮的权威运行状态推导（resolveEffectiveSessionState）

Status: implemented

## Problem

在 BlackBerry Q20 客户端中，会话在后台运行中时（如通过挂接、后台轮询或切会话进入），用户在主界面按下快捷键 `X`，状态栏却提示“当前无运行中的会话 [X]”，未能直接终止会话；只有按 `I` 展开输入对话框后点击右上角红色的停止按钮，才能成功终止会话。

经代码排查，根本原因在于停止入口的状态判定逻辑存在双轨失配：
1. **停止判据脱节**：`sendBtn.onclick` 遵循 [2026-09-18-fix-completed-session-running-state-residue.md](2026-09-18-fix-completed-session-running-state-residue.md)，使用单一权威推导 `var effClick = resolveEffectiveSessionState(); if (effClick.isRunning) stopStreaming();`；而快捷键 `X`（`code === 88`）与 Esc 键链（`code === 27`）仍旧直接判断局部变量 `if (sessState.running)`；
2. **状态机单向自愈漏洞**：`resolveEffectiveSessionState()` 在查验到服务端快照 `serverObj && !serverObj.isRunning` 时会自愈执行 `sessState.running = false`；但在查验到 `serverObj && serverObj.isRunning` 时，仅直接返回了 `{ isRunning: true, phase: 'running' }`，未同步将 `sessState.running` 正向自愈置为 `true`，导致 `sendBtn` 虽然通过 `renderSendButton()` 被正确渲染为红色停止图标，但局部 `sessState.running` 仍保持 `false`；
3. **取消后竞态保护**：`stopStreaming()` 执行后未同步更新当前 `sessCache` 缓存中的 `isRunning` 标志，在服务端取消 RPC 往返期间可能被未刷新的缓存短暂扰动。

## Decision

严格遵守 ES5 规范与宪法状态机同构原则，进行以下闭环修复：

1. **统一停止判据至 `resolveEffectiveSessionState()`**：
   - 全局快捷键 `X`（`code === 88`）分支将 `if (sessState.running)` 替换为 `var effX = resolveEffectiveSessionState(); if (effX.isRunning) stopStreaming();`，与 `sendBtn.onclick` 100% 同口径；
   - 对齐修复两处 Esc 键停止分支（`inputBox.onkeydown` 与 `document.onkeydown`），同样采用 `resolveEffectiveSessionState().isRunning`；
2. **`resolveEffectiveSessionState()` 补充正向自愈**：
   - 在服务端快照裁定正在运行中（`serverObj && serverObj.isRunning`）时，补充执行 `sessState.running = true; sessState.phase = 'running';`，彻底消除单向不同步；
   - 增加主动停止会话的 15 秒防重入时间窗口保护（`userStoppedSessions[sid]`），避免在取消 RPC 飞渡期间因服务端旧快照误判运行；
3. **`stopStreaming()` 立即更新 `sessCache`**：
   - 主动终止流时，同步将 `sessCache[cwd]` 中当前会话的 `isRunning` 立即覆写为 `false`、`state` 设为 `'stopped'`，确保停止后全链路状态瞬时闭环；
4. **单测与门禁守卫**：
   - 在 `test-unit.mjs` 新增针对快捷键 X、Esc 键与 `sendBtn` 状态机一致性的断言合约；
   - 运行 Acorn ES5、回归测试套件 `test-suite.mjs` 与 ADR 验证脚本，确保 100% 绿灯。

## Alternatives considered

- **仅在快捷键 X 分支修改 `sessState.running = true` 强行调用 `stopStreaming()`**：治标不治本，未解决 Esc 键及其他未展开对话框时状态脱节的问题，破坏了单一状态源原则，否决。
- **在 `loadSessions` 轮询中强制每秒同步全部会话状态**：老旧 WebKit 与双核处理器下高频轮询会严重占用 CPU 导致掉帧甚至假死，否决；复用已有 `resolveEffectiveSessionState()` 瞬时查验零性能损耗。

## Consequences

- 运行中的会话无论是否展开输入框，在主界面任意时刻按下快捷键 `X` 均能 100% 立即终止生成，文案提示“已手动停止”，彻底消除“当前无运行中的会话 [X]”的误判；
- 发送按钮、快捷键 `X`、`Esc` 键逻辑 100% 归一到 `resolveEffectiveSessionState()`，状态闭环无死角；
- Acorn ES5 静态解析通过，`test-suite.mjs` 7/7 PASS，`test-unit.mjs` 全绿。
