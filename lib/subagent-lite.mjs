/**
 * 多智能体看板懒加载：lite 精简映射（纯函数，零副作用，供 server.mjs 与单元测试共用）。
 *
 * 背景（对齐 dsh web 协议事实 + BB10 小屏性能约束）：
 *   - 宿主 session/list RPC 体积大（实测 2.4MB 级）、慢链路耗时可到 6~16s；
 *     看板列表（团队任务/子智能体/后台任务）只需标题、徽章与状态即可首屏渲染，
 *     必须与详情（任务描述/依赖/写入范围、子智能体 model 等）解耦。
 *   - 客户端先以 `lite=1` 快载列表标题；点击任务行时再按需拉取 `lite=0` 全量详情。
 *
 * @param {object} data /api/session/subagents 的完整响应（含 subagents / tasks / total）
 * @returns {object} 精简后的响应：标记 `lite: true`；子智能体行去掉 model，
 *   任务行只保留列表与基础详情所需字段（description/blockedBy/writeScopes 由
 *   详情按需再取，体现在缺失字段上即客户端 `task.description === undefined` 判据）。
 */
export function applySubagentLite(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = { ...data };
  if (Array.isArray(out.subagents)) {
    out.subagents = out.subagents.map((sa) => {
      const row = {
        id: sa.id,
        parentId: sa.parentId,
        title: sa.title,
        label: sa.label,
        name: sa.name,
        role: sa.role,
        mode: sa.mode,
        kind: sa.kind,
        running: !!sa.running,
        isRunning: !!sa.isRunning,
        state: sa.state,
        status: sa.status,
        updatedAt: sa.updatedAt,
        createdAt: sa.createdAt,
        cwd: sa.cwd,
      };
      return row;
    });
  }
  if (Array.isArray(out.tasks)) {
    out.tasks = out.tasks.map((t) => {
      const row = { id: t.id, subject: t.subject, status: t.status };
      if (typeof t.ownerName === 'string') row.ownerName = t.ownerName;
      if (typeof t.owner === 'string') row.owner = t.owner;
      if (typeof t.revision === 'number') row.revision = t.revision;
      return row;
    });
  }
  out.lite = true;
  return out;
}