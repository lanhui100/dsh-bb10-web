# Agent Note: 消息内文件点击全屏预览（图片 / txt / md）

Status: implemented

## Problem

Q20 小方屏上，消息流里的文件此前都是"死"的：

- 用户经 `＋` 上传的图片/文件（见
  `.agents/notes/implemented/feature/2026-09-21-plus-file-upload.md`）在
  `server.mjs` 的 `/api/history` 解析里被 `extractTextFromContent` 丢掉
  attachment part——历史消息只剩纯文本，纯图片轮次甚至整条消失；
- agent 在 markdown 里写的 `![图](/path/x.png)`、`[文档](docs/y.md)`
  一律按字面文本渲染。

3.1 英寸屏放不下并排阅读区，只能"点开 → 全屏看 → 关掉"。

## Decision

**服务端（`server.mjs`）**

1. `extractAttachmentsFromContent` 保留 `user/message` 的 `image`/`file` part，
   以 `message.attachments = [{kind,id,name,bytes,mediaType,width,height}]` 进
   `/api/history`；`genuine || attachments.length > 0` 才落库，纯附件轮次不再丢。
2. 新增两条只读通道，均只回白名单类型：
   - `GET /api/attachment?id=sha256:<64hex>&name=&kind=&mediaType=` —— 官方附件
     对象存储镜像，路径口径对齐上游 `attachment-local`：
     `objects/<sha2>/<sha>`（图片规范化对象）、
     `files/<sha2>/<sha>/<name>`（文件别名）、
     `file-objects/<sha2>/<sha>`（文件规范对象回退）。
   - `GET /api/file?cwd=&path=&name=` —— 注册工作区内的普通文件（markdown 引用）。
     `realpath` 双侧包含校验 + 注册工作区校验（`registeredWorkspaceRoots()`：
     注册根 realpath 集合带 60s 缓存，避免每次点击都付一次 `getWorkspaces()`
     全量会话扫描——实测冷 3s / 热 1ms，同步阻塞 SSE），
     `..`/符号链接越界一律 403。
     URL 里的 `name`/`kind`/`mediaType` 全部**展示用**，不参与任何判定。
3. **闸门只认磁盘事实，绝不认调用方声明**（安全评审 P0 修复，见下）：
   白名单与 `Content-Type` 一律由服务端推导——工作区文件取 realpath 结果的
   `basename`，附件取**存储侧叶名**；无扩展名的对象只认内容签名
   （PNG/JPEG/GIF/WEBP magic），扩展名自称图片但签名不符同样 415。
   读取后再校一次长度（stat→read TOCTOU）。白名单扩展名 = `png/jpg/jpeg/gif/webp`
   与 `txt/md/markdown/log/json/csv/yml/yaml`，其余 415；上限文本 2MB / 图片 6MB，
   超限 413。绝不从本域回显 HTML/SVG 等可执行类型。缓存策略分流：附件对象
   内容寻址不可变 → `immutable` 长缓存；工作区文件可变 → `no-cache`。

**客户端（`static/index.html`，`@Q20-FILEPREVIEW-START/END`）**

4. 消息内可预览文件渲染为 `.fp-chip` 卡片（图片带缩略图），点击开全屏
   `#file-preview-overlay`（absolute 满屏、z-index 470、静态 HEX）：
   图片交给内核 `<img>` 解码；txt 进 `<pre>`；md 走既有 `formatContent` 渲染。
   纯文本渲染上限 200k 字符、markdown 60k 字符（2GB 内存红线）。
5. markdown 只把**显式**的文件引用变成卡片：`![alt](target)` 与
   `[label](target)` 且 target 是 `data:image/`、同源 `/api/attachment|/api/file`
   或本地可预览扩展名路径；外链、`://`、`<code>` 段内引用保持原字面文本。
   同源 URL 一律**重建而不透传**：`/api/attachment?` 只取内容寻址 id，
   `/api/file?` 只取 `path` 并由 `fpCurrentCwd()` 重新拼 URL——内嵌 `cwd`
   与别名不得越过"当前工作区"范围（安全评审 F2 修复）。
6. 本地回显同口径：上传响应 `value.file.attachmentId`（宿主 `FileUploadValue.file`）
   记进 `plusFile`，刚发出的图片用已读 base64 直出缩略图，历史重载后由
   `/api/history` 的 `attachments` 接管。
7. 交互闭环：卡片点击用 `chatContainer.onclick` 事件委托（单监听、零逐卡闭包）；
   预览层内若还有卡片（md 里的图/文件引用），由 `filePreviewBody` 自带委托
   就地换页；关闭设备路径是右上角 `✕`，`Esc`/`X` 仅 PC 兜底；预览期间
   `document.onkeydown` 吞掉其余快捷键，避免误触 T/B/Space/X。
8. 卡片可见性：markdown 图片若只有本地路径（无缩略图），卡片退回"🖼 文件名"文字态
   ——`.fp-chip-img` 的 `line-height:0` 只服务 `<img>` 场景，文字回退态必须显式
   还原行高，否则行盒被 `overflow:hidden` 裁成 7px 细条（评审实测 blocker）。
   表格单元格与正文同口径接入卡片；`mailto:`/`tel:`/`vscode:`/`#anchor` 等
   非文件目标保持字面。
