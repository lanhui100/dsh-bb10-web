# Agent Note: 简化输入对话框结构并移除外层状态与工作区提示

Status: implemented

## Problem

BlackBerry Q20 采用 720×720 方屏，纵向像素资源极为有限。浮动输入对话框（`#composer-panel`）此前存在双层嵌套结构：
1. 外层头栏（`#composer-head`）承载了状态提示行（`#status-line`）、关闭按钮（`#composer-close-btn`）及当前工作区提示（`#composer-ws-name`）；
2. 内层（`#composer-body`）承载输入多行文本框（`#input-box`）与发送按钮（`#send-btn`）。

头栏的存在占用了宝贵的纵向高度（约 22px），且其中的“就绪/快捷键”等状态提示和当前工作区在输入阶段属于低频或冗余信息（工作区已在顶栏与工作区切换弹窗中可查）。用户期望去除双层嵌套和顶栏干扰，仅保留输入区域和关闭对话框按钮。

## Decision

彻底拍平输入对话框为单层结构，移除外层头栏、状态行与工作区信息：

1. **DOM 结构重构**：
   - 移除 `#composer-head`、`#status-line` 与 `#composer-ws-name` 元素；
   - 移除 `#composer-body` 嵌套层，输入框 `#input-box`、发送按钮 `#send-btn` 以及关闭按钮 `#composer-close-btn` 直接作为 `#composer-panel` 的一级子元素；
   - `#composer-close-btn` 采用绝对定位（`top: 5px; right: 5px;`）浮动在输入框右上角安全区域，不遮挡输入文字。

2. **样式清理与单层线框瘦身**：
   - 移除 `#composer-panel` 与 `#input-box` 的双层线框嵌套：由 `#composer-panel` 独占单层灰色边框（`1px solid #444444`）与深灰底色（`#262626`），内部 `#input-box` 去除独立边框（`border: none; background: transparent; outline: none`），彻底呈现整洁的单层线框外观；
   - 发送/停止按钮 `#send-btn` 定位在右下角（`bottom: 7px; right: 8px;`），与面板边框和圆角保持 8px 舒适间距，杜绝元素与边框重叠；
   - 文本框右侧设置安全留白（`padding: 8px 42px 8px 10px;`），确保输入文本内容不与右上角关闭按钮（✕）及右下角发送按钮重叠；
   - 更新 `#composer-close-btn` 样式为右上角绝对定位（`top: 6px; right: 6px;`），z-index 设为 3；
   - 对话框高度压缩至 88px，为 720×720 方屏释放出更多正文展示区域。

3. **脚本与状态机维护**：
   - 清理已无消费者的 `composerWsName`、`statusLine` 变量引用；
   - 移除 `updateComposerWs()` 函数及其在 `openComposer`、`selectWorkspace`、`loadBootstrap` 中的调用；
   - 重构 `setStatus(text, state)` 函数：仅保留 `sessState.phase` 状态机同步逻辑，确保与 `dsh web` 状态流转契约完全一致，不再执行 DOM 操作。

## Alternatives considered

1. **仅通过 CSS `display: none` 隐藏 `#composer-head`**：残留无用的 DOM 节点与冗余的 `updateComposerWs` 字符串拼接运算，老旧 WebKit 内核内存与重绘开销未能真正根除——否决。
2. **保留外层头栏但仅隐藏文字**：保留空头栏依然浪费 18~22px 高度，未达成“去除外层双层嵌套”的目标——否决。

## Consequences

- 对话框由双层嵌套变为单一容器，仅保留输入框、发送按钮及右上角关闭（✕）按钮。
- 通过 Acorn 严格 ES5 解析门禁（`ES5 PASS`）。
- 自动化单元测试（5/5 PASS）与全链路回归测试（7/7 PASS）100% 通过。
