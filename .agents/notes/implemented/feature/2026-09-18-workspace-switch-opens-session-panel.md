# Agent Note: 切换工作区后自动打开会话面板

Status: implemented

## Problem

`static/index.html` 的 `selectWorkspace(cwd)` 在用户通过 W 面板点击/回车切换工作区后，只清空 `chatContainer` 并追加一条"已切换工作区"气泡就收起面板，用户面对的是无会话的空白（近黑）聊天屏：当前工作区为空时尤其像"黑屏死机"，必须再按一次 `C` 键才能打开会话列表选择进入，多一步操作且状态不连续。

## Decision

`static/index.html`（ES5）：

1. `selectWorkspace(cwd)` 末尾由 `renderWsTree(); loadSessions(cwd);` 改为直接调用 `openSess()`——`openSess` 内部已负责 `closeWs()`、`renderSessTree()` 与对当前 `cwd` 的 `loadSessions()`（`sessLoading` 去重），单入口覆盖三条触发路径（树节点点击 `renderWsTree`、键盘回车 `activateWsNode`、隐藏 select `onchange`）；
2. 保留切换时追加的"已切换工作区"气泡：用户从自动弹出的会话面板按 ✕ 关闭时，聊天屏仍有上下文可看；随后无论选择历史会话（`loadHistory` 重置 `allMessages`）还是"+ 新建"（`selectSession('')` 清空），该气泡都不会污染会话内容；
3. W 面板底部提示与帮助弹窗（`?`/`H`）`W` 行文案同步改为"切换并进入会话列表"；`README.md` / `README.zh.md` 同提交更新 `W` 键说明。

与 [2026-09-17-split-session-modals-and-fullscreen-hotkeys.md](2026-09-17-split-session-modals-and-fullscreen-hotkeys.md) 的 W/C 分离决策兼容：`C` 键仍可随时手动开关会话面板，本条只补齐"切换工作区后"的自动接续。

## Alternatives considered

- **在三个调用点分别补 `openSess()`**：三处重复且未来新增触发路径（如 `wsSelect.onchange`）容易漏改；收敛到 `selectWorkspace` 单一入口，状态闭环由一个函数保证。
- **切换后自动选中该工作区最近会话并直接进入**：省一步但违背"由用户选择进入"的预期，且自动 attach 历史会话会在方屏上产生一次不可预期的长列表渲染（弱 CPU 负担）；弹面板让用户显式选择更稳。
- **去掉"已切换工作区"气泡只留状态行**：状态行小字易被忽略，关掉面板后聊天屏将真正黑屏；保留气泡是零成本的上下文兜底，且不会被后续会话加载继承。

## Consequences

- 切换工作区 → 会话面板直达，键序 `W → ↑/↓(J/K) → Enter` 即可进入目标工作区会话；空白工作区也不再出现黑屏停留。
- `selectWorkspace` 不再显式调用 `renderWsTree()`（`openWs` 打开时会自行重渲染，`renderBootstrap` 亦覆盖打开态），减少一次弱 CPU 下的无效 DOM 重建。
