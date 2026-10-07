# Agent Note: 真实链路测试改 mock 与 q20rm-* 残留清理

Status: implemented

## Problem

`test-unit.mjs` 的"Workspace Create / Remove"契约用例（2a / 2a2）走**真实链路**：经 Q20 服务(3090) 调真实宿主 DSH Web RPC(3080) 的 `workspace/create` / `workspace/delete` / `session/create`，探针命名 `q20rm-*` / `q20unit-*`。用例自身有清理逻辑，但一旦进程中断或宿主瞬时不可达（清理分支 `try{}catch{}` 静默吞错、宿主重写注册表），就会在真实 `~/.dsh/storages/workspace.json` 与 `~/.dsh/sessions` 残留：

1. 实测残留 13 条 `q20rm-*` 工作区注册（`~/` 下目录已被人工清理，注册未注销）；
2. 残留 26 个 `--home-dm-q20rm-*--` 会话转录目录、141 个 `session_projcache` 中 cwd 指向 q20rm 的缓存条目、34 个旧真实链路 `test-suite.mjs` 的 `/tmp/q20-test-sandbox-*` 转录目录；
3. 残留越多，真实 3090 服务每次全量扫描 `SESSIONS_ROOT` 越慢（实测单次 `/api/sessions` 12–26s），`test-unit.mjs` 的 ungrouped 用例 20s 超时失败。

`test-suite.mjs`（真实 LLM 端到端）同样属于"真实链路"：每次运行都向真实宿主建会话、真实模型推理，历史残留同源。

## Decision

**不再做任何真实链路的测试**（用户 2026-09-30 明确要求；部分取代 `.agents/notes/implemented/testing/2026-09-18-test-tiering-and-sandbox-isolation.md` 的第二层"保留真实端到端"决定，其第一层单元分层与沙箱思路继续有效）：

1. **`server.mjs` 内置高隔离 mock 宿主**（双开关，生产默认关闭）：
   - `Q20_MOCK_HOST=1`：`callDshWebRpc` 与 `callDshWebArchiveSession` 全部短路到进程内内存注册表（workspace/session 增删、`session/list`、`session/modelCatalog`、`session/selectModel`、`session/prompt`、`insertSessionBefore`），并对 `~/.dsh/storages/workspace.json`（实际落在临时 `DSH_HOME`）做同构原子读写；
   - `Q20_MOCK_HOME=<dir>`：工作区目录创建根改为临时目录，探针目录绝不落真实 `~/`；
   - `runChatViaHostRpc` 在 mock 分支下跳过真实 mux/WS/follow，合成回合（delta → turn/end → done）并本地写官方口径 zstd 转录（含 header/title/user/assistant/turn-end），`/api/history`、`/api/sessions`、ungrouped 全部可验证。
2. **`test-unit.mjs`**：新建 `lib/test-mock-host.mjs` 拉起独立端口 + 临时 `DSH_HOME` + 临时工作区根的 mock 服务；2a（Workspace Create）、2a2（Workspace Remove）、`/api/session/ensure` 三个真实链路用例全部改为跑在 mock 基址上，断言指向临时注册表，探针命名保留 `q20unit-*`/`q20rm-*` 仅作审计可读。其余纯逻辑/只读用例保持原样。
3. **`test-suite.mjs`**：默认以 mock 宿主运行（7 场景全绿，无真实 LLM/真实宿主）；显式 `Q20_LIVE=1` 才恢复真实链路（须自备运行中的真实 3090 服务）。
4. **清理既有残留**：经宿主 RPC `workspace/delete` 删除 13 条 q20rm 注册（非直写 JSON，避免 global.workspaceIds 与宿主内存态漂移）；删除 26 个 q20rm 转录目录、141 个 projcache 缓存、34 个旧沙箱转录目录。`~/.dsh/storages/workspace.json`、`~/`、`/tmp` 均零 q20rm/q20unit 残留。

## Alternatives considered

- **只加环境变量开关跳过真链路用例**：落选。用户要求"修改为 mock，不再做真实链路的测试"，跳过不满足"仍可验证契约"；且旧清理逻辑一旦中断仍会残留，治标不治本。
- **测试直连 mock 宿主、不开独立 Q20 服务进程**：落选。契约（409/404/仅注销/注册零残留）是 `server.mjs`（`createHomeWorkspace`/`removeWorkspaceByCwd`）的行为，必须让真实服务代码跑起来才测得到；故复用真实 `server.mjs` 靠 env 开关隔离，而非另造假服务。
- **继续保留真实链路仅加清理重试**：落选（曾于 2026-09-18 采纳"保留至少一套真实端到端"）。实测清扫成本高、残留风险持续存在，且用户明确不再需要真实链路覆盖。
- **直写 workspace.json 删 q20rm 条目**：落选。会与宿主 `global.workspaceIds` 顺序、宿主内存缓存及后续原子写竞态，导致幽灵条目或覆盖丢失；一律走宿主 RPC `workspace/delete`（`callDshWebRpc` 被 `Q20_MOCK_HOST` 短路后仅影响测试进程，生产路径不变）。

## Consequences

- 单元与端到端测试默认 100% 隔离：0 真实会话、0 真实工作区、0 真实 LLM、0 家目录/注册表残留；
- `node test-decoupling.mjs && node test-unit.mjs && node test-suite.mjs` 全绿（unit 32/32、suite 7/7），`test-suite.mjs` 总耗时从 ~40s 降到毫秒级，且不再依赖上游模型配额与网络；
- 真实 3090 服务扫描速度恢复（残留清除后无 12–26s 卡顿）；
- 覆盖损失：真实宿主握手 / 真实 WS mux / 真实模型吐字的端到端不再有自动化防线，需按 `Q20_LIVE=1` 人工回归（机器到不了，靠 review）。