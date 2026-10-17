# Agent Note: deepseek-v4-flash 429 "All upstream providers exhausted" 诊断与修复建议（3 路对抗审核后定稿）

Status: implemented

> 落地完成（2026-10-08）：P1 网关（ponyllm）已由 ponylm 侧持续演进落地（池级退避 / 90s 窗口等待 / Retry-After=max(unlock) / 短窗 RPM 记账）；P2-① DSH 分类器修正与 P2-③ profile retryPolicy 配置于本轮落地。详见 `implemented/bug-fix/2026-10-08-sense-429-window-exhaustion-landing.md`（含验证证据与 Alternatives）。

## Context

DSH 长时间会话中断，错误：
`429 {"message":"All candidate upstream providers exhausted for model 'deepseek-v4-flash' (upstream-side failure, gateway did attempt upstream). Last error: Request failed after 7 attempts across keys [redacted]: (failures: 1 timeout/network, 6 rate limited): HTTP 429 from key-4087: {"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"insufficient_quota"}}","type":"rate_limit_error","code":"rate_limit_exceeded"}`

链路：DSH web（`~/.dsh/profiles/web/cordis.patch.yml`，provider ponyllm，baseURL `<gateway-url>`）→ 远程网关（本地镜像仓库 `gateway`，配置 `~/.config/gateway/config.toml`，gateway max_retries=3）→ provider sense（`https://token.sensenova.cn/v1`，6 把 key，priority 1..6，strategy=priority）。用户主张"6 独立账号 + DSH 5 次重试不该失败，轮询机制有 bug"。

初版诊断（Lead 自证）经 3 路对抗审核（review-gateway / review-dsh-client / review-rootcause，均只读源码+实录）攻击后定稿如下。

## Root Cause（定稿模型）

1. **限流窗耗尽（P0 实测定稿）**：2026-09-30 对上游直连实测——每账号 RPM≈10/min（逐 key 快刷 4-7 次后 429，body "rpm exhausted" code 8）；20 万 token 单请求放行 → **TPM 非瓶颈，RPM 是唯一硬约束**；远程 sense 池经 quota API 确认**实为 7 key（含 key-4087）**，"7 attempts = 7 key" 实锤；总预算 ≈70 req/min。单会话顺序调用 3-4 req/min 安全；爆因 = **并发（多会话/子代理/多端）+ 扫荡放大（1 次逻辑请求最多烧 7 次上游额度）+ DSH 重试放大（再 ×5）**：一分钟内烧穿预算 → 全池同时 429 → 恢复需 ≤60s 而重试只等 0.5-10s → 死锁式中断。实测节奏（兄弟会话）：3-4 req/min、burst 3req/11s、每请求 totalTokens 19K→159K（cacheRead 后期 93-99%，新输入尖峰 19-38K 来自大 tool 结果）。
2. **网关毫秒级扫荡**：`max_attempts = max(max_retries, key_count)`（upstream.rs:1198/1413）；多 key 池 429 切换无间隔（transient_retry_delay 多 key 池返 None，upstream.rs:190-192）；"7 attempts"⟹ 远端池 ≥7 key（本地 6 键 key-1005/2890/4432/5798/9478/7702，无 key-4087，远程配置未知）。
3. **分类正确但冷却太短**：sense 429 含 "tpm/rpm" 词 → `is_quota_exhausted_body` 短路判 RateLimit（upstream.rs:384-395，注释明示 Sense 误标 rpm）→ 3s·2^n 冷却 cap 60s（entry.rs:324-327）。误判为 QuotaExhausted（15min/key 默认）会更糟：6 key 全灭 15 分钟（entry.rs:338）——**维持 RateLimit 分类不变**。
4. **DSH 侧双重失败路径**：pi-ai 分类器（llm-pi-ai/src/stream.ts:76-79）外层 429 + body 含 `insufficient_quota` → `isQuotaExceededError`（llm/src/error.ts:98）→ 码 `QUOTA` → 不在默认 retryableCodes（llm/src/retry-policy.ts:18-24）→ **0 次重试直接死**；兄弟会话同类失败按 RATE_LIMIT 重试满 5 次仍全败——**退避上限 10s ≪ 60s 窗口**（llm-retry/src/index.ts:230-232：providerRetryAfterMs>maxDelayMs(10s) 时 normal 模式直接 return next() 不重试，测试 retry.spec.ts:387-396 断言 10_001ms → 无重试）。无论 0 次还是 5 次都救不回。
5. **Retry-After 断路**：网关已发 Retry-After ≤60s（chat.rs:770-772），但 pi-ai 路径把错误压平成 message 字符串（stream.ts:34-48），无 header 入口，providerRetryAfterMs 恒 undefined；`llm-deepseek/src/transport.ts:36-38` 有现成解析模式可循（非全局真空，仅 pi-ai 缺接线）。另：Retry-After 现取 min(unlock)（pool.rs:200），全池耗尽时取 max 才诚实。
6. **调度零窗口感知**：usage_tracker 纯遥测（5 分钟切片，仅成功记账），select_key 只按 Active+priority 过滤（pool.rs:63-104）；429 不记账 → 被限流 key 反显零用量。**独立账号 ≠ 独立配额池**：实录无法证实，需实测区分（打满 keyA 后立刻请求 keyB，B 也 429 即共享池）。

