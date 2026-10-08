# Meta Retrospective — wave-1 解耦部署套件（Agent Team 元复盘）

## 一、通信拓扑与信噪比
- Teammate 3 名（Lead + qa-tester + dev-executor），qa-tester/dev-executor 均为有状态持续角色，符合状态连续性公理；审查与对抗工作走 Subagent 池未占常驻槽位。
- 消息均以任务完成汇报为主，无冗余寒暄；qa-tester 与 dev-executor 各 1 次最终汇报即收口，信噪比高。
- 卡点：qa-tester 首次 turn 未能自主发通知（Lead 轮询确认后由 qa-tester 补报），后续轮次已正常。—— 改进点：spawn 时 prompt 明确"完成必须主动发 closing message"。

## 二、门禁穿透与误杀率
- **红相锚定生效**：测试先于实现落盘（commit 659027f），实现后转绿（commit 8aa0a15），物理证据链完整。
- 机械门禁全绿：解耦配置门禁、npm run test (32/32)、mock 隔离 E2E (7/7)、fold smoke (41)、verify-note 全部 PASS；无一误杀。
- 误杀率 0：红相断言仅针对缺失交付物 3 项，未误伤 package.json 完整性。

## 三、分工契约与隔离有效性
- 写域正交：qa-tester 仅 `tests/`，dev-executor 仅交付件路径，Lead 仅文档/收口；git 写主唯一（Lead），无脏写冲突。
- 契约冻结有效：`tests/test-docker-config.mjs` 定义了 5 类 22 项断言，dev-executor 交付后 100% 命中，零返工。
- Lead 编写测试替代 qa-tester？否——测试由 qa-tester 独立编写，分权制未破。

## 四、元协议迭代建议
1. **spawn prompt 增强**：明确要求任务完成须主动 `send_message` 向 Lead 报 closing（本次 qa-tester 首轮缺失）。
2. **红相先决**：本次 task-2 依赖 task-1 的红相（交付物缺失时测试失败证明其有效性），已按 blocked_by 正确串行。
3. ADR verify-note 全树门禁暴露既有 note 缺 Status 行，本次顺手最小修复；建议把该机械校验纳入常规收口清单。

## 结论
协作元框架运行良好，门禁零穿透零误杀；1 条 spawn prompt 改进项待并入 skill。
---

# Meta Retrospective — 429 限流修复落地（2026-10-08，B 级轻量 Agent Team）

## 一、通信拓扑与信噪比
- Teammate 2 名（red-test-429 + impl-429）+ Lead；审查走 Subagent 池（1 路 L3），未占常驻槽位。Roster 4/8。
- 汇报均为结构化交付（改动摘要 + 测试结果 + 未提交声明），零寒暄；Test Agent 自带"Executor 参考"提示传递契约要点，实现零返工之外仅 1 次加固指令（补回裸 429 判据）。

## 二、门禁穿透与误杀率
- **红相有效**：契约 5 用例在旧实现下 5 failed（拦截点逐一核实，非泛红）；锚定 765ea414e3 后实现 9981055d49 转绿 87/87。
- **基线对照方法论**：Executor 对 llm-pi-ai 全量 59 个既有失败做"stash 后同套件逐条 diff"，确认与本改动无关（环境网络问题），防止误报回归——方法论值得固化为常规动作。
- secret-scan 门禁真实拦截 1 次：诊断文件含本机路径被拒，促成"净化版 ADR 入库、机要诊断文件留本地"的边界决策。

## 三、分工契约与隔离有效性
- 写域正交：tests/ vs src/ + profile，零交叉；git 写主唯一（Lead），两提交链完整。
- 契约冻结（判据顺序 + 正则清单）是零返工关键；唯一加固由审查视角补足（裸 429 语义退化），属契约未覆盖面，非分权失效。

## 四、元协议迭代建议
1. **契约覆盖面检查**：冻结分类契约时应显式列出"原行为保留项"（含裸 429 → RATE_LIMIT），避免实现时合理移除导致语义退化。
2. **secret-scan 边界前置**：迁移含机要路径的诊断记录前，先判定"证据文件 vs 净化交付物"归属，避免提交被拦后临时决策。
3. **schema 验证手段**：zod/schemastery 联合类型现场 parse 易踩环境坑，优先"走真实 resolve 入口 + 临时 spec 验证后删除"。
---

# Meta Retrospective — DSH 运行态误报排查与自愈机制修复（2026-10-08）

## 一、通信拓扑与信噪比
- 任务执行采用 DAG 分阶段推进（Phase 1 红相断言 → Phase 2 绿相修复 → Phase 3 机械与真实浏览器双重验证 → Phase 4 审计收口）。
- 精准定位并解决两大关键因果：
  1. 服务端探活毛刺与缺少 Cache-Control 导致的浏览器启发式错误缓存；
  2. 客户端定时器顶层 `if (!curCwd) return` 将 DSH 底座存活轮询饥饿死锁的缺陷。

## 二、门禁穿透与误杀率
- **红相硬拦截**：Phase 1 成功以 `Expected Cache-Control: no-cache/no-store on /api/bootstrap, got ""` 拦住存量未配置防缓存头的实现；
- **全栈门禁**：
  1. ES5 语法门禁（`acorn.parse({ ecmaVersion: 5 })`）输出 `ES5 PASS`；
  2. 解耦门禁（`node test-decoupling.mjs`）100% 通过；
  3. 单元测试套件（`node test-unit.mjs`）33/33 满分通过；
  4. 回归测试套件（`node test-suite.mjs`）7/7 场景全绿；
  5. 真实浏览器端到端：通过 `agent-browser` 验证页面正常呈现，错误弹层彻底消除，工作区与快捷键正常就绪。

## 三、分工契约与隔离有效性
- 写域正交：修改严格局限于 `server.mjs` 与 `static/index.html` 以及 `test-unit.mjs` 中的断言补充；
- 服务生命周期治理良好，重启后立即对外提供平稳服务。

## 四、元协议迭代建议
- **自愈闭环防饥饿规则**：前端定时器中，不得使用任一特定业务字段（如工作区、选中会话）作为多功能合并轮询的顶层阻断门禁；底层基础设施的健康轮询必须无条件独立运作，确保在任何局部异常态下均保持持续自愈能力。
