# ADR: 工作区会话列表视图筛选快捷键与懒加载实现

## 决策背景
在 BlackBerry 10 (Q20 720x720) 移动端客户端中，用户需要在当前项目工作区会话列表查看已归档、所有会话或隐藏已归档会话。官方 dsh web 具有隐藏/显示/仅归档的视图筛选功能，但 Q20 设备受限于双核 1.5GHz 与 2GB 内存，必须保持极简交互与懒加载策略，且客户端所有代码必须 100% 遵守 ES5 语法规范。

## 实施方案
1. **服务端接口 (`server.mjs`)**：
   - `/api/sessions` 增加可选 query 参数 `filter`（支持 `hide-archived`、`all`、`only-archived`，默认 `hide-archived`）。
   - `getSessionsForCwdCached(targetCwd, filter)` 与 `getSessionsForCwd(targetCwd, filter)`：按 `normalizedCwd + '::' + normFilter` 独立做短期 TTL 缓存与并发 In-flight 去重。
   - 返回已归档会话时附加 `isArchived: true` 标记。
2. **前端客户端 (`static/index.html`)**：
   - 保持严格 ES5 规范（经 Acorn `{ ecmaVersion: 5 }` 校验通过）。
   - 在当前工作区会话列表模式下增加快捷键 `F` 循环切换筛选状态：
     `hide-archived`（默认，隐藏已归档）→ `all`（显示全部包括已归档）→ `only-archived`（仅显示已归档）。
   - 懒加载支持：按需请求对应的 `filter` 数据并独立缓存于 `sessCache[cwd + '::' + filter]`，未加载时呈现加载态，已加载秒级复用。
   - 状态栏与标题联动：`setStatus` 明确提示当前筛选模式，面板顶部标题附带 `[全部]` 或 `[已归档]` 胶囊标识，已归档条目展示 `[📦 已归档]` 灰色角标。
   - 底部提示栏更新：加入 `F 筛选` 提示。

## 门禁验证结果
- Acorn ES5 静态门禁：100% PASS
- `node tests/test-archive-filter.mjs`：红相确定性拦截，绿相 100% PASS
- `node test-decoupling.mjs`：100% PASS
- `node test-suite.mjs`：7 个场景 100% PASS
- `node test-unit.mjs`：33 个单元测试 100% PASS
