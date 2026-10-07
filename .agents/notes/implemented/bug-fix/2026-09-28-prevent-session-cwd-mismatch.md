# Agent Note: 会话跨工作区串发自愈 (Session Cwd Mismatch Averted at Send Gate)

Status: implemented

## Problem

用户在交互中遇到报错：

```
session "session-69de5119-eefa-4a8e-bb10-c1112f25721a" belongs to "<workspace-A>", not "<workspace-B>"
```

服务端日志确认该错误来自 Q20 前端向 `/api/chat/stream` 发送了一个 **cwd 与 sessionId 错配** 的 payload（`cwd: <workspace-B>` 配 `sessionId: session-69de5119...`），后端转发宿主 `session/create` 收养时，DSH 严格校验会话 header 固化归属（`ApiSessionCwdConflict`）而抛错。

根因：前端 `currentSessionCwd`（会话客观归属，由 `selectSession` / `loadHistory` 记录）与当前工作区选择器 `wsSelect.value`（`getCwd()`）可能发生漂移——用户在跨工作区视图/切换后，输入态仍残留旧工作区的 `currentSessionId`，发送时 payload 直接取 `wsSelect.value` 配对旧 sid，产生跨区串发。

相关旧条：[implemented/architecture/2026-09-17-drive-conversations-through-dsh-host-rpc.md](../architecture/2026-09-17-drive-conversations-through-dsh-host-rpc.md)（宿主 `session/create` 为归属唯一权威写者，冲突语义由此产生）。

## Decision

在发送关口（`doSend`）增加**会话-工作区一致性自愈**，DSH 严格归属契约不变：

- `doSend()` 构造 payload 前，若存在 `currentSessionId` 且已记录客观归属 `currentSessionCwd` 且二者与当前所选工作区 `cwd` 不一致：
  - 判定为 sid 指针残留自其它工作区；本消息按**当前工作区新会话**发出；
  - 自动清空 `currentSessionId` / `currentSessionCwd` 对齐当前工作区、复位会话选择器与 `localStorage` 记忆、复位运行态，并给出状态提示“已按当前工作区开启新会话（原会话属于 …）”。
- 服务端保持既有「诚实阻断」契约不引入跨工作区自动收养（避免向真实工作区泄漏 ghost 会话转录，也维持 `test-suite.mjs` 6.5 对冲突错误的容错预期）。

## Alternatives considered

1. **服务端自动收养到会话真实工作区（纠偏后继续）**：被否决。会把任意错配的 sid（含测试 ghost id）自动落到真实工作区，在宿主侧累积非预期转录残留；且 `session/create` 冲突本就承担语义防护，自动改道会掩盖上游状态问题。测试套件 6.5 明确接受 `done` 或 `error` 两种终态，前端自愈已将真实用户路径归零，服务端无需补偿。
2. **仅弹窗阻断、不自动校正**：体验差，方屏上增加用户手动切回工作区的操作负担；且阻断后输入内容丢失风险高。
3. **修改会话 header 允许跨区移动**：违反 DSH 官方持久化契约，破坏工作区/沙盒边界，坚决否决。

## Consequences

- 真实用户路径上 `belongs to "...", not "..."` 不再出现：串发在发送前即被自愈为当前工作区新会话。
- DSH 归属契约、工作区隔离语义、测试套件 6.5 容错预期均保持不变。
- 全程 ES5 语法（Acorn 门禁）、`test-decoupling.mjs`、`test-suite.mjs` 全量 PASS。