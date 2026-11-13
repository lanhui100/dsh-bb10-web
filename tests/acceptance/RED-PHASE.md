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

---

# 红相（Wave 2026-10-18）— 思考强度 reasoningEffort 选择 + 模型目录刷新

- Owner: **test-agent**（独立验收方，L2-T）；契约唯一来源: [contract-wave-2026-10-18.md](.dev-team/contract-wave-2026-10-18.md)（§0 根因 / §1.1–§1.6 冻结接口 / §3 验收矩阵 A1–A8）
- 红相落盘时间: **2026-10-18T12:02+08:00**（本机 `node v22.21.0`，chromium 真实通道）
- 物理日志: [red-reasoning.log](tests/acceptance/artifacts/red-reasoning.log) · [red-runall-2026-10-18.log](tests/acceptance/artifacts/red-runall-2026-10-18.log)
- 物理截图: [a7-effort-panel.png](tests/acceptance/artifacts/a7-effort-panel.png)（真实 chromium 720×720，面板**只有模型行、无「思考强度」分组** = 根因 R4 的用户可见面）
- 交付件: 新增 `tests/acceptance/suite-reasoning.mjs`（冻结件）；`run-all.mjs` 的 `SUITES` 追加该套件（现 4 套件聚合）

## 7.1 复现命令与退出码

```bash
cd <repo>
node tests/acceptance/suite-reasoning.mjs   # exit 1
node tests/acceptance/run-all.mjs           # exit 1（suites=4 failed=1 skipped=0）
```

| 运行 | 摘要 | 退出码 |
|:--|:--|:--|
| `suite-reasoning.mjs` | `SUITE-REASONING SUMMARY: total=8 pass=1 fail=7 degraded=0` | **1** |
| `run-all.mjs` | `ACCEPTANCE-ALL SUMMARY: suites=4 failed=1 skipped=0 exit=1`（CORE/HOST/BROWSER 仍 exit 0，REASONING exit 1） | **1** |

退出码语义与 `run-all` 完全一致：`0` 全绿 · `1` 有 FAIL（断言失败 / SEAM-MISSING / 执行异常）· `2` 套件启动失败 · `3` 无 FAIL 但存在显式 `[RED DEGRADED: 原因]`（真链路不可用，不计 PASS）。A7 环境不足时走 `skip()` → exit 3；本机 chromium 可用，故为真实 FAIL。

## 7.2 逐条红相证据（期望 vs 实际）

| ID | 断言要点 | 红相结论 | 真实失败摘要 |
|:--|:--|:--|:--|
| A1 | `bootstrap.models[]` 的 `glm-5.3-flash` 携 `reasoning.efforts` 3 项 + `defaultEffort=high`；`current.reasoningEffort` 非空 | ✖ FAIL（断言失败） | `reasoning` 缺失：**期望 `{efforts:[{id,name}…],defaultEffort:"high"}`；实际 `{"provider":"ponyllm","model":"glm-5.3-flash","name":"GLM-5.3-Flash","contextWindow":0}`**（根因 R2） |
| A2 | 30s TTL 内两次普通 `/api/bootstrap` 的 `session/modelCatalog` 收据 ≤1；`?refresh=1` 收据 +1 | ✖ FAIL（断言失败） | `plain×2 = 1 次`（TTL 生效）后 `?refresh=1` 仍为 **1 次**：**期望 `2 次`；实际 `1 次`**（根因 R8 无强制刷新入口） |
| A3 | 带 `reasoningEffort:'low'` → `selectModel` 收据 `args.reasoningEffort==='low'` 且 provider/model 正确；不带该键时 `args` 无该字段 | ✖ FAIL（**SEAM-MISSING**，§1.5.2 未实现） | 2 条 `session/selectModel` 收据均有 `method/at` 但**无 `args`**：`[{"method":"session/selectModel","at":…},{"method":"session/selectModel","at":…}]`；两个回合本身 status 200 + `done`，前置通过 |
| A4 | `reasoningEffort:123` → 400 且文案含 `reasoningEffort`；>64 字符 → 400；`''` → 照常 200 流 | ✖ FAIL（断言失败） | **期望 `400`；实际 `200`**（非 string 被静默忽略并起流，§1.3 校验缺失） |
| A5 | mock seed 回合带 `reasoningEffort:'low'` → `/api/session/stats` 返回 `'low'`；无 effort 会话 → `''` | ✖ FAIL（断言失败） | stats 200 但字段缺失：**期望 `low`；实际 `undefined`**（根因 R5；§1.5.3 转录 config 亦未落） |
| A6 | `static/index.html` 全部内联 script 经 acorn `{ecmaVersion:5}` 解析 | ✔ PASS（**回归护栏**） | `ES5 PASS (1 个内联 script, acorn 7.4.1)` |
| A7 | 真实浏览器：点模型徽标开面板出现「思考强度」分组/档位；点 `Low` 后徽标含 `·` 与 `Low`；面板收起；Console Error=0；截图落盘 | ✖ FAIL（断言失败） | 面板打开且模型行渲染正常，但 **`#model-tree` 无「思考强度」**：实际文本 `▼ ⭐ 常用 (0个模型) … ▼ ponyllm (3个模型) ● GLM-5.3-Flash · DeepSeek-V4-Flash · Kimi-K3 ▼ local (1个模型) · Mock Local 1`（根因 R4） |
| A8 | 静态接线（AST 结构断言）：`openModel()` 发 `/api/bootstrap?refresh=1`；`/api/chat/stream` 发送函数（最内层 `doSend()`，27889B）载荷含 `reasoningEffort` | ✖ FAIL（断言失败） | `openModel 目录刷新=false；发送函数 reasoningEffort=false`（openModel 片段仅关闭各面板 + `renderModelTree()`；根因 R7 / R3 前端侧） |

> **A6 说明（不得误读为「待修复」）**：ES5 门禁在实施前即为绿（现有 `static/index.html` 已是 ES5），它是防止 T-WEB 引入模板串、箭头函数、`let/const` 等现代语法的**回归护栏**：实施完成后必须保持 PASS，一旦转红即一票否决。

## 7.3 mock 接缝状态（契约 §1.5 三点，实施前均缺失）

| 接缝 | 契约要求 | 实施前实测 | 红相影响 |
|:--|:--|:--|:--|
| §1.5.1 `session/modelCatalog` mock | `glm-5.3-flash` 带 `reasoning.efforts[off,low,high]` + `defaultEffort:'high'`，`default.reasoningEffort:'high'` | 无 `reasoning`，`default` 仅 `{provider,model}` | A1 断言失败、A7 无档位可渲染 |
| §1.5.2 `mockNoteRpc` | 收据行扩为 `{"method","at","args":<request>}` | 仅为 `{"method","at"}` | A3 判 **SEAM-MISSING**（收据无 `args`，无法断言透传内容；非「行为判负」） |
| §1.5.3 `mockPersistTranscript` | header 行补 `config:{provider,model,reasoningEffort?}` + 追加 `request/header` 事件行 | header 无 `config`，无 `request/header` 事件 | A5 断言失败（stats 无 `reasoningEffort` 来源） |

> `SeamMissingError` 与断言失败分列打印，但同样计入 `fail=` 并使退出码为 1 —— 接缝未实现同样是红相不通过，不放宽、不跳过。

## 7.4 红相真实性核查（防假红）

- **无语法/导入错误**：`node --check suite-reasoning.mjs` 通过；套件正常进入 8 条用例并输出机器摘要（非 exit 2）。
- **无接口 500 当红相**：A1/A2/A3/A4/A5 全部为 HTTP 200（或断言点上的 400 期望）下的真实语义断言；A3 两回合 SSE 均 `start→delta→done`，说明前置链路健康，失败点唯一指向 `selectModel` 透传。
- **接缝失败仍附行为证据**：A3 除 SEAM-MISSING 外，前置断言（2 条 `session/selectModel` 收据、状态码、终态）均已 PASS，可证明 `selectModel` 确实被调用、只是收据不带 `args`。
- **A7 为真实链路**：真实 chromium（playwright 默认通道，720×720）驱动 `http://127.0.0.1:<mock>/`，点击 `#model-badge` 真实交互，面板真实渲染（截图见上），失败点为面板缺少思考强度分组。
- **A8 为 AST 结构断言**：acorn 解析内联脚本后按「最内层函数」定位（`doSend()` 27889B / `openModel()` 677B），避免外层 IIFE 兜底命中造成空洞通过。
- **隔离与零污染**：每条用例独立 mock 实例（`Q20_MOCK_HOST=1` + 临时 `DSH_HOME` + 临时工作区根），`cleanupTempDirs()` 全量回收；未触碰 `server.mjs` / `static/index.html`（只读），未 `git add/commit`。
- **输出脱敏**：stdout / 日志 / 本文档不含绝对家目录路径（`redact()` 归一）；`grep -rnE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-reasoning.log` → 空。

## 7.5 冻结清单（sha256，Lead 复核后置只读）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-reasoning.mjs` | `00d67f4ce22ea70637947365194f431040ac0ea66d00e446f081f847585e65b8` |
| `tests/acceptance/run-all.mjs`（SUITES 追加） | `1ad71b64b8bd12ebf828a4308004ed5c58d1b755a02df897793fc3064cb2078f` |
| `tests/acceptance/lib/harness.mjs`（未改动） | `b9d00ab7765918a65a9ef95015fc9495680572eb508768389636ec7519bf6e64` |
| `tests/acceptance/suite-core.mjs`（未改动） | `ec70681892b2040bac89aef2fedc3ad9f2e1ff2878074e919835c974e43344d4` |
| `tests/acceptance/suite-host.mjs`（未改动） | `0dcef74f2e8fb5b0b4d2e50b24355fcb9e245094ffea6737a3d679cd63535f54` |
| `tests/acceptance/suite-browser.mjs`（未改动） | `9b0c73e3b9925c596f1109dc57e925d4bac9c60b0a0bb22240a3760d0216476f` |

