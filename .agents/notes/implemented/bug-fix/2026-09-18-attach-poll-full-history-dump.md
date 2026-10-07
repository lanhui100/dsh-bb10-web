# Agent Note: 修复 attach 轮询每秒全量推送历史导致长会话页面假死

Status: implemented

## Problem

关联前案：`implemented/feature/2026-09-17-history-lazy-loading-and-archive-loading-state.md`（`/api/history` 已支持 `limit`/`before` 分页，前端 DOM 窗口 `renderWindowedMessages` 常驻 20 条）。但该案漏掉了第二个数据入口：`server.mjs` 的 `GET /api/session/attach` 文件轮询回退路径（`poll()`，每 1000ms 一跳）。

当被查看会话由外部进程持有（如宿主 agent 正在运行、或会话锁存在且宿主在跑，`isSessionUiRunning` 为真）时，每一跳都会：

1. `getSessionHistory(cwd, sessionId)` 完整读取 + zstd 解压 + 逐行 JSON 解析**整个**会话文件（900+ 条消息含全部工具参数/输出）；
2. `sendEvent('sync', { messages: history })` 把**全量**历史 `JSON.stringify` 后经 SSE 推给客户端。

客户端 `sync` 处理器随之每秒：`JSON.parse` 数 MB 载荷 → `allMessages` 全量替换（2GB 设备 GC 压力）→ `renderWindowedMessages` 整窗重建（markdown `formatContent` × 20）。即使会话空闲，attach 前 2 跳也会全量推送两次。

结果是 Q20 主线程被持续打满：输入框无响应、快捷键迟滞、滚动卡顿——这正是"900+ 条会话打开后页面不再及时响应"的根因。DOM 懒加载早已生效，用户猜测的"未懒加载"不成立；真凶是**数据层未懒加载的 attach 轮询全量推送**（附带效应：旧服务进程 RSS 高达 6GB）。

## Decision

1. **服务端 `server.mjs`**：
   - 抽出 `findSessionZstdPath(sessionDir)`（v3 > v2 > legacy 选择逻辑），`getSessionHistory` 与轮询器共用；
   - `poll()` 重写：连接时首跳发送**尾部快照**（`messages: history.slice(-20)` + `total` + `startIndex` + `isRunning`）；此后仅当会话文件 mtime+size 签名变化且距上次同步 ≥ 3000ms 才重发，且永远只发尾部 20 条窗口。空闲跳只做 `statSync`，零解压零序列化。
2. **客户端 `static/index.html`（ES5）**：
   - `sync` 处理器采纳 `data.total`/`data.startIndex` 写回 `historyTotal`/`historyStartIndex`，使 attach 快照之后"加载更多"能无缝续拉远端更早历史；
   - `sync` 处理器增加签名去重（消息数 + 末条文本长度 + total），相同快照跳过整窗重建；
   - 加载条文案按用户要求简化为 `加载更多历史消息（X／X）`（已展示／总数，全角括号与全角斜杠），每次点击增量 10 → **20** 条（`WINDOW_PAGE_SIZE = 20`），加载中态简化为 `⏳ 加载中...`。

## Alternatives considered

1. **客户端解析前的全量 JSON 仍保留、仅前端做增量渲染**：每秒数 MB 的 `JSON.parse` 与传输本身就在弱设备上不可接受，必须从源头裁剪——否决。
2. **服务端流式增量 diff（计算新增消息段推送）**：需要跨 zstd 全量解析维护增量状态机，复杂度高、收益边际（尾部窗口已把每跳负载从 O(全量) 降到 O(20)）——留作后续优化，不引入。
3. **仅延长轮询间隔（如 5s）**：不改变每跳 O(全量) 的复杂度，长会话下仍会周期性冻结——否决。
4. **同步快照改走既有 `/api/history?limit=20`**：语义重复且仍需文件变更检测决定何时重发，收益同现状——否决，直接在 SSE 内联尾部快照最简。

## Consequences

- 实测 263 条 / 1.7MB 会话：attach 全程仅 1 次 sync（20 条 + total），随后 `done` 收流；900+ 条会话收益按全量比例线性放大。
- 代价：会话运行期间客户端尾部视图最高 3s 才刷新一次（原为 1s 但伴随全量重建，实际更慢）；该视图仅用于外部进程持有会话的场景，可接受。
- `/api/history` 未传 `limit` 时仍返回全量数组，测试套件与旧调用者契约不变。
