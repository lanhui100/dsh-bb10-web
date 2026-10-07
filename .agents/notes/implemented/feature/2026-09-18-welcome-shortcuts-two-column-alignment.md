# Agent Note: 欢迎页快捷键提示改为双栏对齐表格布局

Status: implemented

## Problem

BlackBerry Q20 物理屏幕为 720×720 方屏。原新建会话欢迎页（`#welcome-ready`）以单列居中文本 `按 I 开始对话`、`按 G 呼出快捷消息` 等纵向排列，视觉发散且快捷键未垂直对齐，不够紧凑。

## Decision

在 `static/index.html` 前端（严格 ES5 与经典 CSS）：
1. 将 `#welcome-ready` 布局改为居中两栏（左右并排两列，经典 `display: inline-table` 排版，兼容老旧 WebKit，无 CSS Grid，无 CSS 变量）：
   - 左栏：`[I] : 开始对话`、`[W] : 切换工作区`、`[U] : 智能体看板`
   - 右栏：`[G] : 快捷消息`、`[C] : 会话列表`、`[?] : 快捷键帮助`
2. 呈现格式为：`[快捷键] : [简要说明]`，两列各自垂直严格对齐，按键使用实体键深底亮色胶囊（`.welcome-sc-key`），说明文字清晰易读，节省方屏纵向空间。

## Alternatives considered

- **方案 A：使用 CSS Grid / Flexbox**：违反 AGENTS.md 宪法，老旧 WebKit 537.35 对 Grid 不支持，对 Flexbox 存在兼容 Bug；经典 table/inline-block 绝对可靠。
- **方案 B：使用全角空格文本对齐**：不同字体下等宽性不可靠，样式发虚。

## Consequences

- 快捷键提示信息整齐对齐，节省纵向空间，契合 720×720 方屏视野；
- 100% 保持 ES5 与旧 WebKit 兼容，通过 Acorn 与单元测试门禁。
