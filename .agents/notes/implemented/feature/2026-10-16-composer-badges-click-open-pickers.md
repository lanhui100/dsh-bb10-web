# Agent Note: 对话框工作区与模型徽标点击唤起选择面板

Status: implemented

关联：[2026-09-20-composer-bottom-badges-with-context-ring](../feature/2026-09-20-composer-bottom-badges-with-context-ring.md)

## Problem

在对话框（composer）展开时，底部包含当前会话的工作区徽标（`#ws-badge`）与模型徽标（`#model-badge`）。此前这两枚徽标仅作为只读状态展示（父容器 `#composer-meta` 设置了 `pointer-events: none`），用户触控或鼠标点击模型徽标时无法直接唤起模型选择列表进行切换，违背直觉与黑莓触控交互便利性。

## Decision

1. **CSS 交互激活**：
   - 为 `#ws-badge` 与 `#model-badge` 显式设置 `pointer-events: auto; cursor: pointer;` 与 `-webkit-tap-highlight-color: rgba(0,0,0,0);`；
   - 增加 `:active` 态（高亮背景色 `#4A4A4A`），赋予物理触控反馈。
2. **点击事件绑定**：
   - 为 `#model-badge` 绑定 `onclick`：执行 `openModel()` 呼出运行模型树形选择面板（支持上下/JK 选择、回车确认切换、F 收藏、D 设为默认）；
   - 为 `#ws-badge` 绑定 `onclick`：执行 `openWs()` 呼出工作区选择面板，保持交互同构；
   - 点击时阻止冒泡，避免触发底层容器的收起逻辑。
3. **严格遵守宪法**：
   - 纯 ES5 语法与经典绝对布局，无现代浏览器特有 API；
   - 保持与 `dsh web` 状态一致性。

## Alternatives considered

1. **在徽标旁增加独立下拉小箭头按钮**：占用 720×720 方屏宝贵的水平空间，易导致长模型名称被截断，且增加 DOM 复杂度；胶囊本身具备完整语义与视觉边界，整块可点更加自然。
2. **仅支持键盘快捷键（M / W）**：黑莓 Q20 拥有触控屏，仅依靠物理键盘快捷键割裂了触控操作路径。

## Consequences

- 用户在输入框中点击模型徽标即可直接呼出模型列表面板选择模型；
- 门禁：Acorn ES5 检查通过，`test-decoupling.mjs` 与 `test-unit.mjs` 全量通过。
