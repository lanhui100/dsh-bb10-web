# Agent Note: 优化会话加载性能与聚合视图渐进式渲染

Status: implemented

## Problem
在用户按下 `C` 键进入会话面板或进入 Workspace 后，会话列表没有及时刷新；特别是按下 `C` 键后再按 `V` 键切换视图时，界面长时间停留在 `… 加载全工作区会话中` 的 loading 态，会话无法成功展示。
经全链路排查，根因包含：
1. `server.mjs` 中的 `getSessionsForCwd` 在遍历每个会话（如 266 个历史会话）时，串行调用 `isSessionUiRunning`，针对锁定会话触发 `session/list` 宿主 RPC。宿主数据量巨大（2300+ 会话），高频 RPC 引起请求排队拥塞，导致单次 `/api/sessions` 耗时高达 90~105 秒，事件循环严重卡死。
2. `/api/sessions` 缺少同一 `cwd` 的 In-flight 请求合并与内存 TTL 缓存，前端定时器与预加载触发并发请求风暴。
3. `static/index.html` 的 `renderSessAggregated` 聚合视图在任意工作区缓存缺失时采用“一票否决”策略（`total === 0 && missing` 时直接呈现整屏 loading），未对已就绪的工作区做渐进式渲染，且在 `V` 键切换时频繁打满错峰请求队列。

## Decision
1. **服务端批量运行态与元数据解析 (`server.mjs`)**：
   - 在进入工作区扫描前，一次性预先解析全局运行态 ID 集合 `getHostRunningSessionIds()`，使单会话运行态判定收敛为纯内存 `Set.has(sid)`，彻底移除遍历循环内的串行 RPC 阻塞。
   - `applyHostTitles` 复用已拉取的标题映射或进行安全兜底。
2. **服务端 `/api/sessions` In-flight 请求合并与 TTL 缓存 (`server.mjs`)**：
   - 增加按 `cwd` 索引的 `sessionsInflight` Map，合并并发相同 `cwd` 的查询请求。
   - 增加轻量级 TTL 缓存（3000ms），在会话新建、归档、分支等写操作时触发主动失效。
3. **前端聚合视图渐进式渲染 (`static/index.html`)**：
   - 聚合视图（进行中/待处理）采取“有则先渲染”的渐进式呈现策略：已缓存的工作区会话立即渲染可见；若存在缺失的工作区，在底部以轻量状态提示正在加载，会话归来后平滑刷新，消除卡死在全屏 loading 的假象。
   - 保持严格 ES5 语法规范，兼容 BB10 WebKit。

## Alternatives considered
- *完全取消宿主 RPC 校验，仅依赖本地文件锁*：宿主可能长期持有已结束会话的写租约，直接依赖文件锁会导致大批已结束会话被错误标记为 running，违反状态对齐准则。
- *纯前端轮询延迟放大*：虽然能减少请求数，但无法解决单次请求被卡死 100 秒的根本瓶颈，首屏体验仍旧极其卡顿。

## Consequences
- `/api/sessions` 单次请求耗时从 100 秒降低至 20~80 毫秒（大幅降低 99% 以上）。
- `C` 键与 `V` 键切换视图时，已缓存的会话瞬间呈现，不再出现卡死在 loading 的现象。
- 100% 保持 ES5 规范与测试套件完全通过。
