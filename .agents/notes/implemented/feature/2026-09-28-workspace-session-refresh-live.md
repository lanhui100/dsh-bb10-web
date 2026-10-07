# Agent Note: Workspace 面板会话数字实时刷新与无感对账架构 (L0-L3)

Status: implemented

Supersedes: [.agents/notes/implemented/feature/2026-09-18-refresh-via-r-shortcut-remove-buttons.md](../feature/2026-09-18-refresh-via-r-shortcut-remove-buttons.md) (关于 C 面板 R 键破坏性重置为 `loadBootstrap()` 的部分)

## Problem

在 BlackBerry Q20 (720x720 方屏, 双核 CPU, ES5 WebKit) 客户端使用中，存在三个强相关的会话刷新与数据陈旧痛点：
1. **W 呼出的 Workspace 面板数字不自动更新**：面板各工作区行右侧 `(N个会话)` 标签直接读取自服务端 `/api/bootstrap` 下发的 `ws.sessionCount`。而前端后台 5s 轮询与本地乐观插入（`syncSessionPhase`）维护的是 `sessCache[cwd]`，其变动完全不反映在 W 面板数字上；且签名 `wsTreeSignature` 也绑定旧数字，导致即使用户在某工作区创建或归档了会话，W 面板数字仍静止不动。
2. **点击进入 Workspace 后会话列表陈旧，需按 R 键**：后台 5s 轮询只轮询当前 cwd 与在跑会话 cwd，闲置冷工作区的 `sessCache` 从不刷新；点击 W 面板行进入时使用旧缓存渲染，且 `refreshRunningWorkspaceSessions` 仅覆盖含在跑会话的工作区，导致闲置工作区的会话列表长期停留在首屏快照。
3. **R 刷新延时长且破坏会话上下文**：会话面板（C）内按 R 键原先绑定为全量 `loadBootstrap()`，会无条件执行 `sessCache = {}`、重置 `currentSessionId = ''`、清空当前输入，并串行发起 300ms×N 的全局扫描，导致用户正在进行的对话被踢回欢迎页且伴随显著耗时。

## Decision

采取“单一实时真源 + 缓存新鲜度驱动 + 非破坏性轻量刷新”的端到端分层方案（L0-L3）：

1. **L0 计数实时化（纯前端，无感同源）**：
   - 增加 `wsSessionCount(ws)` 辅助函数：优先取 `sessCache[ws.cwd].length`（过滤归档墓碑后的有效列表长度），仅在缓存缺失时回退 `ws.sessionCount`；
   - `wsTreeSignature` 与 `renderWsTree` 标签统一消费 `wsSessionCount(ws)`，确保同源同态；
   - 在本地归档剪枝 `pruneArchivedLocally` 与静默对账中增加 W 面板即时重绘，新建/归档立即在 W 面板显现。

2. **L1 全局清单新鲜度（纯前端，双核安全）**：
   - 引入 `sessCacheAt[cwd]` 时间戳字典，在 `loadSessions` 成功时记录 `Date.now()`，在 `renderBootstrap` 时重置，并在移除工作区时清理；
   - 将 `refreshRunningWorkspaceSessions` 升级为 `refreshStaleWorkspaceSessions`：按 `WS_CACHE_STALE_MS = 15000` 阈值轮换检测已缓存工作区，跳过当前 cwd 与在途请求，每个 5s 周期至多发起 1 个工作区重拉，消灭闲置工作区陈旧且零额外 CPU 尖峰；
   - 拓展 `preloadMissingWorkspaceSessions`：同时覆盖缺失与超 15s 陈旧的工作区，300ms 错峰预热，W 面板打开即达高新鲜度。

3. **L2 R 键非破坏性轻量化（纯前端，契约对齐）**：
   - 将 C 面板与 W 面板的 R 键统一收敛为非破坏性 `refreshWsList(callback, quiet)`；
   - 提取并实现 `rebuildModelSelect` 与 `rebuildPermSelect`，在拉取 `/api/bootstrap` 后保留用户当前选中的模型与权限值，更新工作区树，绝不重置 `currentSessionId` 与 `sessCache`；
   - 移除原先的 300ms×N 串行预取链，仅定向对当前 cwd 调用 `preloadSessions(getCwd())` 与 `loadUngrouped()`，消除 R 键延时与卡顿。

4. **L3 服务端定向失效与模型缓存（服务端优化）**：
   - 给 `readModelCatalog` 增加 30s 内存 TTL 缓存（仅缓存宿主 RPC 成功结果，磁盘镜像保持现读以保证宿主恢复即时切换），显著降低 `/api/bootstrap` 对宿主 RPC 的重复阻塞；
   - 在 `runChatViaHostRpc`（基于 `createdSidsSeen` 集合门控首次建会话）、`/api/session/ensure`、`/api/session/delete`、`attachSessionToWorkspace`、`markArchivedOverlay` 中定向失效 `workspacesCache = null`；
   - 修复非官方工作区 `activeCount` 遗漏空会话过滤（`header.hasTurns === false`）的陈旧问题，确保服务端 `sessionCount ≤ 列表长度` 护栏恒成立。

## Alternatives considered

1. **新增 `/api/workspaces/counts` 独立轻量端点**：被审核驳回。服务端统计有效会话数必须解析 zstd 头（需过滤 blank），精确计数的成本等价于 `/api/sessions` 扫描，轻量端点并不能省去磁盘 IO，反而增加网络连接数；由客户端基于 `sessCache` 长度推导是最轻量且唯一的真源。
2. **在每次发送 prompt 或每次 /api/chat 时无条件失效 `workspacesCache`**：被审核否决。因为每个连续对话轮次都会调用 `session/create` 收养会话，若无条件失效会导致整个对话流中缓存恒为空，每次外部请求都触发耗时 3s 的 1700 目录全盘扫描，严重恶化性能；最终采用 `createdSidsSeen` 门控仅首轮失效。
3. **C 面板 R 键仅调用 `loadSessions(getCwd())` 而完全不拉 bootstrap**：被审核修正。如果完全不拉 bootstrap，则会丢失模型列表和权限变更的页内刷新入口；因此采用“非破坏性 bootstrap + 保留当前选中模型/权限/会话上下文”的折中方案。

## Consequences

- W 呼出的 Workspace 面板各行会话数字完全由本地活跃会话真源实时驱动，新建、发送第一轮、归档时均无需按 R 即可自动实时跳变。
- 点击切换至任何工作区时，由于后台 15s 轮换与打开时 300ms 错峰预热，列表直接呈现最新或在 300ms 内收敛，彻底告别旧快照与反复按 R。
- C/W 面板按 R 键不再卡死或打断会话，状态与选择完整保留。
- 全部静态脚本 100% 严格遵守 ES5（Acorn 解析校验）；全部测试门禁（decoupling / unit 30/30 / e2e suite 7/7）一次性全绿。
