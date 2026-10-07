# Agent Note: 对齐 DSH Web 官方归档机制的测试会话自动清理与门禁

Status: implemented

## Problem

运行自动化端到端测试套件（`test-suite.mjs`）会触发多个测试用例会话创建（如冷启动、多轮对话、模型切换、工作区切换、异常输入等），并在 `~/.dsh/sessions/` 和 `workspace.json` 中积累大量测试对话。

原先测试套件仅在测试顺利跑通的最末尾调用 `DELETE /api/session`：
1. **清理时机不可靠**：一旦任何测试步骤断言失败、超时或进程异常，末尾的清理逻辑被完全跳过，导致单次测试创建的所有会话彻底残留在工作区中；
2. **与 DSH Web 官方归档协议脱节**：DSH Web（3080 端口）基于常驻内存的 `WorkspaceRegistry` 管理工作区视图，并通过 `/api/workspace/follow` feed 向所有 Web 客户端实时广播变更。原有的 `DELETE /api/session` 只是在本地直接删除磁盘目录并私自覆写 `workspace.json`，DSH Web 根本没有收到任何归档或移除通知。结果导致在 Q20 浏览器端会话看似消失，但在宿主官方 DSH Web 侧边栏工作区中堆积了大量测试会话。

## Decision

1. **服务侧删除链路前置通知 DSH Web 官方归档**：
   在 `server.mjs` 的 `DELETE /api/session` 处理逻辑中，在删除本地会话目录与工作区引用前，优先调用 `callDshWebArchiveSession(sessionId)`（通过带签名认证的 Cookie 向 DSH Web 3080 发起 `workspace/archiveSession` RPC）。DSH Web 会将该会话记入全局归档并实时向 Web 前端推流移除，两端视图保持同步。
2. **测试套件生命周期由 `try...finally` 全面兜底**：
   在 `test-suite.mjs` 中将所有测试执行置于 `try...finally` 块中。无论测试正常通过还是中途失败中断，`finally` 块始终百分之百触发会话清理逻辑。
3. **基于基线快照的差分对账补漏机制（Diff Reconciliation）**：
   在测试启动时及切换工作区前抓取当前工作区活跃会话 ID 作为基线快照；在测试结束清理时，除了清理显式记录的 `createdSessions`，还自动扫描工作区中新出现的、符合测试特征标题（如“什么是量子计算”、“PONG”、“WS_SWITCH_OK”、“PASS-SPECIAL-123”）的会话，防止中间流中断未能回传 sessionId 导致的遗漏。
4. **两阶段清理（Archive + Delete）与复检门禁**：
   定位到测试会话后，首先调用 `POST /api/session/archive` 对齐官方 DSH Web 归档通知，再调用 `DELETE /api/session` 进行物理转录与存储回收；并在清理结束后再次请求 `/api/sessions` 严格校验，若有残留则非零退出阻断门禁。

## Alternatives considered

- **仅使用 `DELETE /api/session` 不调用官方归档**：落选。官方 DSH Web 服务在运行时并不监听外部直接修改底层 `workspace.json`，且官方无 `deleteSession` RPC。只有调用官方 `workspace/archiveSession` 才能让 Web 界面实时消除该会话展示。
- **仅归档不物理删除本地会话文件**：落选。每次测试会生成若干转录文件和 zstd 历史记录，频繁测试后磁盘会残留大量垃圾，物理删除能够保证开发环境的纯净与存储卫生。
- **仅按测试标题全局扫描删除**：落选。仅按标题模糊扫描存在误删用户自定义正常会话的风险，结合“测试运行期会话基线差分 + 测试特征匹配”的双重约束，能够精确锁定并仅清理本次测试生成的会话。

## Consequences

- 运行 `node test-suite.mjs` 在正常或异常终止后，均会自动向 DSH Web 官方发送归档通知并物理删除会话，工作区测试对话 0 残留。
- 测试套件退出前增加了严格的复检校验，杜绝任何会话泄漏隐患。
