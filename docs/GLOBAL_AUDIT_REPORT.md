# dsh-q20-web 全局审核报告：功能门禁、安全现状、阻塞与降载优化点

- **日期**：2026-09-19
- **基线**：HEAD `51f0028`；生产服务 `127.0.0.1:3090`（PID 328727，Node v22）
- **方式**：Agent Team 并行审核（安全 / 功能 / 负载三车道，共享任务板 task-1..3）；队友两轮中途失效，按仓库现行先例（红队 rt-recon2 替补 + Lead 接手）由 **Lead 完成全部车道**；门禁全量实跑
- **分报告**：`.redteam/recheck-sec.md`、`.redteam/recheck-func.md`、`.redteam/recheck-perf.md`

---

## 一、结论总览

| 维度 | 结论 |
|---|---|
| **功能实现** | ✅ **门禁 100% 全绿**：ES5 解析 PASS、解耦 12/12、单测 16/16、折叠冒烟 41/41、端到端 live 7/7（42.5s，真实 LLM 冷启动/接续/history/模型切换/工作区切换/异常边界）。**无功能性阻塞缺陷** |
| **安全性** | ⚠️ **Critical 已清除，残留 2 条 High**：V2 崩溃链 FIXED、V1 网页面旁路被 CORS 收敛（p0-security-fixes 有意决策）；仍开放 **V3 sessionId 穿越**、**V1 回环免鉴权**（决策内残余）、**V4 0.0.0.0 暴露面**、**V6 同步 IO**、**V10 弱令牌** |
| **负载** | 📉 **首优降载点**：① 全站无 gzip（静态页 352KB 原样传输）② 静态无缓存头 ③ history 每请求全量解压（单轮响应 301KB）④ /api/sessions 全同步 IO（8 会话 649ms） |

---

## 二、功能门禁（关卡一~三）

| 门禁 | 结果 |
|---|---|
| 关卡一 ES5（acorn `{ecmaVersion:5}`，全部内联 script，1 块 352KB） | ✅ 0 fail |
| 解耦契约 `test-decoupling.mjs` | ✅ 12/12 |
| 快速单测 `test-unit.mjs`（0 LLM） | ✅ 16/16（5.5s） |
| 折叠冒烟 `test-fold-smoke.cjs` | ✅ 41/41 |
| 端到端 live `test-suite.mjs`（真实 LLM） | ✅ **7/7**（42.5s） |

宪法红线抽查（客户端）：70ms 打字机节流 ✅、终态 `flushRender(true)` 强制同步 ✅（done/cancelled/error 全部覆盖）、DOM 气泡窗口化 `visibleCount=20` ✅、历史懒加载按轮次分页（`WINDOW_PAGE_TURNS=5`，服务端切片已落地）✅、快捷键防碰撞（INPUT/TEXTAREA/SELECT 焦点不拦截打字，`static/index.html:7952-7955`）✅、会话状态机 5 态闭环 + cancel 冷却 ✅。

**→ 功能层面没有阻塞项**（详见 `.redteam/recheck-func.md`）。

---

## 三、安全现状（V1–V12 复核，详见 `.redteam/recheck-sec.md`）

**已修复（相对红队基线）**：V2 单请求崩溃（固定 URL base :3242、parseCookies try/catch :3055、handler catch :4190、unhandledRejection :4196）；V5 日志 Cookie 脱敏（:3252-3258）+ server.log 0600；V1-CORS 白名单化（:2875-2901）；token 比较改 SHA-256 定长 + timingSafeEqual（:3320-3323）；限速加阶梯锁定（:3121-3139）。

**仍开放（按优先级）**：

| # | 风险 | 级别 | 现状证据 |
|---|---|---|---|
| 1 | **V3 sessionId 路径穿越 + 跨工作区全局兜底** | High | `findSessionDir`（server.mjs:2135-2187）无 sessionId 白名单；`path.join` 直拼 + `SESSIONS_ROOT` 全局遍历；部分 500 回显 err.message |
| 2 | **V1 回环免鉴权残余** | High（决策内） | `isAuthenticated = isLoopback \|\| isSessionValid`（:3287/:3353）；同机非浏览器进程全权访问。注：**p0-security-fixes ADR 明确为有意决策**（本地测试依赖），网页面向量已由 CORS 收敛 |
| 3 | **V4 HOST 0.0.0.0 + tailnet 全放行** | High | `HOST = env \|\| '0.0.0.0'`（:4201）；公网侧已由 EdgeOne HTTPS-Only 收敛 |
| 4 | **V6 同步 IO 阻塞事件循环** | Medium→可用性 | 全文件 53 处同步 fs/zlib；`/api/sessions` 8 会话实测 649ms |
| 5 | **V10 弱令牌熵** | Low→组合 Medium | `.q20_token` 实测 9 字节；Cookie 无 `Secure` 标志（:3338）；无登出端点 |

防御有效面（负向核验）：静态路径穿越回落 index.html ✅、CRLF 头注入拦截 ✅、主渲染 XSS 顺序正确 ✅、CORS 非白名单 Origin 无回显 ✅、畸形 Host/Cookie 无崩溃面 ✅。