## 7.6 本波绿相判据（T-SRV / T-WEB 完成后由 Lead 复核）

1. `node tests/acceptance/suite-reasoning.mjs` → **exit 0**：A1–A5、A7、A8 全绿，A6 保持 PASS。
2. `node tests/acceptance/run-all.mjs` → **exit 0**（4 套件全绿；HOST 若因窗口内无 running 会话 SKIP 则为 exit 3，以 `suite-reasoning.mjs` exit 0 为准）。
3. A7 绿相要求 `artifacts/a7-effort-panel.png` 中可见「⚙ 思考强度」分组（含 `Off/Low/High`，当前项 `●`）且 `a7-effort-badge.png` 徽标含 `· Low`，Console Error = 0。

## 7.7 红相 #2（契约 v1.1 §5.5 A9–A12）— L3 对抗审查后追加的回归用例

- 落盘时间: **2026-10-18T12:56+08:00**；owner: **test-agent**（L2-T）
- 契约来源: [contract-wave-2026-10-18.md](.dev-team/contract-wave-2026-10-18.md) §5.1–§5.5（v1.1 修订），审查证据 `.dev-team/review-l3a-wave3.json` / `review-l3b-wave3.json`
- 物理日志: [red-reasoning2.log](tests/acceptance/artifacts/red-reasoning2.log) · 物理截图: [a9-effort-rollback.png](tests/acceptance/artifacts/a9-effort-rollback.png)（真实 chromium 720×720：用户已选 High，底栏徽标却回落为 `glm-5.3-flash · Low`）
- 运行: `node tests/acceptance/suite-reasoning.mjs` → **exit 1**（`total=12 pass=8 fail=4 degraded=0`）
  - A1–A8（v1.0 已转绿）**保持 PASS**，A9–A12 全部真实失败 → 聚合 `run-all.mjs` 随之为 exit 1。

| ID | 断言要点 | 红相结论 | 真实失败摘要（期望 vs 实际） |
|:--|:--|:--|:--|
| A9 | 真实浏览器 + 延迟 `/api/session/stats`（playwright route 扣住 2500ms）：转录 effort=low 的会话里用户选 High，在途 stats 到达后徽标/面板 ● 仍 High，发送载荷 `reasoningEffort='high'` | ✖ FAIL（断言失败，非前置失败） | 前置全通过（会话 stats 校真为 low → 开面板触发在途 stats → 选 High 后徽标立即 `"glm-5.3-flash · High"`）；**在途回包落地后观察 1.5s 终值 `"glm-5.3-flash · Low"`**（期望保持 High）。根因：`applyEffortChoice` 未推进 `sessionModelRevision`/`sessionModelDirty`（§5.3.3） |
| A10 | 同会话 turn1 effort=low、turn2 不带该键 → `/api/session/stats.reasoningEffort === ''` | ✖ FAIL（断言失败） | 前置 turn1 stats=`low` 通过；**turn2 后 stats 仍为 `low`，期望 `''`**。根因：stats 折叠保留「最近一个非空值」，未整体替换最新 `request/header`（§5.1） |
| A11 | 真实浏览器：glm-5.3-flash 选 Low 后切同 provider 的 kimi-k3 → 生效档位取新模型 `defaultEffort='high'` | ✖ FAIL（断言失败；接缝缺失为同一根因的可读面） | 切换后 **徽标 `"kimi-k3"`（无档位后缀），期望含 `"· High"`**；页面内实测 `modelReasoningMap['ponyllm:::kimi-k3'] = null`（§5.4 mock 目录未给 kimi-k3 加 reasoning）。接缝补齐后仍受 §5.3.1 守卫：当前 `effortOnModelChange` 会保留同 provider 的 Low |
| A12 | 目录刷新容错：`Q20_MOCK_HOST_CATALOG_FAIL=1` 接缝生效；`FAIL_AFTER=1` 先暖缓存、其后 catalog 失败 → `?refresh=1` 返回上一份含 reasoning 的目录 | ✖ FAIL（接缝缺失，可读断言） | `FAIL=1` 实例仍返回宿主目录：**期望「无模型携带 reasoning（退回磁盘镜像）」；实际 `ponyllm/glm-5.3-flash` 仍带 reasoning**。根因：mock 未实现 catalog 失败接缝（§5.4 由 Lead 裁定为 `CATALOG_FAIL` 全失败 + `CATALOG_FAIL_AFTER=<n>` 成功 n 次后失败） |

### A12 设计说明（接缝语义按 Lead 裁定）

1. **接缝活性是第 1 断言**：`Q20_MOCK_HOST_CATALOG_FAIL=1`（全失败）下不得再返回宿主目录——宿主目录是 `reasoning` 的唯一来源，磁盘兜底路径按 §1.1 不产出该字段，故这是可机器判定的接缝存在性证据。
2. **主断言是第 2 断言**：`Q20_MOCK_HOST_CATALOG_FAIL_AFTER=1` → 首次 `/api/bootstrap` 暖缓存（断言取下 3 档 efforts）→ 后续 `?refresh=1` 失败时仍返回该缓存（3 档 + `current.reasoningEffort='high'`），不得塌缩为无 reasoning 的磁盘镜像（§5.2）。
3. 红相下第 1 断言即失败（接缝未实现），故第 2 断言的红相证据在 Executor 补齐接缝后由同一条用例继续判定——即接缝与行为双保险，不放宽、不跳过。

### 红相真实性核查（防假红）

- `node --check` 通过；套件正常输出 `SUITE-REASONING SUMMARY`（非 exit 2）。
- A9/A11 为真实 chromium（720×720）链路：A9 的失败点是「在途 stats 回包落地后徽标被回滚」的观测断言，前置（会话选中 `getSid()`、stats 校真、面板档位点击、徽标即时 High）全部通过；A11 的失败点是切换模型后的档位断言，前置（glm 选 Low 成功、kimi 模型行点击成功）全部通过。
- A10/A12 均为服务端 HTTP 断言（stats JSON / bootstrap JSON），无 500、无语法/导入错误。
- A9 的延迟注入用 playwright route（确定性扣住回包），判定用「回包完成事件 Set + 1.5s 采样观察窗口」，非盲 sleep 判定；A11 的面板断言在「重开面板 stats 回包落地之后」判定，不吃时序红利。
- 隔离与零污染：A9/A11 每例独立 mock 实例（临时 `DSH_HOME` + 临时工作区根），`cleanupTempDirs()` 回收；A12 使用 `startMockServer` 直连以注入新接缝（`launchMock` 未暴露该 env，harness.mjs 冻结不改）。
- 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-reasoning2.log` → `0`。

### 7.7.1 TEST-DEFECT 修正（A11 marker 扫描）— Lead 裁定 2026-10-18T13:12+08:00

- **缺陷（测试自身，非实现缺陷）**：A11 原实现取「`#model-tree` 中第一个含 `●` 的 `.tree-item`」文本再断言含 `High`。
  但既有 UI 的**选中模型行本身即以 `● ` 前缀渲染**（`applyModelChoice` 渲染口径），且契约 §1.6 规定思考强度分组追加在
  模型分组**之后**，故该扫描必然命中模型行 → 对任何合规实现都不可满足；与 A7(`:630-638`) / A9(`:820-828`) 的「`●` 且 `High`」合取扫描不一致。
- **修正（最小闭包）**：A11 marker 扫描限定为「同时含 `●` 与 `High` 的行」，与 A7/A9 同口径；**未改动其他任何断言**，
  主断言（切 kimi-k3 后徽标必须含 `· High`）保持原样。
- **红相凭证继续有效**：修正前红相（本文件表格 + `red-reasoning2.log` 12:56 段落）中 A11 的失败点是**主断言**
  （切换后徽标 `"kimi-k3"` 无档位后缀，`kimi reasoning=null`），执行流根本未到达 marker 扫描 —— 该 TEST-DEFECT 不参与红相判定，也不改变其结论。
- **修正后重跑（追加于 `red-reasoning2.log` 末尾）**：重跑时工作区已含 Executor 的 v1.1 修复
  （`server.mjs` +184 行 / `static/index.html` +285 行：`Q20_MOCK_HOST_CATALOG_FAIL_AFTER` 接缝、stats 最新 request/header 整体替换、
  `applyEffortChoice` 脏标记与版本推进、kimi-k3 reasoning），结果为 **`total=12 pass=12 fail=0 degraded=0`，`EXIT=0`**：
  - A9 绿相实证：`选 High 后徽标="glm-5.3-flash · High"；回包后观察终值="glm-5.3-flash · High"；面板 ● High 命中；发送载荷 reasoningEffort=high`
  - A11 绿相实证：`glm 选 Low 后徽标="glm-5.3-flash · Low"；切 kimi 后徽标="kimi-k3 · High"；面板档位 ● High 命中；kimi reasoning={"efforts":[low,high],"defaultEffort":"high"}`
  - A10 / A12 同时转绿（最新 request/header 整体替换；`FAIL=1` 与 `FAIL_AFTER=1` 接缝生效且暖缓存目录未塌缩为磁盘镜像）
