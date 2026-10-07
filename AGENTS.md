# AGENTS.md — BlackBerry Q20 (BB10 WebKit) 项目宪法与架构准则

本文档是本仓库（`dsh-q20-web`）的**最高开发宪法**。任何后续的功能扩展、性能优化、界面调整或重构工作，**必须 100% 严格遵守本文档所规定的硬件与浏览器客观约束**。严禁以“现代开发便利”为由引入任何破坏 BlackBerry Q20 浏览器可访问性的语法或特性。

---

## 一、 设备物理与运行环境客观事实（Ground Truth）

1. **硬件规格**：
   - **屏幕**：3.1 英寸，**$720 \times 720$ 正方形视口（1:1 宽高比）**，294 PPI。
   - **运存 (RAM)**：2 GB（系统常驻后可用内存较低，老旧 WebKit 存在内存泄漏风险）。
   - **处理器 (CPU)**：高通骁龙 S4 双核 1.5 GHz（计算性能弱，频繁的大规模 DOM 重绘会导致 CPU 满载甚至假死）。
   - **输入硬件**：35 键物理全键盘、光学触摸板（Optical Trackpad）、实体通话/挂断/返回键。默认不会弹出虚拟键盘遮挡屏幕。
2. **浏览器内核规格**：
   - **平台**：BlackBerry 10 OS 10.3+ 自带浏览器。
   - **内核**：WebKit 537.35+（大致相当于 **Safari 7 / Chrome 28~34** 时代的移动 WebKit）。
   - **User-Agent 示例**：
     `Mozilla/5.0 (BB10; Kbd) AppleWebKit/537.35+ (KHTML, like Gecko) Version/10.3.3.3204 Mobile Safari/537.35+`

---

## 二、 前端代码宪法红线（违反即视为重大事故）

### 1. 严格 ES5 JavaScript 语法（硬性约束）
**客户端所有代码（`static/` 目录下）必须 100% 通过 `{ ecmaVersion: 5 }` 静态解析。**

* **绝对禁止（FORBIDDEN）**：
  - ❌ `const`、`let`（必须全部使用 `var`）；
  - ❌ 箭头函数 `=>`（必须全部使用 `function(...) {}`）；
  - ❌ 模板字符串（反引号 `` `...${}...` ``，除纯 Markdown 反引号分割字面量外，必须使用 `+` 进行字符串拼接）；
  - ❌ 解构赋值（如 `const { a, b } = obj;`）；
  - ❌ 展开/剩余操作符（`...args` / `[...list]`）；
  - ❌ 类定义（`class Foo {}`）；
  - ❌ 默认参数（`function(a = 1)`）；
  - ❌ 可选链 `?.` 与空值合并 `??`；
  - ❌ `async` / `await` 与 `Promise`；
  - ❌ 现代浏览器原生 API：`fetch()`、`ReadableStream`、`TextDecoder`、`IntersectionObserver`、`classList.toggle` 等。
* **强制使用（REQUIRED）**：
  - ✅ 网络通信一律使用经典 `XMLHttpRequest` 并监听 `onreadystatechange`；
  - ✅ 字符消除与清洗一律使用兼容正则 `.replace(/^\s+|\s+$/g, '')`；
  - ✅ 异常捕获必须保守：访问 `xhr.status` 与 `xhr.responseText` 时必须包裹 `try...catch`，状态码需容错 `status === 200 || status === 0`。

### 2. 经典 CSS 布局与高对比度暗色主题（硬性约束）
* **绝对禁止（FORBIDDEN）**：
  - ❌ **严禁使用 CSS 变量**（`var(--custom-prop)`，老旧 WebKit 完全不认识会导致样式全部失效）；
  - ❌ **严禁使用 CSS Grid**（完全不支持）；
  - ❌ 避免使用新版 Flexbox 高级属性（旧 WebKit 仅支持带前缀的旧语法，为保绝对稳定，统一使用绝对定位与流式块级排版）；
  - ❌ 严禁使用半透明浅灰低对比度文字（黑莓 294 PPI 高分屏在阳光或暗光下必须保持锐利）。
* **强制使用（REQUIRED）**：
  - ✅ 布局结构基于 `position: absolute` 锚定 `top/bottom/left/right`，配合 `-webkit-box-sizing: border-box; box-sizing: border-box;`；
  - ✅ 原生滚动条必须带上 `-webkit-overflow-scrolling: touch;` 与显式 `overflow-y: scroll;`；
  - ✅ 颜色一律使用静态 HEX 高对比度声明：背景 `#121212`，顶底栏 `#1E1E1E`/`#1A1A1A`，正文 `#E0E0E0`，操作高亮 `#00897B` 或 `#0078D7`；
  - ✅ 表单 `<select>` 必须显式声明 `-webkit-appearance: none; appearance: none;`，并强制指定深底亮字，消除系统磨砂蒙层导致的文字发虚。

---

## 三、 硬件交互与空间利用率铁律