9. **生成物/交付物列表（完全对齐 dsh web DeliverablesTail / PresentedFileCard）**：
   - 服务端 `getSessionHistory` 完整提取 `deliverables/presented` 声明、`present` 工具调用
     与 `write`/`edit` 产生的文件，并在轮次尾部聚合绑定为 `msg.deliverables`；
   - 响应中补齐当前会话确权 `cwd`，前端通过 `currentSessionCwd` 与 `data-fpcwd` 强绑定每张卡片的
     真实工作区，消除切会话/跨工作区带来的相对路径失效；
   - 前端在每轮 Agent 消息下方渲染 `.deliverables-wrap` 交付物卡片列表（包含图标、文件名、
     模型声明的说明文案与预览动作），点击直通全屏预览，用户无需在正文长文本中搜寻 markdown 链接。

## Alternatives considered

- **图片走宿主 RPC `session/attachment`（管道①）优先，镜像兜底**：官方且带
  会话授权，但只覆盖 image、要求宿主在线且附件被该会话引用；txt/md 根本没有
  官方 RPC（`referencedImage` 只认图片），markdown 引用场景又无 sessionId 上下文。
  最终与 `/api/history` 直读 `~/.dsh/sessions` 的既有镜像口径统一：只读、内容寻址、
  离线可用。**若上游补出通用附件 RPC，应切回管道①优先**（本决策的再访条件）。
- **把消息里任意 `.txt/.md/.png` 路径文本都变卡片**：agent 每轮都提路径，
  会把消息流刷成卡片墙，且无法区分"引用"与"举例"，否决。
- **`<img>` 直接指向工作区文件 URL 或 `file://`**：CSP `img-src 'self' data:`
  不允许外源，且绕过白名单/越界校验，否决。
- **服务端生成缩略图**：需要引入图像依赖（sharp 等），违背本工程服务端零依赖与
  老内核适配原则；官方附件已在上游归一化，直接复用原图。
- **新窗口/Tab 打开**：BB10 浏览器多窗口体验差，且实体返回键语义与页面内模态冲突，
  否决。
- **预览里加复制/下载按钮**：本轮定位是"看一眼"，复制已有消息级按钮；
  留给后续独立决策，避免一次改动铺开三条交互路径。
- **用调用方 `name` 别名做白名单闸门（已实测否决）**：独立安全评审在真机服务上
  验证 `path=.q20_token&name=a.txt` 可把 415 变成 200，等于"读任意注册工作区内
  任意文件"（含 `.q20_token` 本身）——别名是调用方输入，永远不能决定放行。
  同理否决"信 `mediaType` 声明"：一律改由磁盘叶名 + 内容签名推导。
- **把 markdown 里的同源 URL 原样作为 `src` 使用（已实测否决）**：`[x](/api/file?cwd=<别的
  工作区>&path=.q20_token&name=a.txt)` 会生成可点卡片，一次点击即跨工作区读文件；
  改为只取 `path` 并由本端按当前工作区重建。

## Consequences

- `~/.dsh/attachments/v1` 成为第三处"官方格式只读镜像"（继 sessions、
  storages/profiles 之后）；上游若调整 `objects/`、`files/`、`file-objects/`
  布局，本工程须 same-commit 对齐并全量回归。
- HTTP 读取面新增两处：`/api/attachment`（仅内容寻址 id）
  与 `/api/file`（仅注册工作区 + 白名单扩展名 + realpath 包含 + 体积上限）。
- 回归门禁：`test-unit.mjs` 新增 *Message File Preview Contract* 与
  *Message File Preview render logic*（探针对象字节往返、F1 别名绕过回归、
  内容签名闸门、415/400/404/403 守卫、客户端纯函数卡片规则与转义、
  静态接线与 ES5 红线扫描）；
  `test-decoupling.mjs` 新增第 6 项——两条预览通道的代码切片内不得出现任何写盘调用
  （镜像只读的机器可查承诺）；
  真浏览器 `test-preview-browser.mjs`（`pnpm run test:preview`）26 项断言，
  覆盖历史附件卡、markdown 图/文引用、表格内引用、无缩略图卡片不塌陷、
  预览层内卡片可就地换页、F1/F2 越权回归、本地回显、模态键盘守卫。
- 机器到不了的：Q20 真机上大图（6MB 上限内）的内存与滚动流畅度、BB10 WebKit
  537 的 `<pre>`/`textContent` 行为——**靠 review + 真机自检**。
- 两轮独立评审结论（均已闭环）：
  安全向 F1 别名校验绕过（blocker）、F2 markdown 内嵌 cwd 越权（should-fix），
  以及 F3 附件对象 realpath 包含、F5 stat→read TOCTOU、F6 测试空真断言；
  正确性向「无缩略图图片卡被 `line-height:0` 裁成 7px 细条」（blocker）、
  预览层内卡片不可点、表格单元格缺卡片、`/api/file` 冷启动 3s 全量扫描
  （改 60s 注册根缓存）、`mailto:` 等 scheme 变死卡片、空工作区 400 文案、
  连点不中止旧 XHR 全部修掉。
  遗留（登记为已知残余风险，非本特性阻塞项）：预览路由无独立限流/并发上限；
  流式渲染每 70ms 重建卡片 `<img>`（仅当模型在流里吐 markdown 图片时可见）；
  本地回显图片的 base64 在内存中仍有 2 份（已合并 data URL 拼接）；
  真机内存表现归入上述"靠 review + 真机自检"。
