# Agent Note: backlog v2 账本落地与旧待办载体退役

Status: implemented

## Problem

本仓此前**没有单一待办真源**：待办散落在四类临时载体里——`.dev-team/state.json` 的波次任务板状态、
`.dev-team/review-plan*.json` 的评审 findings 清单、`docs/GLOBAL_AUDIT_REPORT.md` / `docs/ALIGNMENT_AUDIT_REPORT.md`
的「仍开放 / 阻塞 / 路线图」章节、以及 `.agents/notes/proposed/` 的未闭环提案。后果是三重的：

1. **状态轴无权威**：同一个「某件事做没做」要从多份快照里交叉推断，快照时点的「未完成」与当前源码事实
   已经不一致（实测：旧报告判为 P1 的「官方跟随流」、P3 的「等待态/状态色系」均已落地）；
2. **无机器校验**：没有任何命令能回答「待办记录是否合法、有没有孤儿状态」；
3. **物理承载未被取代**：`backlog/tasks.jsonl` 虽已被前序会话建立（5 条文档 tier 缺口），但没有 CLI / 契约 /
   门禁，记录连 `metadata.fingerprint` 都缺，`lint` 无从谈起——账本存在但不成立。

## Decision

前序与关联：待办来源的审计基线是 `.agents/notes/implemented/architecture/2026-09-19-global-audit-and-load-roadmap.md`
与 `.agents/notes/implemented/architecture/2026-09-18-dsh-web-alignment-audit-and-roadmap.md`；其原始报告
（`docs/GLOBAL_AUDIT_REPORT.md` / `docs/ALIGNMENT_AUDIT_REPORT.md`）随本决策冻结。治理体检提案
`.agents/notes/proposed/process/2026-09-29-governance-audit.md` 的「留待用户定夺」残项另立 `backlog:B012` 收口，
本 ADR 不改其状态（拆条不代签）。

按框架基线（ponygo 实例版，账本模型 = pg-backlog v2）**落地账本体系并退役旧载体**，一次变更内完成：

1. **判定真源随仓**：`scripts/backlog.mjs`（`ID_FLOOR = 1`，本仓首批编号不跳到 B056；不搬运上游的
   `import-triage` / `normalizeLegacy`——本仓无旧 md 账本载体，无消费者即不引入）。
2. **契约与门禁**：新增 `backlog/README.md`（布局/字段/状态机/租约/归档/编号/迁移口径）；
   `.meta/gates/backlog-gate.sh`（= `lint` + `doctor`）与 `.meta/gates/backlog-gate.spec.sh`
   （P1–P5 + N1–N8 + H/H2，其中 P5 按本仓现实接线：CI = `ponygo-governance.yml` 的 `governance` job、
   本地 = `.githooks/pre-commit`）；
   接线三处：`.githooks/pre-commit` 在 ponygo 哨兵块**之外**追加 fail-closed 调用、CI 增加门与 spec 两个 step、
   `.meta/gates/INSTANCE-GATES.md` 登记「承诺 → 命令」；`.gitignore` 排除 `backlog/.locks/`。
3. **旧待办迁移**：`B001`–`B005`（文档 tier 家缺口）补齐 `fingerprint` / `source_ref` / `description` 规范化；
   从旧载体迁入 **16 条仍开放 / 部分落地项**（`B007`–`B022`，逐条 `source_ref` 指回冻结原文，
   已落地项的 file:line 证据写在记录 `description` 里；`source_ref` 指向**冻结后的路径**，原路径只作为历史指针留在历史文档中）。**已落地项不建记录**：旧快照的未完成叙述是
   快照时点的真话，不是当前事实（实测已闭环：官方跟随流、pendingInteraction、状态色系、local hooks、
   gzip、ETag/304、V3/V4/V8/V10 代码侧、原两处骨架漂移）。
