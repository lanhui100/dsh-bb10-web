# Agent Note: 弹窗右上角关闭按钮固定吸附（Absolute Positioning on Overlay）

Status: implemented

## Problem

在 BlackBerry Q20 (BB10 WebKit 537.35+) 720×720 方屏设备上，当用户在全屏弹窗（Workspace / Session / Model / Permission / Help）中向下滚动长列表时，原先放置在滚动容器 `.tree-panel` 内的关闭按钮会随着页面向下滚动而滚出可视区域。使用 CSS `sticky` 在老旧 WebKit（WebKit 537.35）中由于容器滚动上下文与父级层级特性，无法稳定生效或被内层容器滚动剪裁。

## Decision

将关闭按钮彻底从滚动的 `.tree-panel` / `#help-panel` 内部解耦，直接提升并固定在全屏弹窗遮罩层（`*-overlay`）内：

1. **绝对定位固定在右上角**：
   - 关闭按钮设为：
     ```css
     .panel-close-btn {
       position: absolute;
       top: 10px;
       right: 12px;
       width: 28px;
       height: 26px;
       line-height: 24px;
       background: #333333;
       border: 1px solid #555555;
       color: #FFFFFF;
       font-size: 14px;
       font-weight: bold;
       text-align: center;
       border-radius: 3px;
       cursor: pointer;
       z-index: 110;
     }
     ```
   - 具有微小的安全边距（`top: 10px; right: 12px`），符合设备 720×720 方屏触控标准。
2. **DOM 结构挂载到 overlay**：
   - 将关闭按钮置于各个 modal overlay 的顶层，不参与 panel 的滚动：
     - `#ws-overlay > #ws-close-btn`
     - `#sess-overlay > #sess-close-btn`
     - `#model-overlay > #model-close-btn`
     - `#perm-overlay > #perm-close-btn`
     - `#help-overlay > #help-close-btn`
3. **避让标题**：
   - `.panel-header` 增加 `padding-right: 34px`，确保长标题不会与固定在右上角的关闭按钮重叠。

## Alternatives considered

- 使用 `position: -webkit-sticky`：由于 BB10 WebKit 537.35 对局部 `overflow-y: scroll` 容器内部的 sticky 支持存在已知缺陷，容易随内部滚动条失效。提升至外层固定容器是最具确定性的可靠方案。

## Consequences

- 无论弹窗列表滚动到何处，右上角关闭按钮均稳稳吸附在屏幕右上角（带 10px / 12px 边距），用户操作完毕后无需向上回滚即可单手直接触控关闭。
- 100% 保持 ES5 纯 JavaScript 规范，通过 Acorn 语法门禁测试。
