# Agent Note: 面板底部快捷键底栏遮挡列表最低项

Status: implemented
Related: .agents/notes/implemented/feature/2026-10-04-panel-state-loading-empty-hintbar.md（引入底栏与面板 padding-bottom: 52px 预留，本条修正其旧 WebKit 下失效的载体）

## Problem

各全屏树面板（模型 M / 工作区 / 会话 / 权限 / 子智能体 / 状态 / 快捷消息）底部常驻 `.tree-hint` 快捷键条（z-index:130，绝对锚定底部）。滚动列表时，最低一项被该底栏遮挡，J/K 键盘选中项经 `scrollIntoView(false)` 也会贴在面板底边被遮挡。此前在滚动容器 `.tree-panel` 自身上加了 `padding-bottom: 52px`，但旧 WebKit（BB10 WebKit 537.35）不把滚动容器的 bottom padding 计入可滚动区，底部避让失效。

## Decision

- 把避让空间从滚动容器移到内层内容容器：`#ws-tree, #sess-tree, #subagent-tree, #model-tree, #perm-tree, #status-body, #quick-msg-tree { padding-bottom: 52px; }`，滚动区真实延伸 52px，最低项可滚出底栏之上；
- `markKbSel` / `markQuestionKbSel` / `markQuickMsgKbSel` 三处 `scrollIntoView` 之后补偿：向上找到可滚动祖先，若选中项底边侵入底部 30px 警戒区则 `scrollTop += overlap`，消除 J/K 选中项被底栏遮挡；
- 全程 ES5，无现代 API。

## Alternatives considered

- *仅保留面板自身 padding-bottom*（旧方案）：Rejected。旧 WebKit 不计入滚动区，实测仍被遮挡。
- *增高底栏预留或改 hint 为流式布局*：Rejected。会压缩面板视口高度，违背方屏空间铁律；绝对锚定底栏是已定版式。
- *JS 统一滚动后 setTimeout 追加滚动*：Rejected。魔法延时在旧 WebKit 上时序不可靠，采用同步几何补偿。

## Consequences

- 各面板滚到底部时最后一项下方恒有 52px 空白，底栏不再遮挡；
- J/K / 触控板选中项自动避开底栏；
- 门禁：ES5 Acorn 解析 PASS（靠机器）；真机滚动避让视觉回归靠 review。
