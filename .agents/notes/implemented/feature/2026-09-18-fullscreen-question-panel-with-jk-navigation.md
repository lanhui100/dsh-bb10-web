# Agent Note: Fullscreen Agent Question Panel with JK Navigation and Enter Confirmation

Status: implemented

## Problem

此前 `ask_user_question` 提问面板（`#question-panel`）采用悬浮卡片定位（`bottom: 64px; left: 8px; right: 8px; max-height: 240px`），在黑莓 Q20 720×720 方屏上存在以下局限：
1. 空间狭窄，题干描述和多选项容易出现滚动截断；
2. 缺乏 Q20 实体物理键盘/触控板交互支持，用户必须触屏点击选项，无法使用全键盘经典的 `J` / `K` 上下移动光标高亮选项，也无法直接按 `Enter` 键确认选中或提交。

## Decision

对齐 Q20 工作区/会话/模型面板的全屏模态与快捷键契约，将 Agent 提问面板升级为全屏模式并打通键盘操作链：

1. **全屏沉浸布局**（`static/index.html`）：
   - `#question-panel` 定位改为 `top: 0; bottom: 0; left: 0; right: 0` 全屏覆盖（`z-index: 105`），背景为标准 `#181818` 深色背景，消除悬浮避让与边距留白，最大化 720×720 方屏可视面积；
   - 顶部 `#question-head`（34px）、底部 `#question-foot`（40px 留出物理按键安全区）、中部 `#question-scroll` 绝对定位占满剩余空间（`top: 34px; bottom: 40px`）并支持原生触控平滑滚动。
2. **JK 键盘选择与 Enter 确认机制**：
   - 维护当前题目的选项光标索引 `kbQuestionIdx`（渲染时默认聚焦第一项或选中项）；
   - 选项高亮样式 `.q-option.kb-sel` 沿用全站高对比度焦点规范（`border-color: #0078D7; background: #1A3A5C; color: #FFFFFF`）；
   - 在全局键盘监听 `document.onkeydown` 中，当 `questionState.visible` 为真且未聚焦在文本输入框时：
     - `J`（及 Down 方向键）：向下移动高亮选项并自动滚入视口；
     - `K`（及 Up 方向键）：向上移动高亮选项并自动滚入视口；
     - `Enter`：确认激活当前高亮选项（单选即推进，多选切换勾选）；
     - `S`：跳过当前题目（Skip，针对黑莓 Q20 物理键盘无 Esc 键的实体快捷键）；
     - `X`：取消本次提问（Cancel）；
     - 保留 Esc 兼容（PC/调试环境）；
   - 保留自由文本框的原生输入机制，焦点进入文本框时放行打字，回车直接提交。

## Alternatives considered

- **使用 Esc 作为取消/跳过快捷键**：黑莓 Q20 硬件全键盘不存在物理 Esc 键，机身返回键由 BB10 系统和浏览器内核直接截获导致页面后退，无法可靠用于网页内交互。因此专门引入实体字母键 `S` 作为 Skip 跳过快捷键、`X` 作为 Cancel 取消快捷键。
- **仅增大悬浮卡高度而不做全屏**：黑莓 Q20 纵向仅 720px，悬浮卡上下留白不仅浪费像素，且在软键盘或系统顶底栏之间易产生挤压断层。全屏覆盖与会话列表/模型列表的体验最统一。
- **JK 键仅翻页题目前进后退**：单题目内经常有 2~4 个选项，手指去点小方屏上的选项易误触；用 JK 选选项、Enter 确认是最原生的黑莓全键盘盲打体验。跨题翻页由单选确认后自动前进、或者翻页/跳过按钮处理。

## Consequences

- 满足黑莓 Q20 移动端 720x720 屏幕下全屏沉浸作答；
- 用户可以完全脱离触摸屏，使用实体键盘 J/K 上下选择选项，Enter 确认。
