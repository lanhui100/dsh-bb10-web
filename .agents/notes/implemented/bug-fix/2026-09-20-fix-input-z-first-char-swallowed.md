# Agent Note: 输入框内禁用 Z 撤回拦截，修复首字母 z 被吞

Status: implemented

## Problem

输入框聚焦且为空时，首字母 `z` 按下无响应；非首字母正常。根因是 `static/index.html` 的 `document.onkeydown` 在 `isInputTarget` 分支内对 `code === 90` 且输入框为空时执行 `preventDefault + revokeQueuedPrompt()`（commit 6947cc4 引入），把"空→非空的第一次 z 按键"当作撤回快捷键吞掉。本条是对前置特性 `.agents/notes/implemented/feature/2026-09-20-revoke-queued-prompt-shortcut-z.md` 的行为修正，不取代该条（Z 撤回能力保留）。

## Decision

输入框（`TEXTAREA`/`INPUT`/`contentEditable`）聚焦时 `document.onkeydown` 直接 `return`，不拦截任何键；Z 撤回仅在非输入焦点时生效，与 `T/B/Q` 等全局键一致，符合"焦点在 INPUT 时除 Enter 外不拦截"的键盘铁律。现在 `static/index.html` 约 L8894 分支已删除空输入框 Z 拦截并更新注释。

## Alternatives considered

- 有排队消息时仍拦截、无排队时放行：拒绝，首字不可预测，误吞打字代价大于省一次失焦。
- 改用组合键（如 Alt+Z）撤回：拒绝，增加学习成本，非聚焦 Z 已够用。
- 保留现状：拒绝，首字母丢失是数据正确性 bug。

## Consequences

- 首字母 z（含拼音 z 开头）恢复正常打字。
- 空输入框聚焦时按 Z 不再撤回，需先失焦（点消息区/`✕`）再按 Z；帮助表与 README 的 `Z 一键撤回`语义不变（非输入焦点）。
- 门禁：ES5 PASS；`test-decoupling` PASS；`test-unit.mjs` 19/19；`test-suite.mjs` 7/7。
