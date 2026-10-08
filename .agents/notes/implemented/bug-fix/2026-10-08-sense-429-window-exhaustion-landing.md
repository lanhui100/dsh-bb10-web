# ADR: 429 限流窗口耗尽修复落地（ponyllm 网关 + DSH 分类器 + profile 配置）

Status: implemented

## 上下文与问题陈述

2026-09-30 记录根因诊断（`implemented/bug-fix/2026-09-30-sense-429-window-exhaustion-diagnosis.md`，原 proposed）：sense 上游（deepseek-v4-flash）以 `429 {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"insufficient_quota"}` 表达 **RPM 分钟窗口耗尽**（每账号 ≈10 req/min，7 key 全池 70/min），而 DSH `llm-pi-ai` 的 `classifyPiAiError` 将含 `insufficient_quota` 的错误经 `isQuotaExceededError` 误判为 `QUOTA`（不在默认 retryable 白名单）→ **0 次重试直接失败**；即便判为 RATE_LIMIT，重试退避上限 10s ≪ 60s 窗口也救不回。诊断提出 P1（网关侧）/ P2（DSH 侧）/ P3（需求降级）修复序列。

## 落地内容

### P1 网关（ponyllm，2026-10 期间由 ponylm 侧持续演进落地，本轮复核确认）
- **多 key 429 切换池级退避**：`pool_failover_backoff`（`crates/ponyllm-core/src/executor/upstream.rs`），429 记录后切下一 key 前 sleep `min(earliest_unlock, 2s)`，杜绝毫秒连扫致全池冷却；
- **窗口耗尽透明等待**：`DEFAULT_POOL_WAIT_MAX = 90s`，预算驱动耗尽时持有请求至窗口呼吸，超界回 429；
- **Retry-After 取 max**：`longest_window_refill_in_with_limits`（pool.rs，max across keys）→ `retry_after_secs`（cap 60s）→ HTTP `retry-after` 头；
- **RPM 短窗记账**：`AttemptMeterGuard`（admit 即记 RPM slot，关闭 TOCTOU）；
- **分类细化**：balance 措辞 429→QuotaExhausted、纯 transport 失败不提升 QuotaExhausted（f4b6c53）。

### P2-① DSH 分类器修正（本轮）
`packages/llm/llm-pi-ai/src/stream.ts` `classifyPiAiError` 判据顺序（红相测试 765ea414e3 / 实现 9981055d49）：
`AUTH(401|403)` → `QUOTA(402)` → `RATE_LIMIT(窗口措辞: rate.?limit | tpm|rpm | per-minute | window… | insufficient_quota | rate_limit_error)` → `QUOTA(isQuotaExceededError: 余额措辞)` → `RATE_LIMIT(裸 429)` → 其余分支不变。

关键语义：`insufficient_quota` 归入窗口措辞（sense 用它标记 RPM 窗口而非余额）；裸 429 判据置于余额判据之后，保住"429 + exceeded current quota/billing"（真实余额）仍命中 QUOTA，同时保留裸 429 可重试语义。

### P2-③ profile 配置（本轮）
`~/.dsh/profiles/web/cordis.patch.yml` → `llm-pi-ai.providers.ponyllm.retryPolicy`：
`{ mode: normal, maxRetries: 5, backoff: { maxDelayMs: 90000 } }`——使 RATE_LIMIT 重试可等待越过 60s 窗口，且不被 llm-retry 的"Retry-After > maxDelayMs 直接放弃"规则截断；`backoff` 嵌套为 schema 强制（顶层 maxDelayMs 被 `resolveRetryPolicy` 拒收）。

### 未落地（记录在案）
- **Retry-After → pi-ai 解析**（诊断 E）：pi-ai 上游扁平化错误、丢失 headers，仍暂缓；
- **ponyllm sense `rate_limits` RPM 预算配置**：让网关透明等待生效的前提，需先实测"多账号是否共享配额池"再定值，留待运维。

## 验证证据

- 红相先行：`convert.spec.ts` 反转/新增断言后在旧实现下 5 failed（拦截点逐一核实）；
- 绿相：`convert.spec.ts` 87/87 PASS、`tsc --noEmit` exit 0、llm-pi-ai 全量其余失败项与未改动基线逐条 diff 相同（环境网络问题，非回归）；
- 消费者回归：本仓库 `test-decoupling.mjs` + `test-suite.mjs` 7/7 PASS。

## Alternatives considered

- **A. QUOTA 整体加入 retryableCodes（扩白名单）**：否决——真实余额耗尽（402/balance）会被 60s×5 卡死 5 分钟；改为修分类器（窗口措辞→RATE_LIMIT，余额措辞→QUOTA）。
- **B. 窗口措辞正则含裸 429 数字直接 RATE_LIMIT**：否决——误伤 `429 + exceeded current quota + billing`（真实余额）；故裸 429 判据置于余额判据之后。
- **C. insufficient_quota 保留 QUOTA 分类**：否决——实录 sense 以 insufficient_quota 标记 RPM 窗口（type=rate_limit_error），保留即 0 重试直接死；归入窗口判据后与余额措辞（balance/credits/budget/exceeded current quota）仍可区分。
- **D. maxDelayMs 平级写在 retryPolicy 顶层**：否决——schema `validateKeys` 对未知顶层键抛错；必须嵌 `backoff`（`BACKOFF_KEYS = {initialDelayMs, maxDelayMs, jitterRatio}`）。
- **E. 一次性给 sense 配置 rate_limits RPM 预算**：本次不做——配错值会人为削容，且共享池与否未实测；记录为运维后续项。

## 风险

- 分类器正则基于错误消息文本（pi-ai 上游扁平化所致），上游若改措辞可能回落 PI_AI_ERROR（不可重试）——已由红相测试固化当前措辞面，变更时契约测试会拦截。
- profile 为本地配置，非仓库版本化；DSH 升级需重放该 patch（沿用现有 profile 备份机制）。