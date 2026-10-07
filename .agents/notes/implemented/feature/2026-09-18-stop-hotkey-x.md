# Agent Note: X 键一键停止运行中的会话

Status: implemented

## Problem

`static/index.html` 中停止运行中会话只有两个入口：点击右上角红色停止按钮
（`sendBtn.onclick`，见 [2026-09-17-agent-run-stop-error-status.md](2026-09-17-agent-run-stop-error-status.md)
建立的状态机）与 `Esc` 键链的最后一个分支（PC 浏览器兼容回退）。Q20 实体键盘上
**没有 Esc 键**（宪法 §三.2），机身返回键是系统级导航不可靠；而触控停止按钮在
720×720 方屏上需要抬手瞄准右下角小目标。键盘第一公民（宪法 §三.2）要求运行中
的会话有一个可直接拇指触达的一键停止快捷键，且必须带状态机防碰撞保护——
空闲态按它绝不能误触发 `stopStreaming()` 或残留状态。

## Decision

`static/index.html` 全局 `document.onkeydown`（无输入焦点时才拦截，既有
TEXTAREA/INPUT/SELECT 守卫不变）新增 `X` 键（keyCode 88）分支，置于 Alt 守卫
之后、弹窗 J/K 导航之前：

- `sessState.running || isStreaming` 为真 → 调用既有 `stopStreaming()`，状态行
  由其内部统一置为"已手动停止"（单一状态源，不重复写状态，对齐宪法 §六.1）；
- 否则仅提示"当前无运行中的会话 [X]"，不产生任何状态副作用；
- 弹窗打开时同样生效（停止是全局紧急动作，优先级高于面板导航；各面板仅拦截
  J/K/Enter，不受影响）。

配套：Help 速查表（`#help-panel`）新增 `X` 行；`README.md` / `README.zh.md`
快捷键清单同提交补 `X` 条目。`stopStreaming()` 自身逻辑零改动，仍走
`/api/chat/cancel` + `sessState.phase = 'stopped'` 闭环。

## Alternatives considered

- **`S` 键（首案，已否决）**：语义最直觉（Stop），但 `S` 是浏览器保留快捷键，
  旧 WebKit 内核会截获该键，真机上不可靠；真机验证前用户即否决，改用 `X`。
- **复用 Esc 链 / 机身返回键**：Q20 物理键盘无 Esc 键（宪法明文），返回键是
  系统/浏览器级导航，网页 JS 不可靠，均不成立。
- **在 `stopStreaming` 内加 `[X]` 文案**：停止入口有三个（按钮/Esc/X），入口
  各写文案会破坏单一状态源；保持 `stopStreaming` 统一输出"已手动停止"，X 分支
  只在空闲态给无副作用提示。
- **空闲态按 X 直接展开对话框或无响应**：无响应不可发现；给一行提示既不误触
  又帮助用户确认按键已被系统接收。

## Consequences

- 运行中会话可全程键盘操作停止，无需抬手触控；空闲态按键仅消耗一行状态提示，
  无状态污染。
- mech 门禁：Acorn `ecmaVersion: 5` ES5 PASS + `node test-suite.mjs` 7/7 +
  `bash .agents/skills/write-adr/verify-note.sh` 通过。
