# Agent Note: Permission confirm gate and workspace-write default

Status: implemented

## Problem

`static/index.html` 的 P 面板（运行权限）此前对权限选择**不做任何确认**：切换到
`danger-full-access`（完全权限）与选择普通权限无异，一键即生效。官方
`dsh web`（`packages/client/ui-permission-presets` 的 `PermissionSelect` +
`RiskConfirmation`）对完全权限与 Auto review 强制风险确认（勾选
「我已了解风险，并愿意继续」后才可启用）。同时本项目权限默认值为
`danger-full-access`（危险级），与 dsh 官方默认 `workspace-write` + ask 相悖，
且权限选项文案为英文（`danger-full-access (Full Access)` 等），未对齐 dsh 中文翻译。

## Decision

- 权限默认值从 `danger-full-access` 改为 `workspace-write`（工作区内修改）：
  - `server.mjs` `readDshSettings()` 的 `current.permission` 恒为
    `'workspace-write'`；`/api/chat/stream` 的 `start` 事件权限缺省值同步改为
    `'workspace-write'`。
  - `static/index.html` 发送链路 `permSelect.value || 'workspace-write'` 与状态
    面板兜底文案同步。
- 权限目录文案对齐 dsh 中文翻译：`工作区内修改` / `完全权限` / `仅可查看`
  （对应 `workspace-write` / `danger-full-access` / `read-only`，即
  `ui-permission-presets` `locales.ts` 的 `preset.workspaceWrite` /
  `preset.fullAccess` / `preset.readOnly`）。
- 新增完全权限风险确认组件（对齐 dsh `RiskConfirmation` 语义，BB10 键盘友好变体）：
  - 切换至 `danger-full-access`（与当前值不同时）先弹 `#perm-confirm-overlay`，
    文案对齐 dsh：风险说明 + 「我已了解风险，并愿意继续」勾选；
  - 勾选后才可点「✔ 启用完全权限」或按 Enter；`X`/Esc 取消；空格切换勾选；
  - 触控板/点击对话框外区域关闭；确认失败仅提示，不改权限；
  - `renderPermTree` 与 `activatePermNode` 统一走 `requestPermSwitch(idx)` 网关，
    键盘（回车确认菜单项）与触控路径同一语义。

## Alternatives considered

1. **仅改默认值、不补确认组件**（放弃）：默认收敛到了安全档，但 dsh 消费边界
   对齐准则要求「业务与核心处理逻辑对齐」，完全权限确认是 dsh web 权限面板的
   标准交互，缺失即语义不完整；且危险档无确认会在小屏误触下一键放开沙箱。
2. **引入宿主 `/permission` 命令 RPC 透传权限到引擎**（放弃，留作后续）：当前
   消费边界内 `session/prompt` 走宿主队列、本地 SDK 兜底，两处都暂未提供
   per-call 权限 knob；本次仅对齐 UI 层目录与确认语义 + 默认值，权限真正作用于
   会话执行需要宿主侧权限事件管道（`sandbox/mode` / `approval/policy` /
   `permission/preset`）接入，属独立一次变更（宿主审批面板的接入可复用
   `2026-09-18-ask-user-question-bridge-and-composer.md` 的
   `$events` waterfall 桥）。
3. **完全复制 dsh 的复选框样式（appearance:none + 自绘勾选）**（放弃）：BB10
   WebKit 537 下自绘复选框勾选态不可见，改为原生 checkbox + JS 驱动的
   ✔/· 指示与按钮禁用态联动，保证真机可观测；字形用项目已验证的 ✔（U+2714）
   而非 ☐/☑（U+2610/U+2611 存在 BB10 固件缺字风险）。
4. **确认门禁按预设 id 硬编码白名单**（放弃，改为数据驱动）：切换判定不比较
   `id === 'danger-full-access'` 单串，而由服务端在 `readDshSettings()` 为每个
   预设下发 `requiresConfirm` 元数据，前端经 `data-requires-confirm` 读取——
   未来宿主新增需确认档位（如 auto）仅需目录同步加标志，目录渲染本身按
   bootstrap 下发迭代、无前端白名单。

## Consequences

- 新会话默认工作区内修改权限；完全权限须显式确认后启用。
- P 面板选项为中文，与 dsh web 中文界面一致；状态面板「运行权限」行显示中文
  预设名。
- 当前版本现状（如实声明，防"宣称已生效实际未生效"失真）：`permission` 选择
  仅作会话运行权限记录并随 `start` 事件回显，引擎执行策略由宿主会话默认决定
  （`session/prompt` RPC 与本地 SDK 兜底均未消费该字段）；确认弹窗内已带
  「当前版本说明」现状标注。宿主侧 `sandbox/mode` / `approval/policy` /
  `permission/preset` 事件管道接入后本选择才会约束执行（即 Alternative 2 的
  deferred scope）。
- 键盘交互：确认态以 `X` 取消为主路径（BB10 无实体 Esc 键，宪法禁止宣称
  "按 Esc 收起"）；Esc 仅保留为开发/PC 回退兜底，不入对外文案。
- 权限选择无持久化：页面刷新即回落 `workspace-write` 默认（fail-safe 安全向
  偏差），与 dsh per-session 投影回放不同，单写者场景下无实际失同步源。