## 修复序列（已落地）

修复序列（采纳审核意见后定稿）：

- **P0 算账（已完成）**：每账号 RPM≈10/min × 7 key ≈ 70/min 总预算；单会话安全、并发+放大因子爆表。探测脚本 `/tmp/sense-probe.sh`（直连 token.sensenova.cn，遇 429 即停）。
- **P1 网关（最高性价比）**：① 多 key 429 切换间加池级退避（sleep 至 earliest_unlock 或 1–2s），杜绝毫秒连扫致全池冷却；② Retry-After 改取 max(unlock)。**否决** per-key TPM/RPM 预算 pacing（当前 5min 切片/无配置字段/429 无记账，撑不起 1min 窗口）；**否决** 15min QuotaExhausted 分类。
- **P2 DSH（跨层契约）**：① 修分类器而非扩白名单——stream.ts 429 分支：type=`rate_limit_error` 或 tpm/rpm/per minute/window 措辞 → RATE_LIMIT（默认白名单即有 5 次重试）；仅 balance/credit/budget/402 → QUOTA（终态）。一行优先级调整；② 网关以 RATE_LIMIT 语义表达窗口耗尽 + 附 Retry-After；③ ponyllm 配 `retryPolicy.backoff.maxDelayMs` ≥60s——否则 Retry-After 即便解析也因超 10s 上限被放弃。pi-ai 层独立解析 Retry-After 依赖上游透传原始 Error/headers，暂缓。
- **P3 需求（降级，重新定位）**：实测 TPM 非瓶颈（20 万 token 放行）→ 裁剪历史省 token **收益有限**；重点是**降 RPM 峰值**：① web_search/子代理串行化、并行 ≤2；② 减少并发会话/多端同时使用；③ >8K 字符 tool 结果落盘引用化仅作附带（削大请求耗时与新输入尖峰，非主收益）。context.ts 全量上送无裁剪、contextWindow=1M 仅溢出检测、server.mjs 无上送控制（均核实）。

## Alternatives considered

- **A. 网关全池耗尽时 sleep 至 earliest_unlock 再决定**：被采纳为 P1-① 的池级退避变体；阻塞线程风险以"仅 429 切换间短 sleep + 诚实 Retry-After"折中。
- **B. 把 sense 429 判为 QuotaExhausted（15min 冷却）**：被否决——rpm 窗口 60s 即恢复，15min 会让 6 key 全灭 15 分钟，可用性更差（专家 + review-gateway 一致）。
- **C. per-key TPM/RPM 预算 pacing 调度**：被否决——usage.rs 为 5 分钟切片而非 1 分钟窗口、429 无记账（被限流 key 显零用量反被选中）、配置无 TPM/RPM 字段、慢 key 只耗 tpm 不耗 rpm 会误判。
- **D. QUOTA 整体加入 retryableCodes**：被否决——真实余额耗尽（402/balance）会被 60s×5 卡死 5 分钟；改为修分类器（窗口措辞→RATE_LIMIT，余额措辞→QUOTA）。
- **E. pi-ai 层解析 Retry-After**：暂缓——错误事件只携带 errorMessage 字符串，adapter 原样重抛无 header 入口，需上游透传原始 Error/headers 才可接线到 LlmError。
- **F. "6 独立账号=6 倍容量"的算术**：被推翻——容量以每分钟聚合需求 vs 6×单账号窗口为限；共享池与否需 P0 实测，不能凭"独立账号"断言。

## 相关证据索引

- 本故障类别首次观测记录（2026-09-17 会话 mu5po5yx9e4nm5，turn 1 三次 assistant/attempt 全 429）：`implemented/bug-fix/2026-09-17-bb10-message-copy-fallback.md`；
- Q20 前端错误分类（auth/ratelimit/timeout/upstream）决策：`implemented/feature/2026-09-17-agent-run-stop-error-status.md`；
- 会话实录实测（token 量级/节奏/并发突发）：`~/.dsh/sessions/--home-dm-dsh-q20-web--/session-mumu9sltjuub0m/session.v4.jsonl.zstd` 及兄弟会话 3a71d719/b46be1a2/c7d729f3。
- 网关代码：`ponyllm-core/src/executor/upstream.rs`、`pool/{entry,pool,usage}.rs`、`crates/ponyllm-server/src/{extractors.rs,routes/chat.rs}`。
- DSH 代码：`packages/llm/llm-pi-ai/src/stream.ts`、`packages/llm/llm/src/{retry-policy,error}.ts`、`packages/llm/llm-retry/src/index.ts`、`packages/llm/llm-deepseek/src/transport.ts`。
