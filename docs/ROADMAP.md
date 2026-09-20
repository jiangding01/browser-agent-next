# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR
- [x] DOM baseline — PR #1
- [x] Main-frame Hybrid — PR #2
- [x] Child-frame Hybrid — PR #3
- [ ] OOPIF/session exact mapping — PR #7 in progress

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
- [ ] child-frame coordinate projection / actuation — PR #7 in progress
  - [x] session-aware child live identity revalidation
  - [x] top-level coordinate projection core
  - [x] projection → Strict prepare integration
  - [x] dispatcher top-level coordinate-space guard
  - [ ] Real Chromium child Strict Click dispatch E2E — implemented, CI pending
  - [ ] navigation/detach/projection fail-closed E2E

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
- [ ] safe scoped authorization broker
- [ ] browser.act model-facing policy
- [ ] operator-approved user confirmation integration
- [ ] side-effect MCP integration tests

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
