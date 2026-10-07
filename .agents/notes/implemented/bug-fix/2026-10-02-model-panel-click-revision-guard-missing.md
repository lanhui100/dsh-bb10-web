# Agent Note: M 面板分组点击改模型不生效——缺版本号与会话记忆写入

Status: implemented

## Problem

用户按 `M` 呼出模型面板，点击 **Provider 分组区**（非「常用」区）的模型后，改动不生效：关闭面板后组合器徽标仍显示默认模型/旧模型，且新建对话（`N`）底部仍是默认/之前使用的模型。

复现链路（`static/index.html`）：`renderModelTree()` 有两类点击处理器——

- 「常用」区处理器：`modelSelect.selectedIndex = item.idx; modelChoiceRevision++; recordSessionModel(...)`（**完整**）；
- Provider 分组区处理器：只有 `modelSelect.selectedIndex = item.idx; updateWsBadge(); closeModel();`（**缺 `modelChoiceRevision++` 与 `recordSessionModel`**）。

后果链：

1. 分组区点击不 bump `modelChoiceRevision`、不写 `sessionModelStore` → `getCurrentSessionModelVal`（`stats 真值 → 会话记忆 → 组合器选择`）读不到本地刚确认的选择，徽标仍显 stats/记忆里的旧模型；
2. 更致命：`openModel()` 打开面板时已在途的 `/api/session/stats` 回包用 `requestRevision >= sessionModelRevision[sid]` 判定新旧——本地点击没有 bump 版本号，旧快照必然满足该条件，`loadSessionStats` 回调执行 `recordSessionModel(sid, stats 旧模型)` 并 `applySessionModelToSelector(旧模型)`，**把用户刚点的选择整体回滚**；
3. `D`（设为默认）热键同样只改 `selectedIndex` 不 bump 版本，暴露同一回滚窗口。

### 后续补强：回滚窗口比门槛修复更宽（本记录第二根因）

统一入口 `applyModelChoice` 修复了「点击不 bump 版本号」的上半场，但下半场依然存在：**任何在选取之后发起的 stats 请求**，其 `requestRevision` 必然 ≥ 选取后的 `modelChoiceRevision`，版本守卫 `requestRevision >= sessionModelRevision[sid]` 恒真——而 stats 的 `model` 字段取自宿主**持久转录**（`request/header` 与 `assistant/message.source`，见 `getSessionStats`），在用户尚未实际发送新一轮之前，转录里的旧模型才是服务端真值。于是：

1. 面板选 B（`modelChoiceRevision` 跳高，`sessionModelRevision[sid] = 新值`，未发送）；
2. 之后任意一次 stats 往返——展开输入框 `openComposer`、重开 M/O 面板、`R` 刷新、`done` 终态回调——其 `requestRevision >= sessionModelRevision[sid]` 成立，stats 旧转录 A 被当作「更新真值」回写：`recordSessionModel(sid, A)` + `applySessionModelToSelector(A)`；
3. 记忆、`<select>` 选择器、徽标三者整体回滚为 A；下次发送读取 `modelSelect.value` 仍是 A → **面板改模型不生效**。

版本号不可能区分的两件事：请求「发出时刻(新)」与响应「内容(旧转录)」。必须在本地选择与服务端确认之间加一段**不可被 stats 覆写的脏窗口**。

## Decision

**根因一（点击路径缺写入）**：
- 新增统一选取入口 `applyModelChoice(item)`（ES5，置于 `closeModel()` 之后）：`selectedIndex = item.idx` → `modelChoiceRevision++` → `recordSessionModel(currentSessionId, value, 显式 revision)`（显式传 rev，避免 recordSessionModel 内部再自增导致双跳）→ `updateWsBadge()` → `closeModel()` → `setStatus(...)`；
- 「常用」区点击、「Provider 分组」区点击、键盘激活 `activateModelNode` 三路全部收敛为该入口，杜绝后续路径再漂移；
- `D` 热键保持「面板不关闭、继续设默认」语义，就地补上 `modelChoiceRevision++` + `recordSessionModel(...)` 两行（同样防旧 stats 快照回滚）。

