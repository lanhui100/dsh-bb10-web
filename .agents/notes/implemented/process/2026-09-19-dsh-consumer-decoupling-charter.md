# Agent Note: dsh 消费边界与上游对齐义务入宪

Status: implemented

## Problem

本项目与 `deepseek-harness` 解耦、随 dsh 破坏性更新做对齐调整的契约此前只散落在
README（人读层），未写入本仓库宪法（根 `AGENTS.md`），agent 每次会话不会自动载入；
且 README 的"独立仓库、不受主仓库更新影响"表述与既定行为"宿主离线降级本地 SDK
进程内引擎与镜像直写兜底"口径含混，"仅消费 dsh 服务"与"本地兜底引擎/镜像直写"互相矛盾。
dsh 处于预发布阶段允许破坏性更新，本工程"随上游破坏性更新做对齐调整"的义务没有任何条款承载，
属于契约真空。

## Decision

前序：本条扩展 `.agents/notes/implemented/process/2026-09-18-align-constitution-with-dsh-web-logic.md`
所立的宪法 §六（该章保持现行权威，仅改题并前置消费边界），其“两条管道”与兜底互斥机制的架构真源见
`.agents/notes/implemented/architecture/2026-09-17-drive-conversations-through-dsh-host-rpc.md`，
对齐背景另见 `.agents/notes/implemented/architecture/2026-09-18-dsh-web-alignment-audit-and-roadmap.md`。

- 宪法根 `AGENTS.md` §六改题为「dsh 消费边界与对齐准则」，新增第 0 条
  「消费边界与解耦声明（Decoupled Consumer）」，核心条款包括：
  1. 与 `deepseek-harness` 主仓库完全解耦：同级独立 Git 仓库，不 fork、不 vendor、
     不内嵌其源码，仅通过 DSH 标准接口（宿主 RPC / SDK 库 API）消费其能力；
  2. 能力调用面收敛为且仅为两条管道：宿主 DSH Web 在线 → 宿主 HTTP RPC 面与
     `/api/remote.mux` WebSocket 流载体消费；宿主不可达（连接拒绝、超时、502/503）
     → 降级外部底座的 SDK 进程内引擎（`packages/sdk/client`）兜底；严禁引入第三条私有能力调用路径；
  3. 可达性判定与写租约互斥：仅在宿主未接管会话前遭遇不可达时才允许安全回退 SDK 引擎；
     一旦宿主已接管，失败直接呈现为任务错误，严禁回退（写租约互斥，防止撞锁）；
  4. 存储与凭据镜像豁免：会话转录读取（`~/.dsh/sessions` 下 Zstd 解压）、宿主不可达时
     `~/.dsh/storages/workspace.json` 原子直写镜像、读取用户层配置文档（dsh ≥ 0.1.7 为
     `~/.dsh/profiles/<profile>/cordis.patch.yml`，旧版为 `~/.dsh/settings.yaml`）与
     `.credentials.yaml` 派生认证 Cookie，属于官方格式的持久化镜像适配，均受同等上游格式对齐义务约束；
     该镜像只作管道②降级兜底，可路由数据（模型目录等）在线时以宿主 RPC 为准
     （用户层配置文档迁移见 `.agents/notes/implemented/bug-fix/2026-09-23-model-catalog-source-after-dsh-017-profile-config.md`）；
  5. 上游对齐义务：dsh 处于预发布阶段，允许破坏性更新；dsh 每次破坏性更新落地，本工程
     必须同一次变更内完成对齐调整并全量回归（`test-suite.mjs` 全量 PASS），保证持续正确消费 dsh 服务。
- README.zh.md / README.md「架构解耦」节按"每个事实一个家"去重：保留操作性事实
  （`DSH_ROOT`、端口、RPC 面、兜底行为、门禁入口），规范性声明删除并链回宪法 §六；修正 git 层与行为层的表述张力。
- 新增机器门禁 `test-decoupling.mjs`（非零退出即失败），机械校验：宪法 §六 切片内含本条款
  结构化特征短语、`git submodule status` 为空、无 `.gitmodules`、仓库内无 vendored dsh 目录与文件；
  接入 `package.json` 的 `test` 与 `test:all`。
- 管道独占性、存储镜像豁免边界与 fork/内嵌检测穿透面靠 review；上游对齐义务的语义层（行为是否忠实对齐 dsh）机器到不了，
  标注靠 review + `test-suite.mjs` 门禁。

## Alternatives considered

- **照搬 agent.md「仅消费 dsh 服务」字面**：与既定行为"宿主离线降级本地引擎与镜像直写"直接
  矛盾，要么删兜底要么条款失真，弃；改用"能力调用面收敛为两条管道 + 存储镜像豁免清单"口径，
  既保住解耦声明与降级事实，又理顺了存量代码的合规性。
- **新增独立 §八「dsh 消费与上游对齐义务」**：为一条声明开新章造成章节膨胀，且与
  §六对齐主题天然同族，弃；并入 §六加第 0 条。
- **门禁并入 `test-unit.mjs`**：unit 套件依赖 3090 端口存活服务，而解耦校验是纯
  git/文件系统断言，不应背负服务依赖，弃；独立零依赖脚本接入 test 链。

## Consequences

- 后续任何引入第三条私有能力调用路径（直连未公开模型端点、绕开 DSH 协议等）的提案，先违宪，
  必须走 ADR 修订本条后才可实施。
- 宪法中提及的 RPC 方法清单为运行时当前特化快照（非封闭集），以官方 dsh web 开放接口规范为准。
- dsh 破坏性更新触发的对齐变更，须在本条义务下 same-commit 更新对应文档的家。
