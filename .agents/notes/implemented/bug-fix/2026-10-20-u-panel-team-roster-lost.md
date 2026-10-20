# Agent Note: 修复 U 键多智能体面板团队队员与任务看板丢失

Status: implemented

## Problem

在用户通过物理按键 `U` 唤起多智能体与后台任务看板时，近期创建的 Agent Team 会话无法显示全部队员与任务看板（任务看板显示 0，队友被降级为无名泛化子Agent）。经排查存在两项核心缺陷：
1. **冻结 live 副本整体覆盖权威投影**：宿主 `session/list` 返回的 `projections.values.agentTeam` 与 `subagentCatalog` 是权威全量投影；但本地进程的 live 镜像（`lib/host-live-state.mjs`）中的同名字段仅为会话初创（`api-session/added` 帧）时的冻结副本（由于 `$events` 流仅事件化 `running` 运行态事实，从不事件化队员与任务看板变更）。旧合并逻辑 `mergeLiveSessionItems` 直接使用 live 镜像的不完整副本覆盖了宿主最新快照，导致新出现的队员与任务看板被冲刷清空；
2. **零团队投影时的回源补齐缺口**：在冷启动或快照过期窗口下，当会话持有子会话（`children.length > 0`）但尚未提取到任何团队投影（`teamMembers.length === 0 && teamTasks.length === 0`）时，未触发 C-21 定向 `session/projections` 回源，造成队友与看板静默缺失。

同时对于后台任务（one-shot 子智能体），若冻结副本中目录较旧，也会连带丢失后加的后台任务。

## Decision

1. **投影合并采用纯函数取舍优先级 (`lib/agent-team-projection.mjs`)**：
   - `pickAgentTeam(snapshot, live)`：任务看板条目数优先，其次成员数；完全相同时取快照（快照为权威回源结果，杜绝冻结副本倒退覆盖）；
   - `mergeSubagentCatalog(snapshot, live)`：以快照条目为基准，按 ID 并集追加 live 独有条目，防止后加后台任务丢失。
2. **扩展 C-21 回源判定条件 (`server.mjs`)**：
   - 增加 `(children.length > 0 && teamMembers.length === 0 && teamTasks.length === 0)` 判定，当存在子项但缺失团队数据时自动对父会话定向回源一次 `session/projections`。
3. **增加自动化契约测试与门禁验证**：
   - 在 `test-unit.mjs` 中新增 7d、7e、7f 测试用例，分别覆盖纯函数取舍规则、定向回源补齐、以及冻结 live 副本防遮蔽回归。

## Alternatives considered

- 方案 A：在 `$events` 流中增加自定义事件或轮询拉取队友状态。
  - 否决：违反 DSH 消费准则（解耦消费、不假设上游未约定的私有事件）；且 `session/list` 本身已有权威投影。
- 方案 B：恢复工作区全部跨会话聚合。
  - 否决：违反 2026-10-12 的会话严格隔离准则，会导致多会话互相串台。

## Consequences

- 按 `U` 键唤起面板后，Agent Team 会话的所有队员（包含角色、标签、运行态）与共享任务看板（包含进度、状态、负责人）100% 稳定恢复呈现。
- 后台任务（one-shot）与普通子智能体一同完整显示，不再被冻结副本截断。
- ES5 语法门禁、解耦断言与全量端到端测试均 100% PASS，生产服务验证通过。