1. **720×720 方屏空间利用率（每一像素都极其珍贵）**：
   - 顶栏高度在收缩态下**不得超过 34px**（推荐单行 32px），展开抽屉必须采用绝对定位下推避让（`top: 62px`），绝不能遮挡对话流；
   - 弹性输入框必须限制在 `[36px, 90px]` 范围，回车发送或失去焦点且为空时自动复位至单行 `36px`；
   - 底栏、状态栏与消息容器的底边距必须数学联动（`chatContainer.bottom = bottomBar.height + statusLine.height`），杜绝重叠或留白断层。
2. **物理键盘第一公民与黑莓按键事实（Keyboard First & BB10 Facts）**：
   - **黑莓实体键事实**：Q20 物理键盘上**没有 PC 意义上的 Esc 键**；机身上的实体“返回键”是系统级/浏览器级的导航操作（默认会退出当前页面或后退历史记录），网页 JavaScript 无法可靠将其用作应用内失焦；
   - **收起与闭环机制**：
     * **发送即收起**：用户在输入框按 `Enter` 发送消息后，大号对话框**必须立即自动收起**回到全屏沉浸阅读；
     * **触控关闭**：支持点击右上角 `✕` 按钮或点击背景任意消息区域收起对话框；
     * 文案与交互提示严禁出现“按 Esc 收起”等脱离黑莓硬件事实的误导性说明；
   - **全局快捷键规划**：
     * `T`：顶 / `B`：底 / `Space`：翻页 / `I` 或 `/`：展开对话框 / `M`：菜单 / `N`：新会话 / `J`与`K`：消息跳行；
   - 快捷键必须有严格的状态机防碰撞保护：当焦点在 `INPUT` 或 `TEXTAREA` 时，除 `Enter`、`Shift+Enter` 外，一律禁止拦截用户的正常键盘文本打字。

---

## 四、 性能防御与流式防崩溃保障

1. **老旧双核 CPU 防假死机制**：
   - 模型流式吐字（SSE `delta`）不得按每个 token 频繁刷新 DOM；
   - **必须强制执行 60ms~80ms 的打字机渲染节流器（Throttle）**；
   - 连接终态（`done` 或 `readyState === 4`）必须强制同步调用 `flushRender()` 保证最终字符 100% 完整还原。
2. **2GB 内存防崩溃窗口化机制**：
   - 消息列表中在 DOM 树常驻的气泡数量**默认不得超过 20 条**；
   - 超出部分必须折叠在顶部，提供 `[⬆ 加载更早历史]` 分页回溯，点击展开时必须精确计算滚动高度差，保证视口视觉平滑稳定。
3. **复杂内容折叠呈现机制**：
   - Agent 的工具调用（bash/read/grep/edit）必须渲染为紧凑单行胶囊 `[⚙️ 调用: xxx]`，默认折叠参数与输出；
   - 深度推理思考（Thinking / Reasoning）必须渲染为单行灰色折叠卡片，默认收起，点击再展开。

---

## 五、 模型输出与沟通篇幅铁律（Concise Output Directive）

**720×720 方屏物理尺寸极小（3.1 英寸），绝不适合大段文字与冗长叙述。**

1. **开门见山，极简汇报**：
   - Agent 输出**严禁输出大段详细的执行过程流水账**；
   - 默认**仅做关键结论与变更摘要的简明汇报**（建议控制在数行或短列表内）；
   - **除非用户在提问中明确要求“详细说明”、“给出完整原因”或深入探讨**，否则默认保持紧凑精炼。
2. **系统级约束注入保障**：
   - 服务端在建立首轮对话时，必须注入小屏交互约束指令，强制模型在整个会话生命周期内严格收敛输出长度，减少不必要的屏幕反复翻页负担。

---

## 六、 dsh 消费边界与对齐准则（DSH Web 对齐原则）

