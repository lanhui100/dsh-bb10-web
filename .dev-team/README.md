# .dev-team/ —— 历史契约与证据（冻结区，不是待办载体）

**待办唯一真源 = `backlog/tasks.jsonl`**（契约见 `backlog/README.md`）。
本目录自 2026-11-13 起退役为**只读证据区**（`backlog:B006`）：不再承载任务板/波次状态，也禁止新增待办。

## 这里保留什么、为什么

| 内容 | 角色 |
|---|---|
| `contract-wave-*.md` | 各波次**契约唯一来源**：`lib/session-waiting.mjs`、`lib/host-live-state.mjs`、`lib/preview-policy.mjs` 与 `tests/acceptance/*` 头部注释直接引用 |
| `review-*.json` | 各轮评审的机器证据（verdict / findings），被 ADR 与契约引用 |
| `receipts/`、`nfr-baseline.json`、`regression-baseline-2026-11-06.json` | 交付验收的物理收据与基线（NFR 报告 / ADR 的证据锚点） |
| `retro/`、`meta-retrospective.md` | 波次复盘与流程经验（方法论证据） |

## 已迁出

旧待办载体（`state.json`、`review-plan*.json`）与两份审计快照（其「仍开放 / 路线图」章节）已于
2026-11-13 冻结到 `backlog/legacy/`，逐条映射见 `backlog/legacy/README.md`；其中仍开放项已迁入
活账本 `B007`–`B022`。

## 新增工作的正确入口

```bash
node scripts/backlog.mjs record --category Task --title "..." --fingerprint "<稳定指纹>" --priority P2
```

不要在本目录新建状态文件、任务卡或看板——重复载体 = 双状态源。
