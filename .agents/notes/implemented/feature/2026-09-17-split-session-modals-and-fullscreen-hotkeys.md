# Agent Note: Split Session Modals and Adopt Fullscreen Keyboard Hotkeys

Status: implemented

## Problem
在 BlackBerry Q20 3.1 英寸（720×720 方屏）硬件设备上，原有的会话树抽屉将所有 Workspace 与其下的会话混合堆叠在同一个下拉面板内，层级过深且列表过长，上下滚动翻页负担极大。同时屏幕右上角常驻汉堡包悬浮按钮（☰）占用了宝贵的视口空间并易引发误触。快捷键设计上原有的 S 和 M 均用于展开混合会话树，C 键用于对话配置（模型与权限），缺乏独立的工作区切换入口与当前工作区直达会话列表，且弹窗非全屏模式限制了有效可视列表项。

## Decision
治理客户端交互体系（`static/index.html`）：
1. 移除屏幕右上角汉堡包悬浮按钮（`#menu-btn`）。
2. 将弹窗彻底拆分为纯快捷键触发、100% 全屏展示（`position: absolute; top: 0; bottom: 0; left: 0; right: 0; max-height: none`）：
   - `W` 快捷键：全屏弹出 Workspace 列表（`#ws-overlay`），仅列出所有工作区及其会话数量，回车或点击直接切换工作区并更新界面。
   - `S` 快捷键：全屏弹出当前所在 Workspace 的会话选择弹窗（`#sess-overlay`），直接展示当前工作区的会话列表与新建、归档功能（注：后续已在 [2026-09-17-change-session-hotkey-to-c.md](2026-09-17-change-session-hotkey-to-c.md) 中因浏览器按键冲突改用 `C` 键）。
   - `M` 快捷键：全屏弹出模型选择弹窗（`#model-overlay`），按照 Provider 进行树形分组展开/折叠显示各模型项，回车或点击选择模型。
   - `P` 快捷键：全屏弹出权限选择弹窗（`#perm-overlay`），展示可用权限选项，回车或点击选择权限。
   - 移除旧快捷键 `C`（不再使用），原 `S` 与 `M` 快捷键仅保留 `S` 用于会话，`M` 专用于模型弹窗。
3. 更新帮助弹窗（`?` / `H`）中的快捷键速查表及 README 文档，明确 `W`、`S`、`M`、`P` 语义。
4. 严格遵守 ES5 规范与 BB10 WebKit 约束，所有节点与事件均支持物理触控板上下选择与回车确认。

## Alternatives considered
1. **保留混合抽屉并引入分页折叠**：依然保留单个混合抽屉，但折叠工作区。缺点是在方屏 720×720 下仍然需要多层展开/收起切换，操作繁琐且认知负荷高。
2. **保留右上角汉堡包按钮作为快捷菜单**：点击后弹出二级操作。缺点是占用右上角视觉空间，且触控较慢，不符合黑莓全键盘“Keyboard First”的设计哲学。

## Consequences
- 视口更加干净，消除右上角悬浮按钮的遮挡与点击负担。
- 按键操作直观明确：`W` (Workspace)、`S` (Session)、`M` (Model/Permission)。
- 全屏弹窗大大增加了单屏可视条目，减少滚动翻页频率，显著提升黑莓 Q20 物理按键与触控板导航效率。
