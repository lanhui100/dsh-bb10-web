# 红相证据（实施前失败清单）— Wave 2026-10-16

- Owner: **test-agent**（独立验收方，L2-T 功能契约 + L2-AT 对抗注入）
- 唯一契约来源: [contract-wave-2026-10-16.md](.dev-team/contract-wave-2026-10-16.md)（§0 根因 / §1.1–§1.4 冻结接口 / §3 验收矩阵 / §3bis Addendum v1.1）
- 红相落盘时间: **2026-10-16T15:11+08:00**（本机 `node v22.21.0`，仓库根 `<repo>`）
- 红相物理日志: [red-core.log](tests/acceptance/artifacts/red-core.log) · [red-host.log](tests/acceptance/artifacts/red-host.log) · [red-browser.log](tests/acceptance/artifacts/red-browser.log) · [red-runall.log](tests/acceptance/artifacts/red-runall.log)

---

## 0. 复现命令（原样可跑）

```bash
cd <repo>

# 主门禁（A1–A7, A10）：隔离 mock 实例，零真实宿主 / 零真实 LLM
node tests/acceptance/suite-core.mjs

# 真宿主一致性（A8）：环境不具备时显式 SKIP（退出码 3）
Q20_ACCEPT_RUNNING_SID=<正在运行的会话 id> node tests/acceptance/suite-host.mjs

# 真实页面（A9-C / A9-U）：playwright-core + chromium
node tests/acceptance/suite-browser.mjs

# 总入口（三套件顺序执行 + 聚合退出码）
Q20_ACCEPT_RUNNING_SID=<正在运行的会话 id> node tests/acceptance/run-all.mjs
```

### 退出码语义（绝不伪装成绿）

| 退出码 | 含义 |
|:--|:--|
| `0` | 全部 PASS |
| `1` | 存在 FAIL（断言失败 / SEAM-MISSING / 执行异常） |
| `2` | 套件启动失败 |
| `3` | 无 FAIL 但存在**显式 SKIP(DEGRADED)**（真链路不可用），单列 `degraded=` 计数，不计入 PASS |

`DEGRADED` 一律打印 `[RED DEGRADED: <原因>]` 并记 `⏭ SKIP`，`pass=` 不增加（Lead 裁决 1）。

---

## 1. 用例总览（11 条 = 契约 A1–A10）

| 套件 | 用例 | 契约条目 | 红相结果 |
|:--|:--|:--|:--|
| CORE | A1 运行真源 | §3 A1 / C-4 | ✖ FAIL（断言失败） |
| CORE | A2 LIST_FAIL 对抗注入 | §3 A2 / C-4 | ✖ FAIL（断言失败） |
| CORE | A3 LIST_DELAY 对抗注入 | §3 A3 / C-3 | ✖ FAIL（断言失败） |
| CORE | A4 单一在飞 + 失败退避 | §3 A4 / C-1 C-2 | ✖ FAIL（**SEAM-MISSING**） |
| CORE | A5 子智能体真源 | §3 A5 / C-6 | ✖ FAIL（断言失败） |
| CORE | A6 插队闸门 | §3 A6 / C-7 | ✖ FAIL（断言失败） |
| CORE | A7 轻量状态端点 + C-8 边界 | §3 A7 / C-8 | ✖ FAIL（断言失败） |
| CORE | A10 ES5 门禁 | §3 A10 / F-5 | ✔ PASS（回归护栏，实施前即绿） |
| HOST | A8 真宿主一致性 | §3 A8 | ✖ FAIL（断言失败） |
| BROWSER | A9-C C 面板 | §3 A9 / F-2 | ✖ FAIL（断言失败） |
| BROWSER | A9-U U 面板 | §3 A9 / F-3 | ✖ FAIL（断言失败） |

红相汇总：`CORE total=8 pass=1 fail=7 degraded=0`（exit 1）· `HOST total=1 pass=0 fail=1 degraded=0`（exit 1）· `BROWSER total=2 pass=0 fail=2 degraded=0`（exit 1）。
`run-all` 聚合：`suites=3 failed=3 skipped=0 exit=1`。

> **A10 说明**：ES5 门禁在实施前即为绿（现有 `static/index.html` 已是 ES5），它是防止 T2 引入现代语法的**回归护栏**，不是待修复缺陷。契约 §3 要求 A1–A7、A10 在实施前"红相失败"，A10 的实际语义是"必须保持绿"。

---

## 2. 实施前失败清单（逐条：失败断言 / 期望 vs 实际）

