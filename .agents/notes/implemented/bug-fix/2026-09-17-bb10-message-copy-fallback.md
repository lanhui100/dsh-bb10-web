# Agent Note: BB10 消息复制按钮改为可见反馈 + 长按辅助复制

Status: implemented

## Problem

用户消息与 agent 消息下方的「📋 复制」按钮在黑莓 Q20（BB10 WebKit 537.35）上点击后既无成功交互、也未真正复制。

双层根因（`static/index.html`，纯前端）：

1. **BB10 WebKit 不支持 `document.execCommand('copy')`**：该命令在 2013~2014 年代 WebKit（对应 Safari 7 / Chrome 28~34）上未实现或恒返回 false，程序化写剪贴板不可行（BB10 浏览器对网页内容没有任何可用的剪贴板写入 API）。
2. **失败反馈写进了不可见元素**：`setStatus()` 的目标 `#status-line` 位于默认 `display:none` 的 `#composer-panel` 内——阅读态（发送即收起）下复制失败的提示用户根本看不到，于是表现为"点击无任何反应且没复制成功"。

（现代桌面浏览器中同一代码路径经实测可正常复制——Chrome 下 `execCommand('copy')` 成功、按钮翻转为「✔ 已复制」、剪贴板取到文本；故问题为 BB10 特有。）

## Decision

`static/index.html` 中复制链路改为三件事：

- **常驻可见的瞬时反馈条 `#copy-toast`**：`position:absolute` 顶部居中、z-index 80（高于收起态与展开态，低于全屏弹层），成功时显示「已复制到剪贴板！」，1.8s 自动隐藏；不再依赖藏在收起态 composer 里的 `#status-line`。
- **BB10 手动复制辅助浮层 `#copy-assist-overlay`**：当 `execCommand('copy')` 返回 false（BB10 必然路径），弹出全屏浮层，正文放入 readonly `<textarea>` 并自动全选（`select()` + `setSelectionRange(0, len)` + `focus()`，全部 try/catch 包裹），提示"长按文本区域 → 选择「复制」"，走 BB10 原生选择菜单完成复制；提供「↻ 重新全选」「✔ 完成」「✕」与点击背景关闭。
- **事件委托防误收**：`chatContainer.onclick` 对 `.action-btn`（复制/重试）直接 return，不再在点击动作按钮时把展开中的 composer 收起（否则反馈瞬间被隐藏）；代码块复制按钮（`.code-copy-btn`）继续走同一委托路径。

入口统一：用户消息、agent 消息、代码块三处复制全部收敛到 `copyTextToClipboard()`，一次修复三处生效。

## Alternatives considered

- **UA 嗅探 `BB10` 后直接跳过 execCommand**：可行但没必要——失败路径本身就是自检测（execCommand 返回 false 才进辅助浮层），现代浏览器自动走一键复制，无需维护 UA 清单。
- **`window.prompt('复制以下内容', text)` 兜底**：BB10 prompt 字段长按可复制，但弹窗不可控、长文本体验差、且与全屏小屏交互风格冲突，否决。
- **仅在状态栏提示"请长按原文手动复制"**：原文气泡选中范围不可控、无辅助定位，且状态栏在收起态本就不可见，否决。
- **引入异步 `navigator.clipboard.writeText`**：返回 Promise，违反 AGENTS.md ES5 宪法（禁 Promise/async），且 BB10 无该 API、非安全上下文（LAN HTTP）下未定义，否决。

## Consequences

- 现代浏览器：行为不变（一键复制），但新增常驻可见的成功提示。
- BB10：点击复制按钮 → 自动弹出已全选文本浮层 → 长按原生复制，为 BB10 上唯一可靠的复制路径；浮层为纯 ES5 + 静态 HEX 样式，符合 AGENTS.md 全部硬性约束。
- 门禁：`node -e '...acorn ecmaVersion 5...'` 输出 ES5 PASS；`node test-suite.mjs` 为服务端 SSE 回归，不受前端改动影响（本次运行中的失败为上游 ponylm 网关 429 tpm/rpm 限流所致，非本变更引入，见会话 `session-mu5po5yx9e4nm5` 事件序列：turn 1 三次 `assistant/attempt` 全部 429，`turn/end` reason=error）。
