# Agent Note: ws-panel-ungrouped-default-group

Status: implemented

## Problem

dsh web 有默认分组 Ungrouped，收容未归入任何 Workspace 的会话（如被移除工作区的旧会话）。Q20 的 W/C 面板无此分组，这类会话在小屏侧不可见。用户要求对齐增加“未分组”。

## Decision

1. **服务端（`server.mjs`）**：新增 `getUngroupedSessions` + `GET /api/sessions/ungrouped`：全量扫描 `~/.dsh/sessions/` 有真实转录会话，排除归档（含墓碑）与一切已注册 `sessionIds`，过滤 `origin:subagent`（对齐官方 sessionVisible），按 `updatedAt` 倒序（同值 id tie-break），叠宿主标题；与 `getSessionsForCwd` 同过滤口径（blank 无轮次会话过滤、归档墓碑）；10s 短缓存 + `?refresh=1` 跳缓存（写后对账/测试宿主直写用）；remove/archive/内存遮罩/DELETE 会话全失效点；
2. **前端（`static/index.html`，ES5）**：W 面板末尾常驻“📦 未分组 (N)”行（N>0 才显示，数据源 `loadUngrouped`，W 打开即拉）；Enter/click 进 C 面板新 `sessViewMode === 3` 未分组视图（`sessCache.__ungrouped__`，标题“💬 未分组会话 [V]”，行内附原归属目录名，进会话走 `selectSession(s.cwd, s.id)`）；V 轮换 3→4 态（含未分组，缺缓存即拉）；移除成功与归档静默对账跳缓存刷新（`loadUngrouped(null, true)`）；归档乐观删同步 `__ungrouped__`；help/C-hint 同步四视图；
3. **测试（`test-unit.mjs` 2a3）**：200 数组契约、state 白名单（含 waiting）、全量注册 sid 零泄漏 + subagent 零泄漏、落袋三段强断言（2a2：insertSessionBefore 临时归属→离组→remove 后回归，`?refresh=1` 跳缓存）、前端接线针 6 项。

## Alternatives considered

- **把未分组并入 V 聚合视图（mode 1/2）**：聚合视图按工作区分组渲染，未分组无归属 cwd 会破坏分组结构；且用户要的是默认分组入口；故独立 mode 3 + W 面板入口行。
- **前端用现有 wsList official:false 项代替**：`getWorkspaces` 的非官方项仅收录当前 cwd/活跃目录，不覆盖已注销工作区的旧会话；口径与官方 Ungrouped（注册 sid 之外全部）不一致；故服务端独立扫描。
- **隐藏 origin:subagent 行（如官方侧边栏）**：Q20 现有 C 面板不过滤 subagent，全量可见口径一致；未分组沿用同一口径，不另立过滤。