0. **消费边界与解耦声明（Decoupled Consumer）**：
   - 本工程与 `deepseek-harness` 主仓库**完全解耦**：同级独立 Git 仓库，不 fork、不 vendor、不内嵌其源码，仅通过 DSH 标准接口（宿主 RPC / SDK 库 API）消费其能力；
   - **能力调用面**收敛为且仅为两条管道：
     * ① **宿主 RPC 管道（首选）**：宿主 DSH Web 在线时，经宿主 HTTP RPC 接口（以 dsh web descriptor 为准，如 `session/*`、`workspace/*`、`$events/*`）与 `/api/remote.mux` WebSocket 流载体驱动对话；
     * ② **本地 SDK 引擎管道（兜底）**：宿主不可达时，降级调用 `DSH_ROOT` 外部底座的 SDK 进程内引擎（`packages/sdk/client`）兜底。除此之外严禁引入第三条私有能力调用路径；
   - **可达性判定与租约互斥**：仅在宿主未接管前遭遇连接拒绝（`ECONNREFUSED`）、超时或 `502/503` 等不可达情况时才允许安全回退管道②；一旦宿主已接管会话，后续失败直接呈现任务错误，严禁回退（写租约互斥，避免撞锁）；
   - **存储与凭据镜像豁免**：历史会话转录读取（`~/.dsh/sessions` 下 Zstd 解压）、宿主离线时 `~/.dsh/storages/workspace.json` 的原子直写镜像、以及读取用户层配置文档（dsh ≥ 0.1.7 为 `~/.dsh/profiles/<profile>/cordis.patch.yml`；旧版为 `~/.dsh/settings.yaml`）与 `.credentials.yaml` 派生宿主认证 Cookie，属于官方格式的持久化镜像适配，均受同等上游格式对齐义务约束；该镜像只作管道②降级兜底，**模型、工作区等可路由数据在线时一律以宿主 RPC 为准**（配置格式随上游迁移，见 `.agents/notes/implemented/bug-fix/2026-09-23-model-catalog-source-after-dsh-017-profile-config.md`）；
   - **上游对齐义务**：dsh 处于预发布阶段，允许破坏性更新；dsh 每次破坏性更新落地，本工程必须在同一次变更内完成对齐调整并全量回归（`test-suite.mjs` 全量 PASS），保证持续正确消费 dsh 服务。

本项目虽然受限于 BlackBerry Q20 物理硬件（小方屏、双核 CPU、2GB RAM）及老旧 WebKit 537.35 内核，在**前端展示层（CSS 布局、ES5 语法、DOM 节流、紧凑折叠）**必须严格做环境可行性适配，但在**底层业务与核心处理逻辑**上，必须与官方 `dsh web` 保持高度对齐：

1. **状态管理语义对齐**：
   - 会话状态机（`idle` / `running` / `stopped` / `done` / `error`）必须与 `dsh web`（如 `SessionSnapshot`、`StateDot` 及 session controller 规范）保持同构；
   - 发送/停止按钮及交互触点由单一状态源驱动，严禁出现状态脱节或残留。
2. **数据与协议对齐**：
   - 与服务端通信及对宿主 RPC（如 `session/list`、`session/prompt`、`session/cancel`、`workspace/archiveSession` 等）的请求/响应结构、参数约定必须忠实对齐 `dsh web` 后端规范；
   - 会话记录、消息帧、Transcript 的解析口径与终态推断标准与 dsh 一致。
3. **对话流转与交互逻辑对齐**：
   - 多轮对话接续、输入拦截与发送生命周期、中断机制（cancel）以及事件流推送逻辑，在行为语义上与 `dsh web` 保持完全一致；
   - 展现形式可以按小屏精简，但**逻辑分支、数据一致性与状态闭环绝不缩水**。

---

## 七、 变更验收门禁（Definition of Done）

任何对本仓库的提交与 PR，必须在交付前通过以下“三道关卡”：

1. **关卡一：ES5 静态语法门禁**：
   提取所有客户端脚本，运行 Acorn 解析器：
   ```bash
   node -e '
   const acorn = require("acorn");
   const fs = require("fs");
   const html = fs.readFileSync("static/index.html", "utf8");
   const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
   acorn.parse(script, { ecmaVersion: 5 });
   console.log("ES5 PASS");
   '
   ```
   输出必须为 `ES5 PASS`，任何现代语法泄漏一票否决。

2. **关卡二：自动化端到端全链路回归门禁**：
   前置解耦契约机器门禁与自动化全链路回归套件：
   ```bash
   node test-decoupling.mjs && node test-suite.mjs
   ```
   覆盖解耦契约、冷启动、多轮接续、工作区切换、多模型切换、历史 Zstd 解压、异常边界等场景，**必须全量 100% PASS**。

3. **关卡三：真机兼容性自检**：
   确保黑莓 Q20 浏览器无需开启任何特殊兼容实验性开关即可原生直连流畅访问。
<!-- BEGIN constitution -->

## 常载命约（Standing Orders）
1. 任何非平凡变更都要落为 `.agents/notes/` 下一条带 `## Alternatives considered` 的决策记录（程序与校准样例见 `.agents/skills/write-adr/SKILL.md`）。
2. 凡机械可查的承诺，配一条非零退出的命令；机器到不了的，显式标注"靠 review"。
3. 删除代码前先搜消费者；恢复条件立法，拒绝"以后可能用得上"式怀旧。
4. 每个事实一个家：文档治理规则的家是 `docs/AGENTS.md`（agent 自动加载），人读契约是 README——写文档先找它的家，不另起炉灶；改行为/契约的那次提交同步更新对应文档（same-commit，dsh 实证）。

## 停止线
槽位未填时本文件为模板态：sync 投影的是**引导内容（bootstrap）**而非命约——指引 AI agent 完成填槽与首篇决策；槽位填妥重跑 sync 后引导自动被命约替换。成熟度目标（meta.yaml level）是硬上限，达到前不抢跑下一档。
<!-- END constitution -->

