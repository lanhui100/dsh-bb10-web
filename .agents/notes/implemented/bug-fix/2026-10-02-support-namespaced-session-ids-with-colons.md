# Agent Note: 支持带前缀的远程会话 ID 寻址历史记录

Status: implemented

## Problem

在多节点或远程同步环境以及宿主 RPC 下，会话 ID 包含 `remote:dev:session-...` 等命名空间前缀（含冒号 `:`）。
在 `server.mjs` 的 `isValidSessionId` 白名单中，字符集仅限定为 `/^[A-Za-z0-9._-]+$/`，未包含 `:`，导致 `findSessionDir` 与 `getSessionGoal` 均判定此类有效会话为非法 ID 并直接返回 `null`。
客户端在通过会话列表点击进入这些会话后，`/api/history` 无法定位对应的落盘目录（如 `remote~003Adev~003Asession-...`），返回空列表 `[]`，前端提示 `(该会话暂无历史消息)`。

## Decision

1. 更新 `server.mjs` 中的 `isValidSessionId` 白名单正则为 `/^[A-Za-z0-9._:-]+$/`，允许带 `:` 前缀的会话 ID；配合上游 `encodeSegment`（把 `:` 编码为 `~003A`）精准寻址落盘目录。
2. 保持路径穿越拦截（禁止 `..` 与斜杠），并在 `test-unit.mjs` 中补充带 `:` 的会话 ID 白名单通过断言，确保安全性与合规性。

## Alternatives considered

1. **移除 isValidSessionId 白名单校验**：会导致路径穿越风险，不符合安全要求；否决。
2. **在进入 findSessionDir 前 strip 掉前缀**：会话落盘目录本身就是按 encodeSegment 后的全名（如 `remote~003Adev~003Asession-...`）保存，剥离前缀将导致目录查找不到；否决。

## Consequences

- 带有 `remote:dev:` 等前缀的会话点击后可正常解析并完整展示历史消息。
- 所有单元测试与解耦门禁 100% 通过。