---

## 四、阻塞优化点（建议先于一切负载优化处理）

> "阻塞"口径 = 不解决会持续放大安全/可用性风险、或成为后续优化前置依赖的项。

1. **【阻塞·安全】V3 sessionId 白名单 + 归属校验**（server.mjs:2135）：拒绝 `..`/分隔符/编码变体 + 服务端 cwd→session 归属校验 + 错误消息白名单化。**是"回环收敛"等后续工作的前置**。
2. **【阻塞·安全】V4 收敛暴露面**：`HOST` 默认 `127.0.0.1`（保留回环免鉴权决策不冲突——同一台机器的使用语义不变），ufw 收紧 tailnet0；UA 门移出威胁模型（仅体验分流）。
3. **【阻塞·可用性】V6 同步 IO 异步化**：`fs.promises` + mtime 缓存。不修则 2GB/双核目标机上并发请求会阻塞 SSE 流式通道（旧测：无关探针 1.2ms→605ms）。
4. **【阻塞·凭据】V10 令牌熵 + Cookie Secure**：`.q20_token` ≥32B 随机；签发 `Secure` 标志（经 EdgeOne TLS 生效）；加 logout 端点（吊销通道）。

---

## 五、降载优化点（收益/成本排序，实测数据见 `.redteam/recheck-perf.md`）

| 优先级 | 优化点 | 实测现状 | 预期收益 | 成本/风险 |
|---|---|---|---|---|
| **P0-1** | **全站 gzip 压缩**（静态 + JSON；SSE 除外） | 静态 352,312B 原样、bootstrap 21.6KB 原样（请求 gzip 亦不回） | 静态 352KB→约 40–60KB（6–8×）；bootstrap→约 4KB；history 300KB 同步缩小 | ~30 行；SSE 保持逐块透传不压缩 |
| **P0-2** | **静态缓存头 + ETag/304**（server.mjs:2960-2990 无任何缓存头） | 每次访问全量重下 352KB | 二次进入 304 空响应；配合 EdgeOne 回源减负 | ~15 行；与 :3177 no-store 拦截页分支并存 |
| **P1-3** | **history 服务端强制 limit + 增量解压**（getSessionHistory 每次 readFileSync 全量 zstd 再切分；实测 turn=1 响应 301KB） | limit/turns 参数在解析后生效，内存/CPU 不因小样本下降 | 翻页峰值内存与延迟大幅下降，规避 2GB 机 OOM 窗口 | 重构 60–80 行 + 回归 |
| **P1-4** | **/api/sessions 异步化 + mtime 缓存** | 8 会话 649ms 全同步 | 单发 <100ms；并发不再拖垮流式 | ~40 行 |
| **P2-5** | **history 翻页载荷瘦身**（`stripToolOutput=partial` 摘要化工具输出） | turn=1 301KB 中工具 arguments/output 占大头 | 翻页 301KB→约 40–60KB（×gzip 再 6×） | ~30 行；需 fold 渲染契约回归 |
| **P2-6** | **流式增量渲染**（现每 70ms 整 bubble `innerHTML` 重建，static/index.html:7565-7572） | 长消息重绘成本线性增长 | 双核 CPU 流式占用下降 | 渲染路径小重构；风险中等排 P2 |
| **P2-7** | **静态资源拆分外链 + SSG** | index.html 352KB 内联全部 JS/CSS/SVG | 首字节 TTI 下降、CSS/JS 长缓存 | 构建改动 + 真机复测（关卡三） |

**不建议做**：SSE 全量缓冲压缩（引入延迟）、DOM 每 token 更新（宪法红线）、fetch 流（BB10 WebKit 不支持）。

---

## 六、路线图建议

- **P0（本周）**：安全 P0：V3 白名单+归属校验、V4 HOST 127.0.0.1、V10 令牌/Cookie、logout；负载 P0：gzip、静态缓存头。
- **P1（两周）**：V6 异步化 + mtime 缓存；history 服务端 limit + 增量解压。
- **P2（一个月）**：history 载荷瘦身、流式增量渲染、静态拆分外链；安全 V11 卫生项批量收口（SKIP_Q20_AUTH 告警、err.message 白名单化、validSessions 定时清理）。

每项落地按宪法：ES5 门禁 + `test-decoupling && test-suite` 全量回归 + 真机自检；每条非平凡变更落 `.agents/notes/` ADR。

---

## 七、方法附录

- **团队协作**：`audit-sec`/`audit-func`/`audit-perf` 三队友 + 2 次补位（audit-sec2/audit-func2）均在运行中途失效（无收尾消息，疑似模型路由不稳）；共享任务板 task-1..3 已由 Lead 完成并结算（3/3 completed）。沿用红队先例：失效队友由 Lead 接手。
- **测量纪律**：仅只读 GET/HEAD；未调用 delete/archive、未 POST cancel/stream、未探测宿主 3080。
- **产出文件**：`.redteam/recheck-sec.md`、`.redteam/recheck-func.md`、`.redteam/recheck-perf.md`、本报告、ADR（`.agents/notes/implemented/architecture/2026-09-19-global-audit-and-load-roadmap.md`）。
