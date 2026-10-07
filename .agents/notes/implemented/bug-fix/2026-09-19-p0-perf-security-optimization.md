# Agent Note: P0 安全与降载优化实施（gzip/缓存/sessionId 白名单/绑定收敛/凭据收紧）

Status: implemented

## Problem

2026-09-19 全局审核（`docs/GLOBAL_AUDIT_REPORT.md`、`2026-09-19-global-audit-and-load-roadmap.md`）与红队复核确立的 P0 阻塞项尚未落地：

1. 全站无传输压缩：352KB 静态页、`bootstrap` 21.6KB、history（单轮 301KB）全部原字节传输，BB10 真机首屏负担最大。
2. `serveStaticFile` 无任何缓存头（无 `Cache-Control`/`ETag`/`Last-Modified`），每次访问重下 352KB。
3. `findSessionDir`（server.mjs:2135）无 sessionId 白名单：`path.join` 直拼 `..` 可穿越，`SESSIONS_ROOT` 全局兜底跨工作区横向越权；多个 5xx 回显 `err.message` 绝对路径（V3/V11）。
4. `HOST` 默认 `0.0.0.0`，私网全放行暴露源站（V4）。
5. `.q20_token` 9 字节低熵、无启动告警；Cookie 无 `Secure`（生产经 EdgeOne TLS）；无登出/吊销端点（V7/V10）。

## Decision

在 `server.mjs` 内一次落地以下五项（均为服务端行为变更，无客户端改动，无 ES5 影响）：

1. **gzip 压缩**：新增 `sendJsonGzipAware`（白名单 Origin 下优先，`Accept-Encoding: gzip` 且载荷 ≥1KB 时 `zlib.gzipSync` + `Content-Encoding: gzip`），全部约 48 处 `sendJson` 经由它发送；`serveStaticFile` 对文本类静态按需内存级 gzip。SSE 流与已有处理器原样直通、不拦截。
2. **静态缓存**：文本类静态资源 `Cache-Control: public, max-age=3600` + `ETag`（size-mtime 弱验证）+ `Last-Modified`，`If-None-Match`/`If-Modified-Since` 命中回 304。拦截页（no-store）、API、SSE 响应不受影响。
3. **V3 收敛**：`isValidSessionId` 白名单（`[A-Za-z0-9._-]{1,128}`，拒绝 `..`/`/`/空/超长）；`findSessionDir` 入口即拦截，非法 id 直接返回 `null`（下游 404/`[]` 语义不变）；归属校验——返回目录必须位于 `path.join(SESSIONS_ROOT, projectKey(cwd))` 或该工作区注册目录下，否则返回 `null`；5 个异常回显点改 `sanitizeErrorMessage`（路径脱敏 + 生产 500 固定文案）。
4. **V4 收敛**：`HOST` 默认值 `0.0.0.0` → `127.0.0.1`（`start.sh`/systemd/k8s 的 `HOST=0.0.0.0` 生产绑定不受影响；`SKIP_Q20_AUTH` 开关语义保留）。
5. **凭据收紧**：启动 `console.warn` 低熵 `.q20_token`（<16 字符）；`Q20_COOKIE_SECURE=1` 时签发 `Secure` 标志（默认不设，避免直连 HTTP 场景 Cookie 被拒）；新增 `POST /api/auth/logout`（校验 Cookie → 服务端 Map 删除 → `Max-Age=0` 覆盖清除，loopback 亦可调用）。

恢复条件：任一回归门禁（ES5/decouple/unit/fold/live）失败即回退本提交。

## Alternatives considered

1. **gzip 改为预压缩磁盘文件（.gz 旁路）**：需构建期产物与失效策略，与"单文件服务"现状冲突；内存级 gzipSync 对 ≤352KB 载荷单次 <5ms，简单可靠，否决磁盘方案。
2. **静态 `Cache-Control: immutable` 长缓存**：index.html 随版本变更而内容变化，无内容哈希文件名机制，长缓存会导致版本粘滞；max-age=3600 + ETag 304 是无构建改造下的最优折中。
3. **sessionId 改为 UUID 严格格式**：真实目录含裸 UUID 与 `session-` 前缀两种形态，并有测试 ghost id；严格 UUID 会误杀合法 id。白名单字符集 + 长度上限在兼容性与安全性间平衡。
4. **直接关闭回环免鉴权（V1 全关）**：与 `2026-09-19-p0-security-fixes.md` 的有意决策冲突（test-suite/localhost 自动化依赖），本次不动 V1，仅收敛网络面（HOST 默认值）。
5. **Cookie 默认加 Secure**：源站直连是纯 HTTP，默认加 Secure 会导致直连场景登录态写不进浏览器；环境变量开关 + 生产 EdgeOne 侧开启。

## Consequences

- BB10 真机首屏字节降为约 1/6~1/8；二次进入静态 304 零字节；`..`/跨工作区穿越被入口拦截；
  非回环出口默认仅回环监听（生产覆盖值不变）；弱令牌启动可见告警；登录态可吊销。
- 新增的 gzip/缓存/sessionId 语义由 `test-unit.mjs` 新增断言看守（非零退出即失败）；其余门禁全量回归。
