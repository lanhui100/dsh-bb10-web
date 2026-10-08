# ADR: 修复 DSH 进程运行中但初始化页面偶发误报及无法自愈问题

## 状态
implemented

## 上下文与前序决策
本决策基于并加固了此前引入的前端/服务端停机警示机制：
- 关联前序决策：[.agents/notes/implemented/feature/2026-10-08-dsh-process-down-error-whale-indicator.md](2026-10-08-dsh-process-down-error-whale-indicator.md)

## 背景与问题陈述
在 DSH 进程正常运行的情况下，客户端初始化欢迎页面偶发呈现红色错误提醒：“DSH 进程未运行或已停止”，并附带“重试”按钮。

经深度诊断定位到两大约束与机制缺陷：
1. **服务端探活毛刺与防缓存缺失**：
   - `checkDshHostAlive` 探测超时仅 1500ms，在宿主进行繁重会话列表聚合或 GC 时容易瞬态超时返回 false。
   - 探活无瞬态重试机制，一次毛刺即判定 false。
   - 动态 JSON API（`/api/bootstrap`、`/api/dsh/status`）缺少 `Cache-Control: no-cache, no-store, must-revalidate` 响应头，导致部分浏览器或中间代理启发式持久缓存了包含 `dshAlive: false` 的错误数据。
2. **客户端自愈闭环被中断（死锁）**：
   - 客户端 `static/index.html` 的 5s 后台定时器中，将会话列表轮询与 DSH 探活轮询混排，并将 `var curCwd = getCwd(); if (!curCwd) return;` 置于顶层。
   - 初始化欢迎界面或错误展示态下尚未成功加载并选定工作区，`getCwd()` 返回空字符串 `""`，导致定时器直接提前退出。
   - 后续哪怕 DSH 底座早已恢复健康，`/api/dsh/status` 也永远不会被触发轮询，无法自动触发 `setDshAliveState(true)` 和 `loadBootstrap()` 自愈，形成假死。

## 决策内容
1. **服务端探活鲁棒性与瞬态重试**：
   - 将 `checkDshHostAlive` 单次探活超时由 1500ms 调整为 2500ms。
   - 增加快速 100ms 重试机制（retry 1 次）：仅当连续两次探活均失败时才判定宿主离线，彻底滤除毛刺。
   - 所有动态 API JSON 响应注入 `Cache-Control: no-cache, no-store, must-revalidate` 与 `Pragma: no-cache` 响应头。
2. **客户端欢迎页与错误态自愈解除阻断**：
   - 将 `if (curCwd)` 守卫收敛至仅保护工作区会话列表拉取。
   - DSH 存活探测（每 10s 一次）无条件执行，确保即便在未选中工作区的初始欢迎界面或错误展示态下，依然能够自动探测并触发自愈重载。
   - 严格遵循 BlackBerry 10 宪法，保持 100% ES5 静态语法合规。

## Alternatives considered
- **仅延长服务端超时至 5000ms**：虽然能减少毛刺，但若宿主真的宕机，会导致前端接口阻塞过久；采用 2500ms + 100ms 快速二次确认更为灵敏且稳健。
- **让客户端错误态下仅仅依赖用户手动点击“重试”按钮**：违反抗熵增工程原则与自愈闭环设计；系统必须具备全自动感知恢复能力。

## 验证与门禁物理凭证
1. **ES5 门禁**：通过 acorn `{ ecmaVersion: 5 }` 静态解析无报错，输出 `ES5 PASS`。
2. **解耦门禁**：`node test-decoupling.mjs` 100% PASS。
3. **单元测试与端到端套件**：`node test-unit.mjs`（33/33 PASS）、`node test-suite.mjs`（7/7 PASS）。
4. **真实浏览器端到端**：使用 `agent-browser` 验证初始化页面正常加载，错误状态完全消除，`wsOptions=10 currentWs=<workspace-dir>`。
