# Agent Note: 呼出 workspace 面板会话列表头部图标 stale 修复

Status: implemented

## Problem

呼出 workspace 面板（`openWs` → `renderWsTree`）中各工作区行首状态图标（`workspaceStateMark` 聚合 `sessCache[ws.cwd]`：错误红✖ > 等待黄? > 运行蓝● > 中断橙■ > 完成绿✓ > 空闲灰·）不随会话状态更新：只有进入该 workspace 的会话面板（`openSess` → `loadSessions(cwd)` 落缓存）后，图标才刷新。根因有二：

1. 非当前工作区的 `sessCache` 从无预取——`renderBootstrap` 与 `refreshWsList` 只 `preloadSessions(getCwd())`，其余 cwd 缓存恒缺失，`workspaceStateMark` 对缺失缓存直接返回空闲灰 `·`；旧 ADR（`implemented/feature/2026-09-18-welcome-entry-preload-and-loading-indicator.md`）承诺的 `preloadAllWorkspaceSessions()` 在代码中实际不存在（`grep` 零命中），属提案未落地。
2. 5s 后台轮询只刷当前 cwd（`loadSessions(curCwd)`），其它 cwd 即使已有缓存也永不刷新——仅 `knownSessionsMap` 命中在跑 sid 才顺带刷其 cwd，新建/跨设备产生的在跑会话覆盖不到。

## Decision

在 `static/index.html` 前端（纯 ES5，无服务端/协议改动）补两处轻量机制：

1. `preloadMissingWorkspaceSessions()`：对缺失缓存的工作区以 300ms 错峰串行后台 `loadSessions`（规避并行 Zstd 扫描打满 Q20 双核 CPU；`sessLoading` 去重，归来分支已负责 `isWsOpen` 重绘）。调用点：`renderBootstrap` 预取后、`refreshWsList` 成功后、`openWs` 打开时。
2. `refreshRunningWorkspaceSessions()`：5s 轮询末尾轮换刷新一个"含在跑会话（`isRunning`/`running`/`waiting`/`pendingInteraction`）"的已缓存非当前 cwd（每次最多 1 个，随周期轮换，单次开销与现存轮询同量级）。

## Alternatives considered

- **服务端 `/api/bootstrap` 直接下发各工作区聚合状态**：需新增聚合扫描（每 workspace 一次 Zstd 目录遍历）与缓存失效语义，属跨文件契约变更且加重服务端 CPU；纯前端复用既有 `/api/sessions` 缓存即可，落选。
- **打开 W 面板时并行拉取全部缺失 cwd**：多路并发 Zstd 扫描在双核上瞬时满载，前案 ADR 已明确否决并行（300ms 错峰），延续该结论。
- **每次 5s 轮询全量刷新所有已缓存 cwd**：cwd 数量 unbounded，全量刷新的 CPU 与状态栏冲刷风险随规模线性增长；轮换单刷在跑 cwd 即覆盖图标变化的唯一来源（终态落缓存后图标即定，不再需要反复刷），落选。

## Consequences

- W 面板头部图标与会话面板行图标同源（`sessCache`）同态：打开即准、在跑变化随 5s 周期收敛，无需再逐个进入会话面板。
- Q20 约束：串行错峰 + 单 cwd 轮换，峰值额外负载恒为 1 个 `/api/sessions`，不打满 CPU；ES5 门禁与 `test-unit.mjs` 回归覆盖。
- 旧 ADR 中未落地的 `preloadAllWorkspaceSessions()` 由本条正式落地实现（命名收敛为 `preloadMissingWorkspaceSessions` + `refreshRunningWorkspaceSessions`）。
