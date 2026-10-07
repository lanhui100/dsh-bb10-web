# Agent Note: quick-message-input-textarea-4to6-rows

Status: implemented

## Problem

快捷消息面板（`G` 呼出，见 [session-quick-messages-panel-and-hotkeys](./2026-09-18-session-quick-messages-panel-and-hotkeys.md)）的"按 `A` 新增"弹层使用单行 `<input type="text">`，只能录入一行文本。快捷消息常是需要多行的长指令（如包含换行的提示词），单行输入既无法表达换行，长文本一屏放不下也无舒适的可编辑区；同时长度完全不受控，超长内容会原样写入 `localStorage`。

## Decision

`static/index.html`（ES5，无 CSS 变量）中把新增弹层的 `#quick-msg-input-text` 从 `<input type="text">` 改为 `<textarea>`：

1. **长度上限**：`maxlength="1000"`（最长 1000 字），保存路径 `saveAndCloseQuickMsgInput()` 对 trim 后的值再做 `slice(0, 1000)` 双重护栏（常量 `QMI_MAX_CHARS`）。
2. **行数区间**：`rows="4"` + `min-height: 84px`（4 行）起步；随输入自动增高，`max-height: 120px`（6 行）封顶，超出部分 `overflow-y: auto` 内部滚动。行高 18px、上下内边距共 12px，4 行 = 84px、6 行 = 120px（常量 `QMI_MIN_H` / `QMI_MAX_H`）。
3. **自动高度**：新增 `adjustQuickMsgInputHeight()`，与 Composer 主输入框同一模式（`oninput` + `onpropertychange` 双挂载，兼容旧 WebKit）；打开弹层与每次输入时重算 `scrollHeight` 并夹取在 [84, 120]。
4. **键位语义**：`Enter` = 保存并关闭（按钮提示 `✔ 保存 [↵]` 不变）；`Shift+Enter` = 插入换行（与 Composer 的 Enter 发送 / Shift+Enter 换行约定一致）；`Esc` = 收起不变。
5. 样式沿用 Q20 深底亮字规范（背景 `#121212`、前景 `#FFFFFF`、边框 `#444444`），`resize: none` 禁用原生拖拽角。

## Alternatives considered

- **保留单行 `<input>` 只加 `maxlength`**：无法录入换行，多行快捷消息目的落空，仅解决长度问题；否决。
- **固定 6 行高度不做自动伸缩**：空态时 6 行占用 720px 方屏过多纵向空间，且短消息时留白浪费；采用 4→6 行动态伸缩在紧凑与容量间平衡。
- **用 CSS `field-sizing: content` 自动增高**：该属性超出 WebKit 537 能力范围（宪法规约禁止现代特性），故用 `scrollHeight` 经典测量法，与既有 `adjustInputHeight()` 完全同构。
- **`Enter` 改为换行、`Ctrl+Enter` 保存**：Q20 无 PC 版控制键习惯，且保存按钮提示 `[↵]` 已固化 Enter 语义；保留 Enter 保存、Shift+Enter 换行，与主输入框心智一致。

## Consequences

- 快捷消息可录入最长 1000 字的多行指令，面板保存/持久化链路不变（`dsh_q20_quick_msgs` localStorage 结构无变化，旧数据兼容）。
- 新增/复跑机械门禁：ES5 acorn 解析（`ecmaVersion: 5`）PASS、`node test-decoupling.mjs && node test-suite.mjs` 全量 PASS（7/7）。