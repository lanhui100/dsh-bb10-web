# Agent Note: 模型思考强度（reasoningEffort）选择 + 模型目录随 dsh 刷新

Status: implemented

## Problem

dsh 在模型目录中为每个可路由模型新增了 `reasoning: { efforts[], defaultEffort }`，并在
`session/selectModel` 的请求体（`ModelSelection.reasoningEffort`）与 `session/modelCatalog.default.reasoningEffort`
上暴露当前档位。Q20 Web 消费侧有两处缺口：

1. **思考强度整体被丢弃（功能缺口）**：
   - `server.mjs` 的 `readModelCatalogFromHost()` 只映射 `{provider, model, name, contextWindow}`，`reasoning` 被丢弃；
   - `/api/chat/stream` 发送路径的 `session/selectModel` 只传 `{sessionId, provider, model}`，档位从未下发；
   - 模型面板只有模型行、徽标只显示模型名；会话 stats 也丢弃了转录 `request/header.config.reasoningEffort`。
   证据：宿主 `modelCatalog` 实测（2026-10-18）`deepseek-flash` 带 4 档 + `defaultEffort:"high"`；
   dsh 源 `packages/api/session-controller/src/types.ts:127-143`、`packages/client/ui-model-selection/src/client/ModelSelect.tsx:130-137`。

2. **模型清单不随 dsh 变化（快照陈旧）**：
   - 前端模型目录唯一来源是 `/api/bootstrap`，且只在首屏 `renderBootstrap` 与 `R` 刷新时拉取；
   - `openModel()`（M 键 / 模型徽标点击）只渲染既有 `<select>` 选项，不发任何目录请求；
   - 服务端目录 30s TTL 且无强制刷新入口。
   设备端页面长驻不刷新，dsh 侧新增/下架的模型在 Q20 面板永久不出现（同刻 `/api/bootstrap` 与宿主目录实测一致，
   排除服务端取数错误）。

## Decision

按 `.dev-team/contract-wave-2026-10-18.md` 冻结契约落地（同一提交含冻结测试 `tests/acceptance/suite-reasoning.mjs` A1–A8）：

1. **目录透传思考强度（server）**：`readModelCatalogFromHost()` 经 `normalizeModelReasoning()` 清洗后透传
   `models[].reasoning`（`efforts[{id,name,description?}]`，畸形项丢弃、全空省略）；`current.reasoningEffort`
   先取宿主 `default.reasoningEffort`，缺失回退当前模型 `defaultEffort`（对齐 dsh `effectiveEffort` 语义）。
2. **强制刷新目录**：`readModelCatalog({force})` 支持绕过 30s TTL 并回写缓存；`GET /api/bootstrap?refresh=1`
   走强制回源（保留既有宿主存活探测刷新语义）。前端 `openModel()` 触发一次 `?refresh=1` 防重入异步刷新，
   成功后重建 `<select>` 与 reasoning 元数据（保留当前模型与档位），失败静默。
3. **发送透传**：`/api/chat/stream` 新增可选 `reasoningEffort`（缺省/`''` 不下发；非 string 或 >64 → 400 于 SSE 头前），
   仅在非空时随 `session/selectModel` 下发，离线 SDK 兜底（`new DeepSeekHarness({... reasoningEffort})`）同样透传。
   运行中追发 `/api/session/prompt` 不改：档位属「下一请求模型选择」，由 selectModel 承担。
4. **会话真值回显**：`getSessionStats()` 从转录 `request/header` 读取 `reasoningEffort`，in-flight 会话取任务当前档位，
   缺失回 `''`；前端以与模型相同的 revision/dirty 守卫做 stats 校真。
5. **面板与徽标（web，严格 ES5）**：`renderModelTree` 在模型分组后追加可折叠 `⚙ 思考强度 (N档)` 分组
   （`defaultEffort` 缺失时前置「默认（供应商默认）」），`●` 标当前档位，J/K + Enter 生效；
   切模型语义对齐 dsh（同路由保留有效档位，换模型取新模型 `defaultEffort`）；对话框 `M` 徽标显示 `模型 · 档位`；
   档位写入 `sessionEffortStore`，与 `sessionModelStore` 同生命周期/容量/版本号。

## Alternatives considered

- **只加面板档位、不动目录刷新**：功能可用，但 R6–R9 的「清单陈旧」根因仍在；设备长驻页面永远看不到 dsh 新增模型。
  只加刷新、不接管档位：M 面板仍无法选择思考强度。两件事共用同一目录/RPC 面，拆两次变更要重复冻结测试与红相，故合并。
