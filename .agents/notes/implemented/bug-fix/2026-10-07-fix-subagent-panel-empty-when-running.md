# ADR: 修复 U 键子智能体面板在存在运行中 Agent Team 时显示无子智能体的问题

Status: implemented

## 上下文与问题陈述
在项目中，当存在运行中的子智能体或 Agent Team 成员时，用户通过物理快捷键 `U` 唤起多智能体看板时，面板却显示“当前会话暂无子智能体 / Agent Team / 后台任务”或者未正确标记正在运行的角色。

## 根因分析
1. **服务端运行态判定遗漏**：
   在 `server.mjs` 的 `getSessionSubagents` 中，DSH 官方在会话投影中上报团队成员对象 `teamMember` 时，运行态通常为 `teamMember.phase === 'active'` 或 `ch.running === true`，而非单一的 `teamMember.status === 'running'`。原先仅判定 `m.status === 'running'`，导致状态计算被降级为 `'done'`。
2. **多智能体看板空状态回退门禁拦截**：
   在 `static/index.html` 的 `loadSubagents` 中，原逻辑为：
   `if (isEmpty && sid && !data.page) { loadWorkspaceSubagentsFallback(...) }`
   由于服务端在 `/api/session/subagents` 接口总是注入切片分页对象 `data.page`，导致 `!data.page` 恒为 `false`！
   当当前选中的会话自身无子智能体时，回退到工作区智能体列表的逻辑被该门禁完全截断，直接进入了空列表分支，呈现出“暂无子智能体”。
3. **工作区级团队任务漏聚合**：
   在 `server.mjs` 的 `getWorkspaceSubagents` 中，原逻辑直接返回 `tasks: []`，未聚合工作区内带 `agentTeam.tasks` 的任务列表，导致工作区看板上完全丢失正在运行的看板任务。

## 解决策略与实施
1. **完善状态机与属性映射**：
   - 在 `getSessionSubagents` 中，对 `teamMember` 和补录成员均判定 `m.status === 'running' || m.phase === 'active' || !!ch.running`，确保真实运行中的 Agent Team 成员被准确赋予 `running: true` 与 `state: 'running'`。
2. **放通回退链路**：
   - 在 `static/index.html` 中移除 `!data.page` 阻碍，只要当前会话无子任务，无缝回退加载工作区级子智能体与任务板，并标明“👥 多智能体 · 工作区全部”。
3. **工作区级聚合团队任务**：
   - 在 `getWorkspaceSubagents` 中，遍历工作区内所有带 `agentTeam.tasks` 投影的会话并汇总任务，使工作区概览面板拥有完整任务板。
4. **文案清晰化**：
   - 区分会话级与工作区级文案，去除歧义。

## 替代方案考虑 (Alternatives considered)
- **只在服务端做全局兜底合并**：如果在 `getSessionSubagents` 强行将工作区其它子代理混入单个会话返回，会破坏单会话上下文隔离与点击后返回主会话（`subagentParentSession`）的语义。保持两级上下文并在前端感知 fallback 是最优架构设计。

## 门禁验证
- Acorn ES5 语法门禁：PASS
- `test-decoupling.mjs`：PASS
- `test-suite.mjs`：7/7 全量 PASS
