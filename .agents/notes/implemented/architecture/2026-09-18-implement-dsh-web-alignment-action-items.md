# Agent Note: 落实 DSH Web 核心对齐整改与架构收敛

Status: implemented

## Problem

审计发现当前项目虽然在展示层遵循了 ES5 与小屏约束，但底层存在若干脱离 DSH 官方规范的私造逻辑与隐患：
1. 前端存在 `isStreaming` 与 `sessState.running` 双轨状态机，Attach 外部会话恢复后点击 Stop 会因 `!isStreaming` 误走发送分支；且 Stop 点击后无禁用防连击，存在 Esc 误导提示；
2. 服务端目录查找未实现官方 `projectKey(cwd)` 和 `encodeSegment(sessionId)` 规范，退化为磁盘遍历；
3. 通信层对 follow 流的 `assistant-stream` 增量 chunk 未实时消费；
4. 状态点色彩与语义和官方反转（官方运行蓝、完成绿，此前为运行绿、完成蓝），且缺少 `pendingInteraction` / `waiting` 标识；
5. 历史解压全量加载，缺少基于 Zstd Frame 逆向游标分页支持。

## Decision

1. **前端状态机收敛 (`static/index.html`)**：
   - 彻底将发送、停止、键盘拦截判断收敛至 `sessState.running`，消除双轨反转 Bug；
   - `stopStreaming()` 触发后立即置灰 `sendBtn` 防止老旧触控板连击；
   - 清除按钮 `title` 中脱离黑莓硬件的 `(Esc)` 说明；
   - 对齐状态点配色与标识：运行为科技蓝 `●` (`#3B82F6`)、完成为成功绿 `✓` (`#4EC9B0`)、等待交互为琥珀黄 `?` (`#E5C07B`)。
2. **标准寻址算法对齐 (`server.mjs`)**：
   - 实现官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `projectKey(cwd)` 与 `encodeSegment(sessionId)`；
   - 会话目录定位由暴力扫盘改为确定性路径优先命中。
3. **实时 Token 消费对齐 (`server.mjs`)**：
   - 在 WebSocket `session/follow` 流中实时消费 `assistant-stream` chunk (`text-delta` 与 `thinking-delta`) 并广播。
4. **Zstd 逆向游标流式解压支持 (`server.mjs`)**：
   - `decompressAllZstdFrames` 支持 `maxTailFrames` 逆向切片，释放超大会话历史加载压力。

## Alternatives considered

1. **维持客户端 isStreaming 临时变量**：存在时序脱节导致的幽灵发送，且违背单一状态源准则，否决。
2. **全盘重写前端为现代模块化架构**：受限于 BlackBerry Q20 浏览器 WebKit 537.35 及 ES5 门禁，无法直接引入现代打包产物，必须坚持 ES5 单文件架构。

## Consequences

- 消除会话状态反转与误触发风险；
- 与官方工作区寻址、事件流模型及色彩规范完全对齐；
- 通过 Acorn ES5 语法静态解析与 7/7 场景全链路自动化回归测试。