- **「修正后红相」为何不可复现**：红相要求的是**未修复实现**，而当前工作区已是 v1.1 修复版；回滚业务代码越出 test-agent 写域
  （`server.mjs` / `static/index.html` 属 executor 写域，只读）。故以「修正前红相（12:56）+ 修正后绿相（13:12）」双凭证代替，
  未放宽任何断言、未使用 skip，符合防假红/防假绿要求。
- 证据文件：`tests/acceptance/artifacts/red-reasoning2.log` 末尾「修正后重跑」段落（含命令、`SUITE-REASONING SUMMARY` 与 `EXIT=0`）。

### 冻结清单更新（sha256）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-reasoning.mjs`（v1.1 追加 A9–A12 + TEST-DEFECT 修正） | `e395b15c502b5bcbaf68daff0eaae8338cd66c9c96e3207e02d2a5875ce9c57f` |
| `tests/acceptance/run-all.mjs`（未再改动） | `1ad71b64b8bd12ebf828a4308004ed5c58d1b755a02df897793fc3064cb2078f` |
| `tests/acceptance/lib/harness.mjs`（未改动） | `b9d00ab7765918a65a9ef95015fc9495680572eb508768389636ec7519bf6e64` |

### 绿相判据（A9–A12 追加）

1. `node tests/acceptance/suite-reasoning.mjs` → **exit 0**（A1–A12 全绿），且 `artifacts/a9-effort-rollback.png` 中徽标保持 `· High`。
2. A12 绿相要求 mock 同时实现 `Q20_MOCK_HOST_CATALOG_FAIL=1`（全失败）与 `Q20_MOCK_HOST_CATALOG_FAIL_AFTER=<n>`（成功 n 次后失败）。

---

# 红相（Wave 2026-11-06）— 预览越界读取的会话策略授权（preview-policy）

- Owner: **test-agent**（独立验收方；L2-T 功能契约 + L2-AT 三类对抗；Executor 只读本波测试文件）
- 唯一契约来源: [contract-wave-2026-11-06.md](.dev-team/contract-wave-2026-11-06.md)（§1.1 纯函数字段 / §1.2 错误码表 / §1.3 `/api/file` 处理顺序 / §1.4 接缝 / §2 决策顺序真值表 / §3 A1–A9 / §3bis AT-1…AT-3）
- 红相落盘时间: **2026-11-06T08:11+08:00**（本机 `node v22.21.0`，仓库根 `<repo>`）
- 物理日志: [red-preview-policy.log](tests/acceptance/artifacts/red-preview-policy.log) · [red-preview-policy-at.log](tests/acceptance/artifacts/red-preview-policy-at.log) · [red-preview-policy-runall.log](tests/acceptance/artifacts/red-preview-policy-runall.log)
- 红相原语：`lib/preview-policy.mjs` 空桩（`decidePreviewReadAccess` 函数体仅 `throw new Error('NotImplemented')`）+ `server.mjs` 的 `/api/file` 尚不识别 `session` query。

## 8.1 复现命令（原样可跑）

```bash
cd <repo>

# L2-T 功能契约（A1–A5 纯函数 / A6–A9 服务端集成，隔离 mock 实例）
node tests/acceptance/suite-preview-policy.mjs            # → exit 1（红相）

# L2-AT 三类对抗（失败/超时注入 · 畸形负载 · barrier 并发竞态）
node tests/acceptance/adversarial/preview-policy-attack.mjs   # → exit 1（红相）

# 聚合总入口（8 套件；本波两套件已登记其中）
node tests/acceptance/run-all.mjs
```

退出码语义沿用既有约定（0=PASS / 1=FAIL / 2=套件启动失败 / 3=显式 SKIP(DEGRADED)）。

## 8.2 用例总览（22 条 = L2-T 14 + L2-AT 8）

| 套件 | 用例 | 契约条目 | 红相结果 |
|:--|:--|:--|:--|
| suite-preview-policy | A1 快路径 a（4 组参数） | §2 a / §3 A1 | ✖ FAIL（断言失败） |
| suite-preview-policy | A2 无 session 越界（4 组参数） | §2 b / §3 A2 | ✖ FAIL（断言失败） |
| suite-preview-policy | A3 c 步会话归属（5 组参数） | §2 c / §3 A3 | ✖ FAIL（断言失败） |
| suite-preview-policy | A4 d 步权限（6+1 组） | §2 d / §3 A4 | ✖ FAIL（断言失败） |
| suite-preview-policy | A5 e 步放行 + 9 组畸形输入 | §2 e / T10 / §3 A5 | ✖ FAIL（断言失败） |
| suite-preview-policy | A6 无 session 越界字节等价 + 区内 200 | §1.3 铁律 / §3 A6 | ✔ PASS（向后兼容护栏，实施前即绿） |
| suite-preview-policy | A6b 未注册工作区仍 403 且不泄路径 | §1.3 / §3 A6 | ✔ PASS（护栏，实施前即绿） |
| suite-preview-policy | A7 快路径零宿主调用（`PROJECTIONS_FAIL=1` + RPC 收据=0） | §1.3 / §3 A7 | ✔ PASS（护栏，实施前即绿） |
| suite-preview-policy | A8 完全权限 + 同 cwd 放行越界白名单文件 | §3 A8 | ✖ FAIL（断言失败：期望 200，实际 403） |
| suite-preview-policy | A9.1a 宿主失败（FAIL 接缝）→ 403 UNAVAILABLE + `[PREVIEW]` warn | §1.3③ / §3 A9.1 | ✖ FAIL（断言失败：无 code） |
| suite-preview-policy | A9.1b 该 sid 无投影（values 无 permissions）→ 403 UNAVAILABLE | §1.3③ / §3 A9.1 | ✖ FAIL（断言失败：无 code） |
| suite-preview-policy | A9.2 workspace-write 越界 → 403 PERMISSION_REQUIRED | §3 A9.2 | ✖ FAIL（断言失败：无 code） |
| suite-preview-policy | A9.3 session 指向别的 cwd → 403 SESSION_MISMATCH | §3 A9.3 | ✖ FAIL（断言失败：无 code） |
| suite-preview-policy | A9.4 完全权限后仍 415（.bin）/ 413（>2MB 文本） | §3 A9.4 / §4-1 | ✖ FAIL（断言失败：期望 415，实际 403） |
| adversarial | AT-1a `PROJECTIONS_FAIL=1`（该 sid 本为完全权限）→ fail-closed + 无字节出网 + warn | §3bis AT-1 | ✖ FAIL（断言失败：无 code） |
| adversarial | AT-1b `PROJECTIONS_DELAY_MS=6000` → 403 且墙钟 ≤3000ms；区内 ≤500ms | §3bis AT-1 | ✖ FAIL（断言失败：无 code） |
| adversarial | AT-1c 接缝无该 sid 投影 → 403 UNAVAILABLE | §3bis AT-1 | ✖ FAIL（断言失败：无 code） |
| adversarial | AT-2a `..%2f` 编码穿越（无 session / workspace-write / 完全权限三读法） | §3bis AT-2 | ✖ FAIL（断言失败：workspace-write 无策略码） |
| adversarial | AT-2b/c NUL(`%00`) · ≥4096B 超长 path · `../../etc/passwd` | §3bis AT-2 | ✔ PASS（护栏，实施前即绿） |
| adversarial | AT-2d 伪造 session（穿越/超长/含分隔符/空串/重复）+ 零 RPC | §3bis AT-2 | ✔ PASS（护栏，实施前即绿） |
| adversarial | AT-2e 客户端自述 `permission=danger-full-access` 被忽略 | §3bis AT-2 / §4-4 | ✖ FAIL（断言失败：无策略码） |
| adversarial | AT-3 两 sid barrier 并发 20 轮 → 无策略串味 | §3bis AT-3 | ✖ FAIL（断言失败：full 未放行） |

红相汇总：`total=14 pass=3 fail=11 degraded=0`（exit 1）· `total=8 pass=2 fail=6 degraded=0`（exit 1）·
`run-all` 聚合：`suites=8 failed=3 skipped=0 exit=1`（另两家既有红相：`suite-statusqueue-browser` A8 为**前序波次既有失败**，与本波次无关——本波未改动 `server.mjs` / `static/index.html`）。

## 8.3 关键失败断言（期望 vs 实际，逐条原样摘自日志）

| 用例 | 失败断言 | 期望 | 实际 |
|:--|:--|:--|:--|
| A1–A5 | `decidePreviewReadAccess` 不得 throw | 四字段对象 | `threw: NotImplemented`（空桩） |
| A8 | 完全权限 + 同 cwd + 越界白名单文件 → status | `200` | `403` |
| A9.1a/A9.1b | 宿主失败 / 无投影 → 响应 `code` | `PREVIEW_POLICY_UNAVAILABLE` | `undefined`（旧体无 code） |
| A9.2 | workspace-write 越界 → `code` | `PREVIEW_PERMISSION_REQUIRED` | `undefined` |
| A9.3 | session 指向别 cwd → `code` | `PREVIEW_SESSION_MISMATCH` | `undefined` |
| A9.4 | 完全权限下 .bin → status | `415` | `403` |
| AT-1a/b/c | 注入失败/超时/无投影 → `code` | `PREVIEW_POLICY_UNAVAILABLE` | `undefined` |
| AT-2a | workspace-write 编码穿越 → 拒绝码 | `PREVIEW_PERMISSION_REQUIRED` 或 `SESSION_MISMATCH` | `undefined` |
| AT-2e | 伪造 permission 被忽略 → 拒绝码 | `PREVIEW_PERMISSION_REQUIRED` | `undefined` |
| AT-3 | 20 轮并发：每轮 full=200 / write=403 | 稳定双结果 | `round 1 sid-full 未按完全权限放行（实际 403 path escapes…）` |

