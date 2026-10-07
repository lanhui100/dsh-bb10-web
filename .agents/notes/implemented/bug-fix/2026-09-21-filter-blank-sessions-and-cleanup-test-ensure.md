# Agent Note: 过滤未发消息的空白会话并自愈清理测试残留

Status: implemented

## Problem

在会话列表（`/api/sessions`）与工作区面板中，偶现存在无标题、点击后历史消息为 0 条的“空会话”。
经排查诊断：
1. 打开对话框（`openComposer`）仅操作本地 DOM，不会发送网络请求，亦不会在后端创建空会话；
2. 宿主 DSH 原生 `session/create` 以及底栏文件上传首条预建接口 `/api/session/ensure` 会在磁盘上生成带有会话头与策略配置帧但尚未有任何对话消息（无 `user/message`、无 `turn/start`）的 blank 实体；
3. `test-unit.mjs` 在验证 `/api/session/ensure` 时创建了测试会话但未自愈清理；
4. Q20 服务端 `/api/sessions` 与 `getWorkspaces` 仅凭目录与 `workspace.json` 注册表判定会话存在，未对齐 DSH Web 官方的 `blank: true` 会话收敛规范（官方仅对当前活动连接展示一次性暂存行，不应将未发消息的历史 blank 会话暴露在已完成的会话历史列表中）。

## Decision

1. **服务端 `/api/sessions` 与 `getWorkspaces` 过滤 blank 空会话**：
   - 在扫描会话头部时（`readSessionHeader`），检测会话是否包含实质对话帧（`hasTurns: true`，即包含 `user/message` 或 `turn/start`）；
   - 在 `getSessionsForCwd` 与 `countResolvableRegistered` 中，若会话非正在运行（`!isRunning`）且 `hasTurns === false`（字节数极小且无任何实质轮次），视为空白会话并自动过滤，不返回给前端历史会话列表，也不计入工作区历史会话总数。
2. **`test-unit.mjs` 测试会话自愈清理**：
   - 在跑完 `/api/session/ensure` 契约后，使用 `POST /api/session/archive` 与 `DELETE /api/session` 立即自愈清理所创建的测试临时会话，杜绝磁盘测试垃圾残留。
3. **历史空会话清理**：
   - 清理此前由测试残留的 7 个 0 轮次空会话目录及 `workspace.json` 中的无效空引用。

## Alternatives considered

- **仅在前端过滤（Client-side only filter）**：
  在前端拉取 `/api/sessions` 后自行根据 `turnCount === 0` 或 `blank` 过滤。缺点是工作区面板计数（`sessionCount`）来自服务端 `/api/bootstrap`，会导致工作区面板显示的会话数与实际列表长度不一致，破坏既有回归门禁。
- **直接禁止 `/api/session/ensure` 预建**：
  如果禁止预建，首条带通用文件的消息必须串行阻塞在单次请求里，且如果宿主离线则无法取到官方收据。因此保留预建能力，但在列表端规范收敛 blank 会话。

## Consequences

- 打开会话列表或工作区面板时，不再出现任何 0 条消息的空会话残影；
- `test-unit.mjs` 执行后零存储污染；
- 严格保持 `getWorkspaces().sessionCount` 与 `/api/sessions.length` 的强一致性契约。
