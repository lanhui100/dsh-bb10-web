# Agent Note: Drive Conversations Through the DSH Host RPC

Status: implemented

相关旧条：`implemented/bug-fix/2026-09-17-align-workspace-session-attachment.md`（直写 `workspace.json` 方案）。本条取代其中"在线时的归属写路径"部分；直写降级为离线兜底，仍保留。

## Problem

旧对齐方案在会话落盘后由 Q20 服务端**直接改写** `~/.dsh/storages/workspace.json`，把 `sessionId` 原子插到工作区 `sessionIds` 头部。但该文件只是宿主 `WorkspaceRegistry` 的持久镜像：宿主启动时载入内存后即为权威态，运行期间不再读盘。于是：

1. Q20 直写后，官方 DSH Web（运行中的宿主）并不感知，会话仍显示在"未分组"，直到宿主重启；
2. 宿主对任意工作区事件的下一次写回会以内存态覆盖 Q20 的直写，归属可能凭空丢失；
3. 两个写者竞态写同一镜像文件，本身违背"宿主是唯一权威写者"的 DSH 架构。

进一步实验确认了约束：宿主对它经 RPC 创建或收养的每个会话**立即并长期持有** `session.lock` 写租约（`flock`，随 agent 生命周期、宿主退出才释放；无空闲回收）。因此"事后用 `session/create` 补挂载、同时继续用本地 SDK 子进程续写"不可行——子进程下次打开会话必然撞锁（`SessionAlreadyOwnedError`）。

## Decision

对齐 dsh web 的逻辑 = **在线时把对话本身驱动在宿主上**，Q20 退化为纯远端 UI，与官方 Web GUI 走完全相同的 RPC 面：

1. `session/create`（`{sessionId, workspaceId}` 或无主目录时 `{sessionId, cwd}`）：宿主创建/收养会话并**在此写入工作区归属**（`workspace.attachSession`：cwd 规范校验 + prepend 账本 + 原子持久化 + feed 推送）。归属写路径回到唯一权威写者。
2. `session/selectModel`：与子进程模式 per-run provider/model 语义一致。
3. `/api/remote.mux` WebSocket mux 上打开 `session/follow` 流，`session/prompt`（收据式）提交回合；durable 事件（`assistant/message`、`tool/*`、`turn/end`）驱动既有 SSE 映射（delta/thought/tool），`turn/end` 收尾。
4. `session/cancel`：中止宿主侧当前回合。
5. **回退协议（绝不盲目回退）**：宿主从未接管会话（create 前不可达）或宿主已确认宕机（租约随进程消亡）→ 回退本地 SDK 子进程引擎，并保留旧 ADR 的 `workspace.json` 直写作离线兜底；宿主已接管后的任何失败 → 直接任务错误，不回退（子进程必然撞锁）。
6. "运行中"判定修正：flock 被占在宿主在线时只说明"宿主持有租约"（空闲也持有），须以宿主 `session/list` 的 `running` 标志复核；宿主不可达时保持旧语义。

## Alternatives considered

1. **维持直写，等宿主重启收敛**：即旧 ADR 现状。被否——用户可见的"未分组"要靠重启消失，且双写者竞态是数据丢失源，没有消除。
2. **事后 RPC 补挂载 + 保留子进程续写**：实验否决——宿主 create/adopt 即持锁，子进程下次续写必撞 `SessionAlreadyOwnedError`；"补挂载"产生比问题本身更严重的功能回归。
3. **仅在浏览器展示层按 cwd 归组**：显示与账本分叉，官方侧边栏拖拽/归档等写操作对未入账会话全部失效，两套真相正是本次要消除的分歧。
4. **让 DSH 宿主连续按 cwd 收养未入账会话**：需要改 `deepseek-harness`，违背"当前项目对齐 dsh web、dsh web 不动"的方向。

## Consequences

- 在线时新建/续接的对话，在官方 DSH Web 侧边栏**实时**归入正确工作区（宿主 feed 推送，无需刷新或重启）；
- Q20 不再是镜像文件的写者（离线兜底除外），双写者竞态消除；
- 被宿主接管的会话，Q20 与官方 Web GUI 天然共享同一写者——跨端续接、归档、标题等状态一致；
- 新增对 `ws` 模块（宿主 checkout 自带）与 `/api/remote.mux` 帧协议的运行时依赖；宿主离线时行为与旧版完全一致。
