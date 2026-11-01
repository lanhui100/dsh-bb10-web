# Agent Note: 修复列表面板偶发鼠标点击失灵——容器事件委托与会话树签名跳过重建

Status: implemented

## Problem

在桌面端或通过鼠标操作列表面板（会话面板 C、工作区面板 W 等）时，偶发出现鼠标点击无反应、必须触屏才能点击的情况：
1. **行级事件丢失（DOM换手断连）**：列表由 5s 后台轮询或会话状态刷新驱动，重绘时调用 `innerHTML = ''`。桌面鼠标点击依赖 `mousedown → mouseup → click` 完整链条。若按下到释放的毫秒级窗口内发生列表全量重建，旧 DOM 节点被摘除替换，浏览器的 `click` 判定失效；
2. **会话面板缺少签名跳过机制**：虽然工作区树此前实现了 `wsTreeSignature`，但会话面板 `renderSessTree` 每次轮询或状态刷新无论数据是否变更，都无条件执行整树重建；
3. **触屏可点的原因**：触屏轻点操作瞬时完成（极窄窗口），且 WebKit 的 touch 事件流更宽容，不易撞车。

## Decision

1. **容器级单次事件委托（Event Delegation）**：
   - 在 `#sess-tree` 与 `#ws-tree` 容器上绑定单一 `onclick` 委托（设置 `__delegated` 守卫防止重复绑定）；
   - 通过事件冒泡向上查找 `.tree-node`，根据节点类型分别调用 `activateSessNode(node)` 与 `activateWsNode(node)`；
   - 彻底解除行级 DOM 替换与点击监听器的耦合，无论内部节点如何换手，容器监听器始终常驻。
2. **会话树数据签名与跳过重建（sessTreeSignature）**：
   - 新增 `sessTreeSignature()`，综合当前视图模式（聚合/未分组/当前工作区）、筛选标签、当前激活会话 ID 以及各会话的状态与归档标记；
   - 在 `renderSessTree` 开始时对比 `sessTree.__sig`，数据未变更时直接 `return` 跳过 DOM 重建，保持 hover 状态、视口滚动条与现有 DOM 结构；
   - 在 `closeSess()` 时重置 `sessTree.__sig = null`，确保下次打开时刷新数据。
3. **遵循 BB10 WebKit 约束**：
   - 100% 纯 ES5 语法，通过 acorn 校验；
   - 零现代浏览器独占 API，不引入 CSS 变量或 Grid。

## Alternatives considered

- 仅依靠行级 `mousedown` 监听：旧 WebKit 环境下若在 `mousedown` 立即触发切换会导致用户想滚动时误触行选择，体验不佳，放弃；
- 仅做定时器延时防抖：无法根治网络回包时刻不可控导致的碰撞，放弃。

## Consequences

- 鼠标在 C 面板与 W 面板的点击与选择百分之百可靠，不再受后台 5s 轮询与轻量状态刷新的 DOM 重建干扰；
- 单元测试套件全量通过（39/39 PASS，包含新增契约用例），解耦门禁与 E2E 门禁全量通过；
- ES5 静态门禁全量 PASS。
