# 修复：新会话首条消息发送瞬间状态栏误报"会话已完成 (2条)"

Status: implemented

- 日期：2026-09-28
- 影响面：`static/index.html`（`resolveEffectiveSessionState` fallback 分支）
- 类型：bug-fix

## 背景与现象

新开始一个会话，用户发出第一条消息的瞬间，消息流底部状态栏立即出现
`✓会话已完成 (2条)`（allMessages = 用户消息 + assistant 占位 共 2 条），
约 1 秒后才被真实的 `●深度求索中…` 覆盖。对用户而言是"刚发出即已结束"的
状态错乱。

## 根因

`doSend()` 中，`isStreaming = true` 与 `sessState.running = true` 的赋值
（约 11106-11110 行）**早于** `var xhr = new XMLHttpRequest(); activeXhr = xhr`
（约 11169-11170 行），而两者之间有同步调用 `renderSendButton()` →
`renderSessionStatusTail()` → `resolveEffectiveSessionState()`。

`resolveEffectiveSessionState()` 的 fallback 分支（空白新建会话、尚无 sid、
尚未拉取到快照时）用

```js
var hasNetworkActivity = (activeXhr !== null || attachXhr !== null);
var localRunning = !!(sessState.running && (hasNetworkActivity || sessState.phase === 'waiting'));
```

在发送瞬间 `activeXhr` 尚未建立、`attachXhr` 为 null，`hasNetworkActivity` 为
false，于是 `localRunning` 塌缩为 false，fallback 将 `phase === 'running'`
判定为 `done`，渲染完成态文案。

服务端首问流事件序列（start→thought→delta→usage→done）经 curl 实测完全
正常，问题纯在客户端状态推导时序。

## 修复

fallback 分支的网络活动判据加入 `isStreaming`：

```js
var hasNetworkActivity = (activeXhr !== null || attachXhr !== null || isStreaming);
```

`isStreaming` 在发送流程中先于 `activeXhr` 置位、在连接终态全部收敛路径
（done/error/cancelled/readyState 4/onerror/上传拦截）统一清 false，语义上
正是"本地发送推流在途"标志。加入后发送瞬间 `localRunning` 保持 true，
fallback 返回 running，状态栏显示"正在思考与生成回复"，与全局状态机
（`sessCache`/会话树绿点/停止按钮）恢复同源同态。

## 验证

- 复现脚本（保留为回归工具）：`node scripts/repro-status-bug.mjs`
  - 修复前 `[after click send]`：`tailText:"✓会话已完成 (2条)", running:false`
  - 修复后 `[after click send]`：`tailText:"●正在思考与生成回复 (点击停止可中断)...", running:true`
- 门禁全套通过：ES5 acorn PASS；`node test-decoupling.mjs` PASS；
  `node test-suite.mjs` 7/7 PASS；`node test-unit.mjs` 30/30 PASS；
  `node test-fold-smoke.cjs` 41/41 PASS。

## Alternatives considered

1. **在 `doSend` 中提前建立/占位 `activeXhr`**：把 `new XMLHttpRequest()` 提到
   `renderSendButton()` 之前。侵入发送主流程，且影响 `activeXhr` 的既有
   判空语义（多个分支检查 `activeXhr !== null` 代表真实在途请求），放弃。
2. **在 fallback 中改判 `phase==='running'` 时不篡改为 done**：会削弱 fallback
   对"孤儿 running 残留"的清理能力（历史遗留场景依赖其回落 done），风险更大，
   放弃。
3. **采纳 `isStreaming` 进入网络活动判据（本方案）**：复用已有且收口完备的
   流式标志位，最小侵入、语义一致。