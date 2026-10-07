# Agent Note: dsh 0.1.7 profile-backed Config 后模型目录改由宿主 RPC 供给

Status: implemented

## Problem

dsh 升到 `dsh-v0.1.7-alpha.2` 后，Q20 Web 的 `M` 快捷键模型面板只剩一个 `deepseek-official:deepseek-v4-flash`，而 dsh web 官方界面仍列出 3 个 provider / 17 个模型。

根因是上游一次破坏性配置迁移：dsh 0.1.7-alpha.1 的 `feat(settings): project volatile Config through profile-backed forms (#4587)`（`601d6761e4`，`packages/settings/settings/src/index.ts` 的 `importLegacyDocument()`）在启动时把单一 `~/.dsh/settings.yaml` **改名为 `settings.yaml.imported`**，随后按 section 写进当前 profile 的 Config 文档。用户层配置的新家是 `~/.dsh/profiles/<name>/cordis.patch.yml`：**顶层 YAML 数组**，每项 `{ id, config }`（`llm-deepseek` 在 `config.models`、`llm-pi-ai` 在 `config.providers`；`documentPath` 即 `profileContext.patchPath`，见 `packages/boot/config-editor/src/index.ts:34`）。

本工程 `server.mjs` 的 `readDshSettings()` 只读 `$DSH_HOME/settings.yaml`，该文件已不存在 → `models` 为空 → 只剩函数末尾兜底 unshift 的那一条默认模型。实测证据：`~/.dsh/settings.yaml` 缺失、`settings.yaml.imported` 保留完整旧配置；`/api/bootstrap` 返回 `models.length === 1`，而宿主 `session/modelCatalog` 返回 `groups.length === 3`、`routableProviders = ["deepseek-official","ppx","ponyllm"]`。同一根因也波及 `server.mjs` 里为离线兜底取默认 provider/model 的那处调用。

## Decision

1. **在线权威路径改为宿主 RPC**：新增 `readModelCatalog()`，`/api/bootstrap` 先调宿主 `session/modelCatalog`（与 dsh web 官方模型选择器 `packages/client/ui-model-selection/src/client/catalog.ts` 同源），把 `groups[]` 展平为 `models[]`。信封为 `callDshWebRpc('session/modelCatalog', {}, 6000, { rawArgs: true })`——该 descriptor 无入参，`{ _request: {} }`/`{ request: {} }` 会被 typert gateway 判为 `gateway/arguments-invalid`。
2. **磁盘镜像降为兜底（管道②）**：宿主不可达 / 目录为空时退回 `readDshSettings()`。磁盘读取改为分层：先 `profiles/*/cordis.patch.yml`（`web` profile 优先，新格式），再 `settings.yaml`（旧格式）。`settings.yaml.imported` 只作一次性迁移快照，**不读**——它会冻结迁移当刻的模型，用户此后删除的 provider 会被复活。
3. **`parseYaml` 支持顶层序列**：原实现根节点硬编码为 `{}`，新格式文档会被静默解析成空对象。改为探测首个有效行是否 `- ` 决定根节点为数组（对旧格式完全向后兼容）。
4. **归一化抽成纯函数并加标记块**：`normalizeModelSections(doc)` / `normalizeDefaultSelection(doc)` 同时认新旧两种文档形状，用 `/* @Q20-MODEL-SOURCE-START */ … END */` 包住 `parseYaml`/`parseScalar`/归一化函数，供 `test-unit.mjs` 以 `new Function` 抽取执行（沿用仓库既有的 `@Q20-FAV-MODEL` 标记模式）。
5. **`contextWindow` 补齐**：宿主目录不携带容量（由适配器配置声明），前端 ctx 环靠 `modelCtxWinMap`。用磁盘文档的 `provider:model → contextWindow` 映射回填；缺失即 0，ctx 环按既有逻辑隐藏。
6. **权限与默认值语义不变**：`current.permission` 仍是服务端常量 `workspace-write`；`current` 在线时取宿主 `default`（附 `reasoningEffort`），离线时取磁盘 `agent-default-model`。

## Alternatives considered

- **只补读 `cordis.patch.yml`，不动 RPC 路径**：能用，但把「哪些 provider 真的可路由」交给磁盘猜测。磁盘只有用户覆盖层，bundle 层默认模型根本不在文档里；宿主 `modelCatalog` 还带 `routableProviders` 与逐 provider 失败信息（`failures`），是唯一权威。且 AGENTS.md §六 已定「宿主 RPC 管道为首选」。
- **解析 `settings.yaml.imported` 作为过渡**：迁移后该文件永不更新，等于把历史快照当配置源；用户后续在官方设置里删掉的模型会长期幽灵般留在 Q20 面板里。已拒绝。
- **用配置文件解析（yaml 库 / SDK 进程内引擎）拿目录**：引入第三条能力调用路径或新依赖，违反 §六 的两条管道收敛；SDK 侧也没有等价于 `modelCatalog` 的现成接口。
- **让前端直接调宿主 RPC**：Q20 的 WebKit 537.35 只有 XHR、无宿主认证 Cookie 派生能力，且会破坏「前端只与本服务对话」的边界；认证派生留在 `server.mjs`（既有 `getDshWebAuthCookie`）。

## Consequences

- `M` 面板恢复 3 provider / 18 项（宿主 17 项 + 未出现在 groups 里的宿主默认项补齐）；`current` 必在列表内，前端 `<select>` 不再选空。
- dsh 此后若再改配置格式，`/api/bootstrap` 仍能靠 RPC 拿到目录——磁盘镜像只影响离线降级，破坏面收窄。
- 机器护栏：`test-unit.mjs` 的 `Model Catalog Source Contract (settings.yaml → profile patch)` 校验新格式解析、新旧归一化等价、bootstrap 必走 `session/modelCatalog`、current 必在 models 内，以及「磁盘声明 ≥2 provider 时接口不得塌缩为单 provider」。
- 宿主离线且磁盘无任何用户层文档时，模型列表仍会退化为单条默认模型——这是数据源缺失而非解析缺陷，与旧版 dsh 行为一致。
- 靠 review：`contextWindow` 回填依赖磁盘命中的 `provider:model`，若某模型只在 bundle 层声明容量，ctx 环对该模型隐藏（不报错、不误报容量）。
