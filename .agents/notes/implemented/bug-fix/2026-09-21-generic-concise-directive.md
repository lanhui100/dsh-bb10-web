# Agent Note: 首轮注入改为通用精简要求

Status: implemented

## Problem

新会话首轮向 prompt 追加的 `[重要交互规范：…]` 携带 BlackBerry Q20 / 720x720 小方屏等特定环境信息，导致模型默认按黑莓浏览器做优化。环境信息属于展示层约束，不应污染模型任务语义；首轮注入应只保留通用的精简输出要求。

## Decision

- `server.mjs` 首轮拼接的指令内容改为通用精简要求，不再携带任何设备/屏幕/浏览器环境信息：`[重要交互规范：回答和汇报务必高度精炼、开门见山；仅简明扼要汇报核心结论与变更，除非用户主动要求细节。]`。
- 拼接位置与触发条件不变：仅无 `sessionId` 的首轮以 `\n\n` 后缀形式拼接（见 `.agents/notes/implemented/bug-fix/2026-09-20-q20-directive-suffix.md`），多轮续写不重复注入。
- `cleanUserPrompt()` 的剥离正则（`\[重要交互规范：[^\]]*\]` 前后缀）保持不变，同时兼容旧数据（黑莓文案）与新数据（通用文案）。

## Alternatives considered

- 保留设备信息并追加通用要求：环境信息仍会引导模型做设备特化优化，问题根源未除；否决。
- 直接去掉首轮注入：精简输出约束丢失，小屏/移动端翻页负担回升；否决。
- 用独立 `system` role 字段下发：当前 `session/prompt` 仅走 `content: [{type:'text'}]` 单文本通道，无独立 system 位，改契约成本高；否决。
- 改为按 UA 动态注入设备信息：把偶发客户端信息变成常态分支，增加展示层与任务语义耦合；否决。

## Consequences

- 新会话首条 `user/message` 尾部为通用精简指令；旧会话尾部黑莓指令仍被 `cleanUserPrompt()` 正常剥离，回显与标题提取不受影响。
- 验证：`node --check server.mjs` 通过；`bash .agents/skills/write-adr/verify-note.sh .agents/notes/implemented/bug-fix/2026-09-21-generic-concise-directive.md` 通过。
