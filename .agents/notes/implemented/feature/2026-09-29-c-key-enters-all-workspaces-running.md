# Agent Note: C 键直进“全工作区进行中”会话列表并修自动打开关闭陷阱

Status: implemented

## Problem

从 W 面板点击工作区后，`selectWorkspace` 会自动打开会话面板（[2026-09-18-workspace-switch-opens-session-panel.md](../../feature/2026-09-18-workspace-switch-opens-session-panel.md)）。此时按 `C` 触发的是既有开关语义的“关闭”分支，面板收起后用户落入只剩一条“已切换工作区: xxx”气泡的粗糙页面；而用户预期的 `C` 键行为是进入会话列表——多工作区并行任务时，核心诉求是“一眼看到所有进行中的会话”（即 [2026-09-20-sess-panel-view-cycle-and-archive-selected.md](../../feature/2026-09-20-sess-panel-view-cycle-and-archive-selected.md) 中由 `V` 轮换才能到达的 mode 1“全工作区进行中”）。已用 Playwright（720×720）实测复现：点击工作区 → `sess-overlay` block、气泡“已切换工作区: job_copilot”垫底；按 `C` → `sess-overlay` none，只剩气泡页。

## Decision

`static/index.html`（ES5，零新依赖）：

1. **`C` 键直进“全工作区进行中”**：`code === 67` 打开分支由 `openSess()` 改为 `openSess(false, 1)`（mode 1 = 全工作区进行中，即“所有进行中的会话列表”），并提示“全工作区进行中 [V 轮换]”。`openSess(skipLoad, viewMode)` 增可选 `viewMode` 参数：不传仍归零 mode 0（当前工作区全部），保证点击工作区自动打开、归档后重开面板（`openSess(true)`）等既有路径展示“该工作区全部会话”的心智不变。
2. **修自动打开关闭陷阱**：新增 `sessOpenedViaC` 标记（`openSess` 一律复位 false；`C` 键两个分支置 true）。面板已打开时按 `C`：`sessOpenedViaC` 为 true（用户按 C 打开的）→ 收起（保留“再按 C 关闭”的开关肌肉记忆，与 [2026-09-20](../../feature/2026-09-20-sess-panel-view-cycle-and-archive-selected.md) 否决 C 复用轮换的理由一致）；为 false（点击工作区等自动打开）→ 不再关闭，重进“全工作区进行中”视图（`sessViewMode=1` + `renderSessTree()`，缺失缓存由 `renderSessAggregated` 走既有 `preloadMissingWorkspaceSessions()` 补齐）。
3. **同提交同步文档**：帮助表 `C` 行、会话面板 `tree-hint`、`README.md` / `README.zh.md` 快捷键说明更新；`test-unit.mjs` 新增机械契约检查（`sessOpenedViaC` / `openSess(false, 1)` / viewMode 参数化）。

## Alternatives considered

- **仅修陷阱、C 保持 mode 0**：能杜绝粗糙页，但用户明确期望“C = 所有进行中的会话列表”，只修陷阱仍须 `V` 才能看到进行中聚合视图，未满足诉求；且用户已在提问中选定了“C 直进全工作区进行中”。否决。
- **C 恒为“重进列表”永不关闭**：会消灭黑莓无 Esc 物理键下唯一的面板键盘关闭路径（`C` 开关），破坏 [2026-09-17-change-session-hotkey-to-c.md](../../feature/2026-09-17-change-session-hotkey-to-c.md) 起的开关肌肉记忆，触控 ✕ 成为唯一键盘外关闭手段。否决，保留“用户按 C 打开 → 再按 C 收起”。
- **C 直进 mode 1 且点击工作区自动打开也改 mode 1**：点击工作区的自动打开将展示全工作区进行中而非该工作区会话，破坏 [2026-09-18-workspace-switch-opens-session-panel.md](../../feature/2026-09-18-workspace-switch-opens-session-panel.md) “切换后自动打开会话列表供选择进入”的接续心智。否决，自动打开保持 mode 0。
- **移除“已切换工作区”气泡**：气泡在面板自动打开时被覆盖、仅在面板关闭后暴露，本身非陷阱根因；移除会回归 [2026-09-18-workspace-switch-opens-session-panel.md] 记录的“黑屏死机”观感问题。否决。

## Consequences

- 键盘路径收敛：`C` → 全工作区进行中（直接巡检所有在跑会话）→ `J/K` + `Enter` 进入；`V` 轮换回当前工作区全部 / 待处理 / 未分组。
- 自动打开的面板按 `C` 由“关闭”变为“重进进行中列表”，点击工作区后的 C 键不再落入粗糙气泡页。
- 门禁：ES5 Acorn 解析 + `node test-decoupling.mjs && node test-unit.mjs` 全量通过。

## 后续修订（同日，bubble 清除）

- **删除“已切换工作区: xxx”过渡气泡**（`selectWorkspace` 原 `appendMessage('assistant', '已切换工作区: ' + wname)`）：切换工作区后会话面板立即自动打开，气泡只会在此后按 `C` 关闭面板时被暴露成无意义的粗糙页。现改为清除消息流后调用 `hideWelcomeError()` + `updateWelcomePlaceholder()`（与 `startNewChat` 同源），关闭面板后展示设计内的欢迎空态（探索未至之境）；`wname` 局部计算一并删除。
- 前端 `static/index.html` 不再包含“已切换工作区”字符串，`test-unit` 2a4 契约新增机械断言（字符串缺失 + `appendMessage` 调用缺失）。
- 测试基建配套：`package.json` 增 `devDependencies.playwright-core` 并固定为 `1.61.1`（精确版本）——本机 `~/.cache/ms-playwright` 仅有 chromium-1228 及以下缓存，`^1.63.0` 需 chromium-1243 会导致 `test-preview-browser.mjs` 在 `chromium.launch` 处崩溃而非 SKIP；对齐 1.61.1 后 `node test-preview-browser.mjs` 无需 `Q20_PLAYWRIGHT` 环境变量即机械可执行（29/29 PASS）。
- 备选（否决）：保留气泡并美化（气泡在自动打开面板场景下永远不可见，纯死代码）；改为纯黑空白页（回归 [2026-09-18-workspace-switch-opens-session-panel.md](../../feature/2026-09-18-workspace-switch-opens-session-panel.md) 记录的“黑屏死机”观感问题）。
