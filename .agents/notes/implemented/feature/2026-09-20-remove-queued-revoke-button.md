# Agent Note: 去掉排队气泡下方的撤回按钮（保留 Z 键撤回）

Status: implemented

## Problem

排队灰泡（`.msg-user.msg-queued`）下方动作栏内嵌了一个红色「撤回」按钮
（`revokeBtn`，`static/index.html` 的历史渲染与实时追加两处）。在 720×720
小方屏上，该按钮与复制图标并排挤占本就紧张的气泡下方空间，且触控误触代价高；
黑莓 Q20 以物理全键盘为第一交互，`Z` 键已覆盖同一撤回能力，按钮属于重复入口。

## Decision

删除两处 `revokeBtn` 创建逻辑（历史 `renderWindowedMessages` 分支与实时
`appendMessage` 分支），排队气泡下方只保留与普通用户消息一致的复制入口；
`revokeQueuedPrompt()` 函数、`Z` 快捷键绑定、`/api/session/queue/remove`
服务端链路、帮助表与 README 中的 `Z` 说明全部保留，撤回能力无损。

## Alternatives considered

- **保留按钮仅缩小样式**：仍占用动作栏横向空间，且与「Keyboard First」铁律冲突；否决。
- **连 Z 键一起去掉、仅保留按钮**：触控在 Q20 上精度差，物理键更快且零误触；否决。
- **按钮改为长按触发**：旧 WebKit 下长按与滚动/选择手势冲突，实现不可靠；否决。

## Consequences

- 排队气泡下方视觉与普通气泡一致；`Z` 键仍可一键撤回并恢复草稿。
- 后续调整（同提交）：排队灰泡（`isQueued`）下方连复制入口一并去掉——
  灰泡是未落定的排队态，复制无意义且挤占 720×720 空间；转正/重渲染为普通
  用户气泡后复制入口恢复。两处（历史 `renderWindowedMessages` 分支与实时
  `appendMessage` 分支）条件均为 `msg.text && !msg.isQueued`。
- 机械门禁：`! grep -q revokeBtn static/index.html`（零残留）+ ES5 门禁 +
  `test-unit.mjs` 19/19（含 `revokeQueuedPrompt` 接线断言）。
