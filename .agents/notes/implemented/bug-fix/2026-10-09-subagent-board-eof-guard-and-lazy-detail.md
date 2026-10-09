# Agent Note: 多智能体看板空响应崩溃修复与懒加载详情

Status: implemented

## Problem

> 前置相关记录：`.agents/notes/implemented/bug-fix/2026-10-09-subagent-session-isolation-and-task-detail-modal.md`
> 已治理看板串台与任务详情弹窗交互；本条在其之上继续治理看板加载健壮性与首屏性能。

在会话中按 `U` 键唤起的多智能体看板（团队任务 / 子智能体 / 后台任务）存在两项缺陷：

1. **空响应崩溃（用户实报 "JSON parse error: unexpected EOF"）**：看板加载请求
   `/api/session/subagents` 依赖宿主 DSH Web 的 `session/list` RPC（体积 2.4MB 级，
   慢链路实测 5~16s）。BB10 老旧 WebKit 的 XMLHttpRequest 在移动/CDN 链路波动或请求
   等待过久时，连接被截断后 `readyState === 4` 且 `status === 0`、`responseText` 为
   空串；旧代码无条件执行 `JSON.parse(xhr.responseText)`，JavaScriptCore 对空串回
   `JSON parse error: unexpected EOF`，看板直接显示误导性报错并不可恢复。
2. **加载慢**：每次按 U 打开看板都独立向宿主重发一次全量 `session/list` RPC（直连
   `callDshWebRpc`，不复用 `/api/sessions` 路径的缓存与单飞），冷启动耗时 6~16s；
   且列表载荷内嵌了团队任务完整描述等重字段，首屏无法快速呈现标题清单。

## Decision

1. **空响应容错（客户端，static/index.html）**：`loadSubagents`、
   `loadWorkspaceSubagentsFallback`、`loadSubagentPage` 三个加载器在 JSON.parse 前先
   校验 `responseText` 去空白后非空；空响应急抛可读错误
   「网络中断或云端超时（空响应），请按 U 重试」，渲染为看板内错误节点，不再裸抛
   JavaScriptCore 的 "unexpected EOF"。
2. **宿主 session/list 共享单飞 + 短缓存（服务端，server.mjs）**：新增
   `fetchHostSessionListFull()`（8s TTL + In-Flight 单飞，mock 模式豁免缓存），
   `getSessionSubagents` / `getWorkspaceSubagents` 改经它取权威 items；
   `fetchHostSessionListData` 内部复用它，使 `/api/sessions`、看板列表、任务详情
   按需拉取共享同一次 2.4MB RPC——热路径下看板打开从 6~16s 降到毫秒级（实测缓存
   命中 15~24ms）。
3. **列表轻量快载 + 详情按需（懒加载）**：
   - 服务端 `/api/session/subagents` 支持 `lite=1`：子智能体行去掉 `model`，任务行
     只保留 `id/subject/status/ownerName/owner/revision`，丢弃
     `description/blockedBy/writeScopes` 重字段，响应标记 `lite: true`；精简映射抽为
     纯函数 `lib/subagent-lite.mjs`（server.mjs 与 test-unit.mjs 共用，可独立单测）。
   - 客户端看板三路加载器一律 `lite=1` 先快载标题/徽章/状态；点击任务行经
     `fetchTaskDetail` 按 `lite=0` 按需取回单条全量详情（先展示"正在加载任务详情…"；
     会话视图按看板缓存 `parentId` 定位父会话，工作区兜底视图按工作区口径不带 id
     重取，均命中服务端共享缓存），成功后 `__full` 标记并回写
     `subagentCache.tasks`，同会话内后续点击不再重复请求；
     `openTaskDetail` 对 `description === undefined` 且未 `__full` 的 lite 行走此
     懒加载路径，否则直接渲染。

契约兼容性：`lite` 缺省即全量（`lite=0` 或旧客户端不传参行为零变化）；
`unicode-EOF` 与分页 `limit/offset/total/page` 契约保持原样。

## Alternatives considered

- 方案 A（仅加客户端 try/catch 包住 JSON.parse）：能把 "unexpected EOF" 变成「格式
  错误」，但不解决 6~16s 慢加载与连接截断高发根因，看板仍频繁失败。否决：只治标。
- 方案 B（服务端全列表常驻后台轮询预热）：看板每次打开都瞬时，但每 8s 向宿主重发
  一次 2.4MB RPC，持续压榨宿主，违背最小化对上游负载。否决：改为共享现有
  `/api/sessions` 已触发的 RPC（同一次变更、零新增流量）。
- 方案 C（新增独立端点 `/api/team/task-detail?id=` 单条详情）：减少详情拉取字节，
  但新增契约面与路由代码，且详情本就来自同一份 session/list 投影，复用
  `lite=0` 全量 + `id` 匹配成本更低。否决：不扩契约面。
- 方案 D（任务详情继续内嵌列表返回）：保持现状零改动，但与"先标题后详情"的懒加载
  诉求相悖，首屏仍携带重字段。否决。

## Consequences

- U 键看板不再出现 "JSON parse error: unexpected EOF"；空响应/超时给出可读提示并可
  按 U 重试。
- 看板打开热路径（宿主列表 8s 缓存窗口内）毫秒级出标题清单；任务详情点击后按需
  加载，首屏载荷显著减小，契合 Q20 双核/2GB 性能约束。
- 新增 `lite` 契约与 `lib/subagent-lite.mjs` 纯函数门禁；test-unit.mjs 新增
  lite 映射、lite 端点信封与前端 wiring 断言。全部门禁：Acorn ES5 静态解析、
  `node test-unit.mjs`（35/35）、`node test-decoupling.mjs`、`node test-suite.mjs`
  （7/7）全绿。
- 已知限制：宿主列表 RPC 冷启动首次仍可达 5~6s（受宿主自身吞吐约束，非本服务可控）；
  此时客户端会先显示看板 spinner，空响应由第 1 条决策兜底为可读错误。