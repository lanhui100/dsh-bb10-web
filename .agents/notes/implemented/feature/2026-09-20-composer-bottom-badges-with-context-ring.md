# Agent Note: 对话框加高与底部全局徽标行（工作区/模型图标 + 上下文占用圆环）

Status: implemented

关联：部分取代 [2026-09-18-composer-badge-row-w-left-m-right](../feature/2026-09-18-composer-badge-row-w-left-m-right.md) 的"对话框顶部悬浮、仅新建空白会话可见"摆放决策（其 W/M 快捷键教育语义与 `provider/model` 文本口径继续有效）；结构扁平化沿用 [flatten-composer-dialog](../simplification/2026-09-18-flatten-composer-dialog-remove-outer-header.md)。

## Problem

1. 输入对话框偏矮（输入框 86px），长提示词编辑吃力；
2. workspace/model 徽标悬浮在对话框顶部外部（`top: -24px`），仅新建空白会话可见——初始化页之外打字时看不到当前工作区与模型，且顶部悬浮易与消息流重叠；
3. 徽标无语义图标，扫读慢；模型徽标后无上下文占用指示，用户发长会话前无法感知窗口压力。

## Decision

`static/index.html`（纯 CSS/ES5，无新增依赖）+ `server.mjs`（bootstrap 下发容量）：

1. **对话框加高**：`#input-box` 默认/最小 86px→120px，最大 160px→220px，`adjustInputHeight` 常量同步；
2. **徽标沉底全局化**：`#composer-meta` 为单行底部栏（高 40px，`line-height:40px`，右垫 110px 给圆环+发送键）；`#ws-badge` / `#model-badge` 为 inline 收缩胶囊（内容多长占多长，不做绝对三栏切分），`display` 在 block/inline-block 间切换；`updateWsBadge` 对话框展开即显示（初始化页同样可见）；
3. **语义图标**：workspace 前加 `W`、model 前加 `M` 键帽（`.composer-badge-icon`，14px 深底键帽 + 绿字，与快捷键 W/M 同义；emoji 在旧 WebKit 缺字形故弃用）；
4. **上下文圆环**：inline 跟在模型徽标后（左间距 6px），14px SVG 圆环 + 百分比；口径对齐 dsh web（`packages/client/ui-conversation/src/client/context-occupancy.ts` + `packages/llm/token-meter/src/usage-projection.ts pressureFrom`）：`percent = min(100, round(pressure / contextWindow * 100))`，分子取**最近一次单请求 prompt 侧压力** `pressureTokens`（= input + cacheRead + cacheWrite，不含输出，**不做全会话累计**；累计值做分子是旧版恒 100% 的根因）；服务端 `usage` 广播与 `/api/session/stats` 均下发该字段，`stats.inputTokens` 等累计值继续供状态面板使用；容量取 bootstrap `models[].contextWindow`，未知隐藏；≥90% 红 / ≥70% 黄 / 其余绿；
5. **发送按钮入行**：`#send-btn` 置底部栏内（`bottom:5px`），与徽标/圆环同行垂直居中。
6. **关闭按钮去框**：`#composer-close-btn` 去圆形背景与边框，仅保留 ✕ 文字（16px 加粗），点击区不变。
7. **空输入回车收起**：输入框 `Enter` 空内容时直接 `closeComposer()`（运行中除外），有内容走 `doSend`。

## Alternatives considered

1. **保持顶部悬浮仅加图标/圆环**：顶部 `-24px` 悬浮与消息流重叠风险仍在，且非新建态不可见，否决。
2. **Flex 左右布局底部栏**：旧 WebKit 仅支持带前缀旧 flex，为保稳定继续绝对定位 + 块级排版（宪法 §二.2），否决。
3. **仅百分比文字不画环**：小方屏下文字占比大，14px 环 + 短百分比更省像素，且与官方 ContextMeter（环+百分比）同构，否决纯文字。
4. **前端写死 128K 窗口**：各模型窗口以 1M 为主（如 `muse-spark-1.3`），写死会系统性虚高/虚低；改为服务端随 `models[]` 下发、缺失则隐藏，否决。（下发来源后随 dsh 0.1.7 配置迁移改为「宿主 `session/modelCatalog` 提供模型集合 + 磁盘用户层文档回填 `contextWindow`」，见 `.agents/notes/implemented/bug-fix/2026-09-23-model-catalog-source-after-dsh-017-profile-config.md`。）

## Consequences

- 任意时刻展开对话框底部即可确认工作区与模型 + 上下文压力；发送按钮与底部栏无重叠；
- `GET /api/bootstrap` 的 `models[]` 新增 `contextWindow`（数字，缺失为 0）， additive，后端契约全量回归须 PASS；
- 门禁：`node -e 'acorn ES5 parse static/index.html'` 输出 ES5 PASS；`node test-decoupling.mjs && node test-unit.mjs` 全量 PASS。
