/**
 * 预览读取授权判定（协议指纹冻结：签名与语义由契约 Wave 2026-11-06 固定）。
 *
 * 契约来源：.dev-team/contract-wave-2026-11-06.md §1（冻结接口）／§2（决策顺序）。
 * 背景：/api/file 旧路径（server.mjs:4195 resolveWorkspacePreviewPath）只做「已注册工作区 +
 * realpath 包含性」两把锁，完全不看会话文件策略，导致完全权限会话的交付文件仍被 403 拒绝。
 * 本模块把「越界读取是否被会话策略授权」抽成零副作用纯函数，供 server.mjs 与验收测试共用。
 *
 * 硬约束：无 IO／无 env／无 Date／无缓存／不 throw 携带环境细节；
 * 判定顺序与错误码逐条取自契约 §2 真值表，禁止在本文件内新增分支语义。
 */

export const FULL_ACCESS_POLICY = 'danger-full-access';

/**
 * @param {{ contained?: boolean, registered?: boolean, sessionId?: string,
 *           requestCwd?: string, sessionCwd?: string, permission?: string }} input
 *   requestCwd：请求 cwd 的 realpath（调用方归一）；sessionCwd：宿主投影 workingDirectory 的
 *   realpath。步 c 只做字符串比较；requestCwd 缺失按「无法核验归属」处理（sessionCwd 非空即命中 c）。
 * @returns {{ ok: boolean, status: number, code: string, error: string }}
 */
export function decidePreviewReadAccess(input) {
  throw new Error('NotImplemented');
}
