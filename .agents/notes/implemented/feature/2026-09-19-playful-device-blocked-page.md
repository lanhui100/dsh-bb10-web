# Agent Note: 非BB10访客拦截页改为趣味模糊文案

Status: implemented

## Problem

`server.mjs` 中 `renderDeviceBlockedPage` 对非 BB10 UA 直接返回
`Access Denied: 仅限 BlackBerry Q20 专用浏览器访问`，把设备品牌、型号、
专用浏览器等敏感识别信息明文暴露给任意公网访客，既帮助攻击者定向构造
伪造 UA，也与 UA 仅做客户端特征识别、不做安全边界的既有决策矛盾。
需要保留拦截行为本身，只把页面文案改为不剧透、有乐趣的模糊提示。

相关代码：`server.mjs` `isQ20Client` / `renderDeviceBlockedPage`；
相关决策：`.agents/notes/implemented/architecture/2026-09-19-harden-auth-gate-and-api-surface.md`、
`.agents/notes/implemented/feature/2026-09-19-security-headers-and-ratelimit.md`。

## Decision

- `renderDeviceBlockedPage(res)` 不再接受外部 `message` 参数透传，
  调用方不再拼接任何设备信息，统一渲染内置趣味文案。
- 页面标题与正文不再出现 `BlackBerry / Q20 / BB10 / 专用浏览器 / 物理设备 /
  Access Denied / Forbidden` 等字样，HTTP 状态码保持 `403` 不变，
  仅正文变模糊，避免暴露识别规则。
- 内置多条中文趣味文案随机轮换（如走错片场、小乌龟驮走了页面、
  茶水间午睡等），每条文案配一张专属内联动效 SVG（穿堂风场记板 /
  散步小乌龟 / 午睡茶杯 / 星空小屋 / 热茶），动画全部使用 CSS keyframes
 （含 `-webkit-` 前缀），无外部资源、无 JS，与 CSP `default-src 'self'` 兼容。
- 拦截响应追加 `Cache-Control: no-store, no-cache, must-revalidate` 与
  `Pragma: no-cache`，避免浏览器与 CDN 缓存旧 403 页面导致文案更新不生效。
- 保持原有暗色高对比样式与 `SECURITY_HEADERS` 注入不变。
- 回环（`isLoopbackRequest`）放行逻辑与 `/api/*` 鉴权网关保持不变。

## Alternatives considered

- *保持直白文案不变*：信息最明确，但直接泄漏目标设备指纹，方便攻击者
  定向伪造 UA，且公网访客体验生硬，否决。
- *改为 404 彻底伪装不存在*：隐蔽性最强，但运维排查时难以区分 UA 拦截
  与真实 404，现有日志 `[REQ]` 已记录路径，状态码保持 403 更易审计，否决。
- *前端 JS 跳转式趣味页*：BB10 老 WebKit 与 curl 等非浏览器访客不执行 JS，
  服务端直出 HTML 才是唯一可靠载体，否决。

## Consequences

- 公网非 BB10 访客只看到趣味模糊页，无法从响应得知目标设备类型与 UA 规则。
- 拦截语义与状态码不变，现有回环测试与认证流程不受影响。
- 趣味文案为纯静态字符串，无新增依赖，不影响 Q20 ES5 宪法（服务端变更）。
