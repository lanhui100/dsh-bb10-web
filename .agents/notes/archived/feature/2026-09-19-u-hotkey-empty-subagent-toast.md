# Agent Note: U Hotkey Empty Subagent Toast Instead of Panel

Status: implemented
Related: .agents/notes/implemented/feature/2026-09-18-subagent-drill-down-u-hotkey-two-tier-navigation.md

## Problem

U 键呼出子智能体面板时，若当前会话无子智能体/Agent Team/后台任务可显示，仍会进入空面板（仅一行"无子智能体"提示），在 720 方屏上是一次无效的全屏跳转，打断阅读流。

## Decision

U 键改为先查后开（`tryOpenSubagent()`，`static/index.html`）：
- 有缓存直接判空：`subagents` 与 `tasks` 皆空则 `showCopyToast('当前会话无子智能体')`，不进面板；
- 无缓存则先发一次 `GET /api/session/subagents` 预检，空结果同样 toast 不进面板，非空/失败仍进面板（`openSubagent()` 原逻辑）；
- toast 复用 `#copy-toast`，1800ms 自动延时关闭。

## Alternatives considered

- *进面板显示空态行*（现状）：Rejected。空面板全屏遮挡对话流，Q20 小屏代价过高；toast 足够传达。
- *用状态栏 setStatus 替代 toast*：Rejected。状态栏在收起态易被忽略，toast 居顶可见且自动消失。
- *U 键空态直接静默无反应*：Rejected。无反馈会被误认为按键失灵。

## Verification

- `node -e acorn.parse(ecmaVersion:5)` → ES5 PASS（靠机器）。
- `node test-decoupling.mjs && node test-suite.mjs` → 全量 PASS（7/7）。
