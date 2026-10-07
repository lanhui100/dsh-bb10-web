# Agent Note: 新建会话对话框顶部徽标行重构（W 左对齐 / M 右对齐）

Status: implemented

前置关联：部分取代 [2026-09-18-new-session-workspace-badge](../feature/2026-09-18-new-session-workspace-badge.md) 中"底部居中"的摆放与结构决策（其状态生命周期、显示条件与文本回退口径继续有效）；关联上下文见 [flatten-composer-dialog-remove-outer-header](../simplification/2026-09-18-flatten-composer-dialog-remove-outer-header.md)。

## Problem

新建会话对话框（composer）上方的 workspace 徽标原先居中横贯整行，仅显示工作区名，存在两点不足：
1. 未提示打开工作区面板的物理键盘快捷键（W）；
2. 无当前模型展示入口，用户需按 M 打开模型面板才能确认 provider/model。

## Decision

将对话框上方徽标行改为左右分区布局（`static/index.html`，纯 CSS/ES5，无新增依赖）：
1. **左侧 workspace 徽标**：`#ws-badge` 改为左对齐（`left: 6px; max-width: 48%`），前缀物理键帽徽标 `W`（`.composer-key-badge`，`17px × 17px` 深色拟物键帽 + 黄字居中），暗示按 W 可进入工作区面板；
2. **右侧模型徽标**：新增 `#model-badge` 右对齐（`right: 6px; max-width: 50%`，`overflow: visible`），前缀同款按键徽标 `M`，后接内含省略号平滑过渡的 `provider/model` 胶囊（`#model-badge-text`，`max-width: 82%`）；
3. **可见性语义不变**：沿用原 ws-badge 条件（对话框展开 + 新建空白会话 + 无消息），两徽标同显同隐；
4. **数据口径**：模型文本取 `modelSelect.value` 按 `:::` 拆分为 `provider/model`，空值回退 `latestSessionStats.provider/model`，均缺失时隐藏徽标；
5. **刷新时机**：模型树三处选中路径（常用收藏项、分组项、JK 激活）切换后同步调用 `updateWsBadge()`，bootstrap 渲染尾部既有调用覆盖初始值。

## Alternatives considered

1. **单行容器 + float 左右布局**：旧 WebKit 对 shrink-to-fit 容器内 `max-width:100%` 椭圆裁剪解析不稳，改为两个独立绝对定位徽标 + `overflow: hidden` 硬裁剪，行为可预测，否决 float 方案。
2. **徽标常驻显示（不随新建态隐藏）**：会话进行中顶部空间与状态行信息重复且挤占 720 方屏空间，维持仅新建空白会话时显示，否决。
3. **模型徽标点击直接打开模型面板**：与快捷键 M 语义重复，且徽标行保持 `pointer-events: none` 不拦截触控板滚动，维持纯指示用途。

## Consequences

- 新建会话即可一眼确认当前工作区与模型，W/M 徽标同时承担快捷键教育职能；
- 左右 `max-width` 合计 98%，长工作区名与长模型名同时极端时以硬裁剪兜底，不重叠、不换行；
- Acorn ES5 门禁 PASS，7/7 全链路回归 PASS，12/12 单元测试 PASS。
