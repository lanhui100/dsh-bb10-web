# 证据包 session-mw47e45cavblex（pack_hash=9b99367580404d53）

- 任务: 工作区外交付文件预览改由会话策略+交付物成员授权 / 分级 B / 源码 L=0 文件 0
- 区间: 90b27b2..aafd2fc

## 提交序列
- 25d8af55d22b test(wave-2026-11-06-preview-policy): freeze contract, red-phase acceptance tests (L2-T + L2-AT)  16 files changed, 2424 insertions(+), 2 deletions(-)
  files: .dev-team/contract-wave-2026-11-06.md, .dev-team/receipts/baseline-decoupling.log, .dev-team/receipts/baseline-live.log, .dev-team/receipts/baseline-preview.log, .dev-team/receipts/baseline-unit.log, .dev-team/regression-baseline-2026-11-06.json, .dev-team/state.json, lib/preview-policy.mjs
- 2491389a9d55 test(wave-2026-11-06-preview-policy): r4 security hardening red tests (sensitive denylist, cwd fail-closed, client wiring)  6 files changed, 638 insertions(+), 13 deletions(-)
  files: tests/acceptance/RED-PHASE.md, tests/acceptance/adversarial/preview-policy-attack.mjs, tests/acceptance/artifacts/red-preview-policy-at-r4.log, tests/acceptance/artifacts/red-preview-policy-r4.log, tests/acceptance/lib/preview-host.mjs, tests/acceptance/suite-preview-policy.mjs
- 52693736dfad test(wave-2026-11-06-preview-policy): r8 deliverables-membership red tests (R-8/R-9 membership gate)  5 files changed, 568 insertions(+), 9 deletions(-)
  files: tests/acceptance/RED-PHASE.md, tests/acceptance/adversarial/preview-policy-attack.mjs, tests/acceptance/artifacts/red-preview-policy-at-r8.log, tests/acceptance/artifacts/red-preview-policy-r8.log, tests/acceptance/suite-preview-policy.mjs
- f9f0ec61a7a4 test(wave-2026-11-06-preview-policy): migrate pre-R8 cases to deliverables-membership contract (R-8)  5 files changed, 230 insertions(+), 26 deletions(-)
  files: tests/acceptance/RED-PHASE.md, tests/acceptance/adversarial/preview-policy-attack.mjs, tests/acceptance/artifacts/green-preview-policy-at-r8.log, tests/acceptance/artifacts/green-preview-policy-r8.log, tests/acceptance/suite-preview-policy.mjs
- 571df920f279 test(wave-2026-11-06-preview-policy): r9 fail-closed on unknown session cwd (A14f red)  3 files changed, 215 insertions(+)
  files: tests/acceptance/RED-PHASE.md, tests/acceptance/artifacts/red-preview-policy-r9.log, tests/acceptance/suite-preview-policy.mjs
- 0f64413f8c5d feat(preview): allow out-of-workspace file preview when session holds full access and file is a session deliverable  27 files changed, 2018 insertions(+), 53 deletions(-)
  files: .agents/notes/implemented/bug-fix/2026-11-06-out-of-workspace-preview-session-policy.md, .agents/notes/implemented/feature/2026-09-23-message-file-fullscreen-preview.md, .dev-team/contract-wave-2026-11-06.md, .dev-team/meta-retrospective.md, .dev-team/receipts/green-adversarial.log, .dev-team/receipts/green-decoupling.log, .dev-team/receipts/green-e2e-outside.log, .dev-team/receipts/green-live.log
- aafd2fca34e7 chore(review): attach provenance (schema v2) to review receipts  8 files changed, 483 insertions(+), 382 deletions(-)
  files: .dev-team/review-l3a-preview.json, .dev-team/review-l3b-preview-r4.json, .dev-team/review-l3b-preview-r8.json, .dev-team/review-l3b-preview.json, .dev-team/review-l3p-preview.json, .dev-team/review-plan-r4.json, .dev-team/review-plan-r8.json, .dev-team/review-plan.json

## 交付后 7 天相关提交
- 无

## 机械红旗（判定必须逐条回应）
- self_signed_review:review-l3a-preview.json
- self_signed_review:review-l3b-preview-r4.json
- self_signed_review:review-l3b-preview-r8.json
- self_signed_review:review-l3b-preview.json
- self_signed_review:review-l3p-preview.json
- self_signed_review:review-plan-r4.json
- self_signed_review:review-plan-r8.json
- self_signed_review:review-plan.json

## 无法从机器判定的未知项
- 每个门禁实际抓到多少缺陷（gate_caught）需从 review JSON/测试日志判定
- 用户是否口头授权了自扩范围（scope）需读会话原文