4. **物理承载退役**：`.dev-team/state.json` 与 `review-plan*.json`、两份审计快照 → 冻结到
   `backlog/legacy/`（原貌一字不改，映射表 = `backlog/legacy/README.md`）；`.dev-team/` 降级为只读证据区
   （新增 `.dev-team/README.md` 声明「不是待办载体」）。**冻结而非删除**的原因：它们是 ADR / NFR /
   契约的引用锚点（`contract-wave-*.md` 是 `lib/*.mjs` 与 `tests/acceptance/*` 的「契约唯一来源」，
   `receipts/` / 基线是交付收据），删除会切断可追溯性。
5. **可清理项清理**（本轮唯一的直接删除面）：`.meta/meta.yaml` 重复的 `ai-surface: on` 键、
   `.githooks/pre-commit` 末尾游离的重复哨兵 END 标记（哨兵块已在首个 `fi` 后闭合，重复行使 2.4 字节比对失真）。
6. **留痕**：本条 ADR + `backlog:B006`（record → 验收后 resolve，`evidence` 为门禁退出码）；
   文档家同步：`docs/AGENTS.md` 放置速查补「待办→backlog/tasks.jsonl」、根 `README.md` 增
   「Backlog & Change Workflow」节。

## Alternatives considered

1. **继续沿用 `.dev-team/` 波次状态 + 审计报告路线图作待办源**：拒绝。快照无法收敛（同一事项在不同快照里
   状态冲突），且没有机器校验；账本与本方案是同一个新体系，二者并存只会制造双状态源。
2. **整目录删除 `.dev-team/`（含契约与收据）**：拒绝。`contract-wave-*.md` 被 `lib/` 与验收套件当作
   契约唯一来源引用，`receipts/` / 基线是 ADR 与 NFR 的证据锚点；删除即断链，违反「删除代码前先搜消费者」。
3. **逐条重写历史文档（ADR / 契约 / RED-PHASE）中被冻结路径的引用**：拒绝。冻结件与历史记录**保持原貌**
   （冻结即法律），路径映射集中登记在 `backlog/legacy/README.md`；原件是当时事实的凭证，改指针等于重写证据。
4. **搬上游 CLI 的 `import-triage` / `normalizeLegacy` 与编号下限 56**：拒绝。本仓没有旧 md 任务单可 triage，
   无消费者即死代码；且首批编号从 B001 起，保留 56 会让首次 `record` 凭空跳到 B056（spec P2 已看守）。
5. **把 16 条迁移项直接写成 `done`（以「旧报告说做了」为证据）**：拒绝。证据必须可被人复跑；旧报告的
   「做完了」与当前源码不对应（如 V3/V4 已落地、P1 跟随流已落地），故按现状取证后**只迁开放项**。
6. **只落账本、不退役旧载体**（账本与 `.dev-team/` 并存）：拒绝。双状态源正是本 ADR 要消灭的问题，
   正中「每个事实一个家」。

## Consequences

- 待办唯一真源 = `backlog/tasks.jsonl`；状态机（`todo→in_progress→done`，`done` 只经 `resolve`）与租约
  （`owner` + `touched_paths`）由 CLI 强制，`lint`/`doctor` 守住记录不变量与跨归档对账。
- 旧载体冻结后，历史文档里的旧路径**引用会指向不存在的位置**——这是冻结的已知代价，映射表是唯一授权入口；
  恢复条件写进 `backlog/legacy/README.md`（重新立法须新 ADR）。
- `.dev-team/` 的证据文件保留原位，只被 `lib/` / `tests/` 的契约注释与 ADR 引用，不再承担状态职能。
- 账本当前 22 条活跃（B001–B022），最高优先级是 `B007`（P0：isStreaming 双轨状态机残项 + Stop 防连击）；
  门禁接线后，任何账本违规提交在本地与 CI 两层都会被拒（`--no-verify` / 缺少 `core.hooksPath` 时仅 CI 兜底）。
- 诚实边界：`lint`/`doctor` 不解析 git 历史，无法识别「同时改记录与高水位」的伪装；spec 只证明门会拒绝
  非法样本，账本内容的真实性靠 review。
