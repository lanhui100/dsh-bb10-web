# Agent Note: 转录头解析缓存与启动预热，消除首屏全树同步解压阻塞

Status: implemented

## Problem

服务本身在线（`/healthz` 200、公网边缘入口 200、宿主 RPC `session/modelCatalog` 仅 10~170ms），
但 Q20 手机端打开页面后停在欢迎加载态十几秒、偶发报「DSH 进程未运行或已停止」，用户观感即"服务打不开"。

现场测定（`~/.dsh/sessions` 已累积 **4024 个转录、1.4GB**）：

- `/api/bootstrap` 冷请求 **7.8~15.2s**；期间 `/healthz` 最大阻塞 **7.56s**（事件循环被同步 CPU 占死）。
- `/api/sessions?cwd=…` 单工作区 **2.4~3.6s**，前端首屏并行拉 6 个工作区，总装载 10~15s。
- 探活 `checkDshHostAlive` 超时 2.5s，被长阻塞连带误杀 → `dshAlive=false`
  → 前端 `loadBootstrap` 直接落「DSH 进程未运行或已停止」终态。
  探活侧的 100ms 二次确认与前端自愈机制见
  `.agents/notes/implemented/bug-fix/2026-10-08-dsh-alive-probe-and-welcome-self-healing.md`；
  本条补的是其根因：误报并非宿主 GC，而是**本进程事件循环被同步解压卡住**，
  阻塞期间探活 timer 与宿主响应同时积压，timer 先到即判死。

前序优化（`.agents/notes/implemented/bug-fix/2026-10-02-session-loading-perf-and-progressive-render.md`）
已消除串行宿主 RPC 与请求风暴；本次继续收口其未覆盖的剩余成本。

根因在 `server.mjs` 的扫描路径：`getWorkspaces()`（工作区树）与 `getSessionsForCwd()`
（会话列表）都要逐个会话执行 `readSessionHeader()`——读取 64KB 前缀、用
`zlib.zstdDecompressSync` 解压最多 5 帧来拿 `id / cwd / title / hasTurns`。4000+ 次同步解压
串起来就是 7~8 秒纯 CPU 阻塞；而工作区缓存 TTL 仅 10s，于是每 10 秒重演一次。

## Decision

1. **按文件指纹缓存解析结果**（`server.mjs` `readSessionHeader` / `sessionHeaderCache`）：
   键为 zstd 路径，指纹为 `mtimeMs + size`。转录只会在尾部追加，指纹变化即重解析，
   未变化直接命中；全树扫描因此退化为 stat-only。命中/写回均做浅拷贝，
   调用方就地修改 `header` 字段不会污染缓存。容量上限 12000 条，超出按插入序 FIFO 淘汰 1/4。
2. **启动预热**（`warmSessionHeaderCacheAsync`）：`listen` 成功后以 `setImmediate` 分批
   （24 条/批）把全树头部灌进缓存，单批约 40~60ms，既让 `/healthz` 保持可响应，
   又保证冷启动后首个 `/api/bootstrap` 撞到热缓存而非空白缓存。
   `Q20_DISABLE_HEADER_WARM=1` 可关闭（测试用）。
3. **不改动任何对外契约**：缓存 TTL、接口结构、DSH 对齐语义（workspace.json 权威序、
   archived 过滤、blank 会话判定）全部保持原样；`readSessionHeader` 行为签名不变。

## Alternatives considered

- *只拉长 `WORKSPACES_CACHE_TTL_MS`（10s → 数分钟）*：把阻塞频率降低而非消除，
  且直接损害新会话/新工作区的可见时延；阻塞峰值依旧是 7~8s，与"事件循环不可卡"的底线冲突。
- *把头部缓存持久化到磁盘*：跨重启免预热，但引入新的磁盘格式、失效一致性与版本迁移负担，
  为一个可用 5 秒预热覆盖的冷启动窗口付出长期维护成本，收益不成比例。
- *整条扫描链路异步化（读文件/解压改 worker 线程）*：治本但改动面覆盖多个扫描函数与
  调用序，超出本次"最小闭包"边界；指纹缓存已把重复成本掉到 stat-only，
  且预热把首次成本摊平，异步化留作后续独立议题。
- *不做启动预热*：缓存能治好"每 10 秒一卡"，但服务重启后首个首屏请求仍要吃满 7~8s，
  而重启后首个请求恰是用户最可能撞上的那一次。

## Consequences

- `/api/bootstrap` 冷请求：7.8~15.2s → **0.20~0.23s**（缓存过期重扫窗口内 ≤210ms）。
- `/api/sessions?cwd=…`：2.4~3.6s → **4~40ms**。
- `/healthz` 最大阻塞：7.56s → **132ms**（预热期间最大 14ms）。
- 启动预热：4024 条转录 **4.75~5.05s** 完成，分摊在多轮事件循环里。
- 内存：头部缓存上限 12000 条（单条仅 id/cwd/title/hasTurns 等小字段）。
- 风险（靠 review）：若转录被**原地改写**而保留 mtime/size（正常追加不会），可能命中旧头；
  盘上副本经 rename 写入属常见路径，风险可忽略，留作 review 检查项。
- 验证门禁：`node test-decoupling.mjs`（PASS，exit 0）+ `node test-suite.mjs`（7/7 PASS，exit 0）
  + ES5 静态解析（PASS）+ 首屏时延回归命令（非零退出即回退）：

```bash
# 首屏 bootstrap 冷请求必须 < 1.5s（超出即视为回归）
node -e 'const http=require("http");const t=Date.now();http.get("http://127.0.0.1:3090/api/bootstrap",r=>{r.resume();r.on("end",()=>{const ms=Date.now()-t;console.log("bootstrap="+ms+"ms");process.exit(ms<1500?0:1);});}).on("error",()=>process.exit(1));'
```
