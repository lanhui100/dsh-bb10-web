# Agent Note: ws-panel-d-remove-unregister-only

Status: implemented

Related: `.agents/notes/implemented/feature/2026-09-22-ws-panel-ungrouped-default-group.md`（移除后会话落袋口径）、租约互斥依据见消费边界（宿主接管后禁回退；404 子串分流在生产 sanitize 下语义靠 review）

## Problem

W 面板只有 A 新增，没有移除入口。用户要求加 D 键移除：必须先呼出确认弹窗，确认后方可移除；仅从 Workspace 列表注销，绝不删除文件夹与会话记录（对齐 dsh web：Delete 说明“文件夹与会话日志保留，其会话进 Ungrouped”）。

## Decision

1. **前端（`static/index.html`，ES5）**：新增 `#ws-remove-overlay` 确认弹窗（z-index 460，仿 archive-confirm 结构：✕/取消/移除三关闭路径）；`openWsRemove/closeWsRemove/executeWsRemove` 三函数（防连击、open/xhr/send 三处容错、按钮态必恢复）；**乐观删除（对齐归档链）**：确认即关弹窗、`pruneRemovedWsLocally` 本地先剔（wsList/wsSelect/sessCache 备份/徽章/重绘；仅删前选中才跟随 `selectWorkspace` 切新选中防错配，删光则清空聊天流），成功 `refreshWsList` 静默对账，失败 `rollbackRemovedWsLocally` 回滚（wsList/wsSelect-option/sessCache/选中/跟随过的聊天流复位）；W 面板内 D 键（`code === 68`）取 `wsNodes[kbWsIdx]` 的 cwd+name 呼出确认，与面板 A 键同级拦截（不穿透全局归档）；确认弹窗 Enter/X/Esc/C 键态 + Esc 链首位；hint 与 help 同步“D 移除”；
2. **服务端（`server.mjs`）**：新增 `POST /api/workspace/remove { cwd }` + `removeWorkspaceByCwd`：按 canonical 查注册表得 workspaceId → 优先宿主 `workspace/delete` → 仅不可达时本地原子删注册（`tables.workspaces` + `global.workspaceIds`）；宿主拒收直接抛错禁回退；全程不碰目录；未注册 → 404；
3. **测试（`test-unit.mjs` 2a2）**：缺参 400、幽灵 404、真实移除→目录保留→注册表无残留→同名重建 409（证明仅注销）、清理幂等、前端接线针 8 项。

## Alternatives considered

- **复用 archive-confirm 弹窗**：归档是会话级、移除是工作区级，pending 状态与执行链不同槽；混用易串台；故独立弹窗独立状态。
- **移除同时删空目录**：用户明令“不是删除文件夹”；且官方 delete 语义即保留；删目录不可逆，Q20 小屏误触代价高；故绝不删。
- **D 键直接执行无确认**：与 A 归档（需确认）不对称；误删后需重建注册（虽可恢复但扰民）；故必须确认。