- **每 N 秒轮询 `/api/bootstrap`**：2GB RAM 老设备上纯增功耗与宿主 RPC 压力；目录变化是低频事件，
  面板打开时强制刷新（+ 既有 `R`）已覆盖真实使用路径。
- **前端直接调宿主 RPC 拿目录/档位**：违反 AGENTS.md §六 两条管道收敛（Q20 WebKit 无宿主认证 Cookie 派生能力），
  认证派生必须留在 `server.mjs`。
- **把 `reasoningEffort` 放进 `/api/session/prompt`（运行中追发）**：宿主语义中档位属「下一请求模型选择」，
  由 `session/selectModel` 安装；在 prompt 上另开入口会形成第二条选择通道，与 dsh 状态机不一致。
- **照搬 dsh 的 drilled-pane 键盘焦点链**：720×720 小屏 + 物理 J/K 导航下，树面板内嵌可折叠分组即等价且更省空间；
  焦点链（root → model → effort 三窗格）在 3.1 吋屏上是纯负担。
- **为「默认（供应商默认）」显式持久化空档位**：dsh 仅在 `defaultEffort` 未定义时提供该选项；Q20 沿用同规则，
  不额外扩展存储语义。

## Consequences

- M 面板/模型徽标（同一 `#model-overlay`）现在可选思考强度；发送请求体实测 `"reasoningEffort":"low"`，
  宿主 `session/selectModel` 收据 `args.reasoningEffort` 与之一致。
- 打开 M 面板即强制回源目录：dsh 侧模型增删无需刷新页面；面板在 30s TTL 之外每次打开多 1 次
  `session/modelCatalog` RPC（6000ms 超时，失败静默，不影响面板可用性）。
- 机器护栏：`tests/acceptance/suite-reasoning.mjs` A1–A8（目录透传 / TTL 绕过收据 / selectModel 透传 / 400 校验 /
  stats 真值 / ES5 / 真实浏览器 720×720 Console Error=0 / 静态接线）已接入 `run-all.mjs`。
- 真实宿主验收（2026-10-18，临时实例 3098 对接 3080）：26 个模型中 4 个带 reasoning 档位；真实 chromium 720×720
  面板显示 `⚙ 思考强度 (4档)` + 「默认（供应商默认）」、点 Low 后徽标 `antigravity/gemini-3.8-flash · Low`、
  Console Error=0；截图 `docs/release/2026-10-18-live-effort-panel.png`。
- 靠 review：宿主未来若把 `defaultEffort` 改为不在 `efforts` 内的值，Q20 回退为 `''`（供应商默认）而非报错；
  mock 宿主接缝（catalog reasoning / RPC 收据 `args` / 转录 `request/header`）与真实事件流的等价性依赖该用例集。
- **L3 对抗审查后的 v1.1 修订（同波次）**：两位独立审查者（状态竞态 / 契约安全）判 FAIL 共 7 条，物理复现后修复：
  ① `applyEffortChoice` 必须与模型路径同权推进 `sessionModelRevision`/`sessionModelDirty`，否则在途 stats 会静默回滚刚选档位；
  ② stats 的 `request/header` 折叠改为整体替换（对齐上游 `foldRequestHeader`），最新请求头无该键即 `''`，并让缓存/in-flight 分支在运行中
  以 `task.reasoningEffort` 覆盖，消除「model 属本回合、effort 属上回合」；
  ③ 强制回源失败返回上一份有效目录缓存（不得用无 reasoning 的磁盘镜像覆盖），缓存回写加单调保护；
  ④ 档位继承仅限 `provider:::model` 完全相同的同路由，换任何模型取新模型 `defaultEffort`；
  ⑤ `defaultEffort` 必须属于 `efforts`，否则按未定义回退；⑥ 默认模型/新建会话路径同步重算档位。
  回归用例 A9–A12 先红后绿（`tests/acceptance/artifacts/red-reasoning2.log`，修正后 12/12）。
- 相关旧条：[2026-09-23 模型目录改由宿主 RPC 供给](../bug-fix/2026-09-23-model-catalog-source-after-dsh-017-profile-config.md)
  （目录数据源）、[2026-09-20 对话框底栏徽标](../feature/2026-09-20-composer-bottom-badges-with-context-ring.md)（徽标形状）。
