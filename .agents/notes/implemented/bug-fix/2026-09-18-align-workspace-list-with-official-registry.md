# Agent Note: align-workspace-list-with-official-registry

Status: implemented

## Problem

在 BlackBerry Q20 客户端的工作区选择弹窗中，出现了多个同名为 `ws` 的重复工作区项。
经排查诊断发现：
1. DSH 官方架构中，工作区（Workspace）是强实体登记制，数据真源为 `~/.dsh/storages/workspace.json` 中的 `tables.workspaces`（并由 `global.workspaceIds` 决定权威展示顺序）。
2. 在 `server.mjs` 原有的 `getWorkspaces()` 实现中，在读取官方 `workspace.json` 后，额外对 `~/.dsh/sessions/` 物理目录进行了无差别扫描，并将任意曾经生成过会话或遗留目录的文件夹（如自动化测试产生的临时沙箱 `/tmp/q20-test-sandbox-.../alt/ws`、`/main/ws`）自动反解为 `name: path.basename(canon) || canon`，作为“非官方工作区”追加到工作区列表中。
3. 这些测试沙箱的目录名都为 `ws`，导致前端工作区列表中堆积了多个重名且会话数已为 0 的孤儿工作区 `ws`，与 DSH Web 官方界面（仅展示注册的工作区）严重脱节。同时在会话删除时，若该物理目录内已无任何会话子目录，未做空目录回收，导致历史遗留目录持续被扫描呈现。

## Decision

1. **对齐 DSH Web 官方注册表源头**：
   - 工作区列表 `getWorkspaces()` 严格对齐 DSH Web 规范：以 `workspace.json` 中登记的工作区为主，按 `global.workspaceIds` 的权威顺序排列输出。
   - 过滤或不再将临时沙箱/测试目录（如 `/tmp/...`）作为常态工作区向客户端输出，同时过滤不存在或已无任何会话的未注册临时目录。
2. **支持当前活动工作区自动就地展示（若临时打开）**：
   - 若当前运行所在的工作区尚未注册到 `workspace.json`，且存在有效会话或为当前服务所在 cwd，允许追加当前工作区，但不额外扫描残留的测试临时目录。
3. **删除与归档彻底回收空目录**：
   - 会话物理删除（`DELETE /api/session`）在清除该会话目录后，若所在的工作区顶级目录为空且属于临时目录或非官方目录，自动执行空目录清理，杜绝产生孤儿目录。
4. **清理已存在的临时沙箱空目录**：
   - 清理 `~/.dsh/sessions/` 下残留的空沙箱目录。

## Alternatives considered

- **方案 A（维持目录全扫描，仅在前端按 basename 去重）**：
  不解决底层数据源与 DSH Web 规范脱节的根本问题，仍会返回一堆无用且无法通信的临时目录。
- **方案 B（彻底只返回 workspace.json 中已注册的工作区）**：
  在临时单测或未登记的新项目中直接启动服务时，可能会因为当前目录未登记在 `workspace.json` 中而导致当前工作区不可见。
- **采纳方案（以官方 workspace.json 为权威源，辅以对当前活动 cwd 的兜底，严格过滤 /tmp 临时测试孤儿）**：
  兼顾与官方 DSH Web 的 100% 对齐，又保障了单测与独立临时启动的兼容性。
