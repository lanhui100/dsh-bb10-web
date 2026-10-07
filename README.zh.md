# DSH BlackBerry Q20 Lightweight Web Client

[English](README.md) | 简体中文

专门为 **BlackBerry Classic (Q20)** 等老旧移动浏览器量身定制的 DeepSeek Harness (DSH) 极简 Web 客户端与伴侣服务。

---

## 特性亮点

1. **为黑莓 Q20 极致定制**：
   - **纯 ES5 JavaScript & 经典 CSS**：0 现代框架依赖，完全兼容 BlackBerry 10 OS 内置 WebKit 浏览器。
   - **720×720 方屏适配**：单行极简折叠顶栏（高度 32px），最大化纵向阅读区域。
   - **黑莓实体全键盘快捷键**：
     - `W` 键：全屏切换工作区 (Workspace)，面板内 `A` 新增（家目录下单名创建）、`D` 移除（确认后仅注销，文件夹保留），末尾“未分组”默认组；切换后自动打开会话列表供选择进入
     - `C` 键：直进“全工作区进行中”会话列表（所有进行中的会话；用户按 `C` 打开的面板再按 `C` 收起，点击工作区自动打开的面板按 `C` 重进列表而不关闭；面板内 `V` 轮换四视图含未分组，`A` 归档选中）
     - `M` 键：全屏切换运行模型 (按常用与 Provider 树形分组，光标移动至模型按 `F` 收藏/取消常用)
     - `P` 键：全屏配置运行权限
     - `O` 键：全屏查看当前会话状态面板 (包含工作区、会话、当前目标、权限、模式、模型、发送模式、轮次/步数、Token速度及统计；有目标时右下 💬 按钮外圈变红)
     - `Q` 键：切换运行中追发模式：排队 / 插队 (toast 反馈)；追发在发出前仅停靠在底部排队区（不进入消息流），实际执行后才入流
     - `Z` 键：一键撤回排队中等待执行的消息并放回输入框 (对齐 dsh 队列撤回)
     - `R` 键：会话 / 工作区 / 状态面板内刷新；消息流非运行状态发送"继续"
     - `T` 键：直达顶部
     - `B` 键：直达底部
     - `Space` / `Shift+Space`：下翻屏 / 上翻屏
     - `I` 或 `/` 键：聚焦输入框
     - `✕` 按钮：点击右上角关闭按钮或背景消息区域收起对话框
     - `Esc` 键：退出输入焦点 / 生成中打断 (PC 浏览器兼容)
     - `X` 键：一键停止运行中的会话（仅会话运行中生效，空闲态不误触）
     - `E` 键：打开并进入全局顶部横幅首条通知会话 (Enter)
     - `D` 键：关闭全局顶部横幅通知首条 (Dismiss)
     - `N` 键：新建会话
     - `A` 键
     - `V` 键：会话面板内轮换视图：当前工作区 → 全工作区进行中 → 全工作区待处理 → 未分组：归档当前会话；会话面板内归档 J/K 选中的会话（归档后自动打开会话列表供选择进入）
     - `H` 键：快捷键速查表
     - `Enter`：发送消息，`Shift+Enter`：换行
2. **多轮对话与智能首问标题**：
   - 会话下拉框自动提取第一轮用户提问作为会话标题，一目了然。
   - 原生 Zstandard 多帧串联解压，支持读取海量历史消息。
3. **老旧 WebKit 内存与功耗保护**：
   - 消息 DOM 窗口化（默认渲染最近 20 条，支持按需向上加载更早历史）。
   - 70ms 打字机流式渲染节流器，消除旧双核 CPU 高频重绘假死。
4. **Agent 工具轨迹与思考折叠（轮级聚合）**：
   - 对齐 dsh web turn-process：每个轮次结束后，思考卡片、中间过程 agent 消息与工具调用整体收进单行计数折叠行（`N 次工具调用 · N 条消息`，纯思考记「已思考」），最终回答正文保持可见；
   - 单条过程项（如孤立的 1 次工具调用）不折叠；懒加载窗口按轮次对齐扩窗，加载更早历史后折叠计数自动补全，展开态跨重渲染保持；
   - 打开长会话时自动静默补齐至最近一轮的用户消息（无需多次点击「加载更多」），进入即锚定该轮提问，自上而下呈现「用户消息 → 折叠行 → 最终回答」；
   - 工具调用（bash/read/grep等）与深度推理（Thinking）仍各自渲染为可折叠胶囊（参数/输出默认收起）。
5. **Agent 状态与错误直显**：
    - 状态行四色：运行中（绿）/ 已停止（橙）/ 完成（蓝）/ 出错（红）。
    - DSH 后端错误原文直显（鉴权 / 限流 / 超时 / 上游异常），断网与服务端错误可区分，主界面一键重试（`R`）；会话/工作区/状态面板内 `R` 键为即时刷新（无刷新按钮）。
