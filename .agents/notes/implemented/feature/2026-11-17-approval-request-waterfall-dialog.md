# Agent Note: Bridge approval/request Waterfall to a Q20 Approval Dialog

Status: implemented

## Problem

非完全权限会话（`read-only` / `workspace-write` 预设）中，模型对工作区外文件发起操作时，宿主会以 `approval/request` waterfall 询问用户（sandbox 提权）。Q20 此前只实现了 `user-questions/request` 的应答桥（见 [2026-09-18-ask-user-question-bridge-and-composer.md](./2026-09-18-ask-user-question-bridge-and-composer.md)），`approval/request` 落到任何已连接的客户端都无人认领：官方 dsh web 前端未打开时，宿主侧授权请求只能等到超时后 fail-closed（`unavailable` / `rejected`），Q20 终端上既看不到「谁在申请什么权限」，也无法完成一次越界操作。

对齐参照（dsh 源码）：

- `packages/interaction/user-approval/src/types.ts` —— `approval/request` 请求形状（`toolName` / `callId?` / `reason?` / `displayReason?`）与封闭结局 `allowed-once | rejected | cancelled | unavailable`；
- `packages/client/ui-approval/src/client/index.ts` + `ApprovalPanel.tsx` —— 浏览器侧瀑布消费者：单卡呈现 `displayReason`，只提供「允许一次 / 拒绝」两个决策，Enter 允许、Esc 拒绝；
- `packages/api/remotes/src/remote-events.ts` —— `{ event: 'approval/request', mode: 'waterfall' }` 与提问同列转发；
- `packages/api/gateway/src/stream-protocol.ts` —— `$events` 逻辑流（`ready` → `waterfall` → `$events/result`）与 `{ kind:'result', value }` 结局信封。

## Decision

1. **服务端瀑布接管（`server.mjs` + `lib/approval-bridge.mjs`）**
   - `planApprovalWaterfall(taskSessionId, eventsClientId, frame, now?)` 是唯一决策点：`claim`（本会话）/ `delegate`（其他会话 → `$events/result next`）/ `unavailable`（缺 `toolName`，无法呈现 → fail-closed 结算）/ `ignore`（畸形帧）。归属判定复用 `lib/ask-ownership.mjs` 的同构 `classifyApprovalFrame`，`normalizeApprovalRequest` 只保留线格式字段（`displayReason` 收敛为 `{en,zh}`）。
   - 两条宿主引擎路径（`runChatViaHostRpc` / `attachHostFollowToSession`）在既有 `$events` 流上接管：`task.pendingApproval` + SSE `approval` request；`ready` 前到达的帧在 `ready` 时补投一次；`cancel` 帧清挂起；流/回合终结（`finishOnce`）与 attach 建桥迁移都清理或保留挂起。
   - 新端点 `POST /api/session/approval`：`allow → value:'allowed-once'`、`reject → value:'rejected'`，结算失败保持挂起可重试；幽灵会话幂等 `200 {ok:false}`。
   - 会话状态单点口径：`pendingInteraction: 'approval'`（只信内存 `task.pendingApproval`；`approval/asked` 是审计事件，不做磁盘推断）。
2. **前端单卡审批（`static/index.html`，ES5 + 静态 HEX + 绝对定位）**
   - `#approval-panel`（z-index 106，全屏半透明遮罩 + 居中卡片）：标题「⚠ 需要授权」、正文取 `displayReason.zh → .en → reason → 「工具 X 请求越权执行」`、按钮「允许一次 [Enter] / 拒绝 [X]」。
   - 键盘进入 fail-closed 闸门分支（先于 Esc chain 与提问面板）：Enter 允许、`X`/Esc 拒绝，未决期间吞掉其余快捷键；面板打开时焦点不在输入框，符合「输入焦点不拦截」宪法。
   - 跨会话授权与提问同构：不打断当前会话，只把目标会话标黄 + 顶部横幅（`kind:'approval'`，携带 `eventId`），进入该会话后由 attach 重放打开面板；终态事件按 `sessionId + eventId` 精确收口，绝不误关当前会话。
   - `approvalState` 纳入 `resolveEffectiveSessionState` 的 waiting 优先级；done/cancelled/error、停止、切会话/新建均收起面板。
3. **测试与门禁**
   - `lib/test-fake-host.mjs`：假 DSH 宿主（HTTP RPC 信封 + `/api/remote.mux` 逻辑流），让整条链路成为行为测试而非文本断言；
   - `test-unit.mjs` 新增 4 条：planner/normalize 决策矩阵、端点 400/幽灵幂等、面板纯逻辑 + 接线 + fail-closed 断言、假宿主 E2E（allow `allowed-once` / reject `rejected` / foreign `next` 且不弹窗）。

## Verification（机器可查）

- Acorn `{ ecmaVersion: 5 }` 解析 `static/index.html` → `ES5 PASS`；
- `node test-decoupling.mjs` → `DECOUPLING PASS`；
- `node test-unit.mjs` → 43/43 PASS（含上述 4 条新增；E2E 在假宿主上验证三种结局）。

## Alternatives considered

- **仅放行、不加审批（把预设固定为 `danger-full-access`）**：等于取消权限边界，越界写入无人工闸门；否决。
- **新增「永久允许」选项**：dsh `ApprovalOutcome` 只有 `allowed-once`，永久放行需另立策略载体（`approval/policy`），超出本次瀑布桥范围且放大误授风险；否决，保持 `allowed-once` 单词表。
- **跨会话也直接弹全屏面板**：720×720 上会抢占用户正在进行的会话且无法判断上下文，与既有提问隔离决策 [2026-09-29-q20-ask-user-question-cross-session-isolation.md](../bug-fix/2026-09-29-q20-ask-user-question-cross-session-isolation.md) 矛盾；改为标黄 + 横幅。
- **转录尾部推断 approval 挂起**：`approval/asked` 与 `approval/decided` 需要完整配对扫描，尾部窗口无法保证不误报 waiting；只在内存真源上判定，宁可让外部会话状态滞后也不撒谎。
- **把面板做成提问面板的复用分支**：提问是多题草稿状态机，审批是单次二元决策，复用会引入无意义的草稿/翻页状态；独立极简卡片与键盘分支更小更稳。
