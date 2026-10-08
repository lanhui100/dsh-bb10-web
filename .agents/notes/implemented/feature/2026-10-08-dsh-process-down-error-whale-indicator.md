# Agent Note: DSH 进程停机/崩溃错误提醒与红线小鲸鱼指示

Status: implemented

## Problem
当 DSH 官方 Web 进程（端口 3080）停止运行或发生崩溃时，Q20 客户端与后端未能及时向用户呈现明确的停机警示，用户无法直接分辨是服务暂时加载还是后端底座 DSH 进程已退出；同时，欢迎页面下方的蓝色线条小鲸鱼动画（`loading-whale-tail.svg`）仍以蓝色加载状态轮播，缺乏红色错误提醒态，无法直观反映 DSH 底座故障。

## Decision
1. **服务端 DSH 运行态感知**：
   - 在 `server.mjs` 中增加权威探活逻辑 `checkDshHostAlive()`，短超时探测 `DSH_WEB_URL`（支持 HEAD /）。
   - 在 `/api/bootstrap` 接口返回体中增加 `dshAlive` 字段，并在 `/api/dsh/status` 暴露轻量探活端点（支持 5s 级别短缓存与后台长连接探活），供前端初始化和轮询探测。
2. **前端初始化与会话流态故障倒换**：
   - 在前端进入时或检测到 DSH 进程没有运行时（`dshAlive === false`），强制显示初始化页面（欢迎页占位 `updateWelcomePlaceholder()`）。
   - 将标题下方的蓝色线条小鲸鱼切换为错误提醒态：加载光圈背景切换为红色线条小鲸鱼（`error-whale-tail.svg`），显示“DSH 服务已停止或异常”错误文案与重试提示，隐藏就绪快捷键表。
3. **红线小鲸鱼资产设计**：
   - 新增 `static/error-whale-tail.svg`，保持原有 100% 官方小鲸鱼矢量骨架与下沉水纹波纹，将蓝色线框（`#4D6BFE`、`#2B7FFF`、`#85A5FF`）转为警示红（`#F85149`、`#DA3633`、`#FFA198`），生动表达底座中断。

## Alternatives considered
- *仅通过顶部 Banner 飘字报错*：无法在方屏初始化中央直接给用户醒目的停机提示，未满足小鲸鱼图标变错误的诉求。
- *仅在 welcome-error 显示纯文字*：小鲸鱼仍然在上方以蓝色欢快摆尾，视觉矛盾且未直观呈现错误状态。

## Consequences
- 当 DSH 主进程崩溃或退出时，用户立即在方屏初始化中央看到醒目的红线小鲸鱼及停机提示。
- DSH 恢复后，点击重试或自动探活成功即可恢复正常蓝色鲸鱼并点亮快捷键提示。
