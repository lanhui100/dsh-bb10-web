# Agent Note: workspace-panel-shortcut-a-add-workspace

Status: implemented

Superseded-by: `.agents/notes/implemented/bug-fix/2026-09-22-ws-add-home-single-name-create-only.md`
（其 Decision-2 输入口径与 create-or-resolve 复用语义已被取代；RPC 优先/离线兜底/快捷键防碰撞部分继续有效）

## Problem

在 BlackBerry Q20 移动端操作中，用户在通过 `W` 物理快捷键打开工作区选择面板后，只能在既有的工作区列表中上下浏览与切换。当需要连接或新建一个项目目录（Workspace）时，没有在小屏终端上直接新增工作区的入口，必须依赖桌面浏览器端添加或手动操作配置文件。同时需对齐 DSH 官方 `WorkspaceRegistry.create` 与 RPC `workspace/create` 规范，避免工作区登记与会话账本脱节。

## Decision

1. **前后端接口对齐 DSH 官方规范**：
   - 在 `server.mjs` 中新增 `POST /api/workspace/create` 端点。
   - 优先通过 `callDshWebRpc('workspace/create', { path })` 将新增请求委托给官方 DSH Web 服务（3080 端口），保证全局工作区投影与实时 feed 同步。
   - 离线回退机制：当官方 DSH Web 服务未运行时，按照 DSH 官方规范校验并使用 `writeAtomic` 协议原子写入 `~/.dsh/storages/workspace.json`（更新 `tables.workspaces` 与 `global.workspaceIds`），确保离线可用。

2. **工作区面板交互与物理快捷键扩展**：
   - 工作区面板打开状态下（`isWsOpen === true`），新增物理快捷键 `A`（`code === 65`）支持，弹出 720×720 方屏适配的新增工作区弹窗（`#ws-add-overlay`）。
   - 严格的状态机防碰撞：`W` 面板打开时拦截 `A`，绝不穿透触发全局当前会话归档操作。
   - 弹窗输入框支持路径输入（兼容绝对路径与 `~/...` 家目录简写）；回车（`Enter`）提交，`Esc` 或取消按钮收起。
   - 提交成功后自动刷新工作区列表、切换至该工作区并无缝拉起会话面板，形成连贯交互闭环。

3. **严格遵守项目宪法**：
   - 前端代码 100% 保持 ES5 规范并通过 Acorn 解析门禁；
   - 样式遵循静态 HEX 颜色与绝对定位，适配 720×720 方屏。

## Alternatives considered

- **仅提供原生 Prompt 弹窗 (`window.prompt`)**：
  在老旧 BB10 WebKit 上原生系统 prompt 会中断全屏 Web 状态，弹出的系统对话框可能遮挡界面且样式割裂，快捷键体验差；因此采用与其他模态框一致的深色微型弹窗。
- **直写 `workspace.json` 不调用 DSH Web RPC**：
  若官方 DSH Web 在线运行，直接修改底层磁盘文件无法触发官方宿主内存更新与 Feed 广播，导致桌面端无法实时感知；因此优先走官方 `workspace/create` RPC 并在离线时原子落盘。
