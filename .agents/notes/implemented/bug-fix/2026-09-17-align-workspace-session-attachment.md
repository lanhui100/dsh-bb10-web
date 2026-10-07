# Agent Note: Align Workspace Session Attachment with Official DSH Logic

Status: implemented

## Problem
在 BlackBerry Q20 浏览器上操作新建会话并选择 `dsh-q20-web` 工作区后，在官方 DSH Web GUI（http://127.0.0.1:3080）中查看时，该新会话并未出现在 `dsh-q20-web` 工作区树下，而是被归到了“未分组”（Ungrouped）下。

经过排查对比：
1. **DSH 官方会话归属逻辑**：
   - 官方由 `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry` 和 `@deepseek-ai/dsh-api-session-controller` 控制。
   - 工作区数据源是 `~/.dsh/storages/workspace.json`。
   - 工作区成员资格要求（`packages/workspace/workspace/README.md` & `docs/subsystems/workspace.md`）：
     “所有权的真源是记录中有序的 `sessionIds`，绝不从会话 cwd 派生——但成员资格要求两者同时成立：账本上有其 id，且 header 的规范 cwd 等于工作区路径”。
   - DSH 官方在创建会话时，由 `session-controller` 执行 `await workspace.attachSession(sessionId)`，该方法调用 `realpathNormalize` 校验 session header 的 cwd，并将 `sessionId` 原子写入工作区记录的 `sessionIds` 列表最前位置（`sessionIds: [sessionId, ...record.sessionIds]`），同时更新 `updatedAt`。
   - `ui-workspace` 在渲染左侧工作区树时（`tree.ts` 的 `groupByWorkspace`），遍历 `workspaces` 的 `sessionIds`。凡是不在任何工作区 `sessionIds` 中的会话，无论其 cwd 在哪里，统一归入 `UNGROUPED_KEY`（“未分组”）。
2. **`dsh-q20-web` 原有逻辑**：
   - Q20 服务端直接通过 SDK `harness.run(..., { sessionId })` 启动会话；
   - 会话创建并在磁盘写入 `jsonl.zstd` 后，Q20 服务端**从未调用 DSH 工作区逻辑将 `sessionId` 挂载（attach）到对应的 Workspace**；
   - 导致该会话在 `workspace.json` 中不存在，因此在 DSH Web 中被判定为 stray session，落入“未分组”。

## Decision
直接复用并严格对齐 DSH 官方实现：
1. 复用 DSH 官方库 `@deepseek-ai/dsh-workspace` 导出的权威函数：
   - 引入 `realpathNormalize` 进行规范路径对齐与校验；
   - 引入 `writeAtomic`（与 DSH 官方 `storage-json` 和 `util/atomic-write` 完全一致的临时文件 + fsync + 原子 rename 机制）；
2. 实现官方对齐的 `attachSessionToWorkspace(targetCwd, sessionId)`：
   - 根据传入的 `targetCwd`，通过 `realpathNormalize` 匹配 `workspace.json` 中对应的官方工作区记录；
   - 检查该会话的 session header，校验其 `cwd` 确实规范解析到该工作区路径；
   - 若校验通过且 `ws.sessionIds` 尚未包含该 `sessionId`，则按照官方行为将其插入到 `sessionIds` 头部，更新工作区的 `updatedAt` 时间戳，并通过原子写刷回 `~/.dsh/storages/workspace.json`；
   - 同步刷新内存中的 `workspaceDomainCache`。
3. 在会话初次创建成功时调用挂载逻辑：
   - 在 `/api/chat/stream` 中，当收到首轮对话产生的 `result.sessionId` 且该会话此前未挂载时，调用 `attachSessionToWorkspace(targetCwd, result.sessionId)`；
   - 在执行前如果客户端预分配或显式指定了 `sessionId`，在首轮交互确保落盘时完成挂载。

## Alternatives considered
1. **仅在 Q20 自身维护 cwd 关联而不写入 `workspace.json`**：
   - 无法解决 DSH 官方 Web 显示“未分组”的根本问题，违背了“以 dsh 的实现为准，与官方互通”的架构要求。
2. **完全启动 Cordis Context 加载整个 `WorkspaceRegistry` 服务**：
   - `dsh-q20-web` 是专为黑莓 Q20 设计的轻量级伴生服务，其依赖树与 Cordis 容器隔离；加载整个 Cordis 服务树启动代价高且存在插件依赖缺失。直接复用 `@deepseek-ai/dsh-workspace` 导出的实体逻辑、规范路径方法与原子存储协议，既保证行为 100% 官方一致，又保持 Q20 端的轻量与高响应性。

## Consequences
- 在 Q20 浏览器上新建并选择 `dsh-q20-web`（或任何工作区）发起的会话，都会严格按照官方规范被原子登记到对应工作区的 `sessionIds` 中。
- 刷新官方 DSH Web（http://127.0.0.1:3080）后，该会话将正确出现在对应工作区下，不再掉入“未分组”。

> **部分取代（2026-09-17）**：本条的直接写路径已被 `../architecture/2026-09-17-drive-conversations-through-dsh-host-rpc.md` 取代——宿主在线时归属改由宿主经 `session/create` 写入，本条直写仅在宿主离线兜底时保留。原因：宿主运行期以内存为权威、不再读镜像文件，直写对官方 Web 不可见且会被宿主下一次写回覆盖。
