# Agent Note: 对话框底栏徽章/圆环与发送键重叠——独立内槽几何隔离

Status: implemented

关联：跟进 [2026-09-20-composer-bottom-badges-with-context-ring](../feature/2026-09-20-composer-bottom-badges-with-context-ring.md) 的"徽章/圆环/发送键同行"结构与 [2026-09-21-composer-meta-badge-truncation](../bug-fix/2026-09-21-composer-meta-badge-truncation.md) 的"padding 按控件尺寸核算"决策（其徽章上限 40%/52%、单徽章 85% 独占、`＋` 键左 40px 让位继续有效）；本次仅修正裁剪几何，不动上述口径。

## Problem

用户实测：对话框底部上下文占用圆环有时与发送键重叠。根因在 `static/index.html`：`#composer-meta` 用自身 `padding: 0 46px 0 40px` + `overflow: hidden` 充当"伪 inline"隔离——但 overflow 的裁剪边是 border box 而非 padding box，内容可绘制进 padding 区直至边框；长 workspace/model 文本把行尾无保护的 `#ctx-ring-wrap` 推进右侧 46px 发送键预留区，圆环即画在发送按钮之下造成重叠。

## Decision

`static/index.html`（纯 CSS + 一层 div，无新增依赖；宪法 §二 绝对定位/静态 HEX/ES5 约束不变）：

1. `#composer-meta` 退化为纯背景条（去 `padding/overflow/white-space`，只留定位与底色），不再承担裁剪；
2. 新增 `#composer-meta-inner`（`absolute; left:40px; right:46px; overflow:hidden; nowrap`）：徽章 + 圆环移入其内，裁剪边恰落在发送键左缘 46px 处，溢出在内槽右缘省略，物理上画不到发送键下；
3. `#send-btn` 仍钉外层（`#composer-panel` 右下 `8px+30px`，z-index 高于底栏），点击区不变；`#ws-badge` 左边距 8px→0（内槽左缘已让位 `＋` 键）；
4. `test-unit.mjs` 补防回归断言：发送键在 meta 元素之外、徽章/圆环在内槽之内。

## Alternatives considered

1. **用户建议"workspace/模型/圆环与发送键 inline 布局"**：方向正确但表述需收敛——当前已是同行 inline，缺的是独立裁剪槽；直接 flex/inline 调整不建槽仍会复现，否决纯 inline 重排，改为内槽几何隔离。
2. **加宽右 padding（如 46px→70px）**：治标——padding 区本就可绘制，加宽只是推迟触发点，长文本下仍重叠，否决；裁剪边必须落在独立元素盒上。
3. **Flex 均分底栏**：旧 WebKit 仅支持带前缀旧 flex，宪法 §二.2 明令统一绝对定位保稳定，否决。
4. **圆环移到输入区右上角/另起一行**：挤占 720 方屏输入空间或加高底栏，违背空间利用率铁律，否决。

## Consequences

- 任意长度徽章文本下，圆环最多被内槽右缘裁掉，永不进入发送键 46px 槽位；发送/`＋`键位置与点击区不变；
- 门禁：Acorn `ecmaVersion: 5` 解析 `ES5 PASS`；几何隔离静态断言 `NO-OVERLAP GEOMETRY PASS`；`node test-decoupling.mjs` PASS；`node test-unit.mjs` 23/23 PASS。