**根因二（选取后任一 stats 回包回滚）——脏标记守卫**：
- 新增 `sessionModelDirty = {}`（与 `sessionModelStore/sessionModelRevision/sessionStatsModelRevision` 同居，随 CAP 逐出一并清理）；
- 写入点：`applyModelChoice` 与 `D` 热键在 `recordSessionModel` 成功后置 `sessionModelDirty[sid] = true`（本地选取、服务端未确认）；
- 解除点：发送后服务端 `start` 回执（携带本条已发出的 `provider/model`，两处 SSE 分支：流式推送与回放/attach 均补 `<sid> = false`）。`start` 回执即服务端确认——`session/create → session/selectModel → follow` 链路中按请求模型落位；
- 守卫点：`loadSessionStats` 回包条件追加 `&& !sessionModelDirty[sid]`。脏窗口内无论 `requestRevision` 新旧，一律不得用转录旧模型回写记忆/选择器；其余统计字段（token、goal 红圈等）照常落 `latestSessionStats` 更新，不阻塞。

脏窗口被 `start` 解除后，stats 的「转录真值校正」能力（外部 lane/重载校正，`2026-09-26-live-session-model-truth-sync`）即恢复——仅本地未确认的选取受保护，与既有决策不冲突。

## Alternatives considered

- **只给分组区点击补两行、不动其它**：最小 diff 可修根因一，但根因二（后续 stats 回包回滚）依旧，且三处选取逻辑继续各自为政（本次已出现两处不一致），维护者再改任一处即复发同类漂移；收敛单入口是 2GB/双核小屏下最稳的「单点驱动」形态。否决。
- **改动后立即重发 `/api/session/stats` 校正**：治标——旧回包仍可能晚于新请求乱序到达，且多一次请求徒增小屏开销；版本号守卫（已由 `2026-09-26-live-session-model-truth-sync` 建立）本就该在本地变更侧落地。否决。
- **把版本守卫改成严格大于 `requestRevision > sessionModelRevision[sid]`**：能挡住「选取后发起」的 stats，但代价是任何有过本地选取的会话（即使已确认）都永久丧失 stats 真值校正——外部 lane/转录变更从此无法同步回 `modelSelect`，违背「stats 为真值」的既有决策。否决。
- **脏标记在发送即解除（不等 start 回执）**：发送后、start 回执前存在毫秒级空窗——若服务端 `session/selectModel` 失败或转录未落，脏标记早解会让旧转录回滚选中的 B；`start` 回执按请求模型落位，是最接近服务端事实的确认点。采纳「start 回执解除」。

## Consequences

- M 面板任何路径选取模型均立即成为当前会话的模型记忆并 bump 版本号，且进入脏窗口：在途与后续所有 stats 旧快照均无法回滚（根因一 + 根因二双重守卫生效），徽标/`O` 面板/后续发送即时正确，直到服务端 `start` 回执确认后才恢复 stats 真值校正；
- `D` 设默认并选中时同样受版本守卫 + 脏标记保护；
- **新建空白态隔离**：`getCurrentSessionModelVal(sid)` 严格限定 `sid` 存在时才读取 `latestSessionStats`，且 `applyModelChoice` 在空白态清空旧 stats 残留，彻底杜绝新建态徽标读取上一个已结束会话/默认模型的残留快照；
- 归因链补全：`2026-09-26-o-panel-session-model-isolation` 的「M 面板手动选取即记为当前会话的模型」在分组区路径的写入点（根因一）与「选取后 stats 回滚」的脏窗口（根因二）均已补全；版本守卫语义见 `2026-09-26-live-session-model-truth-sync.md`；
- 门禁：ES5 PASS；`test-decoupling.mjs` PASS；`test-suite.mjs` 7/7；`test-unit.mjs` 32/32（客户端 DOM 路径无自动化端到端，竞态修复经独立 Node 状态机模拟验证——选取 B 后两次 stats(旧 A) 回包均被拦截，徽标/发送取值保持 B；行为靠 review 兜底）。
