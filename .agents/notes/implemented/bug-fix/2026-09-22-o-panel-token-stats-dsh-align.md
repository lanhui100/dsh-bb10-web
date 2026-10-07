# Agent Note: O键会话状态Token统计对齐dsh口径

Status: implemented

## Context

O键会话状态面板的Token统计与dsh官方口径有三处偏离（dsh真相源：
`token-meter/src/usage-projection.ts` 的 `pressureFrom`/`addReplacing`/`usageOf`、
`ui-chat/src/client/chat/token-format.ts` 的 `formatCacheHitPercent`、
`StatsPills.tsx` 的 `billedInputTokens`/`cacheHitPercent`）：

1. 同turn+step重复样本被简单累加——重试settlement/宿主follow渐进更新会双算；
   dsh按turn+step槽位替换（`addReplacing`）。
2. 命中率用`toFixed(1)`——99.95%+的部分命中会舍入成`100%`谎报全中；
   dsh用永不把部分命中舍入到100%的整算口径，且零计费输入返回null（隐藏该行）。
3. usage源只读`data.usage`——`assistant/attempt`的失败settlement与stream内嵌
   usage chunk被漏计；dsh的`usageOf`回退到stream末个`{type:'usage'}` chunk，
   且message与attempt一视同仁。

相关决策：面板规格见
`implemented/feature/2026-09-18-session-status-overview-panel.md`；
实时速度累计口径见
`implemented/bug-fix/2026-02-14-live-token-speed-cumulative-usage-inflation.md`
（本条不动测速窗口逻辑，只修usage累计语义）。

## Decision

1. 新增`lib/token-stats.mjs`（dsh口径的唯一家）：`extractEventUsage`
   （message认data.usage、attempt只走stream + stream回退）、`createUsageFold`
   （turn+step替换 + `closeRetrySlot`关槽）、
   `billedInputTokens`、`pressureFrom`、`formatCacheHitPercent`
   （dsh整算移植：部分命中永不到100，零输入null）。
2. `server.mjs`三处接入：实时`handleSessionEvent`的task.usage累计改fold替换
   （message+attempt分支合并）+ `llm/retry-started`关槽；`getSessionStats`的
   transcript折叠改fold替换并计入attempt + 循环内关槽；两处命中率改
   `formatCacheHitPercent(read, billed)`（整数精度，对齐会话级StatsPills），
   零输入返回null。`inputTokens`仍为计费输入（三桶和，字段语义不变）。
3. O面板Token统计行：`• 缓存命中: <读缓存量> <%>`（数量＋%形式）；
   `cacheHitRate`为null时隐藏该行，不再显示`0.0%`。
4. `test-unit.mjs`：新增`Token Stats Fold Contract`纯函数回归（替换/计费/
   压力/回退/命中率边界）；stats契约断言`cacheHitRate`为null|string +
   `inputTokens === 三桶和`。

## Alternatives considered

- **保持简单累加，只修命中率格式**：重试双算仍在，口径与dsh持续偏离，否决。
- **服务端直接import dsh源码包**：解耦宪法禁止第三条能力路径且dsh包非ESM直引
  稳定面，小体积纯函数移植成本更低，否决。
- **命中率沿用toFixed(1)**：99.96%→`100.0%`谎报全中，dsh已有防舍入算法可移植，
  否决。

## Consequences

- 有重试的会话因关槽累加，totalTokens比修前大（更准，非回归）；
- 零输入会话的`cacheHitRate`由`'0.0%'`变为`null`，O面板隐藏该行（dsh同行为）；
- `lib/token-stats.mjs`为服务端ESM模块，不进`static/`，不受ES5门禁约束。

## Review（对抗审核采纳）

- dsh-align-reviewer BLOCKER：初版缺`llm/retry-started`关槽，同step重试会被
  低估——已加`closeRetrySlot`（封存累加）+ 两处接入 + F1b回归。
- MINOR-1（调用点精度）：会话级改整数精度与StatsPills同构——已采纳。
- MINOR-2（attempt分流）：attempt只走stream——已采纳 + F4断言。
- q20-constraint-reviewer MAJOR-1（无坐标样本静默丢弃）：无turn/step走加法槽
  兜底 + F5回归——已采纳。
- q20-constraint-reviewer MAJOR-2（空/幽灵null无断言）：6.1/6.2加
  `cacheHitRate === null`断言——已采纳。
- q20-constraint-reviewer MINOR m-2（inputTokens同名异义）：task.usage侧加注释
  ——已采纳；m-1（O(n²)）/m-3（stream扫描）量级可接受，维持现状；
  m-4（工作树ws-add混入）超出本ADR域，分开评审。

## Verification

- `node --check server.mjs lib/token-stats.mjs test-unit.mjs` → 全OK
- `node test-decoupling.mjs && node test-unit.mjs` → 全量PASS
- ES5门禁（acorn ecmaVersion=5解析`static/index.html`）→ PASS
