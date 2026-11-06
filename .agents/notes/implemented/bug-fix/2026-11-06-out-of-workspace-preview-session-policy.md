# Agent Note: 工作区外交付文件预览改由会话文件策略授权

Status: implemented

## Problem

轮次结束的「📦 交付文件」列表里，凡 `path` 不在当前工作区根内的文件，点击一律 403
「该文件不在当前工作区内，已拒绝读取」——即使该会话的文件策略是「完全权限」
（`danger-full-access`）。

根因是两段各自成立、拼起来失效的设计：

1. `GET /api/file` 的越权判定只有两把锁：`cwd` 必须是已注册工作区、目标 `realpath`
   必须被工作区根包含（`resolveWorkspacePreviewPath`），**完全不读会话文件策略**；
   因此「完全权限」这一事实在服务端不存在，无从放行。
2. 客户端交付卡片虽可点，但 `fpBuildTarget` 只发 `cwd` + `path`，**不告诉服务端
   「这是哪个会话」**；服务端即便想查策略也无键可查。

上游权威事实在宿主：`session/projections` 的 `permissions.currentValue`（`danger-full-access`
/ `workspace-write` / `read-only` / `custom`）与 `workingDirectory`，本机实测 HTTP 200：
`{"currentValue":"danger-full-access"}`、`"<HOME>/dsh-q20-web"`。q20 侧早已有
`fetchSessionProjections()`（单飞 + 正负缓存 + 2500ms 超时）与 `/api/file` 的
`realpath` 事实收集，缺的只是把它们接起来，并补一个「客户端只上报会话 id」的通道。

## Decision

1. **授权判定抽成零副作用纯函数** `lib/preview-policy.mjs`：
   `decidePreviewReadAccess({contained, registered, sessionId, requestCwd, sessionCwd, permission})`
   → 恒返回 `{ok, status, code, error}`。决策顺序固定为
   a 旧快路径（`contained && registered` → 放行，零宿主调用）→ b 无 session（403
   `PREVIEW_OUT_OF_SCOPE`）→ c 会话归属不匹配（403 `PREVIEW_SESSION_MISMATCH`）→
   d 非完全权限（403 `PREVIEW_PERMISSION_REQUIRED`）→ e 放行。缺字段一律拒绝，永不 throw。
2. **服务端 `/api/file` 改为异步判定**：可选 query `session`（`getAll` 长度 ≠ 1 或未过
   `isValidSessionId` 一律按缺失），只有快路径不成立且 session 合法时才
   `await fetchSessionProjections(sessionId)` 取 `permissions.currentValue` 与
   `workingDirectory`（realpath 归一后参与归属比较）；宿主不可用/超时/无值 →
   fail-closed 403 `PREVIEW_POLICY_UNAVAILABLE`，并落 `[PREVIEW] ... sid=<sid>` warn。
   **不新建第二条宿主取数通道**。
3. **不变量保持**：扩展名白名单（415）、体积上限（413）、`Cache-Control: private, no-cache`
   与 realpath 事实链一律不变——完全权限只解锁「越出工作区」，不解锁任意类型。
4. **客户端只上报会话 id**：交付卡片与 markdown 本地文件 chip 带 `data-fpsid`，
   `fpBuildTarget` 追加 `&session=`（空 sid 不追加，URL 与旧版逐字一致）；403 按响应
   `code` 映射文案。客户端**永不上报 permission**，服务端忽略任何客户端自述权限。
5. **兼容面**：不带合法 `session` 的请求，响应体与旧版逐字节等价（
   `{"ok":false,"error":"path escapes the workspace root"}`，不含 `code`）；未注册
   cwd + 无 session 亦统一走该文案（`code` 不出现）。带合法 session 的拒绝体带 `code`。
6. **敏感路径 denylist（审查 BLOCKING 后的加固，R-4）**：越界放行会顺带把「白名单扩展名
   的凭据文件」也放出去（实测 `~/.dsh/.credentials.yaml` 曾 200/397B）。因此**非快路径**
   （`!(contained && registered)`）在授权前做敏感判定，命中即 403 `PREVIEW_SENSITIVE_PATH`：
   basename ∈ `.credentials* .q20_token id_rsa* .netrc .pgpass cordis.patch.yml settings.yaml`、
   `^\.env(\.|$)`、扩展名 `pem/key/p12/pfx/keystore/jks`、或落在 `~/.ssh ~/.aws ~/.gnupg
   <DSH_HOME>/.credentials*` 前缀内。**工作区内快路径不做该检查**——工作区内 `.q20_token`
   仍 415、`.credentials.yaml` 仍 200，与既有冻结回归（`test-unit.mjs:2994-3013`）一致。