### A1 ✖ FAIL（断言失败）— 运行真源
- 注入: `Q20_MOCK_HOST_RUNNING_SESSIONS=session-acc-a1-0001`
- 造行: `POST /api/workspace/create` + `POST /api/chat/stream`（显式 `sessionId`，落盘真实 zstd 转录）
- 失败断言: `A1 行 isRunning`
- **期望 `true`；实际 `false`**（`state` 兜底为终态）
- 对应根因: §0 缺陷 #1（`session/list` 超时/未生效 → running 集合为 `null` → `sessionTerminalState()` 兜底）

### A2 ✖ FAIL（断言失败）— L2-AT 对抗注入：`session/list` 不可达
- 注入: `RUNNING_SESSIONS=<sid>` + `Q20_MOCK_HOST_LIST_FAIL=1`
- 失败断言: `A2 行 isRunning`
- **期望 `true`；实际 `false`**
- 证明: running 判定仍然依赖 `session/list` 成功（C-4 未落实）

### A3 ✖ FAIL（断言失败）— L2-AT 对抗注入：`session/list` 慢链路 8000ms
- 注入: `RUNNING_SESSIONS=<sid>` + `Q20_MOCK_HOST_LIST_DELAY_MS=8000` + `Q20_MOCK_HOST_RPC_LOG`
- 失败断言: `A3 行 isRunning`
- **期望 `true`；实际 `false`**
- 注: 该用例的耗时断言（`<1500ms`）尚未执行到；`LIST_DELAY_MS` 接缝亦未实现（见 §3）

### A4 ✖ FAIL（**SEAM-MISSING**）— 契约 §1.4 接缝未实现
- 注入: `LIST_FAIL=1` + `Q20_MOCK_HOST_RPC_LOG=<tmp>/rpc.log`
- 失败断言: `A4 Q20_MOCK_HOST_RPC_LOG 接缝活性（mock 必须写入 RPC 收据）`
- **期望 `RPC_LOG 文件存在且 ≥1 条记录`；实际 `5s 内未写入/为空`**
- 归因: **SEAM-MISSING（契约 §1.4 未实现）**，与「行为断言失败」分列
- 该用例的**行为断言（绿相判据）**保持不变并保留：
  1. `RPC_LOG` 被 mock 真实写入（接缝存在）；
  2. `LIST_FAIL=1` 下连续 3 次 `GET /api/sessions` 后，`RPC_LOG` 中 `method==='session/list'` 的行数 **≤ 1**（C-1 单一在飞 + C-2 失败退避 ≥60s；按 Lead C-13 只统计共享主通道）。

### A5 ✖ FAIL（断言失败）— 子智能体真源
- 注入: `Q20_MOCK_HOST_SUBAGENTS=[{"sessionId":"session-acc-a5-child","parentSessionId":"session-acc-a5-parent",…}]` + `LIST_FAIL=1`
- 失败断言: `A5 subagents 必须非空（live 镜像 parentSessionId 兜底，即使 session/list 不可用）`
- **期望 `非空数组 (length ≥ 1)`；实际 `[] (length 0)`**
- 对应根因: §0 缺陷 #3（`items` 非数组即直接返回空）

### A6 ✖ FAIL（断言失败）— 插队闸门
- 注入: `RUNNING_SESSIONS=session-acc-a6-0001`
- 请求: `POST /api/session/prompt {sessionId, prompt, mode:'steer'}`
- 失败断言: `A6 steer 必须放行（不得因 session/list 失败/未跑而拒绝）`
- **期望 `{ok:true}`；实际 `{"ok":false,"error":"session not running"}`**
- 对应根因: §0 缺陷 #4

### A7 ✖ FAIL（断言失败）— 轻量状态端点 C-8
- 注入: `RUNNING_SESSIONS=session-acc-a7-0001`
- 请求: `GET /api/sessions/status?ids=<sid>`
- 失败断言: `A7 响应体 ok`
- **期望 `{ok:true}`；实际 `null`**（该路径未实现，被 SPA 兜底为 HTML 200）
- 该用例同时冻结 C-8 边界：未知 sid → `{isRunning:false,state:'idle'}`；`ids` 为空 → `states:{}`；缺失 `ids` → `400`；单次响应 `<300ms`

### A8 ✖ FAIL（断言失败）— 真宿主一致性（生产态 3090 → 真宿主 3080）
- 运行: `Q20_ACCEPT_RUNNING_SID=session-mvaial3ckyi60b node tests/acceptance/suite-host.mjs`
- 落盘日志首失败断言: `A8 指定会话 /api/sessions 行 isRunning`
  **期望 `true`；实际 `false`**
