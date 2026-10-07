# Agent Note: 对话框 Plus 文件上传（Q20 直传宿主 + prompt 挂收据）

Status: implemented

## Decision

在对话框底栏左侧增加 `＋` 上传入口（`static/index.html`），经 `server.mjs`
`POST /api/session/upload` 原生字节透传宿主 `uploadFileBinary`，返回收据后随
下一次发送以 `content=[{type:'file',receiptId},{type:'text'}]` 挂载（新会话首问
经 `/api/chat/stream`，运行中追发经 `/api/session/prompt`）。

- 前端：`＋` 钉 `composer-meta` 左侧（absolute + 静态 HEX，不加高底栏；
  无框无底纯白 `＋`，`meta` 左 `padding 40px` 给工作区徽标让位，工作区在其后排列）；
  透明 `input[file]` 覆盖直触原生选择器（禁 `display:none` + `.click()`）；
  图片（png/jpeg/webp/gif）走官方内联通道：FileReader 读 base64，随首问直发，
  无需 sid——首条即可带图；通用文件走收据通道：无 sid 时先调
  `POST /api/session/ensure` 建空会话（与 runChat 同源归属），再传文件取收据，
  随首问同发——用户观感与首问同时发出；ensure 宿主不可达 502 fail-fast，
  严禁本地伪造 sid；
  `xhr.send(file)` 以 `application/octet-stream` 直发（禁 FormData/multipart）；
  5MB 硬限、禁大文件 base64 预览、单行卡（名 + 大小 + 状态）；
  receipt/图片单次核销，发出即清卡，失败不复用；
  无 sid 通用文件直接拦截不发请求，切会话/新建/换工作区即废旧附件并中止在途上传。
- 服务端：`proxyUploadToHost` raw 透传 `content-type/length` + 宿主
  `Cookie/Host/Origin`，直回 405/415/400；`callDshWebRpc` 仅用于后续 prompt
  挂收据；宿主不可达 502 fail-fast，严禁回退本地 SDK。
- 回归：`test-unit.mjs` 补 405/415/400/413 + receiptIds/image 双入口校验 +
  Plus 静态接线 + ES5 门禁断言；
  `test-decoupling.mjs` 补无第三路径断言（调用形态）；ES5 门禁 PASS。

## Alternatives considered

- 首条图片走“先建会话再上传收据”：需前端凭空 create 会话并处理工作区归属，
  与宿主归属逻辑冲突且多一次往返；改为官方内联 base64，随首问一次发出。
- 通用文件首条同样内联：DSH 只接受图片内联，通用文件必须收据通道；
  无 sid 时诚实拦截（先发一句话建会话），不伪造归属。

- 浏览器直连宿主：省一次中转，但 Q20 token 与宿主 `dsh-auth-*` Cookie 无法直通，
  且违反网关统一鉴权，否决。
- FormData/multipart 上传：BB10 兼容好写，但宿主强校验 `octet-stream` 必 415，否决。
- 小文件走 Remote base64 兜底：DSH 官方 runtime 有此路径，但 Q20 侧需引入编码器与
  第二套错误语义，首版砍掉；5MB 内统一走原生字节流。
- 上传中允许发送：会产生 receipt 归属错乱（新会话无 sid），改为 uploading 拦截发送。

## Consequences

- 新会话首问可带文件；运行中追发可带文件；失败卡留重试/移除，草稿不丢。
- 超 5MB 前后端双拦截；特性探测缺失时隐藏 `＋` 降级纯文本。
- 机器到不了的（prompt 挂载语义、BB10 真机选择器）靠 review + 真机自检。
