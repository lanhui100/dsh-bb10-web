# Agent Note: 欢迎页 Logo 去蓝色动效改静态白色点阵

Status: implemented

## Decision

欢迎页鲸鱼 Logo 去除 `f9ce295` 引入的蓝色涟漪动效（`dsLogoTick` setInterval 半径波前循环），恢复为静态白色点阵 SVG（`#EEEEEE` / `#999999` / `#444444` 三层灰阶）。删除动效 JS 约 100 行及 `ds-whale` / `ds-shade-*` id 钩子，`updateWelcomePlaceholder` 不再启停 timer。

路径：`static/index.html`（欢迎页 `#welcome-logo` + `updateWelcomePlaceholder`）。

取代旧决策：[2026-09-21-welcome-logo-blue-breathe.md](../../archived/feature/2026-09-21-welcome-logo-blue-breathe.md)（已归档冻结）。

## Alternatives considered

1. 整单 revert `f9ce295` —— 否决：该提交同时去掉了 `#1A1A1A` 背景底噪点并重排三层点阵，直接 revert 会带回底噪。
2. 保留动效仅降速/降对比 —— 否决：用户明确要求静态，且 Q20 双核 CPU 上持续 setInterval 重绘是额外负担。
3. 定向剥离动效 JS、保留静态点阵（采用）—— 最小改动，符合要求。

## Consequences

- ES5 PASS，`test-decoupling.mjs` + `test-suite.mjs` 7/7 PASS。
- Q20 上欢迎页零 JS 定时器，省 CPU/内存。
- 如将来要恢复动效，恢复条件：用户明确要求 + 真机验证不假死。
