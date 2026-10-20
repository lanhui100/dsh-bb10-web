/**
 * Agent Team / 子智能体投影的「新旧取舍」纯函数（U 面板数据修复，2026-10-20）。
 *
 * 背景（唯一事实来源：`.agents/notes/implemented/bug-fix/2026-10-20-u-panel-team-roster-lost.md`）：
 * 宿主 `session/list` 的 `projections.values.agentTeam` / `subagentCatalog` 是权威投影；
 * 本进程的 live 镜像（`lib/host-live-state.mjs`）里的同名字段只是「某一次快照的冻结副本」——
 * `$events` 只事件化 running 事实（契约 C-4），从不事件化队友名单与任务看板。
 * 因此合并 live 镜像时必须逐字段取舍，绝不能让冻结副本整体覆盖更新的快照投影，
 * 否则本次会话新出现的队友、任务看板、后加的后台任务会从 U 面板消失。
 */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function taskCount(team) {
  return (team && Array.isArray(team.tasks)) ? team.tasks.length : 0;
}

function memberCount(team) {
  return (team && Array.isArray(team.members)) ? team.members.length : 0;
}

/**
 * 在「当前快照投影」与「live 镜像冻结副本」之间选出更完整的一份 agentTeam。
 *
 * 取舍口径：任务看板条目数优先，其次成员数；完全相同时取快照（快照是回源结果，
 * live 副本只能来自更早的回源，绝无可能更新）。
 *
 * @param {any} snapshot - session/list 快照中的 projections.values.agentTeam。
 * @param {any} live - live 镜像行中的 agentTeam。
 * @returns {any} 选中的 agentTeam；两侧皆无有效对象时返回 undefined（调用方保持快照原值）。
 */
export function pickAgentTeam(snapshot, live) {
  const snap = isPlainObject(snapshot) ? snapshot : null;
  const liv = isPlainObject(live) ? live : null;
  if (!snap && !liv) return undefined;
  if (!snap) return liv;
  if (!liv) return snap;
  if (taskCount(liv) !== taskCount(snap)) return taskCount(liv) > taskCount(snap) ? liv : snap;
  if (memberCount(liv) !== memberCount(snap)) return memberCount(liv) > memberCount(snap) ? liv : snap;
  return snap;
}

/**
 * 合并两侧 subagentCatalog（按 id 去重并集）。
 *
 * 快照条目优先（回源结果），live 副本中多出的 id 追加在后——既不会丢新增的后台任务，
 * 也不会用旧条目覆盖新条目的 label/mode/createdAt。
 *
 * @param {any} snapshot - session/list 快照中的 subagentCatalog。
 * @param {any} live - live 镜像行中的 subagentCatalog。
 * @returns {Array<any>|undefined} 合并后的目录；两侧皆无有效数组时返回 undefined。
 */
export function mergeSubagentCatalog(snapshot, live) {
  const snap = Array.isArray(snapshot) ? snapshot : null;
  const liv = Array.isArray(live) ? live : null;
  if (!snap && !liv) return undefined;
  if (!snap) return liv.slice();
  if (!liv || liv.length === 0) return snap;
  const out = snap.slice();
  const seen = new Set();
  for (const entry of out) {
    if (entry && entry.id) seen.add(String(entry.id));
  }
  for (const entry of liv) {
    if (!entry || !entry.id) continue;
    if (seen.has(String(entry.id))) continue;
    seen.add(String(entry.id));
    out.push(entry);
  }
  return out;
}
