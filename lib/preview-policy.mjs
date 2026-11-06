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
  // 缺字段=拒绝铁律：非对象输入（null/undefined/字符串/数字/数组）一律降级为空对象，
  // 后续步按缺字段处理，绝不 throw（契约 §1.1 / 真值表 T10）。
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};

  // 步 a：旧快路径（contained && registered）——不查宿主、不要求 session、不看 permission。
  if (src.contained === true && src.registered === true) {
    return { ok: true, status: 200, code: '', error: '' };
  }

  // 步 b：无合法 session（含空串/缺失/非字符串）——保持与旧路径逐字节等价的拒绝。
  const sessionId = (typeof src.sessionId === 'string') ? src.sessionId : '';
  if (!sessionId) {
    return { ok: false, status: 403, code: 'PREVIEW_OUT_OF_SCOPE', error: 'path escapes the workspace root' };
  }

  // 步 c：会话归属。sessionCwd 为空 = 未知（跳过）；requestCwd 缺失 = 无法核验归属（fail-closed）。
  const sessionCwd = (typeof src.sessionCwd === 'string') ? src.sessionCwd : '';
  const requestCwdUnknown = (typeof src.requestCwd !== 'string') || src.requestCwd === '';
  if (sessionCwd !== '' && (requestCwdUnknown || sessionCwd !== src.requestCwd)) {
    return { ok: false, status: 403, code: 'PREVIEW_SESSION_MISMATCH', error: 'session does not own this workspace' };
  }

  // 步 d：越界读取只由宿主投影的文件策略授权。
  if (src.permission !== FULL_ACCESS_POLICY) {
    return {
      ok: false,
      status: 403,
      code: 'PREVIEW_PERMISSION_REQUIRED',
      error: 'session permission does not allow reading outside the workspace',
    };
  }

  // 步 e：完全权限放行。
  return { ok: true, status: 200, code: '', error: '' };
}
