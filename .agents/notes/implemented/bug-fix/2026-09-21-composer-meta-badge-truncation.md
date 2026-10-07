# Agent Note: 对话框底部徽章截断浪费——回收 meta 内边距与动态徽章上限

Status: implemented

关联：跟进 [2026-09-20-composer-bottom-badges-with-context-ring](../feature/2026-09-20-composer-bottom-badges-with-context-ring.md) 的 `#composer-meta` 右垫 110px 与 ws/model 固定 `max-width` 上限决策（其"inline 收缩胶囊 + 底部全局栏 + 上下文圆环"结构继续有效）；`＋` 上传键占位见 [2026-09-21-plus-file-upload](../feature/2026-09-21-plus-file-upload.md)。

## Problem

用户实测：对话面板底部 workspace / model 徽章在右侧仍有明显空白时就被提前截断（`text-overflow: ellipsis` 过早生效），空间没有被合理利用。根因三处叠加，均在 `static/index.html`：

1. `#composer-meta` 右内边距 `110px` 是圆环+发送键时代的遗留预留——发送键实际只占右沿 `8px + 30px`，多出的约 64px 纯浪费，直接吃掉徽章 content 盒宽度；
2. `#ws-badge 32%` / `#model-badge 38%` 双上限合计仅 70%，两者并存时天然留 30% 空白不用；
3. 任一徽章缺席/为空时，另一枚仍被各自固定上限卡住（如 model 为空时 ws 仍只占 32%），缺席徽章让出的份额无人认领。

## Decision

`static/index.html`（纯 CSS + ES5 JS，无新增依赖，宪法 §二 绝对定位/静态 HEX/ES5 约束不变）：

1. **回收右内边距**：`#composer-meta` 的 `padding` 由 `0 110px 0 40px` 改为 `0 46px 0 40px`——右 46px = 发送键（右 8px + 宽 30px）+ 8px 间隙；左 40px 继续让位 `＋` 键（左 6px + 宽 30px）+ 4px 间隙，均按实际控件尺寸核算；
2. **放宽双徽章上限**：`#ws-badge max-width 32%→40%`、`#model-badge 38%→52%`，合计 92%，把底栏余量让给更长的文本（仍保留少量余量给上下文圆环跟随显示）；
3. **单徽章独占**：`updateWsBadge()` 记录 ws/model 是否真实有文本显示，任一缺席时把存活徽章的 `style.maxWidth` 抬到 `85%`（内联样式覆盖 CSS），双徽章并存时清空回落 CSS 默认；`try...catch` 包裹，旧 WebKit 上 `style.maxWidth` 异常不影响徽章主流程。

## Alternatives considered

1. **直接去掉 `max-width` 任徽章自然伸展**：双长文本（长路径 workspace + 长模型名）会把上下文圆环挤出可视区（父级 `overflow: hidden` 直接裁掉圆环而非省略），否决；保留百分比上限 + 省略号仍是小方屏下最稳的防溢出手段。
2. **Flex 均分/按内容比例分配**：旧 WebKit 仅支持带前缀旧 flex，宪法 §二.2 明令统一用绝对定位与块级排版保稳定，否决；百分比上限 + JS 单/双态切换已够用。
3. **缩短文本口径（如 workspace 只显示 basename、model 缩写）**：改变徽章信息契约（W/M 全路径与 `provider/model` 口径是快捷键教育与问题定位的依据），且治标——容器浪费不除，缩写后仍会提前截断，否决。
4. **仅改右 padding 不动上限**：单徽章独占浪费仍在（model 为空时 ws 卡 40%），用户 complaint 的"有空间却截断"在单徽章场景下复现，否决；必须与动态上限同改。

## Consequences

- 双徽章并存时可用宽度增加约 64px + 22 个百分点（70%→92%），省略号生效点显著右移；单徽章时独占至 85%，不再出现"一半空白一半省略号"；
- 发送键/`＋`键/圆环位置与点击区不变（padding 按实际控件尺寸核算，8px/4px 间隙保留防误触）；
- 门禁：Acorn `ecmaVersion: 5` 解析 `ES5 PASS`；`node test-decoupling.mjs` PASS；`node test-unit.mjs` 20/20 PASS。
