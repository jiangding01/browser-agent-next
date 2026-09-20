# Roadmap

## Phase 0 — Foundation and evaluation
- [x] Foundation + evaluation baseline
- [x] real Chromium MV3 E2E gate

## Phase 1 — Perception IR
- [x] DOM baseline — PR #1
- [x] Main-frame Hybrid — PR #2
- [x] Child-frame Hybrid — PR #3
- [ ] OOPIF/session exact mapping

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
- [ ] child-frame coordinate projection / actuation

## Phase 5 — Effects and authorization
- [x] control-plane authorization baseline
- [x] Authorization Assurance type/ranking
- [x] minimum assurance by Effect Class
- [x] trusted-host cannot self-upgrade assurance
- [ ] operator-approved issuance ingress
- [ ] enterprise-policy issuance ingress

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
- [ ] MCP stdio transport/server implementation
- [ ] minimal adapter → trusted Runtime client
- [ ] MCP transport integration tests
- [ ] safe scoped authorization broker before exposing browser.act

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