## 8.4 接缝状态（契约 §1.4）

| 接缝 | 实施前状态 | 说明 |
|:--|:--|:--|
| `Q20_MOCK_HOST_PROJECTIONS` | 已存在（`mockSeamProjections`）但 `/api/file` **从不读取**（无 `session` query） | A8/A9/AT-3 用它注入「权威投影」；A8 用例断言 RPC 收据 `session/projections ≥1` 作为接缝活性证据 |
| `Q20_MOCK_HOST_PROJECTIONS_FAIL=1` | **不存在** | A9.1a/AT-1a 用「FAIL + 该 sid 本为完全权限」的组合判定：若接缝未实现则 mock 仍返回完全权限 → 必须 200 → 用例失败。故该接缝的真实性由行为断言强制 |
| `Q20_MOCK_HOST_PROJECTIONS_DELAY_MS=6000` | **不存在** | AT-1b 同时断言「403 UNAVAILABLE + 墙钟 ≤3000ms」 |
| `Q20_MOCK_HOST_RPC_LOG` | 已存在（`mockNoteRpc`） | A7 用「`session/projections` 收据 = 0」物理计量「快路径零宿主调用」；AT-2d 用同一计量 + 3000ms 延迟接缝证明非法 session 未发起 RPC |

> **给实现者的硬事实（不是放宽断言的理由）**：mock 分支 `callDshWebRpc` 对 `Q20_MOCK_HOST` 短路实现，**不校验 `timeoutMs`**。
> 因此 `Q20_MOCK_HOST_PROJECTIONS_DELAY_MS` 的延迟必须自身带 2500ms 上限（与 `PROJECTIONS_TIMEOUT_MS` 同级 race），
> 否则 AT-1b 的墙钟断言（≤3000ms）必然失败——契约 §3bis AT-1 第 2 行明确要求该上限。

## 8.5 红相真实性核查（防假红）

1. `node --check tests/acceptance/suite-preview-policy.mjs`、`node --check tests/acceptance/adversarial/preview-policy-attack.mjs`、`node --check tests/acceptance/lib/preview-host.mjs` 均通过；两套件均正常输出 `SUITE-* SUMMARY`（**非 exit 2**，无 `MODULE_NOT_FOUND` / `SYNTAX` 失败）。
2. 纯函数的 `throw new Error('NotImplemented')` 被用例显式归类为**断言失败**（`不得 throw（契约 §1.1）`），不是逃逸的执行异常；A1–A5 的失败点是行为断言，不是导入失败。
3. 服务端用例的失败点全部是行为断言（`200 vs 403` / `code undefined vs 冻结码` / `415 vs 403`），无 500、无连接错误。
4. 实施前即绿的 5 条（A6/A6b/A7/AT-2b·c/AT-2d）是**向后兼容与畸形输入护栏**，语义为「实施后必须保持绿」，不是待修缺陷（同类口径见 2026-10-16 波次 A10 说明）。
5. 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-preview-policy*.log` → `0 0 0`。
6. 隔离与零污染：每用例独立 mock 实例（临时 `DSH_HOME` + 临时工作区根 + 临时 HOME），`stop()` 内回收；跨用例不复用实例（规避 `session/projections` 15s 正/负缓存串味，契约 §3bis 对抗前提）。
7. 无 sleep 竞态：AT-3 的「同时性」由**同一 tick 内并发发起两条请求**实现（barrier），结果按轮逐条断言；日志等待用 `waitForLog` 条件轮询，无盲等判定。
8. 冻结产物零改写：本波只新增 `red-preview-policy*.log`；浏览器套件跑动覆盖的既有 PNG 已按 Lead 指令 `git checkout -- tests/acceptance/artifacts/` 恢复（`git status --porcelain tests/acceptance/artifacts` 仅剩 3 个 `?? red-preview-policy*.log`）。

## 8.6 契约歧义（已上报 Lead 裁决；测试取「安全交集」不自行改契约）

1. **重复 `session` 参数**：§3bis AT-2 要求「重复参数按 `!sessionId` 处理 → 403 `PREVIEW_OUT_OF_SCOPE`」，但 §1.3 只声明「新增可选 query `session`」未定义多值语义，而 `searchParams.get()` 只取首值（`a` 恰好通过 `isValidSessionId`）。
   用例断言取交集：**403 + `error` 为 §1.2 冻结文案之一 + 无字节出网**（不强制具体 code）。
2. **未注册工作区 + 无 session 的响应字面量**：§1.3 未固定「`workspace is not registered`（既有）」与「`path escapes the workspace root`（b 步统一）」二选一；用例（A6b）断言取集合，两者皆 fail-closed。
3. **带（非法）`session` 的 403 是否可含 `code`**：§1.3 的「逐字节等价」只约束**不带 `session`** 的请求；故 AT-2d 只断言 `error` 文案 + `code ∈ {缺省, PREVIEW_OUT_OF_SCOPE}`；A6（真·无 session）则保持严格逐字节断言。
4. **AT-2a 完全权限 + 编码穿越**：§2 真值表允许 `200`（越界读取正是「完全权限」的语义），§3bis 只禁「**未授权** 200」。用例接受两种实现：① `200` 且内容必须逐字等于 realpath 解析出的那个真实目标（不得借穿越扩大可达面）；② `400/403/404` 的 fail-closed 收紧。绝不接受 500 或空体 200。
5. **AT-3 二段（同一 sid 改接缝后沿用 15s 缓存）**：mock 接缝由 spawn 时 env 固定，单实例内无法改接缝；且契约 §3bis AT-3 明示「允许沿旧投影（缓存语义，非缺陷）」。故该子项**不设断言**（避免无断言用例），在此显式记录为「靠 review」。
6. **新增测试辅助文件**：`lib/harness.mjs` 为其它套件共用的冻结件（且未暴露 `Q20_MOCK_HOST_PROJECTIONS*` 接缝与子进程 stderr 捕获），故本波新增 `tests/acceptance/lib/preview-host.mjs`（纯新增，未改动任何既有文件），供两套件复用。若 Lead 要求收敛文件数，可内联回两个套件。

## 8.7 冻结清单（sha256，Lead 复核后置只读）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-preview-policy.mjs`（L2-T：A1–A9，14 条） | `f4891f94c3f51fed4318bd56db7e3a887c63bd7c4a3fece23c9c333a6a979e3b` |
| `tests/acceptance/adversarial/preview-policy-attack.mjs`（L2-AT：AT-1/2/3，8 条） | `7758b5907369e1b999cacf480b19f7f4861c0aa632ad9a09de91261663f6e9fc` |
| `tests/acceptance/lib/preview-host.mjs`（本波新增：隔离实例 + 原始 HTTP 断言面） | `9ab4ef2ce3aa6ea56bfb032c08703ea2a51fb77679a97045175ce66704912ab2` |
| `tests/acceptance/run-all.mjs`（登记两套件） | `1fbab93f051a66535688b13dcfb84d71d4b9dbfbc84e58327927f924332782dd` |
| `tests/acceptance/artifacts/red-preview-policy.log`（原始 stdout，`EXIT=1`） | 见文件头时间戳与本表 8.3 |
| `tests/acceptance/artifacts/red-preview-policy-at.log`（原始 stdout，`EXIT=1`） | 同上 |
| `tests/acceptance/artifacts/red-preview-policy-runall.log`（聚合 8 套件，`exit=1`） | 同上 |

## 8.8 本波绿相判据（T-SRV / T-WEB 完成后由 Lead 复核）

1. `node tests/acceptance/suite-preview-policy.mjs` → **exit 0**（`total=14 pass=14 fail=0 degraded=0`）。
2. `node tests/acceptance/adversarial/preview-policy-attack.mjs` → **exit 0**（`total=8 pass=8 fail=0 degraded=0`）。
3. `node tests/acceptance/run-all.mjs` → 本波两套件 `✔ PASS`；其余套件不得因本波回落（`suite-statusqueue-browser` 的既有红相是否转绿与本波次无关）。
4. 实施者不得修改本波测试文件（以 §8.7 sha256 为准）；若断言与契约冲突，停下上报 Lead，**不得**为转绿放宽断言。
5. 绿相自证时同样需要落 `tests/acceptance/artifacts/red-preview-policy*.log` 之外的独立绿相日志，并保持 `git status --porcelain tests/acceptance/artifacts` 只显示本波新增日志。

---

# 红相 #2（Wave 2026-11-06 增补轮）— 契约 amend R-4 / R-5 / R-6 + M-2 + Gate-1 ADVISORY ⑤

- Owner: **test-agent**（独立验收方）；触发源：[review-plan.json](.dev-team/review-plan.json)（BLOCKING `SECURITY` 敏感路径 + `ADVISORY` 未注册 cwd 状态回退 / 客户端接线无断言）与 [review-l3b-preview.json](.dev-team/review-l3b-preview.json)（BLOCKING `SECURITY` `.credentials.yaml` 经 `/api/file` 出网 + `ADVISORY` mock 延迟计时器残留）
- 契约 amend 口径（Protocol Agent 待落文；本轮按 Lead 裁决 2026-11-06 编写）：**R-4** 敏感路径 denylist → 403 `PREVIEW_SENSITIVE_PATH`；**R-5** 归属不可核验 → fail-closed `PREVIEW_POLICY_UNAVAILABLE`；**R-6** 未注册 cwd 一律 b 步越界文案（不得 404 存在性探针）；**M-2** mock 延迟计时器卫生；**Gate-1 ADVISORY ⑤** 客户端接线静态断言
- 红相 #2 落盘时间: **2026-11-06T08:53+08:00**（本机 `node v22.21.0`，仓库根 `<repo>`）
- 物理日志: [red-preview-policy-r4.log](tests/acceptance/artifacts/red-preview-policy-r4.log) · [red-preview-policy-at-r4.log](tests/acceptance/artifacts/red-preview-policy-at-r4.log)

