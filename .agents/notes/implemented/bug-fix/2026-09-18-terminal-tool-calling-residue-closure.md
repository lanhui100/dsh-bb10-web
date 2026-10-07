# Agent Note: 会话结束后底部残留“正在调用工具”的终态收口修复

Status: implemented

## Problem

会话结束后，底部（消息流最后气泡＋尾部状态条）仍显示“正在调用工具 […]...”，而非完成/停止态。复现到 `static/index.html` 三处收口缺口：

1. 历史回放兜底气泡无条件写 running 文案：`renderAssistantBlocks` 中 `lastTool.status === 'running'` 时直接写 `● 正在调用工具`，不看 `sessState.running / isStreaming`。终态（done/stopped/error）回放仍命中该分支。
2. attach `sync` 去重签名漏工具状态：签名只含 `messages.length + text.length (+total)`，工具从 running→done 但文本长度不变时判定为“相同快照”，跳过 `renderWindowedMessages`，终态到了也不重渲染。
3. `sync` 先渲染后落状态：同一 handler 内先用旧 `sessState.running=true` 渲染消息（含缺口 1 的 running 气泡），后半段才把状态置为 done，渲染块读到的是过期 running 态。

相关旧条：`.agents/notes/implemented/bug-fix/2026-09-18-fix-tool-status-residue-and-align-turn-error-display.md` 曾修过同症状的服务端终态与错误卡片，但未覆盖以上三处前端收口，故残留复发。本条为其后续补口，非取代。

## Decision

在 `static/index.html` 内做三处最小收口（ES5，只改前端渲染时序与文案，不动协议与服务端）：

1. 兜底气泡按状态机写文案：running/流式中保持 `● 正在调用工具 […]...`；终态回放改写 `■ 已停止 […]`，与下方 `settleRunningPills` 把残留胶囊结算为 `[已停止]` 同口径。
2. `sync` 签名并入末条消息工具状态（`status + ok` 串），工具结算翻转即触发重渲染；保持原有 total/startIndex 逻辑与 Q20 跳过重渲染的性能意图。
3. `sync` 分支状态机前置：先按 `data.isRunning` 落 `sessState.running/phase`，再做签名比对与 `renderWindowedMessages`；后半段只负责状态条文案与按钮，不再重复落状态。

## Alternatives considered

- *方案 A：服务端把残留 running 改写为 done/stopped 再下发*：否决。转录本是 durable 事实，running 残留本身说明该 step 的 tool/result 尚未落盘或回合异常中断；服务端篡改历史会污染回放与审计。收口应发生在渲染层（与 `settleRunningPills` 同层）。
- *方案 B：sync 去重直接去掉，每次全量重渲染*：否决。Q20 双核 + 老 WebKit 上全量 markdown 重解析会卡顿，去重是性能必需；正确做法是补齐签名维度而非删去重。
- *方案 C：只修兜底气泡文案*：否决。实测终态快照常因签名相同被跳过、不重渲染，单修文案到不了用户屏幕；必须与签名、时序两处同修。

## Consequences

- 终态会话底部不再出现“正在调用工具”；残留 running 工具统一呈现为胶囊 `[已停止]` ＋气泡 `■ 已停止`，状态尾为完成/停止/错误态。
- 运行中会话行为不变：running 态仍显示 `● 正在调用工具` 与红色停止按钮。
- 门禁：ES5 解析 PASS、fold smoke 22/22、unit 11/11。
