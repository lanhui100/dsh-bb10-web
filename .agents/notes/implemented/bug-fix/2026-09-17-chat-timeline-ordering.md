# Agent Note: 历史与流式消息按 dsh web 时序交错渲染

Status: implemented

## Decision

Q20 历史（`GET /api/history`）与运行中流式（`doSend`/`attachSession`）的消息渲染改为与 dsh web 相同的时序逻辑：以会话事件全局 `seq`（文件即 `seq` 增序）为唯一排序依据，同一 step 内按 `assistant/message` 的 `content` 块序（reasoning/text/tool-call）输出，不再按类型分组聚合。

- `server.mjs:getSessionHistory` 改为输出扁平 timeline：`user/message(kind=user)` 逐条为 user 节点；`assistant/message` 按 `(turn,step)` 分组为 assistant 节点，节点内 `blocks` 数组严格按 `content` 块序（`{kind:'thought'|'text'|'tool'}`），tool 的 `status/output` 由 `tool/result` 按 `callId` 回填。旧字段（`text/thought/tools`）保留拼接值以兼容回归断言。
- `static/index.html:renderWindowedMessages` 按 `blocks` 到达序渲染子节点（思考卡/工具胶囊/正文段交错），不再固定思考→工具→正文堆叠。
- `static/index.html:doSend` 与 `attachSession` 的 live 事件改为按到达类型切换追加段（thought/tool/delta 各归其位），取代 `insertBefore` 固定容器。
- dsh web 侧的 turn-process 折叠、tool 嵌套子树等桌面端复杂能力不引入；只对齐"按 seq 时序、块内保序"这一条。
  - 后续部分取代：2026-09-18 起 turn-process 折叠按 Q20 小屏适配形态引入（单 assistant 节点内过程折叠、中文工具标题），见 `.agents/notes/implemented/feature/2026-09-18-tool-title-zh-turn-process-fold.md`。

## Alternatives considered

- 按 step 切更小的气泡但仍分组渲染：未解决同 step 内"正文被压到工具下"的问题，否决。
- 后端保持轮次聚合、仅前端重排：后端聚合已丢失块序信息，前端无法恢复，否决。
- 全量照搬 dsh web assembler/React 视图层：与 ES5/Q20 小屏约束冲突，否决；只取时序规则。
