# Agent Note: 移除面板刷新按钮，改为 R 键刷新

Status: implemented

## Problem

在 BlackBerry Q20 720×720 方屏上，会话列表（`#sess-overlay`）与会话状态面板（`#status-overlay`）各有一个触控刷新按钮：

- 会话列表底部工具栏的 `↻ 刷新`（`#refresh-btn`，Docked Footer 内，见
  [2026-09-18-dock-session-modal-footer-and-remove-archive-button.md](../feature/2026-09-18-dock-session-modal-footer-and-remove-archive-button.md)）；
- 会话状态面板的 `↻ 刷新数据`（`#status-refresh-btn`，见
  [2026-09-18-session-status-overview-panel.md](../feature/2026-09-18-session-status-overview-panel.md)）。

痛点：黑莓实体全键盘是第一输入公民，用户浏览列表时拇指常驻键盘；为一次刷新
必须抬手点按触控屏上的小按钮（同时占用宝贵的 44px 底栏 / 面板行高），违背
"物理键盘第一公民"的空间利用原则。工作区面板（`#ws-overlay`）虽无刷新按钮，
但会话状态一致性同样依赖数据重拉，应获得等价的键盘刷新入口。

## Decision

`static/index.html`：**移除两个刷新按钮及其全部 JS 绑定，刷新统一收敛为快捷键 `R`**，
按当前打开的面板做上下文分发（无输入焦点时，`document.onkeydown` 内拦截）：

- **会话列表面板（C）**：`R` → `loadBootstrap()`（与移除的 `↻ 刷新` 按钮行为完全
  一致：重拉工作区/模型/权限/会话列表并重建各树）；
- **会话状态面板（O）**：`R` → `loadSessionStats()`（即原 `↻ 刷新数据` 的调用）；
- **工作区面板（W）**：`R` → 新增轻量 `refreshWsList()`，仅重拉 `/api/bootstrap`
  更新工作区列表与会话计数、保留当前选中工作区、错峰预热会话列表，**不清空当前
  会话上下文**（区别于会话面板的全量 `loadBootstrap`）；
- **无面板打开（主界面）**：保留原语义——重试上一轮 Prompt（README 既有承诺，
  不因本次改造静默删除）。

配套改动：

1. 删除 `#refresh-btn`、`#status-refresh-btn` DOM 节点及 `refreshBtn` /
   `statusRefreshBtn` 变量、`onclick` 绑定；`loadSessionStats` 去掉 `isManual`
   参数与按钮 loading 态切换（按钮已不存在，参数成死代码）；
2. 更新三个面板的 `tree-hint` 提示行与 Help 速查表 `R` 行文案；
3. 同步更新 `README.md` / `README.zh.md` 快捷键清单与错误重试条目；
4. 全部客户端代码保持 ES5（Acorn `ecmaVersion: 5` 静态门禁通过）。

## Alternatives considered

1. **仅删按钮、不绑快捷键**：用户失去列表刷新途径，会话状态残留绿点无法消除，
   不可接受。
2. **`R` 全局改为纯刷新、移除重试语义**：主界面"重试上一轮"是 README 明文承诺的
   既有功能，用户本次只要求面板刷新改快捷键；静默删除重试会破坏既有交互闭环。
   故采用上下文分发：面板内 `R`=刷新，主界面 `R`=重试。
3. **工作区面板复用 `loadBootstrap()` 作为 `R` 刷新**：`loadBootstrap` 的
   `renderBootstrap` 会无条件重置 `currentSessionId` 并切回欢迎页（页面进入语义），
   用户在会话进行中按 `R` 会被踢出当前会话上下文，破坏性过强；故为工作区单独
   实现 `refreshWsList()`，只刷新列表、保留选择与上下文。
4. **保留 `isManual` 参数**：按钮移除后无任何调用方传 `true`，参数成为死代码；
   直接删除参数并收敛三个调用点为 `loadSessionStats()`，减少维护面。

## Consequences

- 会话/工作区/状态面板的刷新入口从触控按钮迁移到实体键盘 `R`，符合 Q20
  键盘第一公民定位；44px 会话底栏仅剩 `+ 新建` 单按钮。
- `R` 键语义为上下文相关（面板内刷新 / 主界面重试），Help 速查表与 README
  已同步标注，避免误导。
- 会话状态面板（O）不再有任何按钮，面板行高回收给状态正文。
