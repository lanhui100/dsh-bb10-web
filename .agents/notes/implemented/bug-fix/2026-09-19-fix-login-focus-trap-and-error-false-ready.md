# Agent Note: 修复登录焦点陷阱与欢迎页错误态假就绪导致的快捷键无响应

Status: implemented

## Problem

继前案 `implemented/bug-fix/2026-09-18-fix-welcome-false-ready-hotkey-lag.md`（bootstrap 后假报就绪 + 全量预热阻塞）之后，用户仍报告"初始化页面完成后快捷键没反应，等片刻才好"。复核发现两处新的假完成信号：

1. **登录焦点陷阱**：`showLoginModal` 用 `setTimeout 100ms` 对登录输入框 `focus()`，但 `hideLoginModal` 从不 `blur()`。认证通过后 `document.activeElement` 长期停留在 `INPUT`，全局 `document.onkeydown` 开头的 activeElement 守卫（TEXTAREA/INPUT/SELECT 直接 return）吞掉所有字母快捷键（W/C/M 等）。用户看到欢迎页"就绪"却按什么都没反应——不是初始化没完成，而是按键根本到不了分发器。等待片刻后用户无意中点别处失焦，快捷键"自然恢复"，与报障吻合。
2. **欢迎页错误态假就绪**：`showWelcomeError` 把 `bootLoading/preloadPending` 清零后调 `updateWelcomeLoading()`，其 else 分支无条件点亮 `#welcome-ready` 快捷键提示，与 `#welcome-error` 叠加显示。用户在错误态看到快捷键表，以为可用，实际 bootstrap 数据根本没回来。

检验方案（无浏览器环境，用静态时序分析 + 服务端计时代替按键录制）：
- 提取内联 script，确认 `hideLoginModal` 无 blur、`updateWelcomeLoading` else 分支无条件显示 ready、`document.onkeydown` 门控顺序为 activeElement → isAuthOk → 各面板分支；
- 服务端计时：冷启动 `/api/bootstrap` 约 2s（全量 Zstd 扫描）、`/api/sessions` 约 1s，确认旧案收敛为单工作区预取后仍有短窗口，但本次主因是焦点陷阱而非服务端阻塞。

## Decision

在 `static/index.html` 前端（纯 ES5，无服务端改动）做两处联动修复：

1. `hideLoginModal` 在隐藏遮罩时对 `loginTokenInput.blur()`（try/catch 包裹），认证通过即把焦点还给 document，后续字母快捷键直达分发器。
2. `updateWelcomeLoading` 的就绪分支加 `welcomeErrorElShown()` 守卫：错误条可见时不点亮 `#welcome-ready`，错误态只显示错误 + 重试，不再用快捷键表误导。
3. `test-unit.mjs` 的 FSM 合约新增两条存在性断言：`loginTokenInput.blur()` 与 `welcomeErrorElShown`，把两处根因锁进门禁。

## Alternatives considered

- **方案 A：全局 keydown 对登录框 Enter 之外的键也放行快捷键**：破坏"输入框内不拦截打字"的宪法防碰撞，否决。
- **方案 B：登录成功后 focus 到某个隐藏按钮**：多一次焦点跳动，BB10 老 WebKit 下可能弹虚拟焦点框；直接 blur 更干净。
- **方案 C：错误态保留快捷键表（用户可先看帮助）**：错误态数据未就绪，W/C 面板打开是空占位，与"诚实状态"原则冲突；错误态只留重试入口。
- **方案 D：服务端加速 bootstrap/sessions**：本次主因是前端焦点陷阱，服务端已有 10s 工作区缓存 + 单遍扫描优化，不动。

## Consequences

- 认证通过后快捷键立即生效，不再有"等片刻才好"的窗口；错误态不再叠加显示快捷键提示。
- ES5 门禁（acorn ecmaVersion 5）PASS；`node test-decoupling.mjs && node test-unit.mjs` 17/17 PASS。
- 与前案链入：`implemented/bug-fix/2026-09-18-fix-welcome-false-ready-hotkey-lag.md`（假就绪首案）→ 本条补登录焦点与错误态两处残留。
