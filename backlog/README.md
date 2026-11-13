# backlog/ —— 本仓唯一活账本（待办与执行记录）

> **判定真源 = `scripts/backlog.mjs`**（`validateRecord` / `lint` / `doctor`）。本文是它的可读契约：
> 冲突时以代码与命令输出为准，本文只描述模型，不复刻判据细节。
> 跨仓通用操作口径见 skill `pg-backlog`；本仓特化事实（迁移来源、接线、编号口径）只在这里。

## 布局

| 路径 | 角色 | 入仓 |
|---|---|---|
| `backlog/tasks.jsonl` | 唯一活账本，一行一任务（`todo` / `in_progress`） | ✅ |
| `backlog/archive/tasks-<YYYY>.jsonl` | 闭环滚动归档（`resolve` 幂等追加，按 `closed_at` 年份切片） | ✅ |
| `backlog/.next-id` | ID 高水位 = **下一个候选编号**（单调不减，永不回退） | ✅ |
| `backlog/.locks/<ID>.lock` | 任务级租约（pid/会话/心跳，**本地运行时**） | ❌ 已 gitignore |
| `backlog/legacy/` | 冻结历史（旧待办载体原貌 + 迁移映射），只读、不参与校验 | ✅ |
| `backlog/README.md` | 本契约 | ✅ |

`backlog/` 之外**不再有任何待办载体**：`.dev-team/state.json`、`review-plan*.json` 与两份审计报告快照的
「开放项 / 路线图」章节已于 2026-11-13 冻结进 `backlog/legacy/`（映射见 `backlog/legacy/README.md`）；
`.dev-team/` 降级为只读证据区（见 `.dev-team/README.md`）。

## 记录模型

- 必填：`id`（`B\d{3,}`）/ `category`（`Defect|Task|Debt`）/ `priority`（`P0..P3`）/
  `status`（`todo|in_progress|done`）/ `title` / `created_at` / `metadata.fingerprint`。
- 条件必填：`in_progress` → `owner` + `touched_paths`（≥1）；`done` → `evidence` + `closed_at`。
- 可选：`description`（≤2000 字符）、`source_ref`（来源指针：旧载体路径 / 会话标识，CLI 用 `--session` 写入）、
  `updated_at` / `leased_at` / `heartbeat_at` / `archived_at`、`metadata.occurred_count|triage_context`（≤8KiB）。
- `record` 的 `--fingerprint` **必须显式提供**（缺省 → exit 1）：指纹是去重键——同指纹且仍在活跃池
  时 `record` 不新建，而是把 `metadata.occurred_count` +1 并打印「去重命中」。
- 未知字段一律拒绝（`TOP_KEYS` / `META_KEYS` 白名单）——加字段是改契约，须同批改本文与 CLI。
- ID 分配：候选编号 = `max(高水位, 活跃∪归档已见最大编号 + 1, ID_FLOOR)`，本仓 `ID_FLOOR = 1`。
- 账本根默认由 git common dir 解析（同仓所有 worktree 共享一份账本）；夹具/CI 可用
  `PONY_BACKLOG_ROOT=<目录>` 覆盖。

## 编号口径

- `B001`–`B005`：文档体系 tier 家缺口（2026-11-12 首建，2026-11-13 补齐 `metadata.fingerprint` /
  `source_ref` / `description` 以通过 `lint`；标题与事实未改）。
- `B006`：本次自动迁移动账户（账本落地 + 旧载体退役），闭环后归档。
- `B007`–`B022`：从旧载体迁入的 16 条开放/部分落地项，逐条 `source_ref` 指回冻结原文；
  判定依据（已落地项的 file:line 证据、残项缺口）写在各自 `description`。
- 下一次 `record` 从 `B023` 起。编号永不复用：归档/删除都不回退高水位。

## 状态机

`todo → in_progress → done`，允许 `in_progress → todo`（`release`）。**`done` 只能由 `resolve` 写入**
（写入证据、追加归档并释放租约；从 `todo` 直接闭环也合法）。活跃池残留 `done` 由 `lint` 判违规。

手改 JSONL 的状态跳变不被 CLI 拦截，但「记录非 `in_progress` 却仍持锁」会被 `lint`/`doctor` 判违规。
会话中断后用 `owner` / `touched_paths` / `description` 与 `git diff --stat` 交叉确认真实进度——
**不维护任何 plan 文件**。

## 租约（并发控制）

- `start` 以 `O_EXCL` 原子获取 `<ID>.lock`：同一任务同时只允许一个会话；`heartbeat` 刷新；
  `release` 释放；`resolve` 归档时同步清锁。TTL 默认 2 小时。
- `reap --id <ID> --minutes N [--dry-run]` 只回收指定任务的超龄租约；参数是白名单，
  `--id=B006` / `-id` / 位置参数一律 exit 2，不回落为全局清理。
