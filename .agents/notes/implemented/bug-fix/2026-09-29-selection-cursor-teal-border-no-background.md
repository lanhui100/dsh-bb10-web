# Agent Note: 列表选中态语义归一——J/K 选择=Teal 边框无背景，当前项=绿色无边框背景

Status: implemented

## Problem

各面板/界面的列表（W 工作区树、C 会话树、M 模型/收藏树、G 快捷消息、提问选项、聊天消息 J/K 跳行）存在选中态语义错位：

1. **当前项（active）**：`active-sess` 用绿色填充 + 透明边框，但 `active-ws`/`active-item` 用绿色填充 + Teal 边框，三者对"当前"的呈现不一致；
2. **J/K 选择光标（kb-sel / msg-selected / 快捷消息 inline）**：使用蓝色 `#0078D7` 边框 + 蓝色填充 `#1A3A5C`（消息跳行另用 `#569CD6` 左栏 + 灰色填充），既有填充背景又用与"操作高亮"同源的蓝色，视觉上像另一个"被选中的当前项"，与绿色当前项混淆。

正确的语义应当是：**当前项 = 绿色填充、无边框；J/K 选择光标 = Teal 边框、无背景填充**——一个是"值状态"，一个是"游标位置"，靠填充 vs 描边区分，靠绿 vs Teal 区分色域。

## Decision

统一为"当前=绿色无边框填充、选择=Teal 描边"（`static/index.html`）：

1. `.tree-ws.active-ws`、`.tree-item.active-item`：`border-color` 由 `#00897B` 改为 `transparent`（与 `.tree-sess.active-sess` 一致）；`.tree-ws.active-ws:hover` 同步改透明边框，hover 不再给当前项画边；
2. `.tree-node.kb-sel`：删除蓝色填充 `#1A3A5C`，`border-color` 由 `#0078D7` 改为 Teal `#26A69A`（保留 `!important` 与白字，恒优先于 hover）；
3. `.q-option.kb-sel`：同上（删填充、改 Teal 边框）；`.q-option.q-selected.kb-sel`（光标落在已选答案上）：边框提亮为 `#26A69A`，保留绿色填充（该项同时是"当前值"）；
4. `.msg-wrap.msg-selected`（J/K 消息跳行）：左栏由 `#569CD6` 改 `#26A69A`，删除背景 `#181A1F`；
5. `markQuickMsgKbSel`（G 快捷消息，inline 样式）：选中行由绿色填充 `#0E3A36` + Teal 边框改为全框 `1px solid #26A69A`、无填充；未选中行恢复仅 `borderBottom: 1px solid #222222` 分隔线（与树面板"全框 Teal 描边"口径一致）。

全程纯静态 HEX、纯 ES5；`#26A69A` 为调色板既有亮 Teal（hover 强调色），无新增色值。

## Alternatives considered

- 选择光标沿用蓝色系但去填充：蓝色与绿色当前项仍属"两个填充色竞争"，且蓝是本项目操作高亮（按钮）语义，弃；
- 选择光标也保留填充（仅换色）：两条"填充块"并存，值状态与游标状态仍难区分，正是本次要消除的混淆，弃；
- 当前项改描边、选择改填充（对调）：与全站"当前=填充"的既有认知相反，改动面更大且收益不明，弃；
- 统一选择为 `#00897B`（主 Teal）：描边无填充时亮 Teal `#26A69A` 在 `#121212` 底上辨识度更高，且与当前项边框色域拉开，弃。

## Consequences

- 列表内"当前值"（绿色填充）与"J/K 游标"（Teal 描边）一眼可分，hover/触控路径不受影响；
- 与既有决策 `implemented/bug-fix/2026-09-26-ws-panel-mouse-hover-and-render-skip.md` 的 kb-sel/hover 优先级契约（`!important` 恒优先）保持不变；
- 真机 BB10 WebKit 行为不变；`test-decoupling.mjs` + `test-suite.mjs` 全量 PASS、ES5 acorn 门禁 PASS；无 README 交互契约联动（键位/行为未改）。
