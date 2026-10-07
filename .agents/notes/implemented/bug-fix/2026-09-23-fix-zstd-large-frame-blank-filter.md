# Agent Note: 修复 Zstandard 大帧导致非空会话误判为 blank 漏列

Status: implemented

## Problem

在与官方 `dsh web` 对齐排查中发现：`job_copilot` 工作区在官方中包含 8 个活跃会话，而在本项目中仅显示 4 个，漏掉了 4 个真实历史会话（如 `session-17a63ac1-7155-4264-97d0-9724ebf7ee1f`、`session-453fcc10-d3be-4521-893d-b12b1007db1f` 等）。

经过深度分析：
1. **Zstd 帧大小截断**：
   - DSH 会话转录文件采用串联 Zstandard 压缩（Concatenated Zstandard frames）。
   - 首个 Frame（Frame 0）仅包含元数据会话头 JSON（如 `{"type":"session","version":3,...}`），不包含实质消息。
   - `server.mjs` 中的 `readSessionHeader` 仅读取文件开头 `64 KB`（`SESSION_HEADER_PREFIX_BYTES = 64 * 1024`）并调用 `scanZstdFrames(buf, 5)`。
   - 当 Frame 1 包含较长消息（如 90KB~900KB）时，Frame 1 在 64KB 处被物理截断，`scanZstdFrames` 判定其不完整而跳出，最终只解析出 Frame 0。
   - 这导致 `readSessionHeader` 将 `hasTurns` 判定为 `false`。
   - 后续 `getSessionsForCwd` 与 `countResolvableRegistered` 中的 `if (!isRunning && header && header.hasTurns === false) continue;` 将这些包含数百到数千行对话的历史大会话错误当成“未发言的空白草稿（blank）”并彻底过滤。
2. **多版本持久化文件探测（session.v4 支持）**：
   - `findSessionZstdPath` 仅按 `v3 > v2 > .jsonl.zstd` 探测，未支持 DSH 升级后生成的 `session.v4.jsonl.zstd`。
   - 官方已采用 `session.v4.jsonl.zstd`，缺少 v4 会导致存在 v4 文件的会话退化读取过期的 v3 文件甚至丢失。

## Decision

1. **链入相关 ADR**：
   - 链入 `.agents/notes/implemented/bug-fix/2026-09-21-filter-blank-sessions-and-cleanup-test-ensure.md`（该 ADR 引入了 `hasTurns === false` 过滤机制）。
2. **精准判定 blank 会话，避免大帧误杀**：
   - 真正的 blank 会话（未开始对话的会话，仅有初始 header 和配置）整个 `.jsonl.zstd` 文件仅有几百字节（实测均为 400~600 字节，即使加上预置配置也不超过 4KB）。
   - 在 `readSessionHeader` 中：如果前 64KB 帧没有扫出 `hasTurns: true`，但文件本身的物理大小明显大于空白会话上限（`stat.size > 4096`），说明后续帧包含实质对话只是压缩帧超过了 64KB 头部窗口，不能误判为 `hasTurns: false`。
   - 只有当会话文件极小（`<= 4KB`）且前 5 帧完全没有实质轮次时，才认定为 blank 会话。
3. **`findSessionZstdPath` 增加 `session.v4.jsonl.zstd` 支持**：
   - 优先级按 `session.v4.jsonl.zstd > session.v3.jsonl.zstd > session.v2.jsonl.zstd > *.jsonl.zstd`，忠实对齐官方最新格式演进。

## Alternatives considered

- **方案 A：增大 `readSessionHeader` 读取字节至 2MB/全量读取**：
  在小内存环境或 Q20 弱 CPU 上，每个工作区可能存在几十上百个会话，遍历每个会话都全量读入几 MB 的文件并解压会严重阻塞 Node.js 事件循环。利用 `stat.size > 4KB` 判定无需任何额外 I/O 和 CPU 解压开销，最为高效且准确。
- **方案 B：仅依赖官方 session/list RPC**：
  虽然在线时可通过官方 RPC 补全，但根据本工程解耦架构准则（宪法第六条），本地磁盘扫描作为核心保障，必须保证在只读磁盘镜像时数据一致性达到 100%。

## Consequences

- `job_copilot` 工作区的会话数由 4 个恢复为完整的 8 个，与官方 `dsh web` 100% 对齐；
- 包含 `session.v4.jsonl.zstd` 的最新会话能够被准确识别与加载；
- 依然能有效过滤 `< 4KB` 的无实质消息 blank 空白会话残影，保持工作区干净整洁。
