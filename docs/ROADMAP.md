# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR
- [x] DOM baseline — PR #1
- [x] Main-frame Hybrid — PR #2
- [x] Child-frame Hybrid — PR #3
- [x] OOPIF/session exact mapping — PR #7

## Phase 2 — Persistent identity
- [x] DOM lifecycle identity
- [x] main/child DOM ↔ AX exact linked identity

## Phase 3 — Revision and delta
- [x] bounded TabStateStore
- [x] runtime-global revision ids
- [x] keyed delta
- [x] lifecycle invalidation

## Phase 4 — Strict executor
- [x] main-frame Strict Click closed loop
- [x] child-frame target fail closed
- [x] child-frame coordinate projection / actuation — PR #7
  - [x] session-aware child live identity revalidation
  - [x] top-level coordinate projection core
  - [x] projection → Strict prepare integration
  - [x] dispatcher top-level coordinate-space guard
  - [x] Real Chromium child Strict Click dispatch E2E
  - [x] navigation/detach/projection fail-closed E2E
  - [x] scroll + affine transform actuation / perspective fail-closed E2E
  - [x] nested parent-owner occlusion fail-closed
  - [x] detached child-session late-event hardening
  - [x] 2D affine projection / live box-model refresh regression
  - [x] PR #7 final adversarial review
  - [x] Real Chromium nested parent-owner overlay fail-closed / recovery E2E

## Phase 5 — Effects and authorization
- [x] control-plane authorization baseline
- [x] Authorization Assurance type/ranking
- [x] minimum assurance by Effect Class
- [x] trusted-host cannot self-upgrade assurance
- [x] shared strict-click issuance core with source-bound provenance
- [x] operator-approved issuance ingress
- [x] enterprise-policy issuance ingress
- [x] persistent enterprise assertion replay protection
- [x] PR #6 final adversarial review

## Phase 6 — High-level API
- [x] browser.open + Tab Ownership Registry
- [x] browser.observe
- [x] browser.verify
- [x] browser.wait fresh observation + verification
- [x] browser.act → Strict Click
- [x] event-assisted wait wake-up + bounded fallback
- [x] browser.extract retained-observation projection
- [x] PR #4 final adversarial review

## Phase 6.5 — Model-facing adapter boundary
- [x] transport-independent model-facing adapter core
- [x] dedicated model read/egress + navigation origin policy
- [x] explicit model tool exposure allowlist
- [x] prohibit model access to policy mutation / authorization issuance / raw trusted RPC
- [x] bounded model-visible revision store
- [x] projected extract / verify / wait to prevent hidden-state side channels
- [x] MCP tool schema/catalog
- [x] MCP stdio transport/server implementation
- [x] minimal adapter → trusted Runtime client (browser.open / browser.observe only)
- [x] operator config + executable MCP CLI (fail-closed defaults)
- [x] MCP transport integration tests (real stdio pipe)
- [x] PR #5 final adversarial review + frozen-lockfile gate

## Phase 6.6 — Model-facing side-effect authorization
- [x] PR-0：native host 从 `autoact-origins.json` 下发扩展 auto-act origin allowlist（fail closed）
- [x] safe scoped authorization broker（6.6a）
- [x] browser.act model-facing policy（6.6a：side-effect tier、act origin plane ⊆ read、per-connection 预算与单次执行账本）
- [x] operator-approved user confirmation integration（6.6a baseline：broker 创建 pending request 并轮询状态）
- [ ] side-effect MCP integration tests（6.6c：stdio wire 集成测试与最终对抗式审查）
- [x] 6.6b 扩展侧 approval UX
  - [x] 扩展 badge（6.6b-B）
  - [x] progress notification（6.6b-A）
  - [x] popup 显示 TTL 倒计时，并标注页面文本不可信（6.6b-B，含防误点增量刷新）
  - [x] approval 超时 / 客户端取消 / 执行失败后撤销 pending approval request 与未消费 grant（6.6b-A）

## Phase 7 — Intelligence
- [ ] deterministic router
- [ ] Jev CandidateBuilder
- [ ] offline replay
- [ ] shadow mode
- [ ] fast_step
- [ ] bounded fast_run

## Phase 8 — Semantic capabilities
- [ ] WebMCP discovery
- [ ] capability normalization
- [ ] policy-controlled invocation
