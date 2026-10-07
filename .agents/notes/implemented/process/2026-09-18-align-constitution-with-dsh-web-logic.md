# Agent Note: 宪法增补 dsh web 业务与核心逻辑对齐准则

Status: implemented

> 后续修订：本条所立之第六章已由 `.agents/notes/implemented/process/2026-09-19-dsh-consumer-decoupling-charter.md` 改题为《dsh 消费边界与对齐准则》，并增补第 0 条消费边界、两条管道、租约互斥及存储镜像豁免清单。

## Decision

在项目最高开发宪法 `AGENTS.md` 中新增第六章《业务与核心逻辑对齐准则（DSH Web 对齐原则）》，明确如下开发边界：

1. **环境可行性与展示层约束**：本项目受限于 BlackBerry Q20 物理硬件（$720 \times 720$ 方屏、双核 CPU、2GB RAM）及老旧 WebKit 537.35 内核，在 CSS 布局、ES5 纯语法、DOM 渲染节流与精简折叠上必须严格适配硬件约束。
2. **底层与业务逻辑对齐 `dsh web`**：
   - **状态管理语义对齐**：会话状态（`idle` / `running` / `stopped` / `done` / `error`）严格同构 `dsh web`（如 `SessionSnapshot`、`StateDot` 等模型），由单一状态源驱动前端控件；
   - **数据与协议对齐**：与服务端及宿主 RPC（`session/list`、`session/prompt`、`session/cancel`、`session/archive` 等）通信规范、参数形态、Transcript 解析与终态判定口径与 dsh 保持一致；
   - **对话流转与交互逻辑对齐**：多轮对话、中断取消、生命周期流转等行为语义与 `dsh web` 严格对齐，UI 可以针对小屏做极简展现，但核心逻辑与状态闭环绝不缩水。

## Alternatives considered

1. **仅在前端注释中零散提醒**：缺乏最高准则的约束力，后续扩展容易偏离官方 `dsh web` 的协议与状态机模型导致逻辑漂移，否决。
2. **完全复制 dsh web 前端代码**：现代前端依赖的大量 ES6+、React/Vite 及现代 DOM/CSS 无法在 BB10 运行，必须在展示层做降级和适配，不能直接套用，否决。

## Consequences

- 团队与 Agent 在后续开发、修 Bug 和功能演进时，拥有明确的“展示层适配硬件，核心层对齐官方”的双轨规范；
- 宪法章节编号顺延，原验收门禁顺延为第七章。
