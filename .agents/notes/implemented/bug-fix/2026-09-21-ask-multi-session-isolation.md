# Agent Note: 多会话提问隔离与挂起保持

Status: implemented

## Problem

多会话同时发起 `ask_user_question` 时，前端单例 `questionState` 被后来到达的 `question request` 无条件重置（`drafts=[]`），正在作答的多题草稿被清空，且循环反复；提交时若服务端内存挂起已丢失（重启/建桥替换/流终结清挂起），面板尾部直接显示裸英文 `no pending question for this session`。

实测链路（非推测）：`showQuestionPanel` 重置点（`static/index.html`）；attach 重放全量 burst 旧 `question request`（`server.mjs` `for (const ev of liveTask.events)`）；建桥 `attachHostFollowToSession` 新 task 整体替换旧 task（含 `pendingQuestion`）；`clearTaskPendingQuestion` 在流终结时清挂起；`POST /api/session/question` 无匹配挂起固定返回 `no pending`（curl 复现）。

## Decision

服务端两处（`server.mjs`）：

- attach 重放过滤 `question request`（终态 answered/cancelled 照常重放）；重放结束后若仍有挂起，单次补发一次 `request`（带 `replayed:true`，不进缓冲）；
- `attachHostFollowToSession` 建桥时把旧 task 的 `pendingQuestion` 迁移到新 task。

前端（`static/index.html`，ES5）：

- 草稿按会话分槽 `questionDraftStore[sid]`（stash/restore，上限 10 会话）；`dismiss`/`hideKeepSlot` 暂存不清槽，真终态 `hideQuestionPanel` 才清槽；
- 非当前会话的 request 只标黄（`sessCache` + `knownSessionsMap`）+ 顶部横幅（`kind:'question'`，`?` 图标，"提问："前缀，可点击进入），绝不碰当前面板；当前有草稿时 toast 提示不打断；
- 同会话新事件若有未提交草稿先暂存 + toast；`replayed` 补发永不覆盖；
- 切回会话时分槽命中直接恢复打开；`answer` 失效转中文"提问已失效（会话已继续或服务已重启），草稿已保留"，面板不隐藏；`cancel` 失效直接收起 + toast；
- 横幅渲染加 waiting/question 分支（此前只认 done/error，`notifySessionComplete` 早退导致提问横幅不可见）。

## Alternatives considered

- **服务端重放不过滤、前端靠 eventId 去重**：跨会话不同 eventId 必然走到重置分支，去重拦不住；且重放 burst 每次 attach 都来一次，去重条件随面板状态变化不可靠。否决。
- **收起即提交跳过**：跳过是需回填宿主的作答动作，静默提交伪造意图。否决。
- **分槽持久化到 localStorage**：页面生命周期短、2GB 内存约束下避免额外序列化；问题批次经 attach 补发可重建，分槽仅需内存态。否决。
- **失效时自动重建挂起**：服务端无问题原文（仅浏览器持有），重建需重新触发 waterfall，Q20 无此能力；保留草稿 + 中文提示是诚实上限。

## Consequences

- A 会话作答不再被 B 会话闪现清空；切会话续答草稿保留；失效提示中文且不丢草稿；
- 门禁：ES5 PASS、`test-decoupling.mjs` PASS、`test-suite.mjs` 7/7、`test-unit.mjs` 20/20（新增多会话隔离契约 2e）。
