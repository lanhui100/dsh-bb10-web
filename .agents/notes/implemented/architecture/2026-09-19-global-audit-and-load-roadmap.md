# Agent Note: 全局审核结论——功能门禁全绿、安全残留清单与降载路线图

Status: implemented

## Decision

基于 Agent Team 全局审核（安全 / 功能 / 负载三车道，HEAD `51f0028`），确立以下权威基线：

1. **功能门禁 100% 全绿，无功能性阻塞缺陷**：ES5（acorn ecmaVersion:5，全部内联 script）PASS、`test-decoupling.mjs` 12/12、`test-unit.mjs` 16/16、`test-fold-smoke.cjs` 41/41、`test-suite.mjs`（live，真实 LLM）7/7（42.5s）。宪法红线抽查全部合规：70ms 打字机节流、终态 `flushRender(true)` 强制同步、DOM 气泡窗口化 `visibleCount=20`、历史按轮次懒加载、快捷键 INPUT/TEXTAREA 焦点防碰撞（static/index.html:7952）、会话状态机 5 态闭环。
2. **安全残留清单（红线队基线 V1–V12 复核）**：Critical 已清除（V2 崩溃链、V5 日志、V1-CORS 均为已落地修复，见 `2026-09-19-p0-security-fixes.md`、`2026-09-19-security-headers-and-ratelimit.md`、`2026-09-19-harden-auth-gate-and-api-surface.md`）。仍开放：**V3 sessionId 路径穿越 + 跨工作区全局兜底**（server.mjs:2135-2187，High）、**V1 回环免鉴权残余**（High，p0-security-fixes 有意决策：本地测试/开发依赖，网页面已由 CORS 收敛）、**V4 HOST 0.0.0.0**（High，:4201）、**V6 同步 IO**（Medium→可用性）、**V10 弱令牌**（`.q20_token` 9 字节 + Cookie 无 Secure）。
3. **降载路线图（收益/成本排序）**：
   - P0：① 全站 gzip（静态 352KB→约 40–60KB，SSE 除外）；② 静态缓存头 + ETag/304（serveStaticFile 现无缓存头）；③ V3 白名单 + cwd→session 归属校验 + err.message 白名单化；④ V4 HOST 默认 127.0.0.1；⑤ V10 令牌 ≥32B + Cookie `Secure` + logout 端点。
   - P1：⑥ history 服务端强制 limit + 增量/尾部解压（现每请求全量 readFileSync+zstd 解压，实测单轮响应 301KB）；⑦ /api/sessions 异步化（fs.promises）+ mtime 缓存（实测 8 会话 649ms）。
   - P2：⑧ history 翻页工具输出摘要化；⑨ 流式增量渲染替代整 bubble innerHTML 重建；⑩ 静态资源拆分外链；⑪ V11 卫生项（SKIP_Q20_AUTH 告警、validSessions 定时清理）。
4. **约束**：所有落地项必须保持 ES5、不经第三方框架，且每次变更过三道关卡（ES5 门禁 + `test-decoupling && test-suite` 全量 PASS + 真机自检）；详细证据见 `docs/GLOBAL_AUDIT_REPORT.md` 与 `.redteam/recheck-{sec,func,perf}.md`。

## Alternatives considered

1. **立即关闭回环免鉴权**：会中断 `test-suite.mjs` 与本地开发工作流（p0-security-fixes 已权衡）；改为分步：保留免鉴权但收紧绑定（HOST 127.0.0.1）消除网络面，网页面向量维持 CORS 白名单，非浏览器同机进程向量以"本机可信"为前提接受并记录。
2. **引入压缩/缓存中间件或框架**（如 compression/express）：违背零依赖轻量宪法（harden-auth-gate 先例），手写 `zlib` 管道 + ETag 分支更契合。
3. **history 改为整文件增量索引（Frame 游标）**：对齐 dsh web 正向游标解析（alignment audit P3 曾有同类动议），作为 P1 的进阶形态；首期先做"服务端强制 limit + 尾部读取"，Frame 索引视收益再升级。
4. **静态资源立即拆分 SSG**：改动面大（352KB 单文件 → CSS/JS 外链需重建 + CSP 调整 + 真机复测），排 P2 保守推进。

## Consequences

- 本报告与路线图作为后续迭代的权威基线（对齐 `2026-09-18-dsh-web-alignment-audit-and-roadmap.md` 的模式）；
- 安全残留 V3/V4/V10 与降载 P0 项成为下一迭代的验收清单；
- 功能门禁当前全绿可作为"优化不破坏功能"的回归锚点（`test-suite.mjs` 7/7）。
