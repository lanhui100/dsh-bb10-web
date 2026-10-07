# Agent Note: Adopt Ponygo Governance

Status: implemented

## Problem
随着 `dsh-q20-web` 项目面向 BlackBerry Q20 硬件约束、ES5 语法红线以及与 DSH 伴生架构演进的深入，需要一套结构化、零依赖、具备强约束与可追踪特性的工程治理机制，以避免无序重构、契约退化或规范遗忘。

## Decision
采纳 ponygo 工程治理元框架，落地 `.meta/` 与 `.agents/` 治理骨架：
1. 确立 `.meta/constitution/constitution.md` 作为工程命约真相源，与根目录 `AGENTS.md` 结合。
2. 引入 `.agents/notes/` 作为架构决策（ADR）与重要变更唯一流转记录，强制要求每次非平凡变更遵循“先 ADR 后代码”与“Alternatives considered”原则。
3. 设定项目治理等级成熟度目标为 L2，逐步实施静态门禁、自动化回归门禁与提交前检查。

## Alternatives considered
1. **纯手工维护文档与规则**：仅在根目录 `README.md` 或 `AGENTS.md` 累加文字，缺乏机器可校验的生命周期管理（proposed/implemented/rejected）、缺少统一成熟度阶梯评估，容易随迭代产生文档与代码脱节。
2. **重型规范流程体系（如敏捷平台/第三方重度 CLI）**：引入额外外部依赖与学习成本，不适合轻量级终端伴生工具项目。
3. **Ponygo 元框架（最终选用）**：单文件、零额外运行时依赖、强契约、贴合 AI coding 智能体协同。

## Consequences
- 项目新增 `.meta/` 与 `.agents/` 治理资产。
- 所有非平凡功能与架构调整均需在此体系下沉淀对应决策记录并配合自动化门禁验证。
