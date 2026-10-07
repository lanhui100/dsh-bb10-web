# Agent Note: Agent 正文消息字号调大

Status: implemented

## Problem

720×720 方屏上 agent 正文（`.msg-assistant` 15px）偏小，阅读吃力；但工具胶囊（11px）与思考卡片（11–12px）是刻意紧凑的折叠过程信息，需保持不动。

## Decision

- `static/index.html`：`.msg-assistant` 15px→17px（行高 1.45→1.5），h1–h4 同步 +2px（21/20/19/18px）；`.tool-pill`、`.thought-card/body`、代码/表格字号一律不动。

## Alternatives considered

- **整体等比放大（含工具/思考）**：过程信息会挤占正文空间，违背"复杂内容折叠呈现"紧凑约束；否决。
- **只放大正文不动标题**：标题与正文层级差缩小，大屏层级模糊；否决，标题同步 +2px。

## Consequences

- agent 回答更易读；过程折叠行密度不变；回归门禁全量 PASS。