## 9.1 复现命令（只跑本波两套件；**刻意不跑 run-all**）

```bash
cd <repo>
node tests/acceptance/suite-preview-policy.mjs                 # → exit 1（21 条）
node tests/acceptance/adversarial/preview-policy-attack.mjs    # → exit 1（9 条）
```

> 自红相 #1 起 `run-all.mjs` 已登记两套件（commit 25d8af5）；`run-all` 会覆写其它波次的冻结 PNG，
> 故本轮按 Lead 纪律**不跑全量**，`git status --porcelain tests/acceptance` 全程无 PNG 变更（见 §9.6）。

## 9.2 新增用例（8 条：L2-T +4 组、L2-AT +1）

| 套件 | 用例 | 契约条目 | 红相结果 |
|:--|:--|:--|:--|
| suite-preview-policy | A10a 越界敏感路径 denylist（`.credentials.yaml` / `cordis.patch.yml` / `settings.yaml` / `vertex.pem` / `aws.key` / `.env.yaml`） | R-4 | ✖ FAIL（断言失败） |
| suite-preview-policy | A10b 对照组：越界普通 `notes.md` 仍 200（denylist 不误杀） | R-4 | ✔ PASS（护栏） |
| suite-preview-policy | A10c 工作区内快路径不受 denylist 影响：区内 `.credentials.yaml` = 200、区内 `.q20_token` = 415 | R-4 + `test-unit.mjs:2994-3008` 冻结断言 | ✔ PASS（护栏） |
| suite-preview-policy | A10d 无 session 越界命中敏感文件 → 403 且体不含 code | R-4 / R-2 | ✔ PASS（护栏） |
| suite-preview-policy | A11 `workingDirectory:'~/ws-x'`（不可 realpath）→ 403 `PREVIEW_POLICY_UNAVAILABLE` + `[PREVIEW]` warn | R-5 | ✖ FAIL（断言失败） |
| suite-preview-policy | A12 未注册 cwd + 目标不存在 → 403 越界文案（不得 404）；已注册 + 不存在 → 404 不变 | R-6 | ✖ FAIL（断言失败） |
| suite-preview-policy | A13 客户端接线静态断言：`data-fpsid` ×2 + `&session=` 拼接 + 4 个 code→文案映射键 | Gate-1 ADVISORY ⑤ | ✖ FAIL（断言失败） |
| adversarial | AT-4 DELAY=6000 触发超时后：不得残留未 clear/unref 的 mock 计时器 + 子进程真实退出码/退出墙钟受限 + 无未处理 rejection | M-2 | ✖ FAIL（断言失败） |

**A6b 同步收紧（R-6 落地）**：原「未注册 cwd 响应体取 `workspace is not registered` / `path escapes…` 二者之一」的宽松断言，
按 R-6（未注册 cwd 一律 b 步越界文案）收紧为**逐字节等于** `{"ok":false,"error":"path escapes the workspace root"}`；收紧后仍 PASS（实现已符合）。

## 9.3 逐条红相证据（期望 vs 实际，原样摘自日志）

| 用例 | 失败断言 | 期望 | 实际（物理事实） |
|:--|:--|:--|:--|
| A10a | 越界 `.credentials.yaml`（完全权限 + 同 cwd）→ status | `403` | `200`（当前实现无 denylist，凭据文件经 `/api/file` 出网） |
| A11 | `workingDirectory='~/ws-x'` 归属不可核验 → status | `403` | `200`（`realpath('~/ws-x')` 失败 → `sessionCwd=''` → c 步整体跳过 → fail-open） |
| A12 | 未注册 cwd + 不存在目标 → status | `403`（越界文案，无 `code`） | `404`（realpath 先于 registered 判定 → 任意绝对路径存在性可探测） |
| A13 | 403 `code`→文案映射覆盖 §1.2 全部冻结码 | 缺失数 `0` | `1`（`static/index.html` 缺 `PREVIEW_SENSITIVE_PATH` 文案分支） |
| AT-4 | 超时后 active `Timeout` 数不得增加 | `After ≤ Before (0)` | `Before=0 After=1`，`getActiveResourcesInfo()` 实测 `[…,"Timeout"]`（mock 延迟计时器未 clear/unref） |

红相汇总：`suite-preview-policy` `total=21 pass=17 fail=4 degraded=0`（**exit 1**）·
`preview-policy-attack` `total=9 pass=8 fail=1 degraded=0`（**exit 1**）。

## 9.4 本轮已转绿的部分（不是缺陷，是实施已落地）

- A1–A9（14 条）与 AT-1/AT-2/AT-3（8 条）在红相 #1 时为红，现已全绿：`decidePreviewReadAccess` 已实现、`/api/file` 已接 `session` 四态、`PROJECTIONS_FAIL/_DELAY_MS` 接缝已按 M-1 与生产同语义执行 `timeoutMs`（AT-1b 实测 `越界 403 in 2506ms; 区内 200 in 4ms`）。
- 因此本轮红相**只针对新冻结的 R-4/R-5/R-6/M-2/Gate-1⑤**；这 5 条全部真实失败，未放宽任何旧断言。

## 9.5 接缝方法学（为什么 M-2 需要进程内探针）

1. `server.mjs:8156` 有「主模块守卫」：`process.argv[1] === __filename` 才 `listen`。故**不能**用 wrapper `import('server.mjs')` 起服务（实测：import 成功但 `/healthz` 不可达）。
2. AT-4 因此用 `spawn(node, ['--import', <ipc-hook>, 'server.mjs'])` + `stdio[3]='ipc'`：`server.mjs` 仍是主模块（正常 listen），钩子在进程内应答 `resources` 请求。
3. 判定语义（本机 node v22 实测）：`process.getActiveResourcesInfo()` **不列出**已 `clearTimeout` 或已 `unref` 的 setTimeout；因此「DELAY 触发超时前后 active `Timeout` 数 delta > 0」即残留计时器的物理证据（当前实现 delta=+1）。
4. 该断言对两种合规修法都成立：`clearTimeout` 或 `unref` —— 二者在该快照里都不可见；故不偏向任何具体实现。
5. 退出墙钟同样按真实 `'exit'` 事件计时（SIGTERM → exit，实测 5–8ms），无 sleep、无盲等；`SIGKILL` 兜底会直接判失败（`killedByForce`）。

## 9.6 防假红 / 防污染核查

