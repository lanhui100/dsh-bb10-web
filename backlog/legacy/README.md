# legacy/ —— 冻结历史（只读，不参与 lint / doctor）

本目录存放**已被 `backlog/tasks.jsonl` 取代的旧待办载体原貌**。冻结时间：2026-11-13（`backlog:B006`）。
冻结后不改一字：需要引用其中的事实时按路径引用，不要在原件上补状态或改字——状态真源是活账本。

## 冻结映射（旧路径 → 冻结路径）

| 旧载体 | 冻结路径 | 承载的事实 | 处置理由 |
|---|---|---|---|
| `.dev-team/state.json` | `dev-team/state.json` | 6 个波次的基线/红/绿提交、根因、评审计数（冻结时全部 `completed`） | 它是 v2 账本落地前唯一「任务板状态」，与账本状态轴冲突；证据价值高（波次溯源），故冻结而非删除 |
| `.dev-team/review-plan.json` | `dev-team/review-plan.json` | preview-policy 波次的评审计划与 findings 清单（被 contract §信任边界、RED-PHASE 引用） | 待办型产物（findings = 候选工作），开放项已迁账本；原件留证据 |
| `.dev-team/review-plan-r4.json` | `dev-team/review-plan-r4.json` | 第 4 轮评审计划 | 同上（中间轮次快照） |
| `.dev-team/review-plan-r8.json` | `dev-team/review-plan-r8.json` | 第 8 轮评审计划 | 同上 |
| `.dev-team/review-incremental.json` | `dev-team/review-incremental.json` | 增量评审计划 | 同上 |
| `docs/GLOBAL_AUDIT_REPORT.md` | `reports/GLOBAL_AUDIT_REPORT.md` | 2026-09-19 全局审计快照（安全 V1–V12、降载路线图 P0–P2、§六 路线图） | 其「仍开放 / 阻塞 / 路线图」章节是旧待办清单；开放项迁入 `B007`–`B022`，原件作为历史证据冻结 |
| `docs/ALIGNMENT_AUDIT_REPORT.md` | `reports/ALIGNMENT_AUDIT_REPORT.md` | 2026-09-18 对齐审计快照（P0–P4 路线图 + 审计发现） | 同上；开放项迁入 `B007`–`B012` |

## 迁移口径（诚实边界）

- **只迁「仍开放 / 部分落地」的项**：已落地条目（如官方跟随流、pendingInteraction、状态色系、
  local hooks、gzip、ETag/304、V3/V4/V8/V10 代码侧）不新建记录——旧文档的「未完成」叙述是快照时点的真话，
  不是当前事实。各项现状判定与其 file:line 证据写在账本对应记录的 `description` 里。
- **旧报告的指针不重写**：`.agents/notes/implemented/**`、`.dev-team/contract-wave-*.md`、
  `tests/acceptance/RED-PHASE.md` 中对被冻结路径的引用保持原貌（冻结即法律）；本文件是唯一授权映射。
- **未冻结的 `.dev-team/` 内容**是契约与机器证据，不是待办载体：`contract-wave-*.md` 是
  `lib/*.mjs` 与 `tests/acceptance/*` 的「契约唯一来源」，`review-*.json` / `receipts/` / 基线是 ADR 与
  NFR 的证据锚点。它们原位保留，见 `.dev-team/README.md`。
- **恢复条件**：仅当活账本被整体废弃且需要回放旧待办时，才把对应冻结件拷回原位；本目录的冻结件
  不得被重新当作状态源（恢复即重新立法，须新 ADR）。