6. **交互便利**：
   - 生成中一键打断（红色「■ 停止」）。
   - 每条回复底部一键复制（`execCommand('copy')` 降级支持）与一键重试。
   - 任意已落盘回复一键分支为新会话（回复下复制旁分支图标，或按 `F`；经官方 `session/fork` 从该轮切出）。
   - 消息内文件点击预览：上传的图片 / txt / md 附件与显式 markdown 图片、本地文件引用（`![…](…)`、`[…](…md)`）渲染为紧凑卡片，点击即全屏预览（图片解码直显、txt 原文 `<pre>`、md 按 markdown 渲染），右上角 `✕` 关闭（`Esc` 仅 PC 兜底）。
7. **新建对话入口与数据预热**：
   - 进入页面一律呈现"探索未至之境"新建对话欢迎页，对话框保持收起（仅右下角 💬 触发键）；
   - 欢迎页标题下方带简易动效加载指示器（旋转光圈 + 轮播趣味文案），指示数据正在后台准备；
   - Workspace 与会话列表进入页面即懒加载预热，工作区（`W`）与会话（`C`）面板打开即秒开，无需长时等待。

---

## 架构解耦与独立性

规范性契约（解耦声明、两条消费管道、可达性与租约互斥、镜像豁免、上游对齐义务）的**家是根 `AGENTS.md` §六「dsh 消费边界与对齐准则」**，此处只保留操作性事实：

- **Git 层面独立**：本工程为同级独立 Git 仓库，主干 `deepseek-harness` 仓库 `git pull` / `rebase` 零合并冲突；行为与接口层面严格遵循宪法上游对齐义务。
- **配置自由**：通过环境变量 `DSH_ROOT` 指定外部底座路径，默认为 `../deepseek-harness`。
- **官方归属与兜底逻辑**：DSH Web 宿主（3080 端口）在线时，对话经宿主 RPC 面（HTTP RPC 与 `/api/remote.mux` 流载体）驱动，工作区归属由宿主亲自写入；宿主不可达（连接拒绝、超时、502/503）时，才降级调用外部底座的 SDK 进程内引擎并直写 `workspace.json` 镜像兜底。
- **机器门禁**：`node test-decoupling.mjs`（已接入 `pnpm test` 与 `test:all`）——校验宪法条款在场、无 submodule、无 vendored dsh，非零退出即失败。

---

## 快速启动与测试体系

### Docker Compose 一键启动

```bash
# 复制并配置环境变量
cp .env.example .env

# 构建并后台拉起容器服务
docker compose up -d

# 查看运行日志
docker compose logs -f
```

> **可复制给 AI Agent 的一键拉起 Prompt**（粘贴给任意 agent 聊天即可自动部署本服务）：
> ```text
> 请在此仓库根目录执行以下操作，一键拉起 dsh-q20-web 服务：
> 1) 若不存在 .env，执行 `cp .env.example .env`；按需修改 .env 中的
>    DSH_WEB_URL（上游 DeepSeek Harness Web 地址，Docker 内默认
>    http://host.docker.internal:3080）、ALLOWED_ORIGINS（反代域名）、
>    Q20_AUTH_TOKEN（可选鉴权令牌，≥16 字符）等解耦配置项。
> 2) 执行 `docker compose up -d --build` 构建并后台启动；
> 3) 执行 `docker compose ps` 确认容器 healthy/running；
> 4) 执行 `curl -f http://127.0.0.1:3090/healthz` 确认健康检查返回 200；
> 5) 汇报容器状态、健康检查结果与服务访问地址。
> 不要修改 server.mjs、package.json 或既有的 systemd 部署文件。
> ```

### 原生 / 脚本启动

```bash
# 启动服务（默认监听 0.0.0.0:3090）
./start.sh

# 停止服务
./stop.sh

# 1. 默认快速单元契约测试（0 Token、0 会话污染、纯本地高速断言，日常高频推荐）
pnpm test          # = node test-decoupling.mjs && node test-unit.mjs

# 2. 全链路端到端回归测试（默认高隔离 MOCK 宿主：0 真实 LLM、0 真实宿主 RPC、
#    0 工作区/会话残留；临时沙箱 + 本地合成转录）
pnpm run test:live # 或 node test-suite.mjs
#    真实链路（真实 LLM + 真实宿主）需显式启用并自备运行中的真实 3090 服务：
#    Q20_LIVE=1 node test-suite.mjs

# 3. 消息内文件预览浏览器 E2E（需已启动服务 + Playwright：
#    `npm i -D playwright`，或 Q20_PLAYWRIGHT=/abs/path/to/playwright/index.mjs）
pnpm run test:preview
```

在 BlackBerry Q20 浏览器输入：`http://127.0.0.1:3090`（已配置 SSH 隧道）即可畅快使用！

---

## 生产托管与可用性

- **systemd 托管**：使用 `deploy/dsh-q20-web.service` 通用模板（需 `/etc/default/dsh-q20-web` 环境文件，在其中配置 `DSH_WEB_URL`、`DSH_ROOT` 等）。安装：`sudo cp deploy/dsh-q20-web.service /etc/systemd/system/ && sudo systemctl enable --now dsh-q20-web`。
- **探活**：`curl --noproxy '*' http://127.0.0.1:3090/healthz` → `{ ok: true }`（免鉴权、UA 无关，位于鉴权/UA 网关之前）。
- **排障入口**：`journalctl -u dsh-q20-web`（看 `[FATAL]`/`[BIND]` 行）；仅回环监听 ⇒ 公网 Ingress 502。