7. **归属不可核验必须 fail-closed（R-5）**：宿主给了 `workingDirectory` 但非绝对路径或
   realpath 失败时，不得退化为「未知→跳过归属步」（那等于只凭 preset 放行），而是
   403 `PREVIEW_POLICY_UNAVAILABLE` + `[PREVIEW] ... reason=cwd-unresolvable`。
8. **未注册 cwd 先拒绝再取目标（R-6）**：`!registered && 无合法 session` 在目标 realpath
   之前返回 403，堵掉「403/404 二值化探测任意绝对路径是否存在」的 oracle。
9. **信任边界（显式非目标）**：q20 是单用户 LAN 伴生服务；`session` 参数**不是认证凭据**，
   与 `/api/sessions` 一样是调用方输入；本波的安全边界 = 宿主策略投影 + 交付物成员闸门 +
   敏感路径 denylist + 扩展名白名单 + 体积上限。暴露到不可信网络必须启用 `Q20_AUTH_TOKEN`
   或前置反代鉴权。
10. **交付物成员闸门（终版主闸门，R-8）**：仅靠 denylist 收不住——复审实测
   `~/.config/gh/hosts.yml`(242B, gho_ token)、`~/.aliyun/config.json`(294B)、
   `~/.docker/config.json`(119B)、`~/.claude.json`(38KB) 仍 200 出网，名单永远追不完。
   于是把授权语义收窄：**越界目标必须属于「本会话交付物清单」**（复用 `/api/history` 的
   deliverables 聚合：`present` + `write/edit/str_replace_editor` 的路径，按会话 cwd 归一后
   realpath），清单之外一律 403 `PREVIEW_NOT_IN_DELIVERABLES`。清单由服务端从该会话自己的
   转录推导（`(sid, zstd mtimeMs:size)` 缓存 ≤60s），**不接受客户端声明**；空清单即全拒。
   这同时把硬链接/符号链接别名、任意凭据目录等一切「未在本会话出现过的路径」挡在门外。

## Alternatives considered

- **让客户端上报 permission**（`&permission=danger-full-access`）：一次请求即可放行，
  但把授权闸门交给调用方输入，等同自证；服务将界网监听，任意调用方可自封完全权限。
  否决，改为只上报会话 id、由宿主投影裁决（AT-2e 机器断言伪造 permission 被忽略）。
- **把客户端「权限下拉」的当前值当作会话策略**：q20 的 `permission` 只是 UI 字符串，
  从未下发宿主（`/api/chat/stream` 仅回显），与真实策略可能不一致；且新建会话未选中时
  默认 workspace-write，会再次误拒。否决，改用宿主投影真源。
- **本地镜像 durable 事件 `permission/preset`（transcript zstd）做离线兜底**：可让宿主
  离线时仍可判定，但需新增一条解析通道并承担上游事件格式漂移；本波次只做在线主链，
  离线预览保持 fail-closed（文案「宿主离线，无法核验会话权限」）。留作后续独立决策。
- **放宽扩展名白名单/支持更多类型**：用户抱怨的是「位置」而不是「类型」；放宽会把 2MB
  文本 / 6MB 图片上限与签名闸门一起打穿。否决（Non-Goal，A9.4 机器护栏）。
- **让 `/api/file` 继续同步阻塞取宿主**：宿主 `session/projections` 实测可 2.5s 才回；
  保持同步会让点击卡住事件循环。改为异步 + 既有单飞缓存 + 硬超时。
- **为完全权限会话开放目录浏览/通配**：越权面爆炸且 720×720 无此需求，否决。
- **把 denylist 放进纯函数**：纯函数是「事实→判定」的冻结决策顺序，denylist 依赖
  `os.homedir()`/`DSH_HOME` 与扩展名，属表外闸门；混进去会把纯函数变成有环境依赖的策略
  引擎，并使 A1–A5 的表驱动断言失效。否决，denylist 留在服务端。
- **最初只上 denylist、不做交付物成员校验**：先按名单枚举凭据路径，被两轮独立复审驳回
  （`~/.config/gh/hosts.yml`、`~/.aliyun/config.json`、`~/.docker/config.json`、`~/.claude.json`
  实测 200 出网）。名单追不平「完全权限 ⇒ 全机可读」这条过宽语义，最终改为 R-8 成员闸门；
  denylist 保留为叠加防御（拦下「会话自己写过的凭据路径」这类极端情形）。
