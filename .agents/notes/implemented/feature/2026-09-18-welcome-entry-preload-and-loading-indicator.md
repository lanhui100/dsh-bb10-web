# Agent Note: 进入页面展示新建对话欢迎页 + 数据懒加载预热 + 加载动效指示器

Status: implemented

## Problem

关联前案：`implemented/bug-fix/2026-09-18-welcome-placeholder-and-new-chat-state-reset.md`（居中欢迎占位"探索未至之境"）。该案解决了新建会话的沉浸初态，但入口体验仍有三个缺口：

1. **进入页面不总是展示新建对话页**：`renderBootstrap` 在 `localStorage` 存在上次会话时，会直接 `loadHistory` 恢复该会话（伴随"正在读取历史记录..."的长加载页），用户每次进入都看不到"探索未至之境"欢迎页，而是被扔进上一次的历史会话。
2. **面板打开存在长时等待**：工作区列表随 bootstrap 一次性就绪，但会话列表只在打开会话面板（`openSess`）时才按需拉取；切换工作区时未缓存的工作区还要现场扫描磁盘（Zstd 目录扫描实测 60ms~1s+），Workspace / 会话面板的首次打开与切换均可能长时间空转。
3. **欢迎页缺少加载反馈**：页面首屏在 bootstrap 返回前是空白（欢迎占位初始 `display:none`），加载期间无任何"正在准备"的可视指示，用户无法感知数据正在后台就绪。

## Decision

在 `static/index.html` 前端（纯 ES5 + 经典 CSS，无服务端改动）实现三项联动改造：

1. **入口一律呈现新建对话欢迎页**：`renderBootstrap` 不再依据 `saved.sessionId` 自动恢复历史会话，统一置 `currentSessionId = ''` 并显示"探索未至之境"欢迎页；上次会话仅保留在 `localStorage` 作为工作区预选参考，用户经会话面板（C）显式进入历史会话。对话框保持收起（`#composer-panel` 初始 `display:none`），仅保留右下角 💬 触发键。
2. **数据懒加载预热**：
   - 新增 `preloadSessions(cwd)` 包装 `loadSessions`（新增可选 `done` 回调），对当前工作区立即预取；
   - 新增 `preloadAllWorkspaceSessions()`：对其余工作区以 300ms 间隔错峰后台预取，结果落入 `sessCache`——面板打开即渲染，规避并行 Zstd 扫描瞬时打满服务端 CPU；
   - 预取在途数 `preloadPending` 统一驱动欢迎页 loading 显隐，并带 20s 兜底强制收起，防异常滞留空转。
3. **欢迎页加载动效指示器**：`#welcome-placeholder` 内新增标题下的 `#welcome-loading` 组件——旋转光圈（CSS `@-webkit-keyframes`/`@keyframes` 双前缀）＋呼吸文字（opacity 脉冲）＋ 1500ms 轮播趣味文案（"正在准备 DSH 环境… / 正在唤醒工作区… / 正在点亮 720×720 方屏…"等 6 条）。加载完成切到 `#welcome-ready` 提示（按 I 开始对话 · W 切换工作区 · 按 C 打开会话列表）；bootstrap 失败显示 `#welcome-error` 与"↻ 重试"。
4. **顺带修正隐患**：`allMessages` 原为隐式全局，`updateWelcomePlaceholder` 在初始化前读取会触发 ReferenceError 风险，显式声明 `var allMessages = [];`。

## Alternatives considered

- **方案 A：保留进入自动恢复上次会话，仅在恢复前短暂展示欢迎页**：恢复流程仍需加载历史（长时等待），且"先欢迎后跳转"会造成闪烁与状态割裂，违背"进入页面即新建对话页"的诉求。
- **方案 B：一次性并行预取全部工作区会话**：多个 `/api/sessions` 同时触发多个 Zstd 目录扫描，在双核 CPU 上可能瞬时满载；采用 300ms 错峰逐条发出，牺牲毫秒级延迟换取 CPU 平稳。
- **方案 C：loading 用 GIF/图片素材**：额外引入二进制资源与加载延迟，且无法随文案轮播；纯 CSS 旋转光圈 + opacity 脉冲为 GPU 友好、零资源开销，契合老旧 WebKit 性能约束。
- **方案 D：文案固定为单一"正在加载…"**：无趣且与品牌氛围不符；轮播趣味短语在极小屏幕上既指示进度又不显单调，间隔 1500ms 避免高频重绘。

## Consequences

- 每次进入页面都立即看到"探索未至之境"欢迎页与加载指示器，随后在后台完成 Workspace 与会话列表预热，会话面板/工作区面板打开即为秒开；
- 进入历史会话改为显式操作（会话面板），不再被上次会话"绑架"入口；
- 服务端无改动，`/api/bootstrap` 与 `/api/sessions` 协议保持与 `dsh web` 对齐；
- 预取为每次页面加载的后台开销（约 1~2s 分布执行），换取面板交互零等待，符合小屏交互体验优先的取舍。
