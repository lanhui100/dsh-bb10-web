# Agent Note: tree-modals-initial-selection-and-cursor

Status: implemented

## Problem

在 BlackBerry Q20 客户端中，会话（C）、工作区（W）、多智能体（U）、模型（M）、权限（P）等全屏/树状面板支持使用物理键盘的 J/K 键或光学触摸板上下移动选择，并按 Enter 确认。然而，在现有实现中：
1. 打开上述面板时，键盘光标索引（`kbXxxIdx`）均初始化为 `-1`，面板内没有任何项获得 `.kb-sel` 键盘焦点高亮；
2. 当用户在当前会话中按 C 键打开会话面板时，虽然当前会话带有 `active-sess` 样式，但由于 `kbSessIdx === -1`，视图不仅不会自动滚动定位至当前会话，且用户初次按 J（Down）或 K（Up）时，光标会脱靶强制从列表第 0 项或末尾开始跳动；
3. 同理，按 W 打开工作区、按 M 打开模型、按 P 打开权限、按 U 打开多智能体时，均未能以当前激活项作为导航起点，严重违背物理全键盘用户的操作心智。

## Decision

在所有支持 J/K 导航的列表树面板（工作区、会话、多智能体、模型、权限）中，补齐打开时的初始选中与焦点对齐逻辑：
1. **工作区面板 (`renderWsTree`)**：渲染时自动检测 `ws.cwd === activeCwd`，若未指定光标位置则将 `kbWsIdx` 对齐至该工作区下标（无匹配则为 0），并调用 `markKbSel` 高亮并 `scrollIntoView`。
2. **会话面板 (`renderSessTree`)**：渲染时自动检测 `s.id === currentSessionId`，对齐至当前会话；在异步加载 `loadSessions` 回包重新渲染时，若用户尚未移动光标亦能准确对齐至当前会话，J/K 始终以当前会话为基准上下移动。
3. **多智能体看板 (`renderSubagentTree`)**：渲染时优先匹配当前会话对应的子智能体，否则默认定位至首项，并高亮滚动到可视区。
4. **模型面板 (`renderModelTree`)**：在常用分组及 provider 分组的模型节点列表中匹配 `idx === modelSelect.selectedIndex`，直接选中当前模型；若折叠则定位至所在分组，按 J/K 顺滑移动。
5. **权限面板 (`renderPermTree`)**：自动对齐至 `permSelect.selectedIndex` 对应的权限项。

## Alternatives considered

1. **每次打开始终默认聚焦到第 0 项**：实现简单，但在几十个会话或长模型列表中，用户必须从头滚动寻找当前项，无法获知当前上下文，操作断层感强。
2. **仅在按 J/K 时动态寻找当前项作为起点，打开时不渲染光标高亮**：打开面板时画面无光标指示，用户无法直观确认当前项位置，直接按 Enter 亦无法即时响应当前项。统一在 render 时定位高亮并滚动到视口是最符合键盘首选交互的方案。