- **让 denylist 覆盖工作区内文件**：会打破既有冻结回归（工作区内 `.q20_token` 必须 415），
  且工作区内读取本就是本波之前的能力，越权面来自新增的越界读。否决，只作用于非快路径。

## Consequences

- 机器门禁（本机实测退出码）：`node --check server.mjs`=0；ES5 acorn（`ecmaVersion:5`）=0
  `ES5 PASS`；`tests/acceptance/suite-preview-policy.mjs` **21/21**=0；
  `tests/acceptance/adversarial/preview-policy-attack.mjs` **9/9**=0；`test-unit.mjs` 39/39=0；
  `test-decoupling.mjs`=0；`test-suite.mjs` 7/7=0；`test-preview-browser.mjs` 29/29=0；
  浏览器 E2E 7/7（`docs/release/evidence/wave-2026-11-06-preview-policy/`，正向流程 Console Error=0）。
- 生产收口实测（`http://127.0.0.1:3090`，systemd 重启后新进程）：完全权限会话 + **本会话交付物**
  的工作区外 `.md`（`/tmp/q20-preview-receipt.md`，由本会话 write 工具产生）→ **200 / 437B**；
  同一会话请求**非交付物**的 `~/.dsh/AGENTS.md` → **403 `PREVIEW_NOT_IN_DELIVERABLES`**；
  工作区内 → 200；`/etc/hostname`（非交付物）→ 403 `PREVIEW_NOT_IN_DELIVERABLES`
  （R-8 前该例为 415——白名单闸门不再先行，属成员闸门先于 servePreviewFile 的必然结果）；
  `~/.dsh/.credentials.yaml` → **403 `PREVIEW_SENSITIVE_PATH`（397B 不再出网）**；
  `cordis.patch.yml` → 403；工作区内 `.q20_token` → 415（快路径不变）；
  未注册 cwd + 不存在目标 → 403（无存在性 oracle），已注册 + 不存在 → 404；
  跨工作区/不存在的会话 → 403 `PREVIEW_POLICY_UNAVAILABLE`（≤2.5s fail-closed）；
  `~/.config/gh/hosts.yml`、`~/.aliyun/config.json`、`~/.docker/config.json`、`~/.claude.json`、
  `/etc/hosts` 等「非交付物」一律 403（复审反例全部闭合）。
- 终审复审：Gate-1 `review-plan-r8.json`=PASS、L3-B `review-l3b-preview-r8.json`=PASS
  （前两轮均为 FAIL，反例见各 r4/r8 审查文件）。
- 新增收缩面：`/api/file` 打开工作区外读取，但只对「宿主投影完全权限 + 会话 cwd 与请求
  cwd 一致 + 白名单扩展名 + 体积上限」四重同时成立的目标生效；客户端无权限自述能力。
- 已知遗留（同口径记录在契约 §6 与 `.dev-team/meta-retrospective.md`）：
  ① 宿主离线时越界预览 fail-closed；
  ② 未注册 cwd 的 403 文案由 `workspace is not registered` 统一为
     `path escapes the workspace root`（状态码与客户端文案不变）；
  ③ 15s projections 缓存窗口内 preset 降权可能滞后生效（AT-3 显式接受）；
  ④ 生产 `http.request` 超时是 socket 空闲超时，慢滴流场景墙钟可超 2.5s（fail-closed 不变）；
  ⑤ 无 session 403 的传输 framing 由 chunked 变 Content-Length（body 逐字节不变）；
  ⑥ 客户端 `data-fpsid` 是渲染时快照，切会话瞬间重渲染的旧卡片可能带错 sid → 服务端 403 MISMATCH（fail-closed）；
  ⑦ 清单可由会话自身内容自授权：模型把某路径 `present`/`write` 过（哪怕未成功）即入清单——
     权限主体未提升（该会话本就能读并把内容打进对话），且 denylist 覆盖高价值形态，接受为已知残留；
  ⑧ `sessionCwd` 为空时成员归一本基的 fail-closed 修正已落地（A14f 用例守护）；
  ⑨ 未注册 cwd 分支的 403 `code` 可区分布局（MISMATCH vs OUT_OF_SCOPE）仍可作路径存在性探测，接受；
  ⑩ 413（>2MB）本轮由套件断言覆盖，审计未在生产实例实打（证据缺口，靠 review）。
- 回归护栏：新增两个验收套件并登记进 `tests/acceptance/run-all.mjs`；`test-unit.mjs` 的
  `/api/file` 既有断言（越界 403 / 未注册 403 / 非白名单 415）全部保留通过。
- BB10 真机手感（小屏点击、遮罩关闭）靠 review；本波不改交互形态。