1. `node --check` 三个文件全通过；两套件均正常输出 `SUITE-* SUMMARY`（非 exit 2，无 `MODULE_NOT_FOUND`/`SYNTAX`）。
2. 5 条失败全部是**断言级**行为失败（`200 vs 403` / `404 vs 403` / 缺失文案键 / active Timeout delta），无导入失败、无执行异常逃逸、无 500。
3. 隔离：每用例独立 mock 实例（临时 `DSH_HOME` + 临时工作区根），`stop()`/`cleanupHome()` 回收；AT-4 用独立 IPC 实例且只回收临时目录。
4. 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-preview-policy*-r4.log` → `0 0`。
5. **他人冻结产物零触碰**：本轮未跑 `run-all`；`git status --porcelain tests/acceptance` 仅显示本波 3 个改动文件 + 2 个新日志，`tests/acceptance/artifacts/*.png` 无任何 ` M `/`??` 行。
6. 未改动实现与契约：`server.mjs` / `static/index.html` / `lib/preview-policy.mjs` / `.dev-team/contract-wave-2026-11-06.md` 均由 Executor/Protocol Agent 负责，本 Agent 只读。

## 9.7 需 Lead 裁决的新增口径（A10a 断言顺序）

- A10a 断言「denylist **先于**扩展名白名单」：`vertex.pem` / `aws.key` 在越界（非快路径）分支期望 **403 `PREVIEW_SENSITIVE_PATH`** 而非 415。
- 依据：Lead 裁决 2026-11-06 的枚举明确要求这两条 → 403 SENSITIVE；且 R-4 的语义是「非快路径授权阶段先做敏感检查」。
- 若 Protocol Agent 的 amend 文本把敏感检查放到 `servePreviewFile` 之后（即 pem/key 先 415），**请 Lead 回调本条断言**——本 Agent 不会自行放宽或改契约。

## 9.8 冻结清单（sha256，Lead 复核后置只读）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-preview-policy.mjs`（A1–A13，21 条） | `f270aed2a703a89b3a506f2c22c2fd6a5f3a449c08763e650502e50b424d111f` |
| `tests/acceptance/adversarial/preview-policy-attack.mjs`（AT-1…AT-4，9 条） | `6f277ea20148c1e8cd68adfe71b96262cd6dc051a4de763fbd531e09b1c25f03` |
| `tests/acceptance/lib/preview-host.mjs`（+IPC 探针 `launchPreviewHostWithIpc`） | `3e191703daa59b9888e724536f50810d8c36d961b1d4c6927e81b50759493c67` |
| `tests/acceptance/run-all.mjs`（自红相 #1 起已登记，本轮未改） | `1fbab93f051a66535688b13dcfb84d71d4b9dbfbc84e58327927f924332782dd` |
| `tests/acceptance/artifacts/red-preview-policy-r4.log` | `EXIT=1`（21/17/4） |
| `tests/acceptance/artifacts/red-preview-policy-at-r4.log` | `EXIT=1`（9/8/1） |

## 9.9 本波绿相判据（增补轮）

1. `node tests/acceptance/suite-preview-policy.mjs` → **exit 0**（`total=21 pass=21`）。
2. `node tests/acceptance/adversarial/preview-policy-attack.mjs` → **exit 0**（`total=9 pass=9`）。
3. A10c 必须保持绿：工作区内 `.credentials.yaml` = 200、`.q20_token` = 415（denylist 仅非快路径；呼应 `test-unit.mjs:2994-3008`）。
4. AT-4 绿相要求 mock 延迟计时器在超时分支 `clearTimeout` 或 `unref`，且 SIGTERM 后真实退出 ≤2000ms、总墙钟 ≤4000ms、无未处理 rejection。
5. 实施者不得修改本波测试文件（以 §9.8 sha256 为准）；若断言与 amend 文本冲突，停下来由 Lead 裁决。

---

# 红相 #3（Wave 2026-11-06 第 4 轮）— 契约 amend R-8 / R-9：越界读取必须命中本会话交付物清单

- Owner: **test-agent**（独立验收方）；触发源：Lead 裁决 2026-11-06（复审 FAIL 后方案由「敏感名单 denylist 为主闸门」改为「越界读取必须命中本会话交付物清单」）
- 待落文裁决：**R-8** 交付物成员闸门 → 403 `PREVIEW_NOT_IN_DELIVERABLES`；**R-9** 存在性 oracle 收口（合法 session + `!registered` + 目标不存在 → 403，不得 404）
- 落盘时间: **2026-11-06T09:0x+08:00**（本机 `node v22.21.0`，仓库根 `<repo>`）
- 物理日志: [red-preview-policy-r8.log](tests/acceptance/artifacts/red-preview-policy-r8.log) · [red-preview-policy-at-r8.log](tests/acceptance/artifacts/red-preview-policy-at-r8.log)

## 10.1 复现命令（只跑本波两套件；**不跑全量 run-all**）

```bash
cd <repo>
node tests/acceptance/suite-preview-policy.mjs                 # → exit 1（27 条）
node tests/acceptance/adversarial/preview-policy-attack.mjs    # → exit 1（12 条）
```

## 10.2 新增/扩展用例（6 条新增 + A13 扩展）

| 套件 | 用例 | 契约条目 | 红相结果 |
|:--|:--|:--|:--|
| suite-preview-policy | A14a 越界文件**在清单内**（完全权限 + 同 cwd）→ 200 且内容一致 | R-8 | ✔ PASS（护栏：当前实现「全放行」，故该正向路径天然为绿；实施后必须保持绿） |
| suite-preview-policy | A14b **不在清单内**（同扩展名 `.md`）→ 403 `PREVIEW_NOT_IN_DELIVERABLES` + 无字节出网 | R-8 | ✖ FAIL（断言失败） |
| suite-preview-policy | A14c 清单项为**相对路径**（相对 sessionCwd）→ 归一后命中 200 | R-8 | ✔ PASS（护栏，同上） |
| suite-preview-policy | A14d 工作区内文件（不在清单内）→ 200（快路径不受成员闸门影响） | R-8 | ✔ PASS（护栏） |
| suite-preview-policy | A14e 无合法 session + 越界命中清单 → 403 旧文案（不含 code） | R-8 / R-2 | ✔ PASS（护栏） |
| suite-preview-policy | A15 合法 session + 未注册 cwd + 目标不存在 → 403（不得 404）；已注册 + 不存在 → 404 不变 | R-9 | ✖ FAIL（断言失败） |
| suite-preview-policy | A13（扩展）code→文案映射键增加 `PREVIEW_NOT_IN_DELIVERABLES` | Gate-1 ADVISORY ⑤ + R-8 | ✖ FAIL（断言失败） |
| adversarial | AT-5a 交付物清单**缺失 / 显式为空** → 越界一律 403（fail-closed） | R-8 | ✖ FAIL（断言失败） |
| adversarial | AT-5b 同进程缓存不得串味：清单内 200 → 清单外高危 `.config/gh/hosts.yml` → 403 → 清单内再次 200 | R-8 | ✖ FAIL（断言失败） |
| adversarial | AT-5c 20 轮 barrier 并发（清单内 2 / 清单外 2）→ 结果稳定、无串味 | R-8 | ✖ FAIL（断言失败） |

红相汇总：`suite-preview-policy` `total=27 pass=24 fail=3 degraded=0`（**exit 1**）·
`preview-policy-attack` `total=12 pass=9 fail=3 degraded=0`（**exit 1**）。

## 10.3 逐条红相证据（期望 vs 实际，原样摘自日志）

| 用例 | 失败断言 | 期望 | 实际（物理事实） |
|:--|:--|:--|:--|
| A14b | 清单外同扩展名 `.md`（完全权限 + 同 cwd）→ status | `403` | `200`（当前实现无成员校验：完全权限即放行任意越界白名单类型） |
| A15 | 合法 session + 未注册 cwd + 目标不存在 → status | `403` | `404`（realpath 先于 registered 判定 → 存在性 oracle 在「有合法 session」时仍可探测） |
| A13 | 403 `code`→文案映射覆盖（含 `PREVIEW_NOT_IN_DELIVERABLES`） | 缺失数 `0` | `1`（`static/index.html` 无该映射键） |
| AT-5a | 清单缺失（无 `Q20_MOCK_HOST_SESSION_DELIVERABLES`）→ 越界 status | `403` | `200`（无清单被当成「不限制」而非「无授权」） |
| AT-5b | 清单外高危 `.config/gh/hosts.yml`（缓存已暖）→ status | `403` | `200`（清单外文件被放行；R-4 判据不含该路径形态，成员闸门尚不存在） |
| AT-5c | 20 轮 barrier 并发：清单外每条 → status | 每轮 `403` | `200`（`AT5C-UNLISTED-BYTES` 字节直接出网，逐轮复现） |

## 10.4 mock 接缝约定（**接缝待实现**，测试侧先行冻结）

```jsonc
// Q20_MOCK_HOST_SESSION_DELIVERABLES（mock-only，与 PROJECTIONS 同层；生产路径绝不读取）
{ "<sessionId>": ["<abs path>" | "<relative to sessionCwd>", ... ] }
```

- 生效面：`session/projections` 返回的 `values` 需携带该会话的交付物清单（键名由实现侧定，测试只注入 env）。
- 语义（R-8）：越界（非快路径）读取**只有目标 realpath 命中清单**才放行；清单项可为**相对 sessionCwd** 的路径，实现侧须 `resolve(sessionCwd, entry)` 归一后再比较（A14c 覆盖）。
- 接缝缺失 / 清单为空：一律按「无授权」fail-closed（AT-5a 覆盖），**不得**解释为「不限制」。
- 缓存边界：清单与 `session/projections` 同缓存域时，必须按 sid 隔离（AT-5b/5c 覆盖）；跨 sid 与跨清单不得串味。

## 10.5 本轮已转绿的部分（实施已落地，非缺陷）

- **R-4 denylist**（A10a 六类凭据文件全 403；A10c 区内快路径 `.credentials.yaml`=200 / `.q20_token`=415 不变）。
- **R-5 归属不可核验**（A11 `~/ws-x` → 403 `PREVIEW_POLICY_UNAVAILABLE` + `[PREVIEW]` warn）。
- **R-6 未注册语义**（A12 无 session：未注册+不存在=403 越界文案；已注册+不存在=404）。
- **M-2 定时器卫生**（AT-4：`Timeout before/after = 0/0`，SIGTERM 后 6ms 退出，无未处理 rejection）。
- **A6b 回退说明**：上轮曾把 A6b 收紧为「逐字节 = b 步文案」，本轮按契约 §1.3 **R-3 明文**（“Test A6b 以接受集合断言，实施侧无需保留旧文案”）回退为接受集合 `{path escapes…, workspace is not registered}`；这是**对齐冻结契约**，不是为转绿放宽 —— 存在性 oracle 由 A12/A15 单独收口，比集合断言更严格。

## 10.6 防假红 / 防污染核查

1. `node --check` 两套件通过；均正常输出 `SUITE-* SUMMARY`（非 exit 2，无 `MODULE_NOT_FOUND`/`SYNTAX`）。
2. 6 条失败全部是**断言级**行为失败（`200 vs 403` / `404 vs 403` / 缺失映射键），无导入失败、无执行异常逃逸、无 500。
3. 隔离：每用例独立 mock 实例（临时 `DSH_HOME` + 临时工作区根），`stop()` 回收；AT-5c 每轮 4 条并发由**同一 tick 的 `Promise.all`** 构成 barrier，无 sleep 竞态。
4. 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-preview-policy*-r8.log` → `0 0`。
5. **他人冻结产物零触碰**：未跑 `run-all`；`git status --porcelain tests/acceptance/artifacts/*.png | wc -l` = `0`。
6. 未改动实现与契约：`server.mjs` / `static/index.html` / `lib/preview-policy.mjs` / `.dev-team/contract-wave-2026-11-06.md` 均只读。

## 10.7 待冻结口径（不自行改契约，待 amend 落文/Lead 裁决）

1. **`PREVIEW_NOT_IN_DELIVERABLES` 的 `error` 原文**：amend 尚未给出字面量。当前 A14b 断言「非空字符串 + 不含任何 `/` 与绝对路径」（不锁字面量）；amend 冻结后**应收紧为逐字相等**（一行改动）。
2. **A15 的 `code`**：未注册 cwd + 目标不存在 + 合法 session，允许 `PREVIEW_NOT_IN_DELIVERABLES` 或 `PREVIEW_OUT_OF_SCOPE`（二者皆 fail-closed）；amend 若指定唯一码，请回调收紧。
3. **清单项归一基准**：A14c 按「相对 sessionCwd」实现断言（Lead 裁决原文）；若 amend 改为「相对 requestCwd」，二者在当前用例中等价（c 步已要求 sessionCwd === requestCwd），无需改测试。
4. **R-4 与 R-8 的顺序**：A10a 期望越界敏感文件 → `PREVIEW_SENSITIVE_PATH`（denylist 先于成员闸门或独立命中即可）；AT-5b 同时接受 `NOT_IN_DELIVERABLES`/`SENSITIVE`。若 amend 明确「成员闸门优先于 denylist」，A10a 的 6 条断言需回调为成员闸门码 —— 请 Lead 一并裁决。

## 10.8 冻结清单（sha256，Lead 复核后置只读）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-preview-policy.mjs`（A1–A15，27 条） | `90416508905b92fbd1e032561471337b403911910f9212280770a6f51f95a306` |
| `tests/acceptance/adversarial/preview-policy-attack.mjs`（AT-1…AT-5，12 条） | `2d50b096a1dcd056ce41eb6fc1afa78b8ed49321d9ba53b206000ba58963ca30` |
| `tests/acceptance/lib/preview-host.mjs`（含 IPC 探针，本轮未改） | `3e191703daa59b9888e724536f50810d8c36d961b1d4c6927e81b50759493c67` |
| `tests/acceptance/run-all.mjs`（自红相 #1 起已登记，本轮未改） | `1fbab93f051a66535688b13dcfb84d71d4b9dbfbc84e58327927f924332782dd` |
| `tests/acceptance/artifacts/red-preview-policy-r8.log` | `EXIT=1`（27/24/3） |
| `tests/acceptance/artifacts/red-preview-policy-at-r8.log` | `EXIT=1`（12/9/3） |

## 10.9 本波绿相判据（第 4 轮）

1. `node tests/acceptance/suite-preview-policy.mjs` → **exit 0**（`total=27 pass=27`）。
2. `node tests/acceptance/adversarial/preview-policy-attack.mjs` → **exit 0**（`total=12 pass=12`）。
3. 成员闸门绿相要求：清单内/相对清单项 200；清单外 403 `PREVIEW_NOT_IN_DELIVERABLES`；清单缺失或为空一律 403；工作区内快路径不受影响（`.q20_token`=415 仍由 `test-unit.mjs` 兜底）；同一进程缓存不得让清单外文件借缓存 200。
4. R-9 绿相要求：合法 session + 未注册 cwd + 目标不存在 → 403（不得 404）；已注册 + 不存在 → 404 不变。
5. 实施者不得修改本波测试文件（以 §10.8 sha256 为准）；若断言与 amend 文本冲突，停下由 Lead 裁决。

---

# §11 契约演进迁移记录（Wave 2026-11-06 第 5 轮）— R-8 口径变更后的用例迁移

- Owner: **test-agent**（独立验收方）；裁决来源：Lead 2026-11-06「契约演进门禁，Test 侧迁移；**不是放宽断言**」
- 变更：契约 R-8 把越界读取口径由「完全权限 ⇒ 任意越界白名单文件可读」改为「**越界读取必须命中本会话交付物清单**」。
- 结论：轮次 1/2 冻结的 **A8 / A9.4 / A10b / AT-3** 属旧口径用例，需按新契约迁移——**只补 env 接缝，零断言改动**。

## 11.1 迁移清单（4 条，仅新增 `Q20_MOCK_HOST_SESSION_DELIVERABLES` 接缝）

| 用例 | 迁移内容（只加 env） | 保留的原意（断言阈值一字未改） |
|:--|:--|:--|
| A8 | 接缝 `{"session-a8-full":[<outsideFile>]}`（越界文件在清单内） | 完全权限 + 同 cwd + 成员命中 → `200` + `Content-Type: text/plain; charset=utf-8` + 内容逐字节一致 + 与区内读取 Buffer 相同 + `session/projections` RPC ≥1 |
| A9.4 | 接缝 `{"session-a9-4full":[<binFile>, <bigFile>]}` | 两个越界文件都进清单后才走到 `servePreviewFile`：`.bin` 仍 **415** `unsupported preview type`、>2MB `.md` 仍 **413** + `maxBytes=2097152`（完全权限**不得**放宽上限） |
| A10b | 接缝 `{"session-a10b-full":[<notes>]}` | 对照组 `notes.md` 越界仍 **200**（denylist 不误杀普通文件）；同目录 `.credentials.yaml` 仍 403（A10a） |
| AT-3 | 接缝 `{[sidFull]:[<outsideFile>], [sidWrite]:[<outsideFile>]}` | `sid-full` 恒 200（内容一致）/ `sid-write` 恒 **403 `PREVIEW_PERMISSION_REQUIRED`** —— **两个 sid 都必须列清单**，否则 sid-write 会先撞成员闸门得到 `PREVIEW_NOT_IN_DELIVERABLES`，正是要保留的「权限闸门优先于成员闸门」原意 |

实现细节：4 条用例的「越界目标文件」由用例内构造，故**创建时机提前到 `openHost()` 之前**（接缝必须在 spawn 前注入），
`tempDir()` 生命周期仍由 `cleanupTempDirs()` 统一回收；除此之外用例结构、断言顺序、失败文案全部未改。

## 11.2 新用例在实现前为真红的证据（未被迁移削弱）

| 证据 | 内容 |
|:--|:--|
| [red-preview-policy-r8.log](tests/acceptance/artifacts/red-preview-policy-r8.log) | `total=27 pass=24 fail=3`，`EXIT=1`：A14b 清单外 200（应 403）、A15 未注册+不存在 404（应 403）、A13 缺 `PREVIEW_NOT_IN_DELIVERABLES` 映射键 |
| [red-preview-policy-at-r8.log](tests/acceptance/artifacts/red-preview-policy-at-r8.log) | `total=12 pass=9 fail=3`，`EXIT=1`：AT-5a 清单缺失 200（应 403）、AT-5b 清单外高危 200（应 403）、AT-5c 20 轮 × 4 并发逐轮清单外 200 出网 |

即：成员闸门在实现落地**之前**已被 A14/AT-5 判红；本轮迁移只让 4 条旧口径用例适配新契约，**不涉及任何红相的撤回**。

## 11.3 迁移后绿相（物理收据）

| 套件 | 计数 | 退出码 | 日志 |
|:--|:--|:--|:--|
| `suite-preview-policy.mjs`（A1–A15） | `total=27 pass=27 fail=0 degraded=0` | **0** | [green-preview-policy-r8.log](tests/acceptance/artifacts/green-preview-policy-r8.log) |
| `adversarial/preview-policy-attack.mjs`（AT-1…AT-5） | `total=12 pass=12 fail=0 degraded=0` | **0** | [green-preview-policy-at-r8.log](tests/acceptance/artifacts/green-preview-policy-at-r8.log) |

## 11.4 纪律核查

1. **只加接缝、不改断言**：4 条用例的 status / Content-Type / 内容 / `code` / `error` / `maxBytes` / 轮次数 / 墙钟阈值全部保持迁移前字面量；无任何断言被删除或放宽。
2. **未顺带修改其它用例**：A1–A7、A9.1–A9.3、A10a、A10c、A10d、A11–A15、AT-1/AT-2/AT-4/AT-5 的用例体未改（`git diff` 仅为本轮 4 处接缝迁移 + §11 文档）。
3. **不改实现/契约**：`server.mjs` / `static/index.html` / `lib/preview-policy.mjs` / `.dev-team/contract-wave-2026-11-06.md` 全程只读。
4. **不跑全量 run-all**；`git status --porcelain tests/acceptance/artifacts/*.png | wc -l` = `0`（他人冻结 PNG 零触碰）。
5. 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/green-preview-policy*-r8.log` → `0 0`。

## 11.5 冻结清单更新（sha256）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-preview-policy.mjs`（A1–A15，27 条，含 4 条 R-8 迁移） | `efbe9e008f12c6372c655a6e4400aca6c896cc2c96dfbba8f32780441ed43990` |
| `tests/acceptance/adversarial/preview-policy-attack.mjs`（AT-1…AT-5，12 条，含 AT-3 迁移） | `ad618af3d40de7d5dea2df2daaafb1a0538e1c1632065f73af3d05513e68164d` |
| `tests/acceptance/lib/preview-host.mjs`（本轮未改） | `3e191703daa59b9888e724536f50810d8c36d961b1d4c6927e81b50759493c67` |
| `tests/acceptance/run-all.mjs`（本轮未改） | `1fbab93f051a66535688b13dcfb84d71d4b9dbfbc84e58327927f924332782dd` |

---

# §12 红相 #4（R-8 相对清单项归一口径偏离）— A14f

- Owner: **test-agent**（独立验收方）；触发源：L3-B 终审复审报出的**契约偏离**（Lead 2026-11-06 裁决，最后一轮红相）
- 契约口径：R-8 要求「清单项中的**相对路径按会话 cwd（`workingDirectory`）归一**」。当投影**没有**会话 cwd 时，
  实现**不得**退化为拿**请求 cwd**（`?cwd=`，调用方可控）当归一本基 —— 否则攻击者只要让清单里存在相对条目，
  就能自选 `cwd` 把清单外的任意文件「算成成员」。**正确行为：fail-closed。**
- 落盘时间: **2026-11-06T09:1x+08:00**（本机 `node v22.21.0`，仓库根 `<repo>`）
- 物理日志: [red-preview-policy-r9.log](tests/acceptance/artifacts/red-preview-policy-r9.log)

## 12.1 新增用例（1 条：A14f，双场景同一用例内）

| 场景 | 输入 | 期望 |
|:--|:--|:--|
| ①（红相） | 接缝 `Q20_MOCK_HOST_SESSION_DELIVERABLES={"session-a14f":["./a14f-relative.md"]}`；投影 `{permissions:{currentValue:'danger-full-access'}}`（**无** `workingDirectory`）；请求 `cwd=<临时目录 dirA>`（真实存在但**未注册** → 非快路径）、`path=<dirA>/a14f-relative.md`（真实存在）、`session=session-a14f` | **403**（`PREVIEW_NOT_IN_DELIVERABLES` 或 `PREVIEW_POLICY_UNAVAILABLE`），响应体**不含文件字节** |
| ②（对照） | 同一接缝同上，但投影**补** `workingDirectory=<dirA 绝对路径>` | **200** 且内容逐字节一致（证明**只有**「无会话 cwd」才拒绝） |

执行顺序：两场景各自独立 mock 实例（接缝 env 只能在 spawn 前注入），**先取回两条响应再断言**，
使红相日志同时留下「无 cwd 也 200」与「有 cwd 应 200」两个事实（避免第一处断言即中断、丢失对照证据）。

## 12.2 红相证据（期望 vs 实际）

```
断言失败: A14f 无会话 cwd + 相对清单项 → 必须 fail-closed（403 不得放行；有 cwd 对照=200）
       → 期望: 403；实际: 200
```

- `suite-preview-policy` `total=28 pass=27 fail=1 degraded=0` → **EXIT=1**（唯一红点即 A14f 场景①）。
- 对照场景② 在同一轮内实测 **200**（见失败文案「有 cwd 对照=200」），证明偏离点**精确落在**「无会话 cwd 时拿请求 cwd 当归一本基」。
- 该 200 意味着：清单项 `./a14f-relative.md` 被归一到**调用方自选的 cwd** 并命中，清单外文件因此被当成成员 → 与 R-8 fail-closed 口径冲突。

## 12.3 防假红 / 纪律核查

1. `node --check` 通过；套件正常输出 `SUITE-PREVIEW-POLICY SUMMARY`（非 exit 2，无 `MODULE_NOT_FOUND`/`SYNTAX`）。
2. 红点是**断言级**行为失败（`200 vs 403`），无异常逃逸、无 500、无导入失败。
3. **其余用例零改动**：本轮 diff 仅新增 A14f（`suite-preview-policy.mjs`）+ 本节文档；A1–A15 既有用例与 AT-1…AT-5 一字未改。
4. 回归确认：`preview-policy-attack.mjs` 仍 `total=12 pass=12 fail=0`（未登记新用例、无回归）。
5. 不跑全量 `run-all`；`git status --porcelain tests/acceptance/artifacts/*.png | wc -l` = `0`（他人冻结 PNG 零触碰）。
6. 输出脱敏：`grep -cE '/hom[e]/[a-zA-Z0-9_.-]+/' tests/acceptance/artifacts/red-preview-policy-r9.log` → `0`。

## 12.4 冻结清单更新（sha256）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-preview-policy.mjs`（A1–A15 + A14f，28 条） | `f360fcb1095f04464841ab60bc0cd662337dabceb919e28bec2eaac37070688f` |
| `tests/acceptance/adversarial/preview-policy-attack.mjs`（AT-1…AT-5，12 条，本轮未改） | `ad618af3d40de7d5dea2df2daaafb1a0538e1c1632065f73af3d05513e68164d` |
| `tests/acceptance/lib/preview-host.mjs`（本轮未改） | `3e191703daa59b9888e724536f50810d8c36d961b1d4c6927e81b50759493c67` |
| `tests/acceptance/artifacts/red-preview-policy-r9.log` | `EXIT=1`（28/27/1） |

## 12.5 绿相判据（本轮）

1. `node tests/acceptance/suite-preview-policy.mjs` → **exit 0**（`total=28 pass=28`）。
2. A14f 绿相 = 场景① 403（`PREVIEW_NOT_IN_DELIVERABLES` 或 `PREVIEW_POLICY_UNAVAILABLE`，且响应体不含文件字节）+ 场景② 200（内容一致）。
3. 修复方向（供实现侧参考，不属本 Agent 写域）：相对清单项只在 `sessionCwd` 非空时用 `resolve(sessionCwd, entry)` 归一；
   `sessionCwd` 为空时**不得**回退到 `requestCwd` —— 该会话视为「无法核验成员身份」→ fail-closed。

---

## 13. backlog:B023 — O 状态面板 Goal 动作（2026-11-13/14，L2-T）

- Owner: **test-agent**（独立验收方，冻结件；Executor 只读）；Lead 统一补跑红相、锚定提交与绿相收口。
- 唯一契约来源: [2026-11-13-ctrl-o-goal-actions.md](../.agents/notes/implemented/feature/2026-11-13-ctrl-o-goal-actions.md) §Decision。
- 红相锚定提交: `584f1d0` `test(wave-1-goal-actions): freeze B023 ADR and red-phase acceptance tests`。
- 红相命令：`node tests/acceptance/goal-actions.mjs` → **exit 1**，`total=13 pass=0 fail=13`（POST 端点不存在 405 + 静态锚点缺失，无吞异常、无导入/语法错误）。
- 绿相命令：`node tests/acceptance/goal-actions.mjs` → **exit 0**，`total=13 pass=13 fail=0`。

| 文件 | sha256 / 状态 |
|:--|:--|
| `tests/acceptance/goal-actions.mjs`（13 例，冻结只读） | `85cb9df135bcf0a19415a9e874dbdf76e48fcbe3ed6d18e952588744a76d4478` |
| `tests/acceptance/artifacts/red-goal-actions.log` | `d43620fea521696cd7d1120f326ddde3418fd23008e530ab1d1a1f1c2130262c`（`EXIT=1`） |
| `tests/acceptance/artifacts/green-goal-actions.log` | `485fcc02d3575839f5d37f57d69f4d646fe323951bb82085bb8edeeac5c4611a`（`EXIT=0`） |
| `docs/release/evidence/b023-goal-actions/o-panel-actions.png` | `4b7e0dbfb4c299cd3b533889bc6e14c26d310a0cb7bea83945029874056cb391` |
| `docs/release/evidence/b023-goal-actions/o-panel-final.png` | `fedd7ff66f2d8a28efe46c87f8951a502fc9125ff770aaf4992bc2553b4884fe` |

### 13.1 浏览器 E2E 物理收据（agent-browser，隔离 mock 实例）

- 环境：`Q20_MOCK_HOST=1` + `Q20_MOCK_HOST_GOAL`（临时 DSH_HOME/工作区根，零真实宿主/零 LLM），隔离端口 `127.0.0.1:41105`，`/healthz` 200。
- 核心旅程：裸 `O` 打开会话状态面板 → `E` 行内编辑保存 → `G` 继续（phase 变「进行中」）→ `D` 打开删除确认 → `X` 取消（GET goal 仍存在、revision 未变）→ `D` + `Enter` 确认删除（面板「无」、GET goal `null`）。
- 硬断言：浏览器 Console Error = **0**；关键完成态截图入仓 `docs/release/evidence/b023-goal-actions/o-panel-actions.png`（三按钮可见）与 `o-panel-final.png`（删除后无目标）；临时服务与浏览器会话已回收。
- 覆盖边界：`GOAL_STALE_REVISION`、400 畸形 payload、宿主不可达 502 由冻结套件机器断言；真实断网 502/500 按契约标 `[UNVERIFIED]` 靠 review。

### 13.2 L3 靶向审查与修复复核

- 审查收据：`.dev-team/review-l3a-b023.json`（状态流转，verdict FAIL，1 BLOCKING + 6 ADVISORY）、`.dev-team/review-l3a-b023-r2.json`（修复复核，verdict PASS）、`.dev-team/review-l3b-b023.json`（安全/协议一致性，上游审查服务 503 → `DEGRADED`，由 Lead 依据 Explorer wire 证据 + 宿主 RPC 实测探针 + 冻结套件复核，不冒充独立放行）。四份收据均经 `dev-review-lint.py` exit 0。
- BLOCKING 根因：`goalActionRequest()` 写成功后 `loadSessionStats()` 会回拉尚未落盘的本地转录旧 CAS ref，覆盖刚确认的新 revision；连续动作必撞 `GOAL_STALE_REVISION`。
- 修复：`mergeGoalWithConfirmed()` + `goalConfirmedGoal` / `goalConfirmedClearedId` 守卫，stats 回拉与 GET 真源共用同一合并口径；GET 追上/新 goal/clear 自动收口，`clearGoalRing()` 切会话清空。
- 复核机器证据：审查员原静态 `counterexample_cmd` 重跑 exit 0；隔离 mock 端到端「edit → 立即 GET stats → 用返回 ref 发第二个 resume」返回 `ok:true` 且无 stale；冻结套件 13/13 PASS、ES5 acorn exit 0、unit 39/39、suite 7/7。
- 6 条 ADVISORY（连击 in-flight guard、跨会话回调守卫、确认模态 ref 快照、`isGoalEditOpen` 未读、Esc 提示、写路径 zstd fold）本轮不修，登记为靠 review / 后续 backlog，未扩大改动范围。
