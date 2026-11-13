# DSH-Q20-Web vs. 官方 DSH Web 架构与逻辑对齐全面审计报告

## 一、 审计背景与评估基线

本项目宪法已确立《业务与核心逻辑对齐准则（DSH Web 对齐原则）》：
> 本项目虽然受限于 BlackBerry Q20 物理硬件（$720 \times 720$ 方屏、双核 CPU、2GB RAM）及老旧 WebKit 537.35 内核，在前端展示层（CSS 布局、ES5 语法、DOM 节流、紧凑折叠）必须严格做环境可行性适配，但在**底层业务与核心处理逻辑**上，必须与官方 `dsh web` 保持高度对齐。允许为平衡性能进行合理裁剪，但**绝不应该自己发明/实现一套单独的脱节逻辑**。

本次审计由 Agent Team 针对以下三大维度展开全量源码对比：
1. **数据模型与 Transcript 解析层**：对标 `@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-session`、`workspace.json`；
2. **RPC 通信与宿主协议层**：对标官方 3080 端口 RPC 契约、事件流规范与生命周期管理；
3. **前端状态机与会话生命周期层**：对标 `SessionSnapshot`、`StateDot`、`Composer`、`InputBar` 等状态与交互流转。

---

## 二、 审计发现：合理的性能裁剪 vs. 私造的脱节逻辑

### 🟢 属于“符合宪法约束的合理性能裁剪与环境折中”

1. **会话首帧前缀读（Header 64KB Prefix Read）**：
   - 官方 Transcript 采用串联 Zstd Frames 结构，首行固定为 Session Header 元数据。Q20 服务端仅读前 64KB 解压提取 `id`、`cwd` 与 `createdAt`，规避了解析数十兆大日志引发的 OOM，符合老旧硬件防护。
2. **串联 Zstandard 帧解析复刻（`scanZstdFrames`）**：
   - 100% 严格复刻了官方 `@deepseek-ai/dsh-session-persistence-jsonl` 底层纯 JS 逐字节解码 Block Header 与 Descriptor 的逻辑，保证了帧边界切分的准确性与鲁棒性。
3. **双模工作区同步机制**：
   - 归档与工作区更新优先通过 RPC（3080 端口）调用官方宿主；宿主不可用时降级为符合 POSIX 标准的本地原子写（tmp + rename），与官方 `storage-domain` 完全同构。
4. **前端 70ms 打字机渲染节流与 20 节点 DOM 窗口化**：
   - 彻底防范了模型流式吐字压垮高通 S4 双核 CPU 与 2GB 内存，终态 `flushRender` 确保字符 100% 还原，严格符合宪法第四条。
5. **紧凑折叠呈现（Thinking / Tool Pills）**：
   - 针对 $720 \times 720$ 小方屏，将长思维链和多工具调用默认折叠为紧凑单行卡片，点击再展开，空间利用率极佳。

---

### 🔴 属于“私自发明/脱节的单独逻辑与重大隐患”

#### 1. 通信层：自造“磁盘轮询提取 delta 重组 SSE”（严重脱节）
- **现象**：`/api/chat` 在调用 `session/prompt` RPC 后，并没有接入官方原生流式通道，而是启动定时器（`monitorTranscriptProgress`，每 100ms 一次）反复读取磁盘 Zstd 文件大小变化，并截取解压新增帧，再“拼装伪造”为 SSE 发送给客户端。
- **违规定性**：**私造轮询通道**。
- **后果**：
  - 带来高频的磁盘 I/O 抖动与重复 CPU 解压开销；
  - 受到宿主文件缓冲刷盘（buffer flush）延迟影响，流式吐字出现卡顿喷涌，且终态 `finish_reason` 往往比宿主内存状态滞后数百毫秒；
  - 破坏了官方统一的 Event 生命周期权威性。

#### 2. 数据层：工作区目录寻址未实现官方 `projectKey(cwd)` 算法（性能隐患）
- **现象**：官方使用标准 `projectKey(cwd)`（如 `--home-dm-dsh-q20-web--`）与 `encodeSegment(id)` 确定性寻址；而 Q20 服务端退化为全量遍历 `~/.dsh/sessions/` 目录，并逐个读取 header 反查 cwd。
- **违规定性**：**脱节的暴力搜索实现**。
- **后果**：当用户历史积累了数十个项目、数千个会话时，工作区列表与查找会话会产生严重磁盘瓶颈。

#### 3. 数据层：历史读取全量解压，缺少真·反向流式分页（性能隐患）
- **现象**：官方支持从文件末尾向前的游标分页（Cursor-based Pagination）；而 Q20 的 `getSessionHistory` 无论前端需要多少条，每次都调用 `decompressAllZstdFrames` 解包几万行字符串并在内存 slice。
- **后果**：大长文本会话在打开或刷新时，服务器 CPU 瞬时飙满，存在卡顿甚至超时风险。

#### 4. 前端状态机：双轨状态机未彻底根除（状态机 Bug 隐患）
- **现象**：虽然引入了全局 `sessState`，但在 `sendBtn.onclick`、`doSend`、`stopStreaming` 等核心触点中依然硬编码混用本地私有变量 `isStreaming`（例如 `if (isStreaming) stopStreaming(); else doSend();`）。
- **后果**：当通过历史 attach 监听到外部运行状态或后台刷新会话时，`sessState.running` 为 true（按钮已渲染为停止），但 `isStreaming` 为 false。用户点击“停止”按钮时，代码走入 `else` 分支直接触发重新发送（`doSend()`），导致逻辑与展示彻底反转！

#### 5. 前端状态机：缺失 `pendingInteraction` 状态与色系反转（体验脱节）
- **现象**：
  - 官方状态推导最高优先级为 **`pendingInteraction`**（等待人类审批、确认或提问回答）；Q20 前端完全缺失该状态，会导致会话在等待用户确认时被显示为已完成或空闲；
  - **色系语义反转**：官方运行中为**科技蓝**、完成为**成功绿**；Q20 却定义为运行绿点、完成蓝钩，在视觉语义上与官方规范产生反转冲突。

---

## 三、 架构对齐整改实施路线图（Action Items）

| 优先级 | 模块 | 改进任务 | 验收标准 |
| :--- | :--- | :--- | :--- |
| **P0** | 前端状态机 | 彻底移除 `isStreaming`，主按钮点击与流式逻辑收敛到单一 `sessState.running`；Stop 操作增加禁用防连击过渡态。 | 消除状态反转 Bug，Attach 运行态下点击 Stop 稳定触发 cancel 且不可重复点击。 |
| **P1** | 服务端通信 | 改造 `/api/chat` 的流式数据源，废弃 100ms 磁盘轮询逻辑，接入官方流式信道或事件通道。 | 流式输出平滑平稳，彻底消除高频 disk stat 与重复 zstd 解压。 |
| **P2** | 路径寻址 | 引入官方 `projectKey(cwd)` 编码规范，将会话目录定位直接命中特定文件夹。 | 消除 `~/.dsh/sessions/` 的全盘全目录遍历。 |
| **P3** | 状态与色系 | 在服务端与客户端补齐 `pendingInteraction` 状态，并将运行中与完成状态的标识颜色对齐官方规范（运行蓝、完成绿、等待黄）。 | 列表准确标识等待用户输入的会话，视觉语义与官方保持一致。 |
| **P4** | 历史游标分页 | 改造 `getSessionHistory`：依托 `scanZstdFrames` 从尾部 Frame 逆向解码到所需消息数量即停止。 | 大会话读取速度提升至 O(1)，大幅削减内存与 CPU 峰值。 |
