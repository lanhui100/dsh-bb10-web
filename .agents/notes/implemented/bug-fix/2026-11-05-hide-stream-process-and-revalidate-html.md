# Agent Note: 流式中间过程隐藏与 HTML 缓存重验证

Status: implemented

## Decision

用户与 Agent 正文之间不再展示实时思考卡片和工具胶囊；运行期间仅由状态栏呈现当前动作，轮次结束后全部过程收进单行 `turn-process`，点击才回看。

- CSS 隐藏正文直属过程节点，折叠面板内保持可见；最终回答显式标记，工具状态兜底气泡标记为过程消息，避免被误判为回答。
- 正常 HTTP EOF 也执行幂等终态折叠，覆盖 BB10 readyState 3 末帧未完整派发的情况。
- HTML 响应改 `Cache-Control: no-cache`，保留 ETag/304；其它静态资源仍长缓存。修正 2026-09-19 对同路径 HTML 使用一小时缓存的取舍。

相关旧条：`2026-09-18-tool-title-zh-turn-process-fold.md`、`2026-09-19-p0-perf-security-optimization.md`。

## Alternatives considered

- 只修终态折叠：运行中仍平铺，不能满足需求，否决。
- 全面禁用静态缓存：增加 BB10 下载负担，否决；仅 HTML 每次重验证。
- 继续用 `innerText` 推断回答：隐藏后文本为空，会误留中间气泡，否决；使用显式标记与 `textContent`。

## Consequences

- 机器门禁：ES5 PASS；`test-fold-smoke.cjs` 41/41；`test-decoupling.mjs && test-suite.mjs` 7/7。
- 生产 3090 实测：`Cache-Control: no-cache`，历史 5 个轮次折叠，正文外过程节点与工具兜底残留均 0，Console Error 0。
- BB10 真机手感靠 review。
