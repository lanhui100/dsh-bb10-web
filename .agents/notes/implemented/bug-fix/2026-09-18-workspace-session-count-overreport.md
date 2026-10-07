# Agent Note: Workspace Session Count Over-Reported vs Real Unarchived Sessions

Status: implemented

## Problem
Q20 工作区面板（wsTree）中每个工作区旁的 `(N个会话)` 计数虚高：`dsh-q20-web`
实际未归档、可打开的会话只有 3 个，面板却显示 33（>10）。

## Root cause
`getWorkspaces()` 对官方工作区直接取 `workspace.json` 注册的 `sessionIds` 减去
`archivedSessionIds` 作为计数，**从不校验这些 id 在磁盘上是否真实存在**。
而会话列表 `/api/sessions`（`getSessionsForCwd`）只返回能解析到 `.jsonl.zstd`
转录目录的会话。DSH 官方账本会保留已删除/未落盘的残留 id（实测
`dsh-q20-web` 注册 62 个，29 归档，33 未归档中仅 3 个在磁盘上有转录），
导致计数与列表长期不一致。

## Decision
统一计数口径为「注册 + 未归档 + 磁盘可解析」：
1. 新增 `countResolvableRegistered(wsDir, sessionIds, archived)`：单遍扫描工作区
   目录，收集磁盘上每个有 zstd 转录的会话 id（目录名 + header.id）为 Set，再
   对注册 id 做成员判断（跳过归档）——与 `getSessionsForCwd` 的解析逻辑一致，
   且复杂度为 O(目录数 + 注册数)，避免大工作区逐 id 重扫造成事件循环卡顿。
2. `getWorkspaces()` 官方工作区 `sessionCount` 不再用注册表减归档，改为在
   磁盘扫描循环命中真实目录（`resolvedCwd` 匹配）后，用该目录调用
   `countResolvableRegistered` 收敛；官方但磁盘上无目录的工作区计 0。
3. `getWorkspaces()` 结果加 3s 短缓存（读取每个会话目录的 zstd 头较重，不宜
   每次 /api/sessions 都重算）。
4. 非官方工作区计数（activeCount 扫描）本就以磁盘为准，不动。
5. 测试套件预检查新增回归护栏：`/api/bootstrap` 的 `sessionCount` 不得高于
   `/api/sessions` 实际列表长度（count > list 即判失败）。

## Alternatives considered
1. **清洗 workspace.json 中的残留 id**：改 DSH 官方账本，风险高且会被宿主
   下一次写回覆盖（参见 workspace-attachment ADR 的取代注记），治标不治本。
2. **前端直接调 /api/sessions 数长度**：每工作区多一次请求，Q20 双核 CPU 上
   徒增开销；服务端一次性算好更符合本仓库性能铁律。

## Consequences
- 工作区面板计数与 `/api/sessions` 列表恒一致（实测 `dsh-q20-web`、`job_copilot`
  面板数 = 列表长度）。
- 验证：`node test-suite.mjs` 7/7 PASS（含新回归护栏）；客户端 `ES5 PASS`。