- **诊断（Lead 裁决 1，已内建 + 家目录脱敏）**: `id=session-mvaial3ckyi60b isRunning=false state=stopped updatedAt=1792134501221.3477 (mtime age=196426ms) cwd=~/dsh-q20-web`
  → 尾部终态推断 `stopped`（回合未终结）+ mtime 新鲜 196.4s（≤300000ms）——正是 **C-20 启发式桥接** 应命中的形态
- **红相归因: 真源缺失（冷启动无权威事实）** —— `$events` 只转发订阅建立之后的事件，Q20 启动前已在跑的会话在 live 镜像中永远没有权威事实；仅靠 C-11 后台播种（宿主 `session/list` 实测 ≈474s / 3891 items）无法及时转绿。**修复由 C-20（本地桥接：`stopped` + mtime ≤300s ⇒ 提升为 running）+ C-11（异步非阻塞播种）共同覆盖**，A8 断言本身保持不变。
- 另一次运行的首失败点为 `A8 响应体 ok` → **期望 `{ok:true}`；实际 `<!DOCTYPE html>`**（`/api/sessions/status` 未实现，SPA 兜底 HTML 200）——同一契约缺口的第二副面孔。
- 就绪探测（Lead 裁决 1）: `/healthz` + `GET /api/sessions?cwd=...` 双探，客户端超时 20000/60000ms（≥15000ms）
- 无 running 会话可采样时 → 显式 `⏭ SKIP(DEGRADED)`（`pass=0 fail=0 degraded=1`，exit 3），**不记 PASS**（skip 原因含前 3 行 `state`/mtime 诊断）

### A9-C ✖ FAIL（断言失败）— 真实页面 C 面板
- 真实 chromium 驱动 `http://127.0.0.1:<mock>/`，按 `C` 进入「全工作区进行中」
- 失败断言: `A9-C C 面板必须渲染出 running 会话行（20s 内未出现任何会话行）`
- **期望 `≥1 行 .tree-sess 且状态图标为 run-dot`；实际 `行数=0; #sess-tree 文本="暂无进行中会话"`**
- 链路自证（非交付件探针 `/tmp/a9-harness-verify.mjs`）：把 `/api/sessions` 拦截为契约期望的 `isRunning:true,state:'running'` 后，同一断言链路**转绿**（`tree= ws-verify (1)● mock-session`，Console Error=0）→ 证明红相失败源于服务端运行态口径，而非测试链路缺陷

### A9-U ✖ FAIL（断言失败）— 真实页面 U 面板
- 前置（真实 UI 路径，与运行状态无关）: 按 `W` → 点工作区行（`selectWorkspace` → `openSess` 模式 0）→ 点会话行 → 断言 `getSid() === session-acc-a9-parent` 通过
- 失败断言: `A9-U U 面板必须渲染出子智能体（20s 内未出现 acc-child-a9）`
- **期望 `包含 "acc-child-a9"`；实际 `#subagent-tree 文本="当前会话暂无子智能体 / Agent Team"`**
- 对应根因: §0 缺陷 #3 的用户可见面
- 链路自证（同上探针）：把 `/api/session/subagents` 拦截为契约期望的子会话后，同一断言链路**转绿**（`tree= ● 子Agentverify-child-a9`，Console Error=0）

---

## 3. SEAM-MISSING 分列（契约 §1.4 未实现，与行为断言失败区别归因）

| 用例 | 缺失接缝 | 红相证据 | 绿相判据 |
|:--|:--|:--|:--|
| A4 | `Q20_MOCK_HOST_RPC_LOG`（mock 未写任何 RPC 收据） | 5s 内 `rpc.log` 未出现/为空 | RPC_LOG 被写入 **且** 3 次 `/api/sessions` 后 `session/list` ≤1 |
| A3（次生） | `Q20_MOCK_HOST_LIST_DELAY_MS` / `RPC_LOG` | A3 先失败于 `isRunning`，未执行到接缝断言 | 接缝活性（`RPC_LOG` 含 `session/list`）**且** 单次 `<1500ms` **且** `isRunning=true` |

> 说明：`SeamMissingError` 是独立错误类，报告打印 `SEAM-MISSING: ...`（不是「断言失败」），但仍计入 `fail=` 并使退出码为 1 —— 接缝未实现同样是红相不通过。

---

## 4. 测试纪律与物理凭证