- `.locks/` 是本地运行时状态，不入仓：干净克隆/CI 缺锁只出 `NOTE`；只有本工作区确有 `.locks/` 时，
  「锁在而记录非 `in_progress`」才判违规。
- 租约只保护「同一任务」，不保护账本追加：并发 `record` 仍可能丢行，靠「record 后立即提交 +
  冲突人工合并」兜底。

## 命令

```bash
node scripts/backlog.mjs list                 # 看板（状态/优先级排序）
node scripts/backlog.mjs record --category Defect --title "..." --fingerprint "core::x::y" --priority P1 --session "<来源指针>"
node scripts/backlog.mjs start B023 --owner lane-1 --paths "server.mjs,static/index.html"
node scripts/backlog.mjs heartbeat B023 --owner lane-1
node scripts/backlog.mjs release B023         # 回退 todo + 清锁
node scripts/backlog.mjs resolve B023 --evidence "node test-decoupling.mjs && node test-unit.mjs 全绿；rc=0"
node scripts/backlog.mjs annotate B023 --description "..."        # 传 --status 直接报错（状态无旁路）
node scripts/backlog.mjs lint                 # 记录不变量（非零 = 违规）
node scripts/backlog.mjs doctor               # 跨归档/高水位/孤儿租约对账
node scripts/backlog.mjs reap --id B023 --minutes 0        # 只清该任务的锁
```

提交信息/文档引用写成 `backlog:B023`；裸 `B023` 视为旧编号。

## 门禁与接线

- 门：`bash .meta/gates/backlog-gate.sh` = `lint` + `doctor`；账本缺失 → 明确跳过；无 `node` → fail-closed。
- 负样本自检：`bash .meta/gates/backlog-gate.spec.sh`（P1–P5 + N1–N8 + H/H2）。
- 接线三处：`.githooks/pre-commit`（**ponygo 哨兵块之外**，缺门 fail-closed）、
  `.github/workflows/ponygo-governance.yml` 的 `governance` job（门 + spec 两个 step）、
  `ponygo audit --run-specs`（自动发现 `gates/*.spec.sh`）。
- 登记面与「承诺 → 命令」：`.meta/gates/INSTANCE-GATES.md`。
- 本地钩子前提：`git config core.hooksPath .githooks`（git 不克隆该配置）。未装配时本地门禁静默失效，
  CI 仍兜底。

## 迁移（旧待办载体退役，2026-11-13，一次性）

| 旧载体 | 处置 | 账本落点 |
|---|---|---|
| `.dev-team/state.json`（波次任务板状态，冻结时 6 波全 completed） | 冻结 `backlog/legacy/dev-team/` | 无开放项 |
| `.dev-team/review-plan*.json`（评审计划/findings 清单） | 冻结 `backlog/legacy/dev-team/` | `B019`–`B022`（contract 已知残留表） |
| `docs/GLOBAL_AUDIT_REPORT.md`（§三 仍开放 / §四 阻塞 / §五 降载 / §六 路线图） | 冻结 `backlog/legacy/reports/` | `B013`–`B018` |
| `docs/ALIGNMENT_AUDIT_REPORT.md`（P0–P4 路线图 + 审计发现） | 冻结 `backlog/legacy/reports/` | `B007`–`B012` |

映射规则：

- `source_ref` 一律指回冻结原文的小节/表格行，冻结原件一字不改；`backlog/legacy/README.md` 是唯一映射表。
- **只迁仍开放 / 部分落地项**：已落地项（官方跟随流、pendingInteraction、状态色系、gzip、ETag/304、
  V3/V4/V8/V10 代码侧等）不建记录，其现状证据写进同批迁移记录的 `description`，供复核。
- 迁移不改写事实，只补最小可判定字段（`fingerprint` / `source_ref` / `description` / 优先级映射）：
  旧路线图 P0–P4 五档 → 账本 P0–P3 四档（P0→P0、P1→P1、P2→P2、P3→P2、P4→P3）。

后续新增工作一律走 CLI（`record`/`start`/`resolve`），不再新增 md 任务单或波次状态文件。

## 诚实边界

- `lint` / `doctor` 不解析 git 历史：无法识别「同时改记录与高水位」的伪装；
- spec 只证明「门会拒绝非法样本」，账本内容真实性靠 review；
- 迁移的「仍开放」判定是取证结论而非脚本产物：每条证据是 file:line（写在各记录 `description` 里），
  复核时按行号重查；
- 历史文档（`.agents/notes/implemented/**`、`contract-wave-*.md`、`RED-PHASE.md`）对已冻结路径的引用
  保持原貌，映射以 `backlog/legacy/README.md` 为准——冻结即法律，不在原件上修指针。
