# NFR 达标报告 — wave-2026-10-16 会话运行状态权威化

- 日期: 2026-10-16
- 范围: `server.mjs` / `lib/host-live-state.mjs`（新增）/ `static/index.html`
- 基准: `.dev-team/nfr-baseline.json`（含本波 Lead 仲裁的 logging 演进与 wave_2026_10_16_overrides）
- 契约: `.dev-team/contract-wave-2026-10-16.md`（C-1…C-25）

## 逐项对照（L3-P 五问）

| NFR 字段 | 基准要求 | 证据（file:line / 命令） | 达标 |
| :--- | :--- | :--- | :--- |
| external_call_timeout_ms（热路径） | ≤3000；`/api/sessions/status` 零外部调用 | `server.mjs` `peekHostSessionListFull`/`peekHostRunningSessionIds` 同步窥视 + `scheduleHostSessionListRefresh` fire-and-forget；`/api/sessions/status` 纯内存（`sessionStatusFact`）。实测 `/api/sessions` 0.45–0.79s、`/api/sessions/status` 1.1–3.7ms | PASS |
| external_call_timeout_ms（豁免项） | 主通道 600000ms（C-17）、定向 projections 2500–5000ms（C-21/C-22） | `HOST_LIST_FULL_TIMEOUT_MS=600000`；`fetchSessionProjections` 2500ms + 15s 负缓存；二者均不在请求热路径（唯一 `await` 点位于 fire-and-forget 刷新） | PASS |
| logging（本波演进） | `format=text-prefix`、`correlation_token` + `level` | `[HOST-LIVE] … conn=<streamId>`（连接/断开/重连/waterfall 委托）、`[HOST-LIST] … attempt=<n>`；`grep -c "HOST-LIVE"` 生产 journal 实测；无 Cookie/Token 回显（仅入 headers） | PASS |
| concurrency_lock | 单一在飞 + 无竞态 | `hostSessionListFullInflight` 单一在飞（A4 实测 3 次 `/api/sessions` → `session/list` 0 次）；live 镜像单线程同步读写、`copyRow` 拷贝、`noteListItems` 带 `truth.source==='live'` 守卫；C-21 单飞 + 15s TTL | PASS |
| resource_release | clear-timers / abort-xhr / close-sockets | `host-live-state.stop()` 关 WS + 清 reconnect/stability 定时器且不再重连；前端 `sessStatusXhr` 唯一在飞 + `xhr.timeout=10000` + `ontimeout` + 开新代次前 `abort()`；WS 建连 `handshakeTimeout=10000` + 12s open 看门狗 | PASS |
| config / self-check | 可 grep 自检 + 启动非致命降级 | `[HOST-LIVE] connected/events ready/disconnected/reconnect/open-timeout`；ws 模块缺失仅 warn 并继续；`startHostLiveState()` 外层 try/catch；`Q20_MOCK_HOST_*` 五接缝变量在契约 §1.4 有完整语义表且被 grep 证明生产路径不读取 | PASS |

## 机器证据清单（全部真实 stdout）

- `node --check server.mjs && node --check lib/host-live-state.mjs` → exit 0
- ES5 门禁 `acorn {ecmaVersion:5}` → `ES5 PASS`
- `Q20_ACCEPT_RUNNING_SID=<sid> node tests/acceptance/run-all.mjs` → `suites=3 failed=0 skipped=0 exit=0`（A1–A10 共 11 用例）
- `node test-decoupling.mjs` → `DECOUPLING PASS` exit 0
- `node test-unit.mjs` → **35/35 PASS** exit 0
- `node test-suite.mjs` → **7/7 PASS** exit 0
- 浏览器 E2E（A9-C/A9-U）→ `pass=2 fail=0`，Console Error=0，截图 `tests/acceptance/artifacts/a9-{c,u}-panel.png`
- 生产态终验：`/api/sessions?refresh=1` → `isRunning:true, state:"running"`（0.45s，修复前 12.5s / 状态错）；
  `/api/sessions/status` → 1.1ms；`/api/session/subagents?id=<父会话>` → `subagents=8 tasks=3 running=4`（修复前为空）

## 对抗审查结论

`.dev-team/review-l3a.json`（3 findings）/ `review-l3b.json`（7）/ `review-l3p.json`（4）/ `review-incremental.json`（2）
共 16 条 finding 全部闭环或经 Lead 仲裁归因为基准问题；0 误杀。完整归因与残留风险见
`.agents/notes/implemented/bug-fix/2026-10-16-session-running-state-authority.md`。

## 残留风险（显式登记，靠 review）

1. C-20 桥接 300s mtime 窗口：>300s 无 durable 写入的长工具调用回合会被漏判为未运行，由 live 事件或后台播种纠正。
2. `$events` 长连被宿主心跳终止后的秒级重连间隙内事件会丢，由下一次事件或播种纠正（`[HOST-LIVE]` 可 grep）。
3. `/api/sessions/status` 在「无任何权威事实」路径做一次有界可缓存的 durable 目录定位（其余路径零磁盘 IO）。
4. 冷 `/api/bootstrap` ≈12s 为宿主依赖的既有环境特性（A/B 证明与本次改动无关）。
5. 既有运维脆弱性（A/B 发现，非本波引入）：`/api/sessions/ungrouped` 全库同步扫描阻塞事件循环 ≈4s（旧 3.85s / 新 2.59s），
   重负载下会让 `q20-watchdog` 的 5s `/healthz` 探活超时并触发重启；单设备正常使用无影响，根治属独立事项。

## 部署核验（2026-10-16）

| 项 | 结果 |
| :--- | :--- |
| 运行代码 = 已提交修订 | `server.mjs` / `static/index.html` / `lib/host-live-state.mjs` 与 `HEAD` sha256 一致 |
| 本机服务 | `dsh-q20-web.service` active；`q20-watchdog.timer` active；`/healthz` 200 |
| 公网入口（Q20 设备路径） | `GET /healthz` → 200；BB10 UA 下 `GET /` → 200 且字节数与本地一致（572157） |
| 鉴权门禁 | 未认证 `/api/*` 与默认 UA 均 403（EdgeOne 机器人防护 + 应用鉴权），预期行为 |
| 推送 | `origin/main` `1317c05..49af44b`；tag `wave-2026-10-16` / `wave-2026-10-16-red` 已推送；pre-push 门禁 `secret-scan clean, npm test green` |

