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

### 冻结清单更新（sha256）

| 文件 | sha256 |
|:--|:--|
| `tests/acceptance/suite-reasoning.mjs`（v1.1 追加 A9–A12） | `fff7248c3b4bbe4921fed5fa493cdfbc42ad9e6b4c86a443b805cab2cb3b109e` |
| `tests/acceptance/run-all.mjs`（未再改动） | `1ad71b64b8bd12ebf828a4308004ed5c58d1b755a02df897793fc3064cb2078f` |
| `tests/acceptance/lib/harness.mjs`（未改动） | `b9d00ab7765918a65a9ef95015fc9495680572eb508768389636ec7519bf6e64` |

### 绿相判据（A9–A12 追加）

1. `node tests/acceptance/suite-reasoning.mjs` → **exit 0**（A1–A12 全绿），且 `artifacts/a9-effort-rollback.png` 中徽标保持 `· High`。
2. A12 绿相要求 mock 同时实现 `Q20_MOCK_HOST_CATALOG_FAIL=1`（全失败）与 `Q20_MOCK_HOST_CATALOG_FAIL_AFTER=<n>`（成功 n 次后失败）。
