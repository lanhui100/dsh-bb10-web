# Agent Note: Agent Teams official RPC alignment and badges in multiagent board

Status: implemented

## Problem
在多智能体面板（快捷键 `U`）中，原实现仅从 `session/list` 的 `subagentCatalog` 读取子智能体。在开启 Agent Teams 的会话中：
1. `subagentCatalog` 仅记录一次性或普通可接续子会话，并不反映 Team 领域内的真正队友成员（teammates）及当前运行状态；
2. 缺失 DSH 官方 `agentTeams/view` 权威 RPC 调用，未能获取到队友角色（`role: "teammate"`）及其所属任务看板（task board）；
3. 前端界面无法准确呈现 `[Agent Team]` 徽标与团队成员清单，导致在具备 Agent Teams 的会话中面板显示空或仅能看到泛化的 `[子Agent]`。

## Decision
1. **服务端 RPC 对齐与数据融合 (`server.mjs`)**：
   - 在 `/api/session/subagents` 路由处理中，若指定了父会话 ID，首先调用 DSH 官方 RPC `agentTeams/view`（通过 `{ agentId: parentSessionId }` 载荷获取权威团队名单与任务列表）；
   - 将 `agentTeams/view` 返回的 `teammate` 成员作为高优先级条目注入子智能体列表，设置 `mode: 'team'`、`kind: 'Agent Team'`、`role: member.role`、`name: member.name` 以及对应模型和诊断信息；
   - 与既有 `subagentCatalog` 深度融合去重，确保普通子智能体、一次性后台任务与 Agent Team 队友并存且均能准确感知。
2. **前端徽标与小屏交互对齐 (`static/index.html`)**：
   - 保持严格 ES5 规范与 720x720 紧凑布局；
   - 根据条目的 `mode === 'team'` 或 `kind === 'Agent Team'` 渲染专属蓝色高对比度徽标 `[Agent Team]`；
   - 若存在关联任务看板，在多智能体看板顶部或对应分组中简明展示任务统计与就绪状态；
   - 点击任何 teammate 均可直接切入对应会话流。

## Alternatives considered
1. *仅由本地解析 session.v3.jsonl.zstd 提取 `team/member` 事件*：违反 DSH Web 消费边界准则第 0 条（优先走宿主 RPC 管道，与官方 Web 对齐）；且无法获得实时的运行状态（如 `idle` / `running` / `inactive`）与任务分配。
2. *新增独立快捷键面板展示 Team*：720x720 方屏快捷键资源极其珍贵，用户心智中多智能体（Subagent / Agent Team / Background Task）本是一体化协作看板，集中在 `U` 键展示更自然。

## Consequences
- 多智能体看板能够完整展现当前会话的 Agent Team 队友与任务状态；
- 与官方 DSH Web 的 `agentTeams/view` 状态保持单一权威事实来源。
