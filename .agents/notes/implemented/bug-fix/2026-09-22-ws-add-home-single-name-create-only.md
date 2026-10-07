# Agent Note: ws-add-home-single-name-create-only

Status: implemented

Supersedes: `.agents/notes/implemented/feature/2026-09-19-workspace-panel-shortcut-a-add-workspace.md`
（取代其 Decision-2 输入口径“绝对路径/~/多段”与服务端 create-or-resolve 复用语义；其 RPC 优先/离线兜底/快捷键防碰撞部分继续有效）

## Problem

W 面板 A 键新增工作区弹窗仍接受绝对路径/任意相对路径输入，与“默认就是 ~/ 之下、仅填 workspace 名称”的要求不符；且用户反馈输入完毕点创建/按 Enter 无响应。另需覆盖 Linux/macOS/Windows 三系统目录名合法性（Windows 保留名、尾点、非法字符集），与 ~/ 下既有文件夹冲突时必须拒绝创建。

## Decision

1. **前端（`static/index.html`，严格 ES5）**：
   - 弹窗改为 `~/` 固定前缀 + 单名输入框（占位 `workspace名称`），实时预览 `~/<name>`，仅接受单个目录名，不再接受绝对路径或多段路径；
   - 新增 `wsAddValidateName`：禁空、>64 字符、`.`/`..`、`/ \ : * ? " < > |` 与控制字符、首尾空白 trim（输入填充），trim 后尾点、Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`，含扩展名变体）；
   - 新增行内报错 `#ws-add-err`（替代原来只写状态栏、弹窗内无感知的断层）+ 确认按钮防连击（提交中禁用，归来必恢复）+ `open/xhr.send` 双 try 兜底 + Enter 阻断冒泡（防全局快捷键吞提交）。
2. **服务端（`server.mjs`）**：
   - 新增 `validateWorkspaceName`（与前端同语义，服务端权威）：首尾空白 trim（输入填充），禁空、>64 字符、`.`/`..`、`/ \ : * ? " < > |` 与 C0 控制字符、trim 后尾点、Windows 保留名（含扩展名变体）；
   - 新增 `createHomeWorkspace(name)`：严格 create-only，先 `statSync` 判冲突（文件/目录均拒），`mkdirSync` 原子占位（`EEXIST` 竞态同样转 409），后继任一步失败删空目录回滚；
   - 登记前查注册表残留（删目录未注销的僵尸记录同样视为重复，拒绝复用）；
   - 宿主 RPC 拒收（非 unreachable：duplicate/校验失败）直接抛错，严禁回退离线直写撞锁；仅宿主不可达（`ECONNREFUSED`/超时/`502/503`）走离线原子落盘；离线写失败同样回滚空目录；
   - `/api/workspace/create` 新契约 `{ name }`，重复 → `409`（文件/目录/注册三源），旧 `{ path }` 仅兼容恰好落在 `~/` 下的一段子目录，其它路径一律 `400`。
3. **测试（`test-unit.mjs` 2a 用例）**：14 组非法输入 `400`、创建落点 `~/<probe>`、重复/旧 path 兼容 `409`、宿主 `workspace/delete` 清理断言、注册表零残留断言、前端接线针（`ws-add-preview/ws-add-err/wsAddValidateName/JSON.stringify({ name: name })`）与陈旧绝对路径提示词根除断言。

## Alternatives considered

- **保留 `{ path }` 任意路径 + 服务端 `realpath` 归一**：用户可填 `/tmp` 等任意目录，违背“默认 ~/、仅填名称”；且旧逻辑“目录不存在即 400”使用户无法一键建新目录，体验断裂；故切 create-only 单名。
- **重复时静默复用/绑定既有目录（旧 `created:false` 分支）**：用户显式要求“不能跟现有 ~/ 文件夹冲突”，复用会掩盖输错名，且把他人目录绑进工作区有越权观感；故三源（文件/目录/注册）一律 `409`。
- **宿主拒收后回退本地直写**：宿主已接管会话时本地写会撞写租约（消费边界互斥），且宿主内存/落盘以其拒收为准，本地强写造成双源分歧；故仅 unreachable 回退。
- **只修前端校验、服务端保持旧 path 契约**：旧客户端/脚本仍可直调任意路径创建，约束只在 UI 层，一绕即破；故服务端同步收紧为权威校验。
