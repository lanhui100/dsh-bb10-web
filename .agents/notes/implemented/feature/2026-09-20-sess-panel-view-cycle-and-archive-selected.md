# Agent Note: 会话面板三视图轮换与选中项归档

Status: implemented

## Problem

C 键呼出的会话面板只展示当前工作区全部会话。用户在多工作区并行任务时，想一眼看到“全工作区进行中”和“全工作区待处理（完成/错误/用户终止）”的会话，必须逐个切换工作区逐个开面板，关注成本高。另外面板中用 J/K 选中的会话无法直接归档，只能先回车进入详情页再按 A，键盘路径多一步。

## Decision

`static/index.html`（ES5，零新依赖）：

1. 新增 `sessViewMode`（0=当前工作区全部，1=全工作区进行中，2=全工作区待处理），`openSess()` 打开即归零。
2. 面板内按 `V`（keyCode 86，全局未占用）在三种视图间轮换；`renderSessTree()` 在 mode 1/2 时转调新增 `renderSessAggregated()`，按工作区分组渲染，行节点携带 `{kind:'sess', cwd, sid}`，回车进入走既有 `selectSession(cwd, sid)`。
3. 进行中口径 = `normalizeSessionState` 为 running/waiting；待处理口径 = done/error/stopped（与 `workspaceStateMark` 关注度优先级同源，不含 idle/running）。
4. 数据源复用 `sessCache` 全工作区缓存（与 W 面板聚合图标同源）；缺失缓存走既有 `preloadMissingWorkspaceSessions()` 300ms 错峰补齐，归来分支自动重绘，不新增并发扫描。
5. 面板内按 `A` 归档 kb 选中的会话（新增 `archiveSelectedSessNode()`），与详情页 A 键同流程：`openArchiveConfirm(sid, cwd)` → 确认 → `executeArchiveCurrentSession(sid, cwd)`。归档非当前会话时不碰当前阅读上下文，仅清目标 cwd 缓存并重绘面板；归档当前会话保持原流程（新建+重开面板）。
6. 同提交更新帮助表、面板 hint、`README.md` / `README.zh.md` 快捷键说明。

## Alternatives considered

- 服务端新增聚合接口下发全工作区视图：需新增跨文件契约与 Zstd 扫描开销，前端复用既有 `/api/sessions` 缓存即可，否决。
- V 改用 C 键复用（面板开时再按 C 轮换、双击关闭）：C 已是开关语义，再按 C 关闭是肌肉记忆，复用会造成“想关闭却切了视图”，否决；V（View）全局无冲突。
- 面板 A 直接归档不经确认框：归档不可逆且详情页 A 键必经确认，两处语义必须一致，否决。
- 待处理视图含 idle：idle 多为未开始的新会话，不属于“需关注”，且与聚合图标口径（idle 灰点最低级）保持一致，否决。

## Consequences

- C 面板鍵序变为 `C → V/V → J/K → A → Enter` 即可跨工作区巡检并归档，全程不碰触控板。
- Q20 约束：聚合渲染为一次性 innerHTML 重建，与既有渲染同量级；CPU 峰值仍为单次 `/api/sessions`（错峰预取复用）。
- 门禁：ES5 Acorn 解析 + `node test-decoupling.mjs && node test-unit.mjs` 全量通过。

## 后继（部分取代）

- `openSess()` “打开即归零 mode 0”仅保留给自动打开路径（点击工作区 / 归档后重开）；用户按 `C` 改为直进 mode 1（全工作区进行中），且自动打开的面板按 `C` 不再关闭而是重进进行中列表——见 [2026-09-29-c-key-enters-all-workspaces-running.md](2026-09-29-c-key-enters-all-workspaces-running.md)。
