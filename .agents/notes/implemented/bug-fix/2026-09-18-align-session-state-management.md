# Agent Note: 对齐 dsh web 会话状态管理（单一状态源 + 状态标识）

Status: implemented

## Problem

对比 dsh web 的状态管理（`api/session-controller` 的 `SessionSnapshot`：`running` / `openState` / `promptError`(send|stop) / `lastAgentError` / `blank` / `hasMore` / `loadingOlder`；会话列表 `sessionStatuses` 按 pendingInteraction > running > subagents > completed > idle 推导状态点；composer 由 `running` 单一驱动 send/stop），本项目缺失统一会话状态模型：

1. `agentState` 与 `isStreaming` 双轨并行、易失配；sendBtn 图标在 8+ 处散落手改 innerHTML/样式；
2. 会话列表仅二元 `isRunning`（●/·），无 error / stopped / done 区分；
3. 服务端 `/api/sessions` 与 attach sync 不返回错误/停止态；
4. 会话切换/新建不重置按钮状态，中断/错误后按钮可能滞留停止态。

## Decision

1. **服务端 `server.mjs`**：
   - 新增 `sessionTerminalState(zstdPath, task)`：按 dsh 语义返回 `running | stopped | error | done | idle`。task 内存态优先；否则扫描 transcript 尾部（≤12 帧）判定 finish reason `kind==='error'` → error、`turn/end`/finish → done、有活动无终态 → stopped、空 → idle；结果按文件 mtime+size 短缓存（2s）。
   - `/api/sessions` 每项新增 `state` 字段（isRunning 时强制 `running`）。
   - attach 轮询初始 sync 透传 `state`；文件变化时改为只发轻量 `state` 事件（不再重发 messages，避免每次 getSessionHistory 全量解压阻塞）。
   - 修复 `countResolvableRegistered` O(注册数×目录数) 暴力重扫 → 单遍磁盘 sid 索引（O(N+M)）；`getWorkspaces` 加 3s 缓存。二者叠加将大工作区（173 注册 × 700+ 目录）列表请求从 ~100s 降到秒级。注：该函数的计数口径正确性修复见并行工作 `implemented/bug-fix/2026-09-18-workspace-session-count-overreport.md`（同一提交批次，未并入本 ADR）。
2. **客户端 `static/index.html`（ES5）**：
   - 新增单一状态源 `sessState = { running, phase: idle|running|stopped|done|error, lastError, promptError }`，对齐 dsh `SessionSnapshot` 字段；
   - `renderSendButton()` 成为唯一按钮渲染入口，替换全部 8+ 处散落手改；
   - 会话树行用 `sessionStateMark(s)` 渲染状态点：● 运行(绿) / ✖ 错误(红) / ■ 停止(橙) / ✓ 完成(蓝) / · 空闲(灰)，对齐 dsh `StateDot` 语义；
   - `selectSession`/`startNewChat`/`selectWorkspace` 重置或按缓存应用状态；attach `sync`/`state`/`done`/`cancelled`/`error` 统一写 sessState。

## Alternatives considered

1. **引入前端状态库/框架**：违背 ES5 与 2GB 老 WebKit 约束，否决；用单例对象 + 唯一写入口足够。
2. **服务端每秒全量轮询状态**：长会话（17MB/33723 帧）全量解析 ~1s 同步阻塞事件循环（实测卡死），否决；改为尾部 ≤12 帧轻扫描 + 变更时只发 state 事件。
3. **客户端自行从消息推断状态**：无法获得 server 端 task 的 cancelled/error 终态与 transcript 尾部 finish reason，否决。

## Consequences

- 打开 job_copilot 工作区（173 注册会话）`/api/sessions` 由卡死（>15s 超时）恢复到秒级；attach 期间其他请求 6ms 内响应。
- 所有会话状态展示（状态栏、会话树行、发送/停止按钮、错误提示）收敛到单一 `sessState` 事实源，状态失配消失。
- `/api/sessions` 新增 `state` 字段为向后兼容增量，测试套件仅断言数组结构，7/7 通过。

## 后续修复（同日第二轮）

用户实测仍见"已停止的会话绿点 / 已完成对话红色停止按钮"，二轮定位出三个叠加根因：

1. **`session/list` RPC 参数形状错误**（主因）：`callDshWebRpc` 统一包 `args:{request:{...}}`，但 `session/list` 描述符要求 `args:{_request:{}}` 直传（报 `gateway/arguments-invalid`）→ 调用恒失败 → `hostRunning=null` → 保守判定"运行中" → 宿主持有写租约的锁定会话全亮绿点。修复：`callDshWebRpc` 增加 `opts.rawArgs`，`session/list` 直传；其余端点（create/prompt/cancel/archiveSession）依赖原形状且工作，不动。实测与宿主 `session/list` 双向一致（唯一 running 会话正确点亮，误判清零）。
2. **`getHostRunningSessionIds` 缓存失败结果**：null 也缓存 10s，RPC 瞬时失败放大误判窗口；改为仅缓存成功结果。
3. **`getSessionsForCwd` 官方分支仍 O(注册×目录)**：磁盘未命中的注册 sid 逐个全目录重扫（173×726），事件循环阻塞 ~9s（RPC 超时的放大器）。改为单遍 header.id 索引 O(N+M)，同工作区请求 9.9s → 0.72s（缓存后）；`readSessionHeader` 改前缀读（64KB，首帧即 session 头），避免每目录读整份转录。
4. **客户端滞留复位**：stream `readyState 4` 无条件回发送态（防终态事件丢失滞留红按钮）；`selectSession` 无缓存时复位；打开会话面板强制刷新列表，消除旧快照残留绿点。