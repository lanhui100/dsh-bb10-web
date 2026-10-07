# Agent Note: 实时吐字速度 (tok/s) 虚高至 9000+ 的根因修复

Status: implemented

## Context

会话状态面板的"实时吐字"速度偶发显示 9000+ tok/s（真实解码速度约 50~150 tok/s，
服务端统计口径算出的也是 95 tok/s 量级），数值物理上不可能。

相关决策：面板本身的规格见
`implemented/feature/2026-09-18-session-status-overview-panel.md`（本条只修其
tok/s 测量口径，不改变面板契约）；attach 回放/跟随链路见
`implemented/bug-fix/2026-09-18-attach-running-session-live-follow-sync.md`。

## Root Cause

客户端 `static/index.html` 把 `usage` 事件的 `data.outputTokens` 当作"当前测量
窗口的 token 数"直接除以 elapsed（且窗口最短只挡 0.3s）。但服务端
`server.mjs` 广播的 `task.usage.outputTokens` 是**本回合跨 step 的累计值**
（每个 usage 事件持续累加，非增量），两个口径错配：

1. **attach 回放**：attach 会 burst 重放整段缓冲事件，重放的 usage（数千累计
   token）在连接后 0.3~1s 内到达 → 累计/亚秒 elapsed = 数千 tok/s；
2. **累计值污染**：usage 分支用累计值覆盖 `liveTokenCount`，后续 delta 分支
   继续用它算速度 → 虚高持续存在；
3. 重放的历史 delta（chars/3 估算）也在 burst 内灌入同一窗口，同样爆表。

## Decision

1. **窗口化测速**：新增 `liveUsageCum / liveUsageBase / liveUsageBaseTime`，
   usage 采样先求增量（`cum - base`），再除以窗口时长；合法样本（增量>0 且
   窗口≥0.3s）写入 `liveTps`，随后重开窗口并重置 delta 估算窗口起点——
   delta 估算与 usage 口径共用同一窗口，消除污染路径。
2. **回放屏蔽**：`attachSession` 开启 `liveReplayUntil` 屏蔽窗（服务端回放
   结束后发送新增标记事件 `replay_end` 精确解除，2s 为无标记兜底）；屏蔽期内
   只渲染不计速、只跟踪累计 usage 不计算。回放结束后首个真实 delta 以当前
   累计 usage 为基线开新窗口，正确接续运行中回合。
3. 发送新回合时全套基线归零（新 task 的 usage 从 0 重新累计）。

## Alternatives considered

- **给 tps 设上限阈值（如 300 tok/s 截断）**：治标不治本，正常快速模型被误
  伤，且污染的 liveTokenCount 仍会派生其他错误口径，否决。
- **客户端纯时间屏蔽（固定忽略 attach 后 2s 内事件，不加协议标记）**：无新
  事件类型、改动最小，但超长历史回放超过 2s 时仍会泄漏计速，精度依赖魔法
  数字，否决；改为 `replay_end` 标记精确解除 + 2s 兜底双保险。
- **服务端改为广播增量 usage**：动 host 桥接协议语义，影响既有消费者与 dsh
  对齐口径（服务端统计 `/api/session/stats` 的 decode 窗口算法本就正确），
  客户端适配累计语义成本更低，否决。

## Consequences

- 客户端实时速度恢复物理可信（增量/窗口口径，与服务端 decode tps 语义一致）；
- attach 重放期间状态面板暂不显示速度（回放结束才开测），属预期行为；
- `replay_end` 为附加型 SSE 事件，旧客户端未知事件走默认分支忽略，向后兼容。

## Verification

- ES5 门禁：acorn ecmaVersion=5 解析 `static/index.html` 全部 script 块 → PASS
- `node test-unit.mjs` → 7/7 PASS
- `node test-suite.mjs` → 7/7 PASS（含真实模型流式回合）
