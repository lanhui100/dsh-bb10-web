# Agent Note: 会话归档改乐观删除，列表零 loading

Status: implemented

## Problem

详情页归档会话后，前端走 `delete sessCache + openSess + loadBootstrap + loadSessions` 全量重拉：会话面板先闪 loading，已归档会话仍在裂变列表残留数秒才消失。两处根因：`openSess` 每次重拉；服务端经远端 RPC 归档时官方 `workspace.json` 落盘有延迟，`/api/sessions` 短暂把已归档项吐回。

## Decision

- `static/index.html` `executeArchiveCurrentSession` 改乐观删除：确认即从 `sessCache` 剔除该项并重绘面板（当前会话则收尾上下文后 `openSess(true)` 直达终态），无 loading；后端成功仅后台静默对账（快照不一致才更新），失败回滚并提示。
- 新增 `archivedTombstones` 墓碑：已归档 sid 本页生命周期内不再现，`loadSessions` / `renderSessions` / 静默对账三处统一过滤，堵住 5s 轮询在落盘延迟窗口内的闪回。
- `openSess(skipLoad)`：归档路径传 true 跳过重拉，其余调用点行为不变。
- `server.mjs`：新增内存 `archivedOverlay` 遮罩，归档成功即记入，`getSessionsForCwd` 与 `getWorkspaces` 改经 `archivedWithOverlay()` 过滤，并失效 `workspacesCache` / `hostRunningCache`；失败不记遮罩。

链入旧条：`.agents/notes/implemented/feature/2026-09-18-archive-opens-session-picker.md`（归档后开面板，交互终态保留，本次只改数据同步方式）。

## Alternatives considered

- **维持现状（归档后全量重拉）**：实现简单，但 loading 闪烁 + 残留数秒正是本次投诉，不接受。
- **仅前端乐观、不加服务端遮罩**：轮询与其他客户端仍可能在延迟窗口看到残留；服务端一次 Set 过滤成本可忽略，故双端同修。
- **归档按钮 loading 去掉、允许重复点击**：会引入重复归档请求；按钮禁用锁保留，仅列表侧取消 loading。

## Consequences

- 归档即列表终态：无 loading、无残留闪回；后端不一致才静默修正。
- 墓碑与遮罩均为小集合内存态（遮罩上限 500），刷新页面即清，不影响长期一致性。