- **零假测试**：11 条用例全部含真实行为断言；无「只跑不报错」用例；无吞异常（非断言异常记 `执行异常` + 堆栈）。
- **对抗注入（L2-AT）**：A2（RPC 失败）、A3（RPC 慢链路 8s）、A5（RPC 失败 + 子会话）、A8（真宿主不可达/超时）共 4 处确定性注入，全部经契约 §1.4 接缝，未使用任何 `sleep` 盲等判定（均为显式条件轮询 `waitFor`/轮询循环）。
- **隔离与零污染**：每用例独立 mock 实例（`Q20_MOCK_HOST=1` + 临时 `DSH_HOME` + 临时工作区根）；`cleanupTempDirs()` 回收全部临时目录；真实 `~/.dsh/storages/workspace.json` mtime 在红相前后未变化（14:10，早于全部红相运行）。
- **物理收据**：`red-*.log` 为机器原生 stdout（含 `SUITE-*-SUMMARY` 与退出码），A9 环境具备时另有 `artifacts/a9-c-panel.png` / `a9-u-panel.png`（红相下因断言先失败未落盘，绿相必须落盘）。
- **输出脱敏（pre-commit secret-scan 规则 B-internal）**：stdout / 日志 / 本文档一律不含绝对家目录路径 —— A8 诊断的 `cwd` 经 `redact()` 归一为 `~/dsh-q20-web`，`harness.redact()` 把家目录前缀替换为 `~`。
  物理收据（模式以字符类书写，避免收据自身触发门禁）：
  `grep -rnE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance` → 空；
  `grep -rnE '/hom[e]/|ponyjob[.]top|tailscal[e]|/q20-syn[c]/|/ponyll[m]/|/job_copilo[t]/' tests/acceptance` → 空。
- **链路自证（防假红/假绿）**：A9-C / A9-U 除红相外，另用一次性探针（拦截网络层喂入契约期望响应）验证同一断言链路可转绿；CORE 的 A1–A3/A5–A7 红相失败点均为契约对应断言本身（其前置步骤「造行成功」「行存在」「状态码 200」均已通过），故失败归因唯一指向被测行为。
- **A9 环境**：`playwright-core@1.61.1` 自带 chromium 版本未安装时，回退 `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`、`chromium_headless_shell-*`、`/usr/bin/google-chrome`；全部失败才 `[RED DEGRADED: chromium 无法启动…]`（SKIP，exit 3）。本机红相使用 playwright 默认通道，真实页面已跑通。

---

## 5. 冻结清单（sha256，Lead 确认后置只读）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/lib/harness.mjs` | `b9d00ab7765918a65a9ef95015fc9495680572eb508768389636ec7519bf6e64` |
| `tests/acceptance/suite-core.mjs` | `ec70681892b2040bac89aef2fedc3ad9f2e1ff2878074e919835c974e43344d4` |
| `tests/acceptance/suite-host.mjs` | `0dcef74f2e8fb5b0b4d2e50b24355fcb9e245094ffea6737a3d679cd63535f54` |
| `tests/acceptance/suite-browser.mjs` | `9b0c73e3b9925c596f1109dc57e925d4bac9c60b0a0bb22240a3760d0216476f` |
| `tests/acceptance/run-all.mjs` | `5afd97dc1ed1fc418727f5bdb58cf305ff238693dbaa7260c7385aa5804eba9f` |

- write_scopes 仅 `tests/acceptance/`；未触碰 `server.mjs` / `lib/` / `static/`。
- 冻结后 Executor 只读；测试自身缺陷只能由 test-agent 修正并重锚红相（重跑本文件）。

---

## 6. 绿相判据（T1/T2 完成后由 Lead 复核）

1. `node tests/acceptance/suite-core.mjs` → exit 0（A1–A7 + A10 全绿）。
2. `Q20_ACCEPT_RUNNING_SID=<真实运行中会话> node tests/acceptance/suite-host.mjs` → exit 0（真宿主一致；注意：**必须重启生产实例 3090 加载新代码**，否则仍打旧代码）。
3. `node tests/acceptance/suite-browser.mjs` → exit 0，且 `artifacts/a9-c-panel.png` / `a9-u-panel.png` 落盘、Console Error = 0。
4. `node tests/acceptance/run-all.mjs` → exit 0（若 A8 因窗口内无 running 会话而 SKIP，则 exit 3：核心门禁以 `suite-core.mjs` exit 0 为准，A8 需在自身回合运行中以 `Q20_ACCEPT_RUNNING_SID` 复跑）。